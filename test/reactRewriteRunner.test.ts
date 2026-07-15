import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('packaged React Rewrite runner', () => {
  let upstream: Server | undefined;
  let child: ChildProcess | undefined;

  afterEach(async () => {
    child?.kill('SIGTERM');
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => child?.once('exit', () => resolve()));
    }
    if (upstream) await new Promise<void>((resolve) => upstream?.close(() => resolve()));
  });

  it('starts without a framework config and injects the source editor', async () => {
    upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body><main>Demo</main></body></html>');
    });
    await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', () => resolve()));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Expected an IP server address.');

    child = spawn(process.execPath, [path.resolve('resources/react-rewrite-runner.mjs'), String(address.port), '127.0.0.1'], {
      cwd: path.resolve('.'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = await waitForOutput(child, /Proxy:\s+http:\/\/127\.0\.0\.1:(\d+)/);
    const proxyPort = Number(/Proxy:\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1]);
    const response = await fetch(`http://127.0.0.1:${proxyPort}`, { headers: { accept: 'text/html' } });
    const html = await response.text();

    expect(response.ok).toBe(true);
    expect(html).toContain('/__react-rewrite/overlay.js');
    expect(html).toContain('window.__REACT_REWRITE_WS_PORT__');
  }, 15_000);
});

function waitForOutput(process: ChildProcess, pattern: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for runner output:\n${output}`)), 10_000);
    const inspect = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (!pattern.test(output)) return;
      clearTimeout(timer);
      resolve(output);
    };
    process.stdout?.on('data', inspect);
    process.stderr?.on('data', inspect);
    process.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    process.once('exit', (code) => {
      if (pattern.test(output)) return;
      clearTimeout(timer);
      reject(new Error(`Runner exited with ${code}:\n${output}`));
    });
  });
}
