import * as path from 'node:path';
import * as vscode from 'vscode';
import { inlineStyleEdit, responsiveOverrideDocument, type ResponsiveScope } from './documentEdits.js';
import { diagnoseClaudeBridge, installClaudeBridge } from './hookInstaller.js';
import { focusClaudeInput, openLiveCanvas } from './liveCanvas.js';
import { isRuntimeMessage, type RuntimeMessage } from './messages.js';
import { PreviewServer } from './previewServer.js';
import { escapeHtmlText } from './sourceMap.js';
import { computeViewportLayout } from './viewportLayout.js';
import {
  hashDocument,
  SELECTION_SCHEMA_VERSION,
  SelectionStateStore,
  type CanvasSelectionState,
} from './selectionState.js';

const VIEW_TYPE = 'visualWebCanvas.editor';

interface PanelSession {
  token: string;
  document: vscode.TextDocument;
  panel: vscode.WebviewPanel;
  workspaceRoot: string;
  state: SelectionStateStore;
  selectedElementId?: string;
  selectedDocumentVersion?: number;
  selectedSelector?: string;
  selectedText?: string;
  selectedTag?: string;
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  foldHeight: number;
  compare: boolean;
  showBefore: boolean;
  history: string[];
  lastDocumentText: string;
  suppressHistory: boolean;
  refreshTimer?: NodeJS.Timeout;
  heartbeatTimer?: NodeJS.Timeout;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const runtimePath = path.join(context.extensionPath, 'dist', 'runtime.js');
  const previewServer = new PreviewServer(runtimePath);
  await previewServer.start();
  const provider = new VisualWebCanvasProvider(previewServer);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 80);
  statusBar.name = 'Visual Web Canvas';
  statusBar.text = '$(open-preview) Web Canvas';
  statusBar.tooltip = 'Connect a live website to Visual Web Canvas';
  statusBar.command = 'visualWebCanvas.connectDevServer';
  statusBar.show();

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('visualWebCanvas.open', async (resource?: vscode.Uri) => {
      const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri || path.extname(uri.fsPath).toLowerCase() !== '.html') {
        void vscode.window.showErrorMessage('Open an HTML file before launching Visual Web Canvas.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, vscode.ViewColumn.Beside);
    }),
    vscode.commands.registerCommand('visualWebCanvas.connectDevServer', async () => {
      const fallback = vscode.workspace.getConfiguration('visualWebCanvas').get<string>('defaultDevServerUrl', 'http://localhost:3000');
      const value = await vscode.window.showInputBox({
        title: 'Connect a live dev server',
        prompt: 'Start your Vite, Next.js, React, or other local dev server first.',
        value: fallback,
        ignoreFocusOut: true,
        validateInput: (input) => {
          try {
            const url = new URL(input);
            return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase()) ? undefined : 'Use a loopback dev server URL.';
          } catch {
            return 'Enter a valid URL such as http://localhost:3000.';
          }
        },
      });
      if (!value) return;
      try {
        await openLiveCanvas(context, value);
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not open live canvas: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand('visualWebCanvas.clearSelection', () => provider.clearSelections()),
    vscode.commands.registerCommand('visualWebCanvas.commentInClaude', () => provider.commentInActiveSession()),
    vscode.commands.registerCommand('visualWebCanvas.installClaudeBridge', async () => {
      try {
        const installed = await installClaudeBridge(context);
        void vscode.window.showInformationMessage(`Claude bridge installed: ${installed.hookPath}`);
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not install Claude bridge: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand('visualWebCanvas.doctor', async () => {
      const bridge = await diagnoseClaudeBridge();
      const commands = await vscode.commands.getCommands(true);
      const report = [
        '# Visual Web Canvas diagnostics',
        `VS Code: ${vscode.version}`,
        `Extension host: ${vscode.env.remoteName ? `remote (${vscode.env.remoteName})` : 'local'}`,
        `Workspace: ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'not open'}`,
        `Claude Code command: ${commands.includes('claude-vscode.focus') ? 'available' : 'missing'}`,
        `Claude bridge: ${bridge.detail}`,
        `Selection state: ${path.join(require('node:os').homedir(), '.visual-web-canvas', 'state')}`,
        '',
        'No telemetry is collected. This report contains no page content.',
      ].join('\n');
      const document = await vscode.workspace.openTextDocument({ content: report, language: 'markdown' });
      await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside, true);
    }),
    statusBar,
    { dispose: () => void provider.dispose() },
    { dispose: () => void previewServer.dispose() },
  );

  if (!context.globalState.get<boolean>('visualWebCanvas.welcomeShown')) {
    await context.globalState.update('visualWebCanvas.welcomeShown', true);
    const action = await vscode.window.showInformationMessage(
      'Visual Web Canvas is ready. Open an HTML file or connect a running React/Vite/Next dev server.',
      'Connect Dev Server',
      'Install Claude Bridge',
    );
    if (action === 'Connect Dev Server') void vscode.commands.executeCommand('visualWebCanvas.connectDevServer');
    if (action === 'Install Claude Bridge') void vscode.commands.executeCommand('visualWebCanvas.installClaudeBridge');
  }
}

export function deactivate(): void {}

class VisualWebCanvasProvider implements vscode.CustomTextEditorProvider {
  private readonly sessions = new Map<string, PanelSession>();
  private readonly changeSubscription: vscode.Disposable;

  constructor(private readonly previewServer: PreviewServer) {
    this.changeSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      for (const session of this.sessions.values()) {
        if (event.document.uri.toString() !== session.document.uri.toString()) continue;
        const current = event.document.getText();
        if (current !== session.lastDocumentText) {
          if (!session.suppressHistory) {
            session.history.push(session.lastDocumentText);
            if (session.history.length > 20) session.history.shift();
          }
          session.lastDocumentText = current;
          session.showBefore = false;
          this.previewServer.setAlternateText(session.token, session.history.at(-1));
          void session.panel.webview.postMessage({ type: 'historyState', available: true, showingBefore: false });
        }
        this.scheduleRefresh(session);
      }
    });
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _cancellation: vscode.CancellationToken,
  ): Promise<void> {
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? path.dirname(document.uri.fsPath);
    const token = this.previewServer.register(document, workspaceRoot);
    const session: PanelSession = {
      token,
      document,
      panel,
      workspaceRoot,
      state: new SelectionStateStore(workspaceRoot, token.slice(0, 12)),
      scrollX: 0,
      scrollY: 0,
      viewportWidth: 0,
      foldHeight: 0,
      compare: false,
      showBefore: false,
      history: [],
      lastDocumentText: document.getText(),
      suppressHistory: false,
    };
    this.sessions.set(token, session);

    panel.webview.options = { enableScripts: true };
    panel.webview.html = webviewHtml(token);
    panel.webview.onDidReceiveMessage((message: unknown) => void this.receive(session, message));
    panel.onDidDispose(() => void this.close(session));
    panel.onDidChangeViewState(() => {
      if (panel.visible) void session.state.heartbeat();
    });
    session.heartbeatTimer = setInterval(() => {
      if (panel.visible) void session.state.heartbeat();
    }, 2_000);
  }

  async clearSelections(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(async (session) => {
      session.selectedElementId = undefined;
      session.selectedDocumentVersion = undefined;
      session.selectedSelector = undefined;
      session.selectedText = undefined;
      session.selectedTag = undefined;
      await session.state.clear();
      void session.panel.webview.postMessage({ type: 'clearSelection', token: session.token });
      void session.panel.webview.postMessage({ type: 'selectionAvailable', available: false });
      void session.panel.webview.postMessage({ type: 'status', message: 'No element attached to Claude.' });
    }));
  }

  async commentInActiveSession(): Promise<void> {
    const session = [...this.sessions.values()].find((candidate) => candidate.panel.active)
      ?? [...this.sessions.values()].find((candidate) => candidate.panel.visible);
    if (!session?.selectedElementId) {
      void vscode.window.showInformationMessage('Select an element in an HTML canvas first.');
      return;
    }
    await this.commentInClaude(session);
  }

  async dispose(): Promise<void> {
    this.changeSubscription.dispose();
    await Promise.all([...this.sessions.values()].map((session) => this.close(session)));
  }

  private async receive(session: PanelSession, message: unknown): Promise<void> {
    if (isRuntimeMessage(message)) {
      if (message.token !== session.token) return;
      await this.receiveRuntime(session, message);
      return;
    }
    if (!message || typeof message !== 'object') return;
    const host = message as {
      type?: string;
      width?: number;
      property?: string;
      value?: string;
      scope?: ResponsiveScope;
      enabled?: boolean;
    };
    if (host.type === 'ready') void this.refresh(session);
    if (host.type === 'focusClaude') await this.commentInClaude(session);
    if (host.type === 'clearSelection') {
      session.selectedElementId = undefined;
      session.selectedDocumentVersion = undefined;
      session.selectedSelector = undefined;
      session.selectedText = undefined;
      session.selectedTag = undefined;
      await session.state.clear();
      void session.panel.webview.postMessage({ type: 'clearSelection', token: session.token });
      void session.panel.webview.postMessage({ type: 'selectionAvailable', available: false });
      void session.panel.webview.postMessage({ type: 'status', message: 'No element attached to Claude.' });
    }
    if (host.type === 'setViewport') {
      session.viewportWidth = Number(host.width) || 0;
      void session.panel.webview.postMessage({ type: 'viewport', width: session.viewportWidth });
    }
    if (host.type === 'styleEdit') {
      await this.applyStyleEdit(session, host.property, host.value, host.scope);
    }
    if (host.type === 'setCompare') {
      session.compare = Boolean(host.enabled);
      void session.panel.webview.postMessage({ type: 'compareState', enabled: session.compare });
      void this.refresh(session);
    }
    if (host.type === 'setFold') {
      session.foldHeight = host.enabled ? 768 : 0;
      void session.panel.webview.postMessage({ type: 'foldState', enabled: Boolean(session.foldHeight) });
      void session.panel.webview.postMessage({ type: 'fold', height: session.foldHeight });
    }
    if (host.type === 'toggleBefore') {
      if (!session.history.length) return;
      session.showBefore = !session.showBefore;
      this.previewServer.setAlternateText(session.token, session.history.at(-1));
      void session.panel.webview.postMessage({
        type: 'historyState',
        available: true,
        showingBefore: session.showBefore,
      });
      void this.refresh(session);
    }
    if (host.type === 'revertLast') await this.revertLast(session);
  }

  private async receiveRuntime(session: PanelSession, message: RuntimeMessage): Promise<void> {
    switch (message.type) {
      case 'selection': {
        const sourceMap = this.previewServer.getSession(session.token)?.latest;
        const source = sourceMap?.elements.get(message.elementId);
        if (!source) {
          void this.refresh(session);
          return;
        }
        session.selectedElementId = message.elementId;
        session.selectedDocumentVersion = session.document.version;
        session.selectedSelector = message.selector;
        session.selectedText = message.text;
        session.selectedTag = source.tagName;
        session.scrollX = message.viewport.scrollX;
        session.scrollY = message.viewport.scrollY;
        const documentText = session.document.getText();
        const state: CanvasSelectionState = {
          schemaVersion: SELECTION_SCHEMA_VERSION,
          mode: 'static',
          workspaceRoot: session.workspaceRoot,
          documentPath: session.document.uri.fsPath,
          documentVersion: session.document.version,
          documentHash: hashDocument(documentText),
          documentDirty: session.document.isDirty,
          selectedAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          element: {
            id: source.id,
            tagName: source.tagName,
            sourceRange: {
              startOffset: source.startOffset,
              endOffset: source.endOffset,
              startLine: source.startLine,
              startColumn: source.startColumn,
              endLine: source.endLine,
              endColumn: source.endColumn,
            },
            sourceHtml: source.sourceHtml,
            renderedHtml: message.renderedHtml,
            text: message.text,
            selector: message.selector,
            ancestorTrail: message.ancestorTrail,
            attributes: message.attributes,
            computedStyles: message.computedStyles,
            bounds: message.bounds,
          },
          viewport: message.viewport,
          screenshots: {},
        };
        await session.state.set(state);
        void session.panel.webview.postMessage({ type: 'selectionAvailable', available: true });
        void session.panel.webview.postMessage({
          type: 'selectionDetails',
          tagName: source.tagName,
          selector: message.selector,
          ancestorTrail: message.ancestorTrail,
          computedStyles: message.computedStyles,
        });
        void session.panel.webview.postMessage({
          type: 'status',
          message: `<${source.tagName}> ready. Comment opens your existing Claude chat.`,
        });
        break;
      }
      case 'editText': {
        if (message.documentVersion !== session.document.version) {
          void session.panel.webview.postMessage({ type: 'status', message: 'Page changed; text edit was not applied. Try again.' });
          void this.refresh(session);
          return;
        }
        const sourceMap = this.previewServer.getSession(session.token)?.latest;
        const source = sourceMap?.textNodes.get(message.textId);
        if (!source) return;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          session.document.uri,
          new vscode.Range(session.document.positionAt(source.startOffset), session.document.positionAt(source.endOffset)),
          escapeHtmlText(message.value),
        );
        const applied = await vscode.workspace.applyEdit(edit);
        void session.panel.webview.postMessage({
          type: 'status',
          message: applied ? 'Text updated. VS Code undo is available.' : 'VS Code rejected the text edit.',
        });
        break;
      }
      case 'screenshot':
        await session.state.attachScreenshot(message.kind, message.dataUrl);
        break;
      case 'scroll':
        session.scrollX = message.x;
        session.scrollY = message.y;
        break;
      case 'status':
        void session.panel.webview.postMessage({ type: 'status', message: message.message });
        break;
      case 'elementAction':
        await this.applyElementAction(session, message.action, message.elementId);
        break;
    }
  }

  private async applyStyleEdit(
    session: PanelSession,
    property: string | undefined,
    value: string | undefined,
    scope: ResponsiveScope | undefined,
  ): Promise<void> {
    const allowed = new Set([
      'width', 'max-width', 'height', 'min-height', 'margin', 'padding', 'gap',
      'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align',
      'color', 'background-color', 'border-radius', 'opacity',
    ]);
    if (!property || !allowed.has(property) || value === undefined || !scope) return;
    if (value.length > 160 || /[{};]/.test(value)) {
      void session.panel.webview.postMessage({ type: 'status', message: 'That CSS value is not safe to apply from the inspector.' });
      return;
    }
    if (!session.selectedElementId || !session.selectedSelector) return;

    const documentText = session.document.getText();
    const edit = new vscode.WorkspaceEdit();
    if (scope === 'all') {
      const source = this.previewServer.getSession(session.token)?.latest?.elements.get(session.selectedElementId);
      if (!source) return void this.refresh(session);
      const replacement = inlineStyleEdit(documentText, source, property, value);
      edit.replace(
        session.document.uri,
        new vscode.Range(session.document.positionAt(replacement.start), session.document.positionAt(replacement.end)),
        replacement.text,
      );
    } else {
      const replacement = responsiveOverrideDocument(documentText, session.selectedSelector, scope, property, value);
      edit.replace(session.document.uri, fullDocumentRange(session.document), replacement);
    }
    const applied = await vscode.workspace.applyEdit(edit);
    void session.panel.webview.postMessage({
      type: 'status',
      message: applied ? `${property} updated for ${scope === 'all' ? 'all breakpoints' : scope}.` : 'VS Code rejected the style edit.',
    });
  }

  private async applyElementAction(
    session: PanelSession,
    action: 'focusClaude' | 'duplicate' | 'delete',
    elementId: string,
  ): Promise<void> {
    if (action === 'focusClaude') return this.commentInClaude(session);
    const source = this.previewServer.getSession(session.token)?.latest?.elements.get(elementId);
    if (!source) return void this.refresh(session);
    const edit = new vscode.WorkspaceEdit();
    if (action === 'delete') {
      edit.delete(
        session.document.uri,
        new vscode.Range(session.document.positionAt(source.startOffset), session.document.positionAt(source.endOffset)),
      );
      session.selectedElementId = undefined;
      session.selectedDocumentVersion = undefined;
      session.selectedSelector = undefined;
      session.selectedText = undefined;
      session.selectedTag = undefined;
      void session.panel.webview.postMessage({ type: 'selectionAvailable', available: false });
    } else {
      if (/\sid\s*=\s*["']/i.test(source.sourceHtml)) {
        void vscode.window.showWarningMessage('This element contains IDs. Ask Claude to duplicate it so references remain unique.');
        return;
      }
      const lineStart = session.document.offsetAt(new vscode.Position(source.endLine - 1, 0));
      const indentation = /^\s*/.exec(session.document.getText().slice(lineStart, source.startOffset))?.[0] ?? '';
      edit.insert(session.document.uri, session.document.positionAt(source.endOffset), `\n${indentation}${source.sourceHtml}`);
    }
    const applied = await vscode.workspace.applyEdit(edit);
    void session.panel.webview.postMessage({
      type: 'status',
      message: applied ? `Element ${action}d. VS Code undo is available.` : `Could not ${action} the element.`,
    });
  }

  private async commentInClaude(session: PanelSession): Promise<void> {
    if (!session.selectedElementId) return;
    const comment = await vscode.window.showInputBox({
      title: 'Comment on selected element',
      prompt: 'This comment, the exact source, computed styles, and a cropped screenshot will be supplied to your next Claude Code message.',
      placeHolder: 'Make this section feel more premium…',
      ignoreFocusOut: true,
    });
    if (!comment?.trim()) return;
    await session.state.setComment(comment);
    void session.panel.webview.postMessage({ type: 'captureCommentScreenshot', token: session.token });
    await focusClaudeInput();
  }

  private async revertLast(session: PanelSession): Promise<void> {
    const previous = session.history.at(-1);
    if (previous === undefined) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(session.document.uri, fullDocumentRange(session.document), previous);
    session.suppressHistory = true;
    let applied = false;
    try {
      applied = await vscode.workspace.applyEdit(edit);
    } finally {
      session.suppressHistory = false;
    }
    if (applied) {
      session.history.pop();
      session.showBefore = false;
      this.previewServer.setAlternateText(session.token, session.history.at(-1));
      void session.panel.webview.postMessage({
        type: 'historyState',
        available: Boolean(session.history.length),
        showingBefore: false,
      });
      void session.panel.webview.postMessage({ type: 'status', message: 'Reverted the last document change.' });
    }
  }

  private scheduleRefresh(session: PanelSession): void {
    if (session.refreshTimer) clearTimeout(session.refreshTimer);
    session.refreshTimer = setTimeout(() => void this.refresh(session), 80);
  }

  private async refresh(session: PanelSession): Promise<void> {
    session.refreshTimer = undefined;
    const baseLocation = {
      selected: session.selectedDocumentVersion === session.document.version ? session.selectedElementId : undefined,
      selectedSelector: session.selectedSelector,
      selectedText: session.selectedText,
      selectedTag: session.selectedTag,
      scrollX: session.scrollX,
      scrollY: session.scrollY,
      viewportWidth: session.viewportWidth,
      foldHeight: session.foldHeight,
      mode: session.showBefore ? 'before' as const : 'current' as const,
    };
    const internalUrl = this.previewServer.previewUrl(session.token, { ...baseLocation, surface: 'primary' });
    const compareInternalUrl = this.previewServer.previewUrl(session.token, { ...baseLocation, surface: 'compare' });
    const [externalUrl, compareExternalUrl] = await Promise.all([
      vscode.env.asExternalUri(vscode.Uri.parse(internalUrl)),
      vscode.env.asExternalUri(vscode.Uri.parse(compareInternalUrl)),
    ]);
    void session.panel.webview.postMessage({
      type: 'refresh',
      url: externalUrl.toString(true),
      compareUrl: compareExternalUrl.toString(true),
    });
  }

  private async close(session: PanelSession): Promise<void> {
    if (!this.sessions.delete(session.token)) return;
    if (session.refreshTimer) clearTimeout(session.refreshTimer);
    if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
    this.previewServer.unregister(session.token);
    await session.state.clear();
  }
}

