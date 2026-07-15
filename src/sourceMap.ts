import { parse } from 'parse5';

export interface SourceRange {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface ElementSource extends SourceRange {
  id: string;
  tagName: string;
  sourceHtml: string;
  startTagStartOffset: number;
  startTagEndOffset: number;
}

export interface TextSource extends SourceRange {
  id: string;
  value: string;
  parentElementId?: string;
}

export interface InstrumentedDocument {
  html: string;
  elements: Map<string, ElementSource>;
  textNodes: Map<string, TextSource>;
}

interface ParseLocation {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  startTag?: ParseLocation;
  endTag?: ParseLocation;
}

interface ParseNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  childNodes?: ParseNode[];
  sourceCodeLocation?: ParseLocation;
}

interface Insertion {
  offset: number;
  value: string;
  order: number;
}

const EXCLUDED_TEXT_PARENTS = new Set(['script', 'style', 'noscript', 'template', 'textarea']);

export function instrumentHtml(source: string, runtimeUrl: string): InstrumentedDocument {
  const document = parse(source, { sourceCodeLocationInfo: true }) as unknown as ParseNode;
  const elements = new Map<string, ElementSource>();
  const textNodes = new Map<string, TextSource>();
  const insertions: Insertion[] = [];
  let elementCounter = 0;
  let textCounter = 0;
  let insertionOrder = 0;

  const visit = (node: ParseNode, parentElementId?: string, excluded = false): void => {
    const location = node.sourceCodeLocation;
    let currentParentId = parentElementId;
    let textExcluded = excluded;

    if (node.tagName && location?.startTag) {
      const id = `e${++elementCounter}`;
      currentParentId = id;
      textExcluded = excluded || EXCLUDED_TEXT_PARENTS.has(node.tagName);
      elements.set(id, {
        id,
        tagName: node.tagName,
        sourceHtml: source.slice(location.startOffset, location.endOffset),
        startTagStartOffset: location.startTag.startOffset,
        startTagEndOffset: location.startTag.endOffset,
        ...toSourceRange(location),
      });

      if (node.tagName === 'script') {
        const original = source.slice(location.startTag.startOffset, location.startTag.endOffset);
        const disabled = original
          .replace(/\s+type\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '')
          .replace(/>$/, ` type="application/visual-web-canvas-disabled" data-visual-web-canvas-node-id="${id}">`);
        insertions.push({
          offset: location.startTag.startOffset,
          value: disabled,
          order: insertionOrder++,
        });
        insertions.push({
          offset: location.startTag.endOffset,
          value: `\u0000DELETE:${location.startTag.startOffset}`,
          order: insertionOrder++,
        });
      } else {
        const closingWidth = source.slice(location.startTag.startOffset, location.startTag.endOffset).endsWith('/>') ? 2 : 1;
        insertions.push({
          offset: location.startTag.endOffset - closingWidth,
          value: ` data-visual-web-canvas-node-id="${id}"`,
          order: insertionOrder++,
        });
      }
    } else if (node.nodeName === '#text' && location && !textExcluded && node.value?.trim()) {
      const id = `t${++textCounter}`;
      textNodes.set(id, {
        id,
        value: node.value,
        parentElementId,
        ...toSourceRange(location),
      });
      insertions.push({
        offset: location.startOffset,
        value: `<!--visual-web-canvas-text:${id}-->`,
        order: insertionOrder++,
      });
    }

    for (const child of node.childNodes ?? []) {
      visit(child, currentParentId, textExcluded);
    }
  };

  visit(document);

  const bodyClose = findBodyClose(source);
  const escapedRuntimeUrl = runtimeUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  insertions.push({
    offset: bodyClose,
    value: `<script src="${escapedRuntimeUrl}" data-visual-web-canvas-runtime></script>`,
    order: insertionOrder++,
  });

  return {
    html: applyInsertions(source, insertions),
    elements,
    textNodes,
  };
}

function toSourceRange(location: ParseLocation): SourceRange {
  return {
    startOffset: location.startOffset,
    endOffset: location.endOffset,
    startLine: location.startLine,
    startColumn: location.startCol,
    endLine: location.endLine,
    endColumn: location.endCol,
  };
}

function findBodyClose(source: string): number {
  const matches = [...source.matchAll(/<\/body\s*>/gi)];
  const last = matches.at(-1);
  return last?.index ?? source.length;
}

function applyInsertions(source: string, insertions: Insertion[]): string {
  // Script start tags need replacement, whereas ordinary instrumentation is insertion-only.
  const replacements = new Map<number, { end: number; value: string }>();
  const ordinary: Insertion[] = [];

  for (const insertion of insertions) {
    if (insertion.value.startsWith('\u0000DELETE:')) {
      const start = Number(insertion.value.slice('\u0000DELETE:'.length));
      const replacement = insertions.find(
        (candidate) => candidate.offset === start && candidate.order < insertion.order,
      );
      if (replacement) {
        replacements.set(start, { end: insertion.offset, value: replacement.value });
      }
      continue;
    }
    ordinary.push(insertion);
  }

  const replacementStarts = new Set(replacements.keys());
  const edits = ordinary
    .filter((insertion) => !replacementStarts.has(insertion.offset))
    .map((insertion) => ({ start: insertion.offset, end: insertion.offset, value: insertion.value, order: insertion.order }));
  for (const [start, replacement] of replacements) {
    edits.push({ start, end: replacement.end, value: replacement.value, order: -1 });
  }

  edits.sort((a, b) => b.start - a.start || b.order - a.order);
  let result = source;
  for (const edit of edits) {
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  }
  return result;
}

export function escapeHtmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
