import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LivePreviewServer, validateLoopbackTarget } from './livePreviewServer.js';
import { isRuntimeMessage, type RuntimeLiveSelectionMessage } from './messages.js';
import { SELECTION_SCHEMA_VERSION, SelectionStateStore, type CanvasSelectionState } from './selectionState.js';

interface RewriteBridge {
  process: ChildProcess;
  proxyUrl: string;
  websocketPort: number;
}

export async function openLiveCanvas(context: vscode.ExtensionContext, inputUrl: string): Promise<void> {
  const target = validateLoopbackTarget(inputUrl);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) throw new Error('Open a workspace before connecting a dev server.');

  const runtimePath = path.join(context.extensionPath, 'dist', 'live-runtime.js');
  let rewrite: RewriteBridge | undefined;
  let mode: 'react' | 'inspect' = 'inspect';
  if (vscode.workspace.getConfiguration('visualWebCanvas').get<boolean>('enableReactSourceEditing', true)) {
    try {
      rewrite = await launchReactRewrite(context.extensionPath, workspaceRoot, target);
      mode = 'react';
    } catch (error) {
      void vscode.window.showWarningMessage(`Visual source editing was unavailable; opening inspect mode. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const proxy = new LivePreviewServer({
    targetUrl: rewrite?.proxyUrl ?? target.toString(),
    runtimePath,
    rewriteWebSocketPort: rewrite?.websocketPort,
  });
  await proxy.start();
  const external = await vscode.env.asExternalUri(vscode.Uri.parse(proxy.url));
  const panel = vscode.window.createWebviewPanel(
    'visualWebCanvas.live',
    `Visual Web Canvas · ${target.port || target.hostname}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = liveWebviewHtml(proxy.token, external.toString(true), target.toString(), mode);

  const state = new SelectionStateStore(workspaceRoot, proxy.token.slice(0, 12));
  let currentSelection: RuntimeLiveSelectionMessage | undefined;
  let disposed = false;
  const heartbeat = setInterval(() => {
    if (panel.visible) void state.heartbeat();
  }, 2_000);

  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (isRuntimeMessage(message)) {
      if (message.token !== proxy.token) return;
      if (message.type === 'liveSelection') {
        currentSelection = message;
        await state.set(await liveSelectionState(workspaceRoot, target.toString(), message));
        void panel.webview.postMessage({
          type: 'selectionDetails',
          tagName: tagNameFromHtml(message.renderedHtml),
          selector: message.selector,
          ancestorTrail: message.ancestorTrail,
          computedStyles: message.computedStyles,
          react: message.react,
          accessibility: message.accessibility,
        });
        return;
      }
      if (message.type === 'screenshot') {
        await state.attachScreenshot(message.kind, message.dataUrl);
        void panel.webview.postMessage({ type: 'status', message: 'Comment and screenshot are ready for your next Claude message.' });
        return;
      }
      if (message.type === 'liveStatus' && message.message) {
        void panel.webview.postMessage({ type: 'status', message: message.message });
      }
      return;
    }

    if (!message || typeof message !== 'object') return;
    const host = message as { type?: string; enabled?: boolean };
    if (host.type === 'setInspectMode') {
      void panel.webview.postMessage({ type: 'frameMessage', payload: { channel: 'visual-web-canvas-host', token: proxy.token, type: 'setInspectMode', enabled: host.enabled } });
    }
    if (host.type === 'comment') {
      if (!currentSelection) return;
      const comment = await vscode.window.showInputBox({
        title: 'Comment on selected element',
        prompt: 'This comment, the element context, and a cropped screenshot will be supplied to your next Claude Code message.',
        placeHolder: 'Make this section feel more premium…',
        ignoreFocusOut: true,
      });
      if (!comment?.trim()) return;
      await state.setComment(comment);
      void panel.webview.postMessage({ type: 'frameMessage', payload: { channel: 'visual-web-canvas-host', token: proxy.token, type: 'captureCommentScreenshot' } });
      await focusClaudeInput();
    }
    if (host.type === 'openSource' && currentSelection) await openSourceLocation(workspaceRoot, currentSelection.react);
    if (host.type === 'clearSelection') {
      currentSelection = undefined;
      await state.clear();
      void panel.webview.postMessage({ type: 'frameMessage', payload: { channel: 'visual-web-canvas-host', token: proxy.token, type: 'clearSelection' } });
      void panel.webview.postMessage({ type: 'selectionCleared' });
    }
  });

  panel.onDidDispose(() => {
    if (disposed) return;
    disposed = true;
    clearInterval(heartbeat);
    rewrite?.process.kill('SIGTERM');
    void state.clear();
    void proxy.dispose();
  });
}

