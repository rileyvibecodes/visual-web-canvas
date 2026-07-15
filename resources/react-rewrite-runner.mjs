#!/usr/bin/env node
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const targetPort = Number(process.argv[2]);
const targetHost = process.argv[3] || '127.0.0.1';
if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
  process.stderr.write('Invalid target port.\n');
  process.exit(1);
}

// React Rewrite 0.1.x listens on every interface by default. This child process
// forces its internal HTTP and WebSocket servers onto loopback before they start.
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function loopbackListen(...args) {
  if (typeof args[0] === 'number' && (typeof args[1] === 'function' || args[1] === undefined)) {
    args.splice(1, 0, '127.0.0.1');
  } else if (typeof args[0] === 'object' && args[0] !== null && !args[0].host) {
    args[0] = { ...args[0], host: '127.0.0.1' };
  }
  return originalListen.apply(this, args);
};

// React Rewrite 0.1.x copies an upstream Transfer-Encoding header and then adds
// Content-Length after HTML injection. Strict HTTP clients reject that pair.
const originalWriteHead = http.ServerResponse.prototype.writeHead;
http.ServerResponse.prototype.writeHead = function validWriteHead(...args) {
  const headers = [...args].reverse().find((value) => value && typeof value === 'object' && !Array.isArray(value));
  if (headers) {
    const contentLengthKey = Object.keys(headers).find((key) => key.toLowerCase() === 'content-length');
    const transferEncodingKey = Object.keys(headers).find((key) => key.toLowerCase() === 'transfer-encoding');
    if (contentLengthKey && transferEncodingKey) delete headers[transferEncodingKey];
  }
  return originalWriteHead.apply(this, args);
};

try {
  const require = createRequire(import.meta.url);
  const packageRoot = path.dirname(require.resolve('react-rewrite-cli/package.json'));
  const load = (name) => import(pathToFileURL(path.join(packageRoot, 'dist', name)).href);
  const [{ createProxyServer }, { createSketchServer }, { healthCheck }, { getAvailablePort }] = await Promise.all([
    load('inject.js'),
    load('server.js'),
    load('detect.js'),
    load('utils.js'),
  ]);

  await healthCheck(targetPort, targetHost);
  const websocketPort = await getAvailablePort(3457);
  const sketchServer = createSketchServer({ port: websocketPort });
  const proxyPort = await getAvailablePort(3456);
  const proxyServer = createProxyServer({
    targetPort,
    targetHost,
    proxyPort,
    wsPort: websocketPort,
    getActiveClient: sketchServer.getActiveClient,
  });

  proxyServer.listen(proxyPort, '127.0.0.1', () => {
    process.stdout.write(`Proxy: http://127.0.0.1:${proxyPort}\n`);
    process.stdout.write(`WebSocket: ws://127.0.0.1:${websocketPort}\n`);
  });

  const close = () => {
    proxyServer.close();
    sketchServer.close();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
