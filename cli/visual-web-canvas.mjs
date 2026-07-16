#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8')).version;
const extensionId = 'rileyvibecodes.visual-web-canvas';
const releaseVsixUrl = `https://github.com/rileyvibecodes/visual-web-canvas/releases/download/v${packageVersion}/visual-web-canvas-${packageVersion}.vsix`;
const command = process.argv[2] || 'help';
let vsixDownload;

if (command === 'install') await install(process.argv.slice(3));
else if (command === 'doctor') await doctor();
else if (command === 'uninstall') await uninstall(process.argv.slice(3));
else if (command === 'mcp') await runMcp();
else printHelp();

async function install(args) {
  const cursor = args.includes('--cursor') || args.includes('--all');
  const vscode = !args.includes('--cursor') || args.includes('--all');
  const results = [];
  if (vscode) results.push(await installEditor('code', 'VS Code'));
  if (cursor) results.push(await installEditor('cursor', 'Cursor'));
  const bridge = await installClaudeBridge();
  if (cursor) await installCursorMcp();
  await removeDownloadedVsix();
  for (const result of results) process.stdout.write(`${result}\n`);
  process.stdout.write(`Claude bridge installed: ${bridge}\n`);
  if (cursor) process.stdout.write('Cursor MCP installed (beta). Restart Cursor before testing it.\n');
  process.stdout.write('Run visual-web-canvas doctor to verify the complete setup.\n');
}

async function installEditor(binary, label) {
  const check = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (check.error) return `${label}: CLI not found; install from the Marketplace or GitHub VSIX.`;
  const marketplace = spawnSync(binary, ['--install-extension', extensionId, '--force'], { encoding: 'utf8' });
  if (marketplace.status === 0) return `${label}: extension installed.`;
  let vsix;
  try {
    vsix = await downloadReleaseVsix();
  } catch (error) {
    return `${label}: Marketplace install unavailable and the release download failed (${error instanceof Error ? error.message : String(error)}). Download the VSIX from ${releaseVsixUrl} and run ${binary} --install-extension <file>.`;
  }
  const file = spawnSync(binary, ['--install-extension', vsix, '--force'], { encoding: 'utf8' });
  if (file.status !== 0) return `${label}: VSIX install failed (${(file.stderr || file.stdout).trim()}).`;
  return `${label}: extension ${packageVersion} installed from the GitHub release.`;
}