async function launchReactRewrite(extensionPath: string, workspaceRoot: string, target: URL): Promise<RewriteBridge> {
  if (target.protocol !== 'http:') throw new Error('React source editing currently requires an HTTP dev server.');
  const port = Number(target.port || 80);
  if (!Number.isInteger(port) || port < 1) throw new Error('The dev server URL must include a valid port.');
  const runner = path.join(extensionPath, 'resources', 'react-rewrite-runner.mjs');
  const child = spawn(process.execPath, [runner, String(port), target.hostname], {
    cwd: workspaceRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  return await new Promise<RewriteBridge>((resolve, reject) => {
    let output = '';
    let settled = false;
    const timer = setTimeout(() => fail(new Error('React source editor did not start within 15 seconds.')), 15_000);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      reject(error);
    };
    const inspect = (chunk: Buffer) => {
      output += stripAnsi(chunk.toString('utf8'));
      const proxy = /Proxy:\s+(https?:\/\/\S+)/.exec(output)?.[1];
      const websocket = /WebSocket:\s+ws:\/\/[^:]+:(\d+)/.exec(output)?.[1];
      if (proxy && websocket) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ process: child, proxyUrl: proxy, websocketPort: Number(websocket) });
      }
    };
    child.stdout?.on('data', inspect);
    child.stderr?.on('data', inspect);
    child.once('error', fail);
    child.once('exit', (code) => {
      if (!/Proxy:\s+https?:\/\//.test(output)) fail(new Error(lastUsefulLine(output) || `React source editor exited with code ${code}.`));
    });
  });
}

async function liveSelectionState(
  workspaceRoot: string,
  liveUrl: string,
  message: RuntimeLiveSelectionMessage,
): Promise<CanvasSelectionState> {
  const documentPath = resolveSourcePath(workspaceRoot, message.react.filePath);
  const contents = documentPath ? await fs.readFile(documentPath).catch(() => undefined) : undefined;
  return {
    schemaVersion: SELECTION_SCHEMA_VERSION,
    mode: 'live',
    workspaceRoot,
    documentPath,
    documentHash: contents ? createHash('sha256').update(contents).digest('hex') : undefined,
    documentDirty: documentPath
      ? vscode.workspace.textDocuments.find((document) => document.uri.fsPath === documentPath)?.isDirty ?? false
      : undefined,
    liveUrl,
    selectedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    element: {
      id: createHash('sha256').update(`${message.selector}:${message.renderedHtml}`).digest('hex').slice(0, 16),
      tagName: tagNameFromHtml(message.renderedHtml),
      sourceHtml: message.react.snippet || message.renderedHtml,
      renderedHtml: message.renderedHtml,
      text: message.text,
      selector: message.selector,
      ancestorTrail: message.ancestorTrail,
      attributes: message.attributes,
      computedStyles: message.computedStyles,
      bounds: message.bounds,
    },
    accessibility: message.accessibility,
    react: message.react,
    viewport: message.viewport,
    screenshots: {},
  };
}

