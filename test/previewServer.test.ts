import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PreviewServer } from '../src/previewServer.js';

const servers: PreviewServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()));
});

describe('PreviewServer', () => {
  it('serves the unsaved document buffer and workspace-local assets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-web-canvas-preview-'));
    const htmlPath = path.join(root, 'page.html');
    const runtimePath = path.join(root, 'runtime.js');
    await fs.writeFile(htmlPath, '<html><body>disk</body></html>');
    await fs.writeFile(path.join(root, 'asset.css'), 'body{color:red}');
    await fs.writeFile(runtimePath, 'window.__canvas = true;');
    const document = {
      version: 7,
      uri: { fsPath: htmlPath },
      getText: () => '<html><head><link rel="stylesheet" href="asset.css"></head><body>buffer</body></html>',
    };
    const server = new PreviewServer(runtimePath);
    servers.push(server);
    await server.start();
    const token = server.register(document as never, root);
    const url = server.previewUrl(token);

    const response = await fetch(url);
    expect(response.status).toBe(200);
    const previewHtml = await response.text();
    expect(previewHtml).toContain('<!--visual-web-canvas-text:t1-->buffer');
    expect(previewHtml).toContain('./__visual_web_canvas_runtime.js?token=');

    const runtime = await fetch(new URL('__visual_web_canvas_runtime.js', url));
    expect(runtime.status).toBe(200);
    expect(await runtime.text()).toContain('window.__canvas = true;');

    const asset = await fetch(new URL('asset.css', url));
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('body{color:red}');
  });

  it('rejects assets outside the workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-web-canvas-root-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-web-canvas-outside-'));
    const htmlPath = path.join(root, 'page.html');
    const runtimePath = path.join(root, 'runtime.js');
    await fs.writeFile(runtimePath, '');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    const server = new PreviewServer(runtimePath);
    servers.push(server);
    await server.start();
    const token = server.register({ version: 1, uri: { fsPath: htmlPath }, getText: () => '<html></html>' } as never, root);

    const response = await fetch(new URL(`../${path.basename(outside)}/secret.txt`, server.previewUrl(token)));
    expect([403, 404]).toContain(response.status);
  });

  it('serves a read-only alternate document without replacing the live source map', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-web-canvas-history-'));
    const htmlPath = path.join(root, 'page.html');
    const runtimePath = path.join(root, 'runtime.js');
    await fs.writeFile(runtimePath, '');
    const document = { version: 2, uri: { fsPath: htmlPath }, getText: () => '<h1>After</h1>' };
    const server = new PreviewServer(runtimePath);
    servers.push(server);
    await server.start();
    const token = server.register(document as never, root);
    await fetch(server.previewUrl(token));
    server.setAlternateText(token, '<h1>Before</h1>');

    const before = await fetch(server.previewUrl(token, { mode: 'before' }));
    expect(await before.text()).toContain('Before');
    expect([...server.getSession(token)!.latest!.elements.values()].find((element) => element.tagName === 'h1')?.sourceHtml).toContain('After');
  });
});
