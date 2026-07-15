import { createHash } from 'node:crypto';
import type { ElementSource } from './sourceMap.js';

export interface OffsetEdit {
  start: number;
  end: number;
  text: string;
}

export type ResponsiveScope = 'all' | 'desktop' | 'tablet' | 'mobile';

export function inlineStyleEdit(
  document: string,
  element: ElementSource,
  property: string,
  value: string,
): OffsetEdit {
  const startTag = document.slice(element.startTagStartOffset, element.startTagEndOffset);
  const styleMatch = /\sstyle\s*=\s*(["'])([\s\S]*?)\1/i.exec(startTag);
  const declarations = parseDeclarations(decodeAttribute(styleMatch?.[2] ?? ''));

  if (value.trim()) declarations.set(property, value.trim());
  else declarations.delete(property);

  let replacement: string;
  if (styleMatch) {
    const serialized = serializeDeclarations(declarations);
    replacement = serialized
      ? startTag.slice(0, styleMatch.index) + ` style="${escapeAttribute(serialized)}"` + startTag.slice(styleMatch.index + styleMatch[0].length)
      : startTag.slice(0, styleMatch.index) + startTag.slice(styleMatch.index + styleMatch[0].length);
  } else if (declarations.size) {
    const insertion = startTag.endsWith('/>') ? startTag.length - 2 : startTag.length - 1;
    replacement = `${startTag.slice(0, insertion)} style="${escapeAttribute(serializeDeclarations(declarations))}"${startTag.slice(insertion)}`;
  } else {
    replacement = startTag;
  }

  return {
    start: element.startTagStartOffset,
    end: element.startTagEndOffset,
    text: replacement,
  };
}

export function responsiveOverrideDocument(
  document: string,
  selector: string,
  scope: Exclude<ResponsiveScope, 'all'>,
  property: string,
  value: string,
): string {
  const key = createHash('sha1').update(`${selector}\0${scope}\0${property}`).digest('hex').slice(0, 12);
  const startMarker = `/* visual-web-canvas:${key} */`;
  const endMarker = `/* /visual-web-canvas:${key} */`;
  const existingPattern = new RegExp(`${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\s*`, 'g');
  let next = document.replace(existingPattern, '');

  if (!value.trim()) return next;

  const declaration = `${selector} { ${property}: ${value.trim()} !important; }`;
  const rule = scope === 'mobile'
    ? `@media (max-width: 767px) {\n  ${declaration}\n}`
    : scope === 'tablet'
      ? `@media (min-width: 768px) and (max-width: 1023px) {\n  ${declaration}\n}`
      : `@media (min-width: 1024px) {\n  ${declaration}\n}`;
  const block = `${startMarker}\n${rule}\n${endMarker}\n`;

  const canvasStyle = /<style\b[^>]*\bdata-visual-web-canvas-overrides\b[^>]*>[\s\S]*?<\/style\s*>/i.exec(next);
  if (canvasStyle) {
    const closing = canvasStyle[0].search(/<\/style\s*>/i);
    const absolute = (canvasStyle.index ?? 0) + closing;
    return `${next.slice(0, absolute)}${block}${next.slice(absolute)}`;
  }

  const style = `<style data-visual-web-canvas-overrides>\n${block}</style>\n`;
  const headClose = /<\/head\s*>/i.exec(next);
  const offset = headClose?.index ?? 0;
  return offset
    ? `${next.slice(0, offset)}${style}${next.slice(offset)}`
    : `${style}${next}`;
}

function parseDeclarations(style: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const segment of splitOutsideSyntax(style, ';')) {
    const colon = indexOutsideSyntax(segment, ':');
    if (colon < 0) continue;
    const property = segment.slice(0, colon).trim().toLowerCase();
    const value = segment.slice(colon + 1).trim();
    if (property && value) declarations.set(property, value);
  }
  return declarations;
}

function serializeDeclarations(declarations: Map<string, string>): string {
  return [...declarations].map(([property, value]) => `${property}: ${value};`).join(' ');
}

function splitOutsideSyntax(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = '';
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== '\\') quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')') depth = Math.max(0, depth - 1);
    else if (character === delimiter && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function indexOutsideSyntax(value: string, delimiter: string): number {
  let quote = '';
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== '\\') quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')') depth = Math.max(0, depth - 1);
    else if (character === delimiter && depth === 0) return index;
  }
  return -1;
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