function resolveSourcePath(workspaceRoot: string, value: string | null): string | undefined {
  if (!value) return undefined;
  let source = value.replace(/^file:\/\//, '').replace(/[?#].*$/, '');
  const webpack = /(?:webpack-internal:\/\/\/|webpack:\/\/[^/]*\/)(.*)$/.exec(source)?.[1];
  if (webpack) source = webpack;
  const candidate = path.isAbsolute(source) ? path.resolve(source) : path.resolve(workspaceRoot, source.replace(/^\.\//, ''));
  const relative = path.relative(workspaceRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return candidate;
}

async function openSourceLocation(workspaceRoot: string, react: RuntimeLiveSelectionMessage['react']): Promise<void> {
  const file = resolveSourcePath(workspaceRoot, react.filePath);
  if (!file) return void vscode.window.showWarningMessage('This element did not resolve to a safe workspace source file.');
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
  const position = new vscode.Position(Math.max(0, (react.lineNumber ?? 1) - 1), Math.max(0, (react.columnNumber ?? 1) - 1));
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

export async function focusClaudeInput(): Promise<void> {
  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes('claude-vscode.focus')) {
    void vscode.window.showErrorMessage('Install or enable the Claude Code extension to use the seamless chat bridge.');
    return;
  }
  try {
    await vscode.commands.executeCommand('claude-vscode.focus');
  } catch (error) {
    void vscode.window.showErrorMessage(`Claude Code could not be focused: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function liveWebviewHtml(token: string, frameUrl: string, targetUrl: string, mode: 'react' | 'inspect'): string {
  const nonce = createHash('sha256').update(`${token}:${Date.now()}`).digest('hex').slice(0, 24);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http: https:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:13px var(--vscode-font-family)}
.top{height:46px;display:flex;align-items:center;gap:7px;padding:7px 10px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-titleBar-activeBackground)}
.badge{padding:4px 8px;border-radius:999px;background:${mode === 'react' ? '#14532d' : '#3f3f46'};color:#fff;font-size:10px;font-weight:700;letter-spacing:.06em}.url{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family);font-size:11px}
button,select{height:29px;border:1px solid var(--vscode-button-secondaryBackground);border-radius:5px;padding:0 10px;background:transparent;color:var(--vscode-foreground)}button:hover,button.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:disabled{opacity:.4}.stage{height:calc(100% - 76px);overflow:auto;background:color-mix(in srgb,var(--vscode-editor-background) 78%,#777);padding:18px}.device{height:100%;min-height:620px;margin:0 auto;background:#fff;box-shadow:0 10px 40px rgba(0,0,0,.28);transform-origin:top center}iframe{display:block;width:100%;height:100%;border:0;background:#fff}.status{height:30px;display:flex;align-items:center;padding:0 10px;border-top:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);font-size:11px}.status strong{margin-right:7px;color:#a78bfa}.source{margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%}
</style></head><body>
<div class="top"><span class="badge">${mode === 'react' ? 'REACT · SOURCE EDITABLE' : 'LIVE · INSPECT'}</span><span class="url">${escapeHtml(targetUrl)}</span>
<select id="viewport"><option value="0">Responsive</option><option value="1440">Desktop · 1440</option><option value="1024">Laptop · 1024</option><option value="768">Tablet · 768</option><option value="390">Mobile · 390</option></select>
<button id="inspect" class="active">Inspect</button>${mode === 'react' ? '<button id="design">Design</button>' : ''}<button id="source" disabled>Open source</button><button id="comment" disabled>Comment → Claude</button><button id="clear">Clear</button><button id="reload" title="Reload">↻</button></div>
<div class="stage" id="stage"><div class="device" id="device"><iframe id="frame" src="${escapeHtml(frameUrl)}" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads"></iframe></div></div>
<div class="status"><strong id="element">No selection</strong><span id="message">Click an element to attach it to Claude.</span><span class="source" id="sourcePath"></span></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi(),token=${JSON.stringify(token)},frame=document.getElementById('frame'),device=document.getElementById('device'),stage=document.getElementById('stage');let inspect=true,selected=false;
function sendFrame(payload){frame.contentWindow?.postMessage(payload,'*')}function resize(){const width=Number(document.getElementById('viewport').value);if(!width){device.style.width='100%';device.style.transform='';return}const available=stage.clientWidth-36,scale=Math.min(1,available/width);device.style.width=width+'px';device.style.transform='scale('+scale+')';device.style.height=(stage.clientHeight/scale)+'px'}
window.addEventListener('resize',resize);document.getElementById('viewport').addEventListener('change',resize);document.getElementById('reload').onclick=()=>{frame.src=frame.src};
function setInspect(value){inspect=value;document.getElementById('inspect').classList.toggle('active',value);document.getElementById('design')?.classList.toggle('active',!value);vscode.postMessage({type:'setInspectMode',enabled:value})}
document.getElementById('inspect').onclick=()=>setInspect(true);document.getElementById('design')?.addEventListener('click',()=>setInspect(false));document.getElementById('comment').onclick=()=>vscode.postMessage({type:'comment'});document.getElementById('source').onclick=()=>vscode.postMessage({type:'openSource'});document.getElementById('clear').onclick=()=>vscode.postMessage({type:'clearSelection'});
window.addEventListener('message',event=>{if(event.data?.channel==='visual-web-canvas'&&event.data.token===token)vscode.postMessage(event.data)});
window.addEventListener('message',event=>{const m=event.data;if(m?.type==='frameMessage')sendFrame(m.payload);if(m?.type==='selectionDetails'){selected=true;document.getElementById('comment').disabled=false;document.getElementById('source').disabled=!m.react?.filePath;document.getElementById('element').textContent='<'+m.tagName+'>';document.getElementById('message').textContent=m.selector;document.getElementById('sourcePath').textContent=m.react?.filePath?m.react.filePath+':'+(m.react.lineNumber||1):'Runtime DOM';}if(m?.type==='status')document.getElementById('message').textContent=m.message;if(m?.type==='selectionCleared'){selected=false;document.getElementById('comment').disabled=true;document.getElementById('source').disabled=true;document.getElementById('element').textContent='No selection';document.getElementById('message').textContent='Click an element to attach it to Claude.';document.getElementById('sourcePath').textContent='';}});
frame.addEventListener('load',()=>sendFrame({channel:'visual-web-canvas-host',token,type:'setInspectMode',enabled:inspect}));resize();
</script></body></html>`;
}

function tagNameFromHtml(html: string): string {
  return /^\s*<([a-z0-9-]+)/i.exec(html)?.[1]?.toLowerCase() ?? 'element';
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function lastUsefulLine(output: string): string {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
