import html2canvas from 'html2canvas';

const params = new URLSearchParams(window.location.search);
const token = params.get('token') ?? '';
const documentVersion = Number(params.get('documentVersion') ?? '0');
const surface = params.get('surface') ?? 'primary';
const readOnly = params.get('mode') === 'before';
let selectedElement: HTMLElement | undefined;
let hoveredElement: HTMLElement | undefined;
let screenshotGeneration = 0;
let scrollTimer: number | undefined;

const overlayStyle = document.createElement('style');
overlayStyle.dataset.visualWebCanvasOverlay = 'true';
overlayStyle.textContent = `
  [data-visual-web-canvas-selected] {
    outline: 2px solid #7c5cff !important;
    outline-offset: 2px !important;
    cursor: default !important;
  }
  [data-visual-web-canvas-hovered]:not([data-visual-web-canvas-selected]) {
    outline: 1px solid #38bdf8 !important;
    outline-offset: 2px !important;
    cursor: default !important;
  }
  [data-visual-web-canvas-editing] {
    outline: 2px solid #16a34a !important;
    outline-offset: 2px !important;
    min-width: 0.5em;
    cursor: text !important;
  }
`;
document.head.append(overlayStyle);

const hoverLabel = createHoverLabel();
const selectionToolbar = createSelectionToolbar();
const foldOverlay = createFoldOverlay();
updateFoldOverlay(Number(params.get('foldHeight') ?? '0'));
if (readOnly) createBeforeBadge();

restoreViewport();

if (!readOnly) {
  document.addEventListener('pointermove', handlePointerMove, true);
  document.addEventListener('pointerleave', clearHover, true);
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-visual-web-canvas-node-id]') : null;
    if (!target || target.hasAttribute('data-visual-web-canvas-runtime')) return;
    event.preventDefault();
    event.stopPropagation();
    select(target);
  }, true);

  document.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    beginTextEdit(event.clientX, event.clientY);
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !document.querySelector('[data-visual-web-canvas-editing]')) clearSelection();
  }, true);
  document.addEventListener('submit', (event) => event.preventDefault(), true);
  document.addEventListener('auxclick', (event) => event.preventDefault(), true);
}
window.addEventListener('scroll', () => {
  positionSelectionToolbar();
  positionHoverLabel();
  if (scrollTimer) window.clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(() => {
    post({ type: 'scroll', x: window.scrollX, y: window.scrollY });
  }, 80);
}, { passive: true });
window.addEventListener('resize', () => {
  positionSelectionToolbar();
  positionHoverLabel();
});

window.addEventListener('message', (event) => {
  if (event.data?.channel !== 'visual-web-canvas-host' || event.data?.token !== token) return;
  if (event.data.type === 'clearSelection') clearSelection();
  if (event.data.type === 'selectAncestor') selectAncestor(Number(event.data.depth) || 0);
  if (event.data.type === 'selectByAnchor') {
    const restored = findRestoredElement(null, event.data.selector ?? null, event.data.text ?? null, event.data.tagName ?? null);
    if (restored) select(restored, false);
  }
  if (event.data.type === 'setFold') updateFoldOverlay(Number(event.data.height) || 0);
  if (event.data.type === 'captureCommentScreenshot' && selectedElement) {
    const generation = ++screenshotGeneration;
    window.setTimeout(() => captureScreenshots(selectedElement!, generation), 50);
  }
});

function restoreViewport(): void {
  const selectedId = params.get('selected');
  const selectedSelector = params.get('selectedSelector');
  const selectedText = params.get('selectedText');
  const selectedTag = params.get('selectedTag');
  const scrollX = Number(params.get('scrollX') ?? '0');
  const scrollY = Number(params.get('scrollY') ?? '0');
  requestAnimationFrame(() => {
    window.scrollTo(scrollX, scrollY);
    const restored = findRestoredElement(selectedId, selectedSelector, selectedText, selectedTag);
    if (restored) select(restored, surface !== 'compare' && !readOnly);
  });
}

function select(element: HTMLElement, emit = true): void {
  if (selectedElement !== element) {
    selectedElement?.removeAttribute('data-visual-web-canvas-selected');
    selectedElement = element;
    element.setAttribute('data-visual-web-canvas-selected', 'true');
  }

  clearHover();
  updateSelectionToolbar();

  if (!emit) return;

  const elementId = element.dataset.visualWebCanvasNodeId;
  if (!elementId) return;
  const rect = element.getBoundingClientRect();
  const computed = window.getComputedStyle(element);
  post({
    type: 'selection',
    elementId,
    renderedHtml: cleanOuterHtml(element),
    text: element.innerText,
    selector: buildSelector(element),
    ancestorTrail: buildAncestorTrail(element),
    attributes: Object.fromEntries(
      [...element.attributes]
        .filter((attribute) => !attribute.name.startsWith('data-visual-web-canvas-'))
        .map((attribute) => [attribute.name, attribute.value]),
    ),
    computedStyles: pickComputedStyles(computed),
    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    viewport: viewportState(),
  });

}

