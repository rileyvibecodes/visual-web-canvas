import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const SELECTION_SCHEMA_VERSION = 2;

export interface CanvasSelectionState {
  schemaVersion: number;
  mode: 'static' | 'live';
  workspaceRoot: string;
  documentPath?: string;
  documentVersion?: number;
  documentHash?: string;
  documentDirty?: boolean;
  liveUrl?: string;
  selectedAt: string;
  heartbeatAt: string;
  element: {
    id: string;
    tagName: string;
    sourceRange?: {
      startOffset: number;
      endOffset: number;
      startLine: number;
      startColumn: number;
      endLine: number;
      endColumn: number;
    };
    sourceHtml: string;
    renderedHtml: string;
    text: string;
    selector: string;
    ancestorTrail: string[];
    attributes: Record<string, string>;
    computedStyles: Record<string, string>;
    bounds: { x: number; y: number; width: number; height: number };
  };
  accessibility?: { role: string; name: string };
  react?: {
    componentName: string | null;
    filePath: string | null;
    lineNumber: number | null;
    columnNumber: number | null;
    stack: string;
    snippet: string;
  };
  comment?: {
    id: string;
    text: string;
    createdAt: string;
  };
  viewport: { width: number; height: number; devicePixelRatio: number; scrollX: number; scrollY: number };
  screenshots: { element?: string; viewport?: string };
}

export function selectionDirectory(): string {
  return path.join(os.homedir(), '.visual-web-canvas', 'state');
}

export function workspaceKey(workspaceRoot: string): string {
  return createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 20);
}

export function hashDocument(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

export class SelectionStateStore {
  private current?: CanvasSelectionState;

  constructor(readonly workspaceRoot: string, private readonly ownerKey = '') {}

  get key(): string {
    return workspaceKey(this.workspaceRoot);
  }

  get statePath(): string {
    const suffix = this.ownerKey ? `-${this.ownerKey}` : '';
    return path.join(selectionDirectory(), `${this.key}${suffix}.json`);
  }

  get screenshotDirectory(): string {
    return path.join(os.homedir(), '.visual-web-canvas', 'screenshots', `${this.key}${this.ownerKey ? `-${this.ownerKey}` : ''}`);
  }

  async set(state: CanvasSelectionState): Promise<void> {
    this.current = state;
    await writePrivateJson(this.statePath, state);
  }

  async heartbeat(): Promise<void> {
    if (!this.current) return;
    this.current.heartbeatAt = new Date().toISOString();
    await writePrivateJson(this.statePath, this.current);
  }

  async attachScreenshot(kind: 'element' | 'viewport', dataUrl: string): Promise<string | undefined> {
    if (!this.current) return undefined;
    const match = /^data:image\/png;base64,(.+)$/s.exec(dataUrl);
    if (!match?.[1]) return undefined;
    await fs.mkdir(this.screenshotDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(this.screenshotDirectory, `${kind}.png`);
    await fs.writeFile(target, Buffer.from(match[1], 'base64'), { mode: 0o600 });
    this.current.screenshots[kind] = target;
    this.current.heartbeatAt = new Date().toISOString();
    await writePrivateJson(this.statePath, this.current);
    return target;
  }

  async setComment(text: string): Promise<void> {
    if (!this.current) throw new Error('Select an element before adding a comment.');
    this.current.comment = {
      id: createHash('sha256').update(`${Date.now()}:${text}`).digest('hex').slice(0, 16),
      text: text.trim().slice(0, 4_000),
      createdAt: new Date().toISOString(),
    };
    this.current.heartbeatAt = new Date().toISOString();
    await writePrivateJson(this.statePath, this.current);
  }

  async clear(): Promise<void> {
    this.current = undefined;
    await fs.rm(this.statePath, { force: true });
  }
}

async function writePrivateJson(target: string, value: unknown): Promise<void> {
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600);
}
