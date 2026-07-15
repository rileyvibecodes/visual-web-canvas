import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LivePreviewServer, validateLoopbackTarget } from '../src/livePreviewServer.js';

const disposables: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(disposables.splice(0).map((dispose) => dispose())));

describe('LivePreviewServer', () => {
  it('injects the tokenized runtime and proxies assets', async () => {
    const upstream = createServer((request, response) => {
      if (request.url === '/asset.js') {
        response.setHeader('Content-Type', 'text/javascript');
        return response.end('window.demo = true;');
      }
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><body><main>Live app</main><script src="/asset.js"></script></body></html>');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    disposables.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('No upstream port');

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-web-canvas-live-'));
    const runtimePath = path.join(directory, 'runtime.js');
    await fs.writeFile(runtimePath, 'window.canvasRuntime = true;');
    const proxy = new LivePreviewServer({ targetUrl: `http://127.0.0.1:${address.port}`, runtimePath });
    await proxy.start();
    disposables.push(() => proxy.dispose());

    const html = await fetch(proxy.url).then((response) => response.text());
    expect(html).toContain('Live app');
    expect(html).toContain(`/__visual_web_canvas_live_runtime.js?token=${proxy.token}`);
    const asset = await fetch(new URL('/asset.js', proxy.url)).then((response) => response.text());
    expect(asset).toContain('window.demo');
    const runtime = await fetch(new URL(`/__visual_web_canvas_live_runtime.js?token=${proxy.token}`, proxy.url)).then((response) => response.text());
    expect(runtime).toContain('canvasRuntime');
  });

  it('rejects non-loopback targets', () => {
    expect(() => validateLoopbackTarget('https://example.com')).toThrow(/loopback/);
  });
});
