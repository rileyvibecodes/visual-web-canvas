import { createReadStream, promises as fs } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type * as vscode from 'vscode';
import { instrumentHtml, type InstrumentedDocument } from './sourceMap.js';

interface PreviewSession {
  token: string;
  document: vscode.TextDocument;
  workspaceRoot: string;
  latest?: InstrumentedDocument;
  alternateText?: string;
}

export interface PreviewLocation {
  selected?: string;
  selectedSelector?: string;
  selectedText?: string;
  selectedTag?: string;
  scrollX?: number;
  scrollY?: number;
  viewportWidth?: number;
  foldHeight?: number;
  surface?: 'primary' | 'compare';
  mode?: 'current' | 'before';
}

export class PreviewServer {
  private readonly sessions = new Map<string, PreviewSession>();
  private readonly server = createServer((request, response) => void this.handle(request, response));
  private port = 0;

  constructor(private readonly runtimePath: string) {}

  async start(): Promise<void> {
    if (this.port) return;
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        const address = this.server.address();
        if (!address || typeof address === 'string') return reject(new Error('Could not determine preview server port.'));
        this.port = address.port;
        resolve();
      });
    });
  }

  register(document: vscode.TextDocument, workspaceRoot: string): string {
    const token = randomBytes(24).toString('hex');
    this.sessions.set(token, { token, document, workspaceRoot });
    return token;
  }

  unregister(token: string): void {
    this.sessions.delete(token);
  }

  getSession(token: string): PreviewSession | undefined {
    return this.sessions.get(token);
  }

  setAlternateText(token: string, text: string | undefined): void {
    this.requireSession(token).alternateText = text;
  }

  previewUrl(token: string, location: PreviewLocation = {}): string {
    const session = this.requireSession(token);
    const query = new URLSearchParams({
      token,
      documentVersion: String(session.document.version),
      cacheBust: `${session.document.version}-${Date.now()}`,
    });
    if (location.selected) query.set('selected', location.selected);
    if (location.selectedSelector) query.set('selectedSelector', location.selectedSelector);
    if (location.selectedText) query.set('selectedText', location.selectedText.slice(0, 240));
    if (location.selectedTag) query.set('selectedTag', location.selectedTag);
    if (location.scrollX) query.set('scrollX', String(location.scrollX));
    if (location.scrollY) query.set('scrollY', String(location.scrollY));
    if (location.viewportWidth) query.set('viewportWidth', String(location.viewportWidth));
    if (location.foldHeight) query.set('foldHeight', String(location.foldHeight));
    if (location.surface) query.set('surface', location.surface);
    if (location.mode && location.mode !== 'current') query.set('mode', location.mode);
    return `http://127.0.0.1:${this.port}/preview/${token}/?${query}`;
  }

  async dispose(): Promise<void> {
    this.sessions.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${this.port}`);
      const runtimeMatch = /^\/runtime\/([a-f0-9]+)\.js$/.exec(url.pathname);
      if (runtimeMatch?.[1]) return await this.serveRuntime(runtimeMatch[1], response);

      const previewMatch = /^\/preview\/([a-f0-9]+)\/(.*)$/.exec(url.pathname);
      if (!previewMatch?.[1]) return send(response, 404, 'text/plain; charset=utf-8', 'Not found');
      const session = this.sessions.get(previewMatch[1]);
      if (!session) return send(response, 404, 'text/plain; charset=utf-8', 'Unknown preview session');

      const relativePath = decodeURIComponent(previewMatch[2] ?? '');
      if (!relativePath) return this.serveDocument(session, url, response);
      if (relativePath === '__visual_web_canvas_runtime.js') return await this.serveRuntime(session.token, response);
      return await this.serveAsset(session, relativePath, response);
    } catch (error) {
      send(response, 500, 'text/plain; charset=utf-8', error instanceof Error ? error.message : String(error));
    }
  }

  private serveDocument(session: PreviewSession, url: URL, response: ServerResponse): void {
    const runtimeUrl = `./__visual_web_canvas_runtime.js?token=${session.token}`;
    const before = url.searchParams.get('mode') === 'before';
    const instrumented = instrumentHtml(before ? session.alternateText ?? session.document.getText() : session.document.getText(), runtimeUrl);
    if (!before) session.latest = instrumented;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self' data: blob: http: https:; script-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; style-src 'self' 'unsafe-inline' http: https:; font-src 'self' data: http: https:; img-src 'self' data: blob: http: https:; media-src 'self' blob: http: https:",
    );
    send(response, 200, 'text/html; charset=utf-8', instrumented.html);
  }

  private async serveRuntime(token: string, response: ServerResponse): Promise<void> {
    if (!this.sessions.has(token)) return send(response, 404, 'text/plain; charset=utf-8', 'Unknown preview session');
    response.setHeader('Cache-Control', 'public, max-age=3600');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    createReadStream(this.runtimePath).on('error', (error) => {
      if (!response.headersSent) send(response, 500, 'text/plain; charset=utf-8', error.message);
      else response.destroy(error);
    }).pipe(response);
  }

  private async serveAsset(session: PreviewSession, relativePath: string, response: ServerResponse): Promise<void> {
    if (relativePath.includes('\0')) return send(response, 400, 'text/plain; charset=utf-8', 'Invalid path');
    const root = path.resolve(session.workspaceRoot);
    const documentDirectory = path.dirname(session.document.uri.fsPath);
    const candidate = path.resolve(documentDirectory, relativePath);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      return send(response, 403, 'text/plain; charset=utf-8', 'Asset is outside the workspace');
    }

    const stat = await fs.stat(candidate).catch(() => undefined);
    if (!stat?.isFile()) return send(response, 404, 'text/plain; charset=utf-8', 'Asset not found');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Type', contentType(candidate));
    createReadStream(candidate).pipe(response);
  }

  private requireSession(token: string): PreviewSession {
    const session = this.sessions.get(token);
    if (!session) throw new Error('Unknown preview session.');
    return session;
  }
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.setHeader('Content-Type', type);
  response.end(body);
}

function contentType(file: string): string {
  const extension = path.extname(file).toLowerCase();
  return ({
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.mp4': 'video/mp4',
  } as Record<string, string>)[extension] ?? 'application/octet-stream';
}
