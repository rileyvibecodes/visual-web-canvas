import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const hookPath = path.resolve('resources/user-prompt-submit.cjs');

describe('Claude UserPromptSubmit bridge', () => {
  it('injects a fresh matching selection into the current prompt', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-web-canvas-home-'));
    const workspace = path.join(home, 'workspace');
    const documentPath = path.join(workspace, 'page.html');
    const contents = '<h1>Hello</h1>';
    await fs.mkdir(path.join(home, '.visual-web-canvas', 'state'), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(documentPath, contents);
    await fs.writeFile(path.join(home, '.visual-web-canvas', 'state', 'selection.json'), JSON.stringify({
      schemaVersion: 2,
      mode: 'static',
      workspaceRoot: workspace,
      documentPath,
      documentVersion: 1,
      documentHash: createHash('sha256').update(contents).digest('hex'),
      documentDirty: false,
      selectedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      element: {
        sourceRange: { startOffset: 0, endOffset: 14, startLine: 1, startColumn: 1, endLine: 1, endColumn: 15 },
        sourceHtml: contents,
        renderedHtml: contents,
        selector: 'h1',
        ancestorTrail: ['body', 'h1'],
        attributes: {},
        computedStyles: { 'font-size': '32px' },
        bounds: { x: 10, y: 20, width: 300, height: 40 },
      },
      viewport: { width: 1440, height: 900, devicePixelRatio: 2, scrollX: 0, scrollY: 0 },
      screenshots: {},
    }));

    const output = execFileSync(process.execPath, [hookPath], {
      input: JSON.stringify({ cwd: workspace, prompt: 'Make this smaller' }),
      env: homeEnvironment(home),
      encoding: 'utf8',
    });
    const parsed = JSON.parse(output);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('File: page.html');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('<h1>Hello</h1>');
  });

  it('emits no context for stale selection state', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-web-canvas-stale-'));
    const directory = path.join(home, '.visual-web-canvas', 'state');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'selection.json'), JSON.stringify({
      schemaVersion: 2,
      mode: 'static',
      workspaceRoot: home,
      documentPath: path.join(home, 'page.html'),
      heartbeatAt: '2020-01-01T00:00:00.000Z',
      element: {},
      viewport: {},
    }));
    const output = execFileSync(process.execPath, [hookPath], {
      input: JSON.stringify({ cwd: home }),
      env: homeEnvironment(home),
      encoding: 'utf8',
    });
    expect(output).toBe('');
  });

  it('formats live React context, accessibility, comment, and screenshot', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-web-canvas-live-hook-'));
    const workspace = path.join(home, 'workspace');
    const directory = path.join(home, '.visual-web-canvas', 'state');
    await fs.mkdir(directory, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(directory, 'live.json'), JSON.stringify({
      schemaVersion: 2,
      mode: 'live',
      workspaceRoot: workspace,
      liveUrl: 'http://localhost:3000',
      selectedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      element: {
        sourceHtml: '[<button>Buy now</button> in Hero]',
        renderedHtml: '<button>Buy now</button>',
        selector: 'main > button',
        ancestorTrail: ['body', 'main', 'button'],
        attributes: { class: 'primary' },
        computedStyles: { color: 'white' },
        bounds: { x: 10, y: 20, width: 140, height: 48 },
      },
      accessibility: { role: 'button', name: 'Buy now' },
      react: { componentName: 'Hero', filePath: 'src/Hero.tsx', lineNumber: 12, columnNumber: 4, stack: 'Hero > Page', snippet: '<button>Buy now</button>' },
      comment: { id: 'abc', text: 'Make this the primary conversion action', createdAt: new Date().toISOString() },
      viewport: { width: 1440, height: 900, devicePixelRatio: 2, scrollX: 0, scrollY: 0 },
      screenshots: { element: path.join(home, 'comment.png') },
    }));
    const output = execFileSync(process.execPath, [hookPath], {
      input: JSON.stringify({ cwd: workspace, prompt: 'do this' }),
      env: homeEnvironment(home),
      encoding: 'utf8',
    });
    const context = JSON.parse(output).hookSpecificOutput.additionalContext;
    expect(context).toContain('React component: Hero');
    expect(context).toContain('Accessibility: role=button name="Buy now"');
    expect(context).toContain('Visual comment: Make this the primary conversion action');
    expect(context).toContain('comment.png');
  });
});

function homeEnvironment(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home };
}
