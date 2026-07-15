import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';

interface ClaudeSettings {
  hooks?: {
    UserPromptSubmit?: Array<{
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export async function installClaudeBridge(context: vscode.ExtensionContext): Promise<{ settingsPath: string; hookPath: string }> {
  const claudeDirectory = path.join(os.homedir(), '.claude');
  const bridgeDirectory = path.join(claudeDirectory, 'visual-web-canvas');
  const hookPath = path.join(bridgeDirectory, 'user-prompt-submit.cjs');
  const settingsPath = path.join(claudeDirectory, 'settings.json');
  const bundledHook = path.join(context.extensionPath, 'resources', 'user-prompt-submit.cjs');

  await fs.mkdir(bridgeDirectory, { recursive: true, mode: 0o700 });
  await fs.copyFile(bundledHook, hookPath);
  await fs.chmod(hookPath, 0o700);

  const settings = await readSettings(settingsPath);
  settings.hooks ??= {};
  const groups = (settings.hooks.UserPromptSubmit ?? [])
    .map((group) => ({
      ...group,
      hooks: group.hooks?.filter((hook) => !hook.command?.includes('/funnel-canvas/user-prompt-submit.cjs')),
    }))
    .filter((group) => (group.hooks?.length ?? 0) > 0);
  const command = `${shellQuote(process.execPath)} ${shellQuote(hookPath)}`;
  let repaired = false;
  for (const group of groups) {
    for (const hook of group.hooks ?? []) {
      if (hook.command?.includes('visual-web-canvas/user-prompt-submit.cjs')) {
        hook.type = 'command';
        hook.command = command;
        hook.timeout = 5;
        repaired = true;
      }
    }
  }
  if (!repaired) {
    groups.push({ hooks: [{ type: 'command', command, timeout: 5 }] });
  }
  settings.hooks.UserPromptSubmit = groups;
  await writeSettings(settingsPath, settings);
  await fs.rm(path.join(claudeDirectory, 'funnel-canvas'), { recursive: true, force: true });
  return { settingsPath, hookPath };
}

export async function diagnoseClaudeBridge(): Promise<{ installed: boolean; settingsPath: string; hookPath: string; detail: string }> {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const hookPath = path.join(os.homedir(), '.claude', 'visual-web-canvas', 'user-prompt-submit.cjs');
  const [settings, hookExists] = await Promise.all([
    readSettings(settingsPath).catch(() => ({} as ClaudeSettings)),
    fs.stat(hookPath).then((stat) => stat.isFile()).catch(() => false),
  ]);
  const configured = (settings.hooks?.UserPromptSubmit ?? [])
    .some((group) => group.hooks?.some((hook) => hook.command?.includes('visual-web-canvas/user-prompt-submit.cjs')));
  return {
    installed: hookExists && configured,
    settingsPath,
    hookPath,
    detail: hookExists && configured ? 'Claude bridge is installed and configured.' : `Hook file: ${hookExists ? 'found' : 'missing'}; settings entry: ${configured ? 'found' : 'missing'}.`,
  };
}

export async function uninstallClaudeBridge(): Promise<void> {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const settings = await readSettings(settingsPath);
  const groups = settings.hooks?.UserPromptSubmit ?? [];
  const filtered = groups
    .map((group) => ({
      ...group,
      hooks: group.hooks?.filter((hook) => !hook.command?.includes('visual-web-canvas/user-prompt-submit.cjs')),
    }))
    .filter((group) => (group.hooks?.length ?? 0) > 0);
  if (settings.hooks) settings.hooks.UserPromptSubmit = filtered;
  await writeSettings(settingsPath, settings);
  await fs.rm(path.join(os.homedir(), '.claude', 'visual-web-canvas'), { recursive: true, force: true });
}

async function readSettings(target: string): Promise<ClaudeSettings> {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8')) as ClaudeSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function writeSettings(target: string, settings: ClaudeSettings): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const existing = await fs.readFile(target).catch(() => undefined);
  if (existing) {
    const timestamp = new Date().toISOString().replaceAll(':', '-');
    const backup = `${target}.visual-web-canvas-backup-${timestamp}`;
    await fs.writeFile(backup, existing, { mode: 0o600 });
  }
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600);
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
