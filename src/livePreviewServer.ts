import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import httpProxy from 'http-proxy';

export interface LivePreviewOptions {
  targetUrl: string;
  runtimePath: string;
  rewriteWebSocketPort?: number;
}

/**
 * A loopback-only reverse proxy for live dev servers. Keeping the target behind
 * one origin makes Vite/Next asset paths and HMR work inside a VS Code webview,
 * including through Remote SSH port forwarding.
 */
export class LivePreviewServer {
  readonly token = randomBytes(24).toString('hex');
  private readonly target: URL;
  private readonly proxy: httpProxy;
  private readonly rewriteProxy: httpProxy;
  private readonly server;
  private port = 0;

  constructor(private readonly options: LivePreviewOptions) {
    this.target = validateLoopbackTarget(options.targetUrl);
    this.proxy = httpProxy.createProxyServer({
      target: this.target.origin,
      changeOrigin: true,
      ws: true,
      selfHandleResponse: true,
    });
    this.rewriteProxy = httpProxy.createProxyServer({ ws: true });
    this.server = createServer((request, response) => void this.handle(request, response));
    this.proxy.on('proxyRes', (proxyResponse, _request, response) => this.handleProxyResponse(proxyResponse, response as ServerResponse));
    this.proxy.on('error', (error, _request, response) => {
      if (response && 'writeHead' in response) send(response as ServerResponse, 502, 'text/plain', `Dev server unavailable: ${error.message}`);
    });
    this.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/__visual_web_canvas_rewrite_ws' && this.options.rewriteWebSocketPort) {
        request.url = '/';
        this.rewriteProxy.ws(request, socket, head, {
          target: `ws://127.0.0.1:${this.options.rewriteWebSocketPort}`,
        });
        return;
      }
      this.proxy.ws(request, socket, head, { target: this.target.origin });
    });
  }

  async start(): Promise<void> {
    if (this.port) return;
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        const address = this.server.address();
        if (!address || typeof address === 'string') return reject(new Error('Could not determine live canvas port.'));
        this.port = address.port;
        resolve();
      });
    });
  }

  get url(): string {
    if (!this.port) throw new Error('Live canvas server has not started.');
    return `http://127.0.0.1:${this.port}${this.target.pathname}${this.target.search}`;
  }

  async dispose(): Promise<void> {
    this.proxy.close();
    this.rewriteProxy.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${this.port}`);
    if (url.pathname === '/__visual_web_canvas_live_runtime.js') {
      if (url.searchParams.get('token') !== this.token) return send(response, 403, 'text/plain', 'Invalid canvas token');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      createReadStream(this.options.runtimePath).on('error', (error) => response.destroy(error)).pipe(response);
      return;
    }
    if (url.pathname === '/__visual_web_canvas_ws_patch.js') {
      if (url.searchParams.get('token') !== this.token) return send(response, 403, 'text/plain', 'Invalid canvas token');
      return send(response, 200, 'text/javascript; charset=utf-8', websocketPatchScript(this.options.rewriteWebSocketPort));
    }

    if (request.headers.accept?.includes('text/html')) {
      request.headers['accept-encoding'] = 'identity';
      delete request.headers['if-none-match'];
      delete request.headers['if-modified-since'];
    }
    this.proxy.web(request, response, { target: this.target.origin });
  }

  private handleProxyResponse(proxyResponse: IncomingMessage, target: ServerResponse): void {
    const contentType = String(proxyResponse.headers['content-type'] ?? '');
    if (!contentType.includes('text/html')) {
      target.writeHead(proxyResponse.statusCode ?? 200, proxyResponse.headers);
      proxyResponse.pipe(target);
      return;
    }

    const chunks: Buffer[] = [];
    proxyResponse.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    proxyResponse.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf8');
      const runtime = `<script src="/__visual_web_canvas_live_runtime.js?token=${this.token}" data-visual-web-canvas-runtime></script>`;
      const wsPatch = this.options.rewriteWebSocketPort
        ? `<script src="/__visual_web_canvas_ws_patch.js?token=${this.token}"></script>`
        : '';
      if (wsPatch && body.includes('<script src="/__react-rewrite/overlay.js"')) {
        body = body.replace('<script src="/__react-rewrite/overlay.js"', `${wsPatch}\n<script src="/__react-rewrite/overlay.js"`);
      }
      body = body.includes('</body>') ? body.replace('</body>', `${runtime}\n</body>`) : `${body}${runtime}`;
      const headers = { ...proxyResponse.headers };
      delete headers['content-encoding'];
      delete headers['content-length'];
      delete headers['transfer-encoding'];
      delete headers['content-security-policy'];
      headers['content-length'] = String(Buffer.byteLength(body));
      headers['cache-control'] = 'no-store';
      headers['x-content-type-options'] = 'nosniff';
      target.writeHead(proxyResponse.statusCode ?? 200, headers);
      target.end(body);
    });
  }
}

export function validateLoopbackTarget(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only HTTP(S) dev servers are supported.');
  const hostname = url.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error('For safety, live canvases connect to loopback dev servers only.');
  }
  return url;
}

function websocketPatchScript(port: number | undefined): string {
  if (!port) return '';
  return `(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(Target, args) {
        const value = String(args[0] ?? '');
        if (value === 'ws://localhost:${port}' || value === 'ws://127.0.0.1:${port}') {
          const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          args[0] = protocol + '//' + location.host + '/__visual_web_canvas_rewrite_ws';
        }
        return new Target(...args);
      }
    });
  })();`;
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.setHeader('Content-Type', type);
  response.end(body);
}