function webviewHtml(token: string): string {
  const nonce = cryptoNonce();
  const computeViewportLayoutSource = computeViewportLayout.toString();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http: https:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
    .toolbar { height: 42px; display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); overflow-x: auto; overflow-y: hidden; }
    button, select { height: 28px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 4px; padding: 0 10px; }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button:disabled { cursor: not-allowed; opacity: .45; }
    button.secondary { color: var(--vscode-foreground); background: transparent; border: 1px solid var(--vscode-button-secondaryBackground); }
    button.active { color: white; background: #6d5bd0; }
    select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); }
    .crumbbar { height: 32px; display: flex; align-items: center; gap: 3px; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .breadcrumbs { display: flex; min-width: 0; align-items: center; gap: 2px; overflow: hidden; }
    .breadcrumbs button { height: 23px; max-width: 170px; padding: 0 7px; overflow: hidden; text-overflow: ellipsis; color: var(--vscode-foreground); background: transparent; white-space: nowrap; }
    .breadcrumbs .separator { opacity: .4; }
    .status { min-width: 100px; margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .72; font-size: 11px; text-align: right; }
    .workbench { width: 100%; height: calc(100% - 74px); display: flex; min-height: 0; }
    .canvas-column { min-width: 0; flex: 1; }
    .stage-row { width: 100%; height: 100%; display: flex; min-width: 0; }
    .scale { margin: 0 auto; flex: none; position: relative; height: 100%; }
    .stage { min-width: 0; height: 100%; flex: 1; overflow: hidden; position: relative; background: color-mix(in srgb, var(--vscode-editor-background) 82%, #777); }
    .compare-stage { display: none; flex: 0 0 min(390px, 45%); border-left: 1px solid var(--vscode-panel-border); }
    body.compare .compare-stage { display: block; }
    .surface-label { position: absolute; z-index: 2; top: 8px; left: 50%; transform: translateX(-50%); padding: 3px 7px; border-radius: 10px; color: white; background: rgba(24,24,27,.78); font-size: 10px; pointer-events: none; }
    .viewport { position: absolute; inset: 0 auto auto 0; background: white; box-shadow: 0 0 0 1px rgba(127,127,127,.3); transform-origin: top left; }
    iframe { width: 100%; height: 100%; border: 0; background: white; }
    .zoom { font-size: 11px; opacity: .72; white-space: nowrap; }
    .inspector { display: none; width: 252px; flex: 0 0 252px; overflow: auto; border-left: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
    .inspector.visible { display: block; }
    .inspector-header { position: sticky; top: 0; z-index: 2; padding: 11px 12px 9px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
    .inspector-header strong { display: block; font-size: 13px; }
    .selector { margin-top: 4px; overflow: hidden; text-overflow: ellipsis; color: var(--vscode-descriptionForeground); font: 10px/1.3 var(--vscode-editor-font-family); white-space: nowrap; }
    .scope-row { display: flex; align-items: center; gap: 8px; margin-top: 9px; }
    .scope-row label { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .scope-row select { min-width: 0; flex: 1; }
    .inspector-section { padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
    .inspector-section h3 { margin: 0 0 8px; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
    .field { display: grid; grid-template-columns: 78px 1fr; align-items: center; gap: 7px; margin: 5px 0; }
    .field label { overflow: hidden; color: var(--vscode-descriptionForeground); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .field input { width: 100%; height: 25px; padding: 3px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 3px; font: 11px var(--vscode-editor-font-family); }
    .inspector-note { margin: 7px 0 0; color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.35; }
  </style>
</head>
<body>
  <div class="toolbar">
    <select id="viewport" aria-label="Viewport width">
      <option value="0">Responsive</option>
      <option value="1440">Desktop · 1440</option>
      <option value="1024">Laptop · 1024</option>
      <option value="768">Tablet · 768</option>
      <option value="390">Mobile · 390</option>
    </select>
    <span class="zoom" id="zoom">Fit · 100%</span>
    <button class="secondary" id="compare" type="button">Compare mobile</button>
    <button class="secondary" id="fold" type="button">Fold · 768</button>
    <button class="secondary" id="before" type="button" disabled>Show before</button>
    <button class="secondary" id="revert" type="button" disabled>Revert</button>
    <button id="comment" type="button" disabled title="Focus the existing Claude Code conversation. Your selected element is attached automatically.">Comment in Claude</button>
    <button class="secondary" id="clear" type="button">Clear</button>
  </div>
  <div class="crumbbar"><div class="breadcrumbs" id="breadcrumbs"><span>Click an element to inspect it</span></div><span class="status" id="status">Loading preview…</span></div>
  <div class="workbench">
    <div class="canvas-column"><div class="stage-row">
      <div class="stage" id="stage"><div class="scale" id="scaleFrame"><div class="viewport" id="viewportFrame"><iframe id="preview" sandbox="allow-scripts allow-same-origin allow-forms allow-modals"></iframe></div></div></div>
      <div class="stage compare-stage" id="compareStage"><span class="surface-label">MOBILE · 390</span><div class="scale" id="compareScaleFrame"><div class="viewport" id="compareViewportFrame"><iframe id="comparePreview" sandbox="allow-scripts allow-same-origin allow-forms allow-modals"></iframe></div></div></div>
    </div></div>
    <aside class="inspector" id="inspector">
      <div class="inspector-header"><strong id="elementName">Element</strong><div class="selector" id="selector"></div><div class="scope-row"><label for="scope">Apply to</label><select id="scope"><option value="all">All breakpoints</option><option value="desktop">Desktop ≥1024</option><option value="tablet">Tablet 768–1023</option><option value="mobile">Mobile ≤767</option></select></div></div>
      <section class="inspector-section"><h3>Layout</h3>
        <div class="field"><label>Width</label><input data-property="width"></div>
        <div class="field"><label>Max width</label><input data-property="max-width"></div>
        <div class="field"><label>Height</label><input data-property="height"></div>
        <div class="field"><label>Min height</label><input data-property="min-height"></div>
        <div class="field"><label>Margin</label><input data-property="margin"></div>
        <div class="field"><label>Padding</label><input data-property="padding"></div>
        <div class="field"><label>Gap</label><input data-property="gap"></div>
      </section>
      <section class="inspector-section"><h3>Typography</h3>
        <div class="field"><label>Font size</label><input data-property="font-size"></div>
        <div class="field"><label>Weight</label><input data-property="font-weight"></div>
        <div class="field"><label>Line height</label><input data-property="line-height"></div>
        <div class="field"><label>Tracking</label><input data-property="letter-spacing"></div>
        <div class="field"><label>Alignment</label><input data-property="text-align"></div>
      </section>
      <section class="inspector-section"><h3>Appearance</h3>
        <div class="field"><label>Text color</label><input data-property="color"></div>
        <div class="field"><label>Background</label><input data-property="background-color"></div>
        <div class="field"><label>Radius</label><input data-property="border-radius"></div>
        <div class="field"><label>Opacity</label><input data-property="opacity"></div>
        <p class="inspector-note">Press Enter or leave a field to apply. Empty a field to reset it. Every change is undoable.</p>
      </section>
    </aside>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const token = ${JSON.stringify(token)};
    const computeViewportLayout = ${computeViewportLayoutSource};
    const frame = document.getElementById('preview');
    const compareFrame = document.getElementById('comparePreview');
    const stage = document.getElementById('stage');
    const compareStage = document.getElementById('compareStage');
    const scaleFrame = document.getElementById('scaleFrame');
    const compareScaleFrame = document.getElementById('compareScaleFrame');
    const viewportFrame = document.getElementById('viewportFrame');
    const compareViewportFrame = document.getElementById('compareViewportFrame');
    const zoom = document.getElementById('zoom');
    const comment = document.getElementById('comment');
    const compare = document.getElementById('compare');
    const fold = document.getElementById('fold');
    const before = document.getElementById('before');
    const revert = document.getElementById('revert');
    const inspector = document.getElementById('inspector');
    const breadcrumbs = document.getElementById('breadcrumbs');
    const scope = document.getElementById('scope');
    const status = document.getElementById('status');
    let presetWidth = 0;
    let compareEnabled = false;
    let foldEnabled = false;
    let showingBefore = false;
    let hasSelection = false;

    function layoutViewport() {
      const layout = computeViewportLayout(presetWidth, stage.clientWidth, stage.clientHeight);
      scaleFrame.style.width = layout.renderedWidth + 'px';
      viewportFrame.style.width = layout.layoutWidth + 'px';
      viewportFrame.style.height = layout.layoutHeight + 'px';
      viewportFrame.style.transform = 'scale(' + layout.scale + ')';
      zoom.textContent = presetWidth ? presetWidth + 'px · ' + Math.round(layout.scale * 100) + '%' : 'Responsive · 100%';
    }

    function layoutCompareViewport() {
      if (!compareEnabled) return;
      const layout = computeViewportLayout(390, compareStage.clientWidth, compareStage.clientHeight);
      compareScaleFrame.style.width = layout.renderedWidth + 'px';
      compareViewportFrame.style.width = layout.layoutWidth + 'px';
      compareViewportFrame.style.height = layout.layoutHeight + 'px';
      compareViewportFrame.style.transform = 'scale(' + layout.scale + ')';
    }

    function sendToFrames(message) {
      const payload = Object.assign({ channel: 'visual-web-canvas-host', token }, message);
      frame.contentWindow?.postMessage(payload, '*');
      compareFrame.contentWindow?.postMessage(payload, '*');
    }

    function showSelection(message) {
      hasSelection = true;
      inspector.classList.toggle('visible', !showingBefore);
      document.getElementById('elementName').textContent = '<' + message.tagName + '>';
      document.getElementById('selector').textContent = message.selector;
      breadcrumbs.innerHTML = '';
      message.ancestorTrail.forEach((label, index) => {
        if (index) {
          const separator = document.createElement('span');
          separator.className = 'separator';
          separator.textContent = '›';
          breadcrumbs.append(separator);
        }
        const button = document.createElement('button');
        button.textContent = label;
        button.title = label;
        button.addEventListener('click', () => sendToFrames({ type: 'selectAncestor', depth: message.ancestorTrail.length - 1 - index }));
        breadcrumbs.append(button);
      });
      document.querySelectorAll('[data-property]').forEach((input) => {
        input.value = message.computedStyles[input.dataset.property] || '';
      });
      sendToFrames({ type: 'selectByAnchor', selector: message.selector, text: '', tagName: message.tagName });
    }

    function setBeforeMode(enabled) {
      showingBefore = enabled;
      before.textContent = enabled ? 'Show current' : 'Show before';
      before.classList.toggle('active', enabled);
      inspector.classList.toggle('visible', hasSelection && !enabled);
      document.querySelectorAll('#inspector input, #inspector select').forEach((control) => { control.disabled = enabled; });
    }

    window.addEventListener('message', (event) => {
      if (event.data?.channel !== 'visual-web-canvas' || event.data?.token !== token) return;
      vscode.postMessage(event.data);
    });
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.token && message.token !== token) return;
      if (message.type === 'refresh') { status.textContent = showingBefore ? 'Loading previous version…' : 'Refreshing…'; frame.src = message.url; compareFrame.src = message.compareUrl; }
      if (message.type === 'status') status.textContent = message.message;
      if (message.type === 'clearSelection') sendToFrames({ type: 'clearSelection' });
      if (message.type === 'captureCommentScreenshot') sendToFrames({ type: 'captureCommentScreenshot' });
      if (message.type === 'selectionAvailable') {
        comment.disabled = !message.available;
        if (!message.available) { hasSelection = false; inspector.classList.remove('visible'); breadcrumbs.innerHTML = '<span>Click an element to inspect it</span>'; }
      }
      if (message.type === 'selectionDetails') showSelection(message);
      if (message.type === 'compareState') { compareEnabled = message.enabled; document.body.classList.toggle('compare', compareEnabled); compare.classList.toggle('active', compareEnabled); layoutViewport(); layoutCompareViewport(); }
      if (message.type === 'foldState') { foldEnabled = message.enabled; fold.classList.toggle('active', foldEnabled); }
      if (message.type === 'fold') sendToFrames({ type: 'setFold', height: message.height });
      if (message.type === 'historyState') { before.disabled = !message.available; revert.disabled = !message.available; setBeforeMode(message.showingBefore); }
      if (message.type === 'viewport') { presetWidth = Number(message.width) || 0; layoutViewport(); }
    });
    frame.addEventListener('load', () => {
      if (status.textContent === 'Loading previous version…') status.textContent = 'Previous version · read only';
      else if (status.textContent === 'Refreshing…' || status.textContent === 'Loading preview…') status.textContent = 'Click an element to attach it to Claude.';
    });
    compareFrame.addEventListener('load', layoutCompareViewport);
    comment.addEventListener('click', () => vscode.postMessage({ type: 'focusClaude' }));
    compare.addEventListener('click', () => vscode.postMessage({ type: 'setCompare', enabled: !compareEnabled }));
    fold.addEventListener('click', () => vscode.postMessage({ type: 'setFold', enabled: !foldEnabled }));
    before.addEventListener('click', () => vscode.postMessage({ type: 'toggleBefore' }));
    revert.addEventListener('click', () => vscode.postMessage({ type: 'revertLast' }));
    document.getElementById('clear').addEventListener('click', () => vscode.postMessage({ type: 'clearSelection' }));
    document.getElementById('viewport').addEventListener('change', (event) => vscode.postMessage({ type: 'setViewport', width: Number(event.target.value) }));
    document.querySelectorAll('[data-property]').forEach((input) => {
      input.addEventListener('change', () => vscode.postMessage({ type: 'styleEdit', property: input.dataset.property, value: input.value, scope: scope.value }));
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur(); });
    });
    new ResizeObserver(() => { layoutViewport(); layoutCompareViewport(); }).observe(stage);
    new ResizeObserver(layoutCompareViewport).observe(compareStage);
    layoutViewport();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function cryptoNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
}