function clearSelection(): void {
  selectedElement?.removeAttribute('data-visual-web-canvas-selected');
  selectedElement = undefined;
  selectionToolbar.style.display = 'none';
}

function selectAncestor(depth: number): void {
  let target = selectedElement;
  for (let index = 0; target && index < depth; index += 1) {
    target = target.parentElement?.closest<HTMLElement>('[data-visual-web-canvas-node-id]') ?? undefined;
  }
  if (target) select(target, surface !== 'compare');
}

function beginTextEdit(x: number, y: number): void {
  const caret = caretAtPoint(x, y);
  const textNode = caret?.startContainer;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    post({ type: 'status', message: 'No editable text at that point.' });
    return;
  }

  beginTextNodeEdit(textNode);
}

function beginSelectedTextEdit(): void {
  if (!selectedElement) return;
  const walker = document.createTreeWalker(selectedElement, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    if (textNode.nodeValue?.trim() && textNode.previousSibling?.nodeType === Node.COMMENT_NODE) {
      beginTextNodeEdit(textNode);
      return;
    }
  }
  post({ type: 'status', message: 'No directly editable text in this element.' });
}

function beginTextNodeEdit(textNode: Node): void {
  const marker = textNode.previousSibling;
  const markerMatch = marker?.nodeType === Node.COMMENT_NODE
    ? /^visual-web-canvas-text:(t\d+)$/.exec(marker.nodeValue ?? '')
    : null;
  if (!markerMatch?.[1] || !textNode.parentNode) {
    post({ type: 'status', message: 'That text is generated or cannot be mapped safely to source.' });
    return;
  }

  const original = textNode.nodeValue ?? '';
  const editor = document.createElement('span');
  editor.dataset.visualWebCanvasEditing = 'true';
  editor.dataset.visualWebCanvasOverlay = 'true';
  editor.contentEditable = 'true';
  editor.spellcheck = true;
  editor.textContent = original;
  textNode.parentNode.replaceChild(editor, textNode);

  let finished = false;
  const finish = (commit: boolean): void => {
    if (finished) return;
    finished = true;
    const value = editor.innerText.replace(/\r\n?/g, '\n');
    editor.replaceWith(document.createTextNode(commit ? value : original));
    if (commit && value !== original) {
      post({ type: 'editText', textId: markerMatch[1], value, documentVersion });
    }
  };

  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      finish(true);
    }
  });
  editor.addEventListener('blur', () => finish(true), { once: true });
  editor.focus();

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function handlePointerMove(event: PointerEvent): void {
  if (event.target instanceof Element && event.target.closest('[data-visual-web-canvas-overlay]')) return;
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-visual-web-canvas-node-id]') : null;
  if (target === hoveredElement) return;
  clearHover();
  if (!target || target === selectedElement) return;
  hoveredElement = target;
  target.setAttribute('data-visual-web-canvas-hovered', 'true');
  hoverLabel.textContent = elementLabel(target);
  hoverLabel.style.display = 'block';
  positionHoverLabel();
}

function clearHover(): void {
  hoveredElement?.removeAttribute('data-visual-web-canvas-hovered');
  hoveredElement = undefined;
  hoverLabel.style.display = 'none';
}

function createHoverLabel(): HTMLDivElement {
  const label = document.createElement('div');
  label.dataset.visualWebCanvasOverlay = 'true';
  label.style.cssText = 'all:initial;display:none;position:fixed;z-index:2147483647;padding:3px 6px;border-radius:3px;background:#0284c7;color:white;font:11px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;pointer-events:none;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  document.body.append(label);
  return label;
}

