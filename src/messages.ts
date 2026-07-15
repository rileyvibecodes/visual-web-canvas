export interface RuntimeSelectionMessage {
  channel: 'visual-web-canvas';
  token: string;
  type: 'selection';
  elementId: string;
  renderedHtml: string;
  text: string;
  selector: string;
  ancestorTrail: string[];
  attributes: Record<string, string>;
  computedStyles: Record<string, string>;
  bounds: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number; devicePixelRatio: number; scrollX: number; scrollY: number };
}

export interface RuntimeLiveSelectionMessage {
  channel: 'visual-web-canvas';
  token: string;
  type: 'liveSelection';
  renderedHtml: string;
  text: string;
  selector: string;
  ancestorTrail: string[];
  attributes: Record<string, string>;
  accessibility: { role: string; name: string };
  computedStyles: Record<string, string>;
  bounds: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number; devicePixelRatio: number; scrollX: number; scrollY: number };
  react: {
    componentName: string | null;
    filePath: string | null;
    lineNumber: number | null;
    columnNumber: number | null;
    stack: string;
    snippet: string;
  };
}

export interface RuntimeLiveStatusMessage {
  channel: 'visual-web-canvas';
  token: string;
  type: 'liveStatus' | 'commentScreenshotReady';
  message?: string;
}

export interface RuntimeTextEditMessage {
  channel: 'visual-web-canvas';
  token: string;
  type: 'editText';
  textId: string;
  value: string;
  documentVersion: number;
}

export interface RuntimeScreenshotMessage {
  channel: 'visual-web-canvas';
  token: string;
  type: 'screenshot';
  kind: 'element' | 'viewport';
  dataUrl: string;
}

export interface RuntimeScrollMessage {
  channel: 'visual-web-canvas';
  token: string;
  type: 'scroll';
  x: number;
  y: number;
}

export interface RuntimeStatusMessage {
  channel: 'visual-web-canvas';
  token: string;
  type: 'status';
  message: string;
}

export interface RuntimeElementActionMessage {
  channel: 'visual-web-canvas';
  token: string;
  type: 'elementAction';
  action: 'focusClaude' | 'duplicate' | 'delete';
  elementId: string;
}

export type RuntimeMessage =
  | RuntimeSelectionMessage
  | RuntimeLiveSelectionMessage
  | RuntimeLiveStatusMessage
  | RuntimeTextEditMessage
  | RuntimeScreenshotMessage
  | RuntimeScrollMessage
  | RuntimeStatusMessage
  | RuntimeElementActionMessage;

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RuntimeMessage>;
  return candidate.channel === 'visual-web-canvas' && typeof candidate.token === 'string' && typeof candidate.type === 'string';
}