function downloadReleaseVsix() {
  vsixDownload ||= (async () => {
    const response = await fetch(releaseVsixUrl, { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${releaseVsixUrl}`);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-web-canvas-'));
    const target = path.join(directory, `visual-web-canvas-${packageVersion}.vsix`);
    await fs.writeFile(target, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
    return target;
  })();
  return vsixDownload;
}

async function removeDownloadedVsix() {
  if (!vsixDownload) return;
  const target = await vsixDownload.catch(() => undefined);
  if (target) await fs.rm(path.dirname(target), { recursive: true, force: true });
}

async function installClaudeBridge() {
  const claudeDirectory = path.join(os.homedir(), '.claude');
  const bridgeDirectory = path.join(claudeDirectory, 'visual-web-canvas');
  const hookPath = path.join(bridgeDirectory, 'user-prompt-submit.cjs');
  const settingsPath = path.join(claudeDirectory, 'settings.json');
  await fs.mkdir(bridgeDirectory, { recursive: true, mode: 0o700 });
  await fs.copyFile(path.join(packageRoot, 'resources', 'user-prompt-submit.cjs'), hookPath);
  await fs.chmod(hookPath, 0o700);
  const settings = await readJson(settingsPath, {});
  settings.hooks ||= {};
  settings.hooks.UserPromptSubmit = (settings.hooks.UserPromptSubmit || [])
    .map((group) => ({
      ...group,
      hooks: group.hooks?.filter((hook) => !String(hook.command || '').includes('/funnel-canvas/user-prompt-submit.cjs')),
    }))
    .filter((group) => group.hooks?.length);
  const command = `${shellQuote(process.execPath)} ${shellQuote(hookPath)}`;
  let repaired = false;
  for (const group of settings.hooks.UserPromptSubmit) {
    for (const hook of group.hooks || []) {
      if (String(hook.command || '').includes('visual-web-canvas/user-prompt-submit.cjs')) {
        hook.type = 'command';
        hook.command = command;
        hook.timeout = 5;
        repaired = true;
      }
    }
  }
  if (!repaired) {
    settings.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command, timeout: 5 }] });
  }
  await writeJson(settingsPath, settings, true);
  await fs.rm(path.join(claudeDirectory, 'funnel-canvas'), { recursive: true, force: true });
  return hookPath;
}

async function installCursorMcp() {
  const target = path.join(os.homedir(), '.cursor', 'mcp.json');
  const config = await readJson(target, {});
  config.mcpServers ||= {};
  config.mcpServers['visual-web-canvas'] = {
    command: 'npx',
    args: ['--yes', 'visual-web-canvas@latest', 'mcp'],
  };
  await writeJson(target, config, true);
}

async function doctor() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const settings = await readJson(settingsPath, {});
  const hookPath = path.join(os.homedir(), '.claude', 'visual-web-canvas', 'user-prompt-submit.cjs');
  const hookExists = await exists(hookPath);
  const configured = (settings.hooks?.UserPromptSubmit || []).some((group) => group.hooks?.some((hook) => String(hook.command || '').includes('visual-web-canvas/user-prompt-submit.cjs')));
  const states = await stateFiles();
  const checks = [
    ['Node', process.version],
    ['VS Code CLI', binaryVersion('code')],
    ['Cursor CLI', binaryVersion('cursor')],
    ['Claude hook file', hookExists ? 'ok' : 'missing'],
    ['Claude settings entry', configured ? 'ok' : 'missing'],
    ['Active canvas states', String(states.length)],
  ];
  for (const [name, value] of checks) process.stdout.write(`${name.padEnd(24)} ${value}\n`);
  process.exitCode = hookExists && configured ? 0 : 1;
}

async function uninstall(args) {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const settings = await readJson(settingsPath, {});
  if (settings.hooks?.UserPromptSubmit) {
    settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit
      .map((group) => ({ ...group, hooks: group.hooks?.filter((hook) => !String(hook.command || '').includes('visual-web-canvas/user-prompt-submit.cjs')) }))
      .filter((group) => group.hooks?.length);
    await writeJson(settingsPath, settings, true);
  }
  const cursorPath = path.join(os.homedir(), '.cursor', 'mcp.json');
  const cursor = await readJson(cursorPath, {});
  if (cursor.mcpServers?.['visual-web-canvas']) {
    delete cursor.mcpServers['visual-web-canvas'];
    await writeJson(cursorPath, cursor, true);
  }
  await fs.rm(path.join(os.homedir(), '.claude', 'visual-web-canvas'), { recursive: true, force: true });
  await fs.rm(path.join(os.homedir(), '.visual-web-canvas'), { recursive: true, force: true });
  if (!args.includes('--keep-extension')) {
    spawnSync('code', ['--uninstall-extension', extensionId], { stdio: 'ignore' });
    if (args.includes('--cursor') || args.includes('--all')) spawnSync('cursor', ['--uninstall-extension', extensionId], { stdio: 'ignore' });
  }
  process.stdout.write('Visual Web Canvas bridge, MCP configuration, and local state removed.\n');
}

async function runMcp() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.method?.startsWith('notifications/')) continue;
    try {
      const result = await handleMcp(request);
      if (request.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    } catch (error) {
      if (request.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })}\n`);
    }
  }
}

async function handleMcp(request) {
  if (request.method === 'initialize') return { protocolVersion: request.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'visual-web-canvas', version: packageVersion } };
  if (request.method === 'tools/list') return { tools: [
    { name: 'get_current_selection', description: 'Get the latest element selected in Visual Web Canvas. Call this when the user says this element, this section, or this page.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_pending_comments', description: 'Get the visual comment attached to the current selection.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_screenshot', description: 'Get the cropped screenshot for the current visual comment.', inputSchema: { type: 'object', properties: {} } },
    { name: 'mark_comment_resolved', description: 'Remove the pending visual comment after implementing it.', inputSchema: { type: 'object', properties: {} } },
  ] };
  if (request.method !== 'tools/call') return {};
  const state = await latestState();
  if (!state) return textResult('No active Visual Web Canvas selection.');
  if (request.params?.name === 'get_current_selection') return textResult(JSON.stringify(state, null, 2));
  if (request.params?.name === 'get_pending_comments') return textResult(state.comment ? JSON.stringify(state.comment, null, 2) : 'No pending visual comment.');
  if (request.params?.name === 'get_screenshot') {
    const imagePath = state.screenshots?.element || state.screenshots?.viewport;
    if (!imagePath) return textResult('No screenshot is attached to the current selection.');
    const data = await fs.readFile(imagePath);
    return { content: [{ type: 'image', data: data.toString('base64'), mimeType: 'image/png' }] };
  }
  if (request.params?.name === 'mark_comment_resolved') {
    delete state.comment;
    await writeJson(state.__file, withoutInternal(state), false);
    return textResult('Visual comment marked resolved.');
  }
  throw new Error(`Unknown tool: ${request.params?.name}`);
}

async function latestState() {
  const files = await stateFiles();
  const states = [];
  for (const file of files) {
    try { states.push({ ...(JSON.parse(await fs.readFile(file, 'utf8'))), __file: file }); } catch {}
  }
  return states.sort((a, b) => Date.parse(b.heartbeatAt || 0) - Date.parse(a.heartbeatAt || 0))[0];
}

async function stateFiles() {
  const directory = path.join(os.homedir(), '.visual-web-canvas', 'state');
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => path.join(directory, entry.name));
}

function withoutInternal(value) {
  const copy = { ...value };
  delete copy.__file;
  return copy;
}

function textResult(text) { return { content: [{ type: 'text', text }] }; }
function binaryVersion(binary) { const result = spawnSync(binary, ['--version'], { encoding: 'utf8' }); return result.error ? 'not found' : (result.stdout.split(/\r?\n/)[0] || 'found'); }
async function exists(file) { return fs.stat(file).then((stat) => stat.isFile()).catch(() => false); }
async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return structuredClone(fallback); } }

async function writeJson(file, value, backup) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (backup && await exists(file)) {
    const suffix = new Date().toISOString().replaceAll(':', '-');
    await fs.copyFile(file, `${file}.visual-web-canvas-backup-${suffix}`);
  }
  const temp = `${file}.${process.pid}.${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 6)}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600);
}

function shellQuote(value) { return process.platform === 'win32' ? `"${value.replaceAll('"', '\\"')}"` : `'${value.replaceAll("'", "'\\''")}'`; }
function printHelp() { process.stdout.write(`Visual Web Canvas\n\n  visual-web-canvas install [--cursor|--all]\n  visual-web-canvas doctor\n  visual-web-canvas uninstall [--cursor|--all|--keep-extension]\n  visual-web-canvas mcp\n`); }