function createSelectionToolbar(): HTMLDivElement {
  const toolbar = document.createElement('div');
  toolbar.dataset.visualWebCanvasOverlay = 'true';
  toolbar.style.cssText = 'all:initial;display:none;position:fixed;z-index:2147483647;align-items:center;gap:2px;padding:3px;border-radius:6px;background:#18181b;color:white;box-shadow:0 5px 18px rgba(0,0,0,.28);font:11px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;';
  toolbar.innerHTML = '<span data-role="label" style="padding:0 5px;color:#c4b5fd;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span><button data-action="parent">Parent</button><button data-action="edit">Text</button><button data-action="comment">Comment</button><button data-action="duplicate">Duplicate</button><button data-action="delete" title="Delete selected element">Delete</button>';
  for (const button of toolbar.querySelectorAll<HTMLButtonElement>('button')) {
    button.dataset.visualWebCanvasOverlay = 'true';
    button.style.cssText = 'all:initial;box-sizing:border-box;padding:4px 6px;border-radius:4px;color:white;font:11px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;';
    button.addEventListener('pointerenter', () => { button.style.background = '#3f3f46'; });
    button.addEventListener('pointerleave', () => { button.style.background = 'transparent'; });
  }
  toolbar.querySelector('[data-action="parent"]')?.addEventListener('click', () => selectAncestor(1));
  toolbar.querySelector('[data-action="edit"]')?.addEventListener('click', beginSelectedTextEdit);
  toolbar.querySelector('[data-action="comment"]')?.addEventListener('click', () => postElementAction('focusClaude'));
  toolbar.querySelector('[data-action="duplicate"]')?.addEventListener('click', () => postElementAction('duplicate'));
  toolbar.querySelector('[data-action="delete"]')?.addEventListener('click', () => postElementAction('delete'));
  document.body.append(toolbar);
  return toolbar;
}

function updateSelectionToolbar(): void {
  if (!selectedElement || readOnly) {
    selectionToolbar.style.display = 'none';
    return;
  }
  const label = selectionToolbar.querySelector<HTMLElement>('[data-role="label"]');
  if (label) label.textContent = elementLabel(selectedElement);
  selectionToolbar.style.display = 'flex';
  positionSelectionToolbar();
}

function positionSelectionToolbar(): void {
  if (!selectedElement || selectionToolbar.style.display === 'none') return;
  const rect = selectedElement.getBoundingClientRect();
  const width = selectionToolbar.offsetWidth;
  const left = Math.max(6, Math.min(window.innerWidth - width - 6, rect.left));
  const above = rect.top - selectionToolbar.offsetHeight - 6;
  const top = above >= 6 ? above : Math.min(window.innerHeight - selectionToolbar.offsetHeight - 6, rect.bottom + 6);
  selectionToolbar.style.left = `${left}px`;
  selectionToolbar.style.top = `${Math.max(6, top)}px`;
}

function positionHoverLabel(): void {
  if (!hoveredElement || hoverLabel.style.display === 'none') return;
  const rect = hoveredElement.getBoundingClientRect();
  hoverLabel.style.left = `${Math.max(4, rect.left)}px`;
  hoverLabel.style.top = `${Math.max(4, rect.top - 20)}px`;
}

function elementLabel(element: HTMLElement): string {
  const identity = element.id ? `#${element.id}` : [...element.classList].slice(0, 2).map((name) => `.${name}`).join('');
  return `${element.tagName.toLowerCase()}${identity}`;
}

function postElementAction(action: 'focusClaude' | 'duplicate' | 'delete'): void {
  if (!selectedElement?.dataset.visualWebCanvasNodeId) return;
  post({ type: 'elementAction', action, elementId: selectedElement.dataset.visualWebCanvasNodeId });
}

function findRestoredElement(
  selectedId: string | null,
  selector: string | null,
  text: string | null,
  tagName: string | null,
): HTMLElement | undefined {
  if (selectedId) {
    const exact = document.querySelector<HTMLElement>(`[data-visual-web-canvas-node-id="${CSS.escape(selectedId)}"]`);
    if (exact) return exact;
  }
  if (selector) {
    try {
      const exact = document.querySelector<HTMLElement>(selector);
      const candidateText = exact ? normalizeText(exact.innerText) : '';
      const expectedText = normalizeText(text ?? '');
      if (exact && (!expectedText || candidateText === expectedText || candidateText.includes(expectedText))) return exact;
    } catch {}
  }
  const normalizedText = normalizeText(text ?? '');
  const candidates = [...document.querySelectorAll<HTMLElement>('[data-visual-web-canvas-node-id]')]
    .filter((candidate) => !tagName || candidate.tagName.toLowerCase() === tagName.toLowerCase());
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: normalizedText && normalizeText(candidate.innerText) === normalizedText ? 3
        : normalizedText && normalizeText(candidate.innerText).includes(normalizedText) ? 2 : 0,
    }))
    .sort((left, right) => right.score - left.score);
  if ((ranked[0]?.score ?? 0) > 0) return ranked[0]?.candidate;
  return candidates.length === 1 ? candidates[0] : undefined;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function createFoldOverlay(): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.dataset.visualWebCanvasOverlay = 'true';
  overlay.style.cssText = 'all:initial;position:absolute;left:0;right:0;z-index:2147483646;border-top:2px dashed #f97316;pointer-events:none;color:#f97316;font:11px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;';
  const label = document.createElement('span');
  label.dataset.visualWebCanvasOverlay = 'true';
  label.textContent = '768px fold';
  label.style.cssText = 'all:initial;position:absolute;right:8px;top:-18px;padding:2px 5px;border-radius:3px;background:#f97316;color:white;font:11px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;';
  overlay.append(label);
  document.body.append(overlay);
  return overlay;
}

function updateFoldOverlay(height: number): void {
  if (!foldOverlay) return;
  foldOverlay.style.display = height > 0 ? 'block' : 'none';
  foldOverlay.style.top = `${height}px`;
  const label = foldOverlay.firstElementChild;
  if (label) label.textContent = `${height}px fold`;
}

function createBeforeBadge(): void {
  const badge = document.createElement('div');
  badge.dataset.visualWebCanvasOverlay = 'true';
  badge.textContent = 'BEFORE · read only';
  badge.style.cssText = 'all:initial;position:fixed;right:12px;top:12px;z-index:2147483647;padding:5px 8px;border-radius:4px;background:#a16207;color:white;font:600 11px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;';
  document.body.append(badge);
}

function caretAtPoint(x: number, y: number): Range | undefined {
  const modern = document.caretPositionFromPoint?.(x, y);
  if (modern) {
    const range = document.createRange();
    range.setStart(modern.offsetNode, modern.offset);
    range.collapse(true);
    return range;
  }
  return document.caretRangeFromPoint(x, y) ?? undefined;
}

async function captureScreenshots(element: HTMLElement, generation: number): Promise<void> {
  try {
    const shared = {
      backgroundColor: null,
      logging: false,
      scale: Math.min(window.devicePixelRatio, 2),
      useCORS: true,
      ignoreElements: (candidate: Element) => candidate.hasAttribute('data-visual-web-canvas-overlay'),
    };
    const elementCanvas = await html2canvas(element, shared);
    if (generation !== screenshotGeneration) return;
    post({ type: 'screenshot', kind: 'element', dataUrl: elementCanvas.toDataURL('image/png') });

    const viewportCanvas = await html2canvas(document.documentElement, {
      ...shared,
      x: window.scrollX,
      y: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
    });
    if (generation !== screenshotGeneration) return;
    post({ type: 'screenshot', kind: 'viewport', dataUrl: viewportCanvas.toDataURL('image/png') });
  } catch (error) {
    console.warn('Visual Web Canvas screenshot unavailable', error);
  }
}

function viewportState() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}

function cleanOuterHtml(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  for (const candidate of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    for (const attribute of [...candidate.attributes]) {
      if (attribute.name.startsWith('data-visual-web-canvas-')) candidate.removeAttribute(attribute.name);
    }
  }
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
  const comments: Comment[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode as Comment);
  for (const comment of comments) comment.remove();
  return clone.outerHTML;
}

function buildSelector(element: Element): string {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement && parts.length < 5) {
    let part = current.tagName.toLowerCase();
    const classes = [...current.classList].filter((name) => !name.startsWith('visual-web-canvas')).slice(0, 2);
    if (classes.length) part += classes.map((name) => `.${CSS.escape(name)}`).join('');
    const parent: Element | null = current.parentElement;
    if (parent && parent.querySelectorAll(`:scope > ${current.tagName}`).length > 1) {
      part += `:nth-of-type(${[...parent.children].filter((child) => child.tagName === current?.tagName).indexOf(current) + 1})`;
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(' > ');
}

function buildAncestorTrail(element: Element): string[] {
  const trail: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement && trail.length < 8) {
    const label = [
      current.tagName.toLowerCase(),
      current.id ? `#${current.id}` : '',
      ...[...current.classList].slice(0, 3).map((name) => `.${name}`),
    ].join('');
    trail.unshift(label);
    current = current.parentElement;
  }
  return trail;
}

function pickComputedStyles(style: CSSStyleDeclaration): Record<string, string> {
  const names = [
    'display', 'position', 'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap',
    'color', 'background-color', 'border', 'border-radius', 'box-shadow',
    'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
    'letter-spacing', 'text-align', 'text-transform', 'opacity', 'z-index',
    'align-items', 'justify-content', 'grid-template-columns', 'flex-direction',
  ];
  return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)]).filter(([, value]) => value));
}

function post(message: Record<string, unknown>): void {
  window.parent.postMessage({ channel: 'visual-web-canvas', token, ...message }, '*');
}
