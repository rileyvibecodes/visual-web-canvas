import html2canvas from 'html2canvas';
import { getElementContext } from 'react-grab/primitives';

const token = new URL((document.currentScript as HTMLScriptElement | null)?.src ?? location.href).searchParams.get('token') ?? '';
let inspectMode = true;
let selected: HTMLElement | undefined;
let hovered: HTMLElement | undefined;

const overlay = document.createElement('div');
overlay.dataset.visualWebCanvasOverlay = 'true';
overlay.style.cssText = 'all:initial;display:none;position:fixed;z-index:2147483646;border:2px solid #7c3aed;background:rgba(124,58,237,.08);pointer-events:none;box-sizing:border-box;';
const label = document.createElement('div');
label.style.cssText = 'all:initial;position:absolute;left:-2px;bottom:100%;padding:3px 7px;border-radius:5px 5px 0 0;background:#6d28d9;color:#fff;font:600 11px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis;';
overlay.append(label);
document.documentElement.append(overlay);

window.addEventListener('message', (event) => {
  const message = event.data as { channel?: string; token?: string; type?: string };
  if (message?.channel !== 'visual-web-canvas-host' || message.token !== token) return;
  if (message.type === 'setInspectMode') {
    inspectMode = Boolean((event.data as { enabled?: boolean }).enabled);
    document.documentElement.style.cursor = inspectMode ? 'crosshair' : '';
    if (!inspectMode) clearHover();
  }
  if (message.type === 'captureCommentScreenshot') void captureScreenshot();
  if (message.type === 'clearSelection') clearSelection();
});

document.addEventListener('pointermove', (event) => {
  if (!inspectMode) return;
  const target = pickTarget(event);
  if (!target || target === hovered) return;
  hovered = target;
  if (!selected) showOverlay(target, '#0284c7');
}, true);

document.addEventListener('pointerout', () => {
  if (!selected) clearHover();
}, true);

document.addEventListener('click', (event) => {
  if (!inspectMode) return;
  const target = pickTarget(event);
  if (!target) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  void selectElement(target);
}, true);

window.addEventListener('scroll', positionOverlay, { passive: true });
window.addEventListener('resize', positionOverlay, { passive: true });
new MutationObserver(positionOverlay).observe(document.documentElement, { subtree: true, childList: true, attributes: true });

document.documentElement.style.cursor = 'crosshair';
post({ type: 'liveStatus', message: 'Inspect mode ready. Click an element to attach it to Claude.' });

async function selectElement(element: HTMLElement): Promise<void> {
  selected = element;
  hovered = undefined;
  showOverlay(element, '#7c3aed');
  try {
    const context = await getElementContext(element);
    const computed = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const attributes = Object.fromEntries([...element.attributes]
      .filter((attribute) => !attribute.name.startsWith('data-visual-web-canvas-'))
      .map((attribute) => [attribute.name, attribute.value]));
    post({
      type: 'liveSelection',
      renderedHtml: context.htmlPreview || element.outerHTML.slice(0, 8_000),
      text: (element.innerText || element.textContent || '').trim().slice(0, 4_000),
      selector: context.selector || cssSelector(element),
      ancestorTrail: ancestors(element),
      attributes,
      accessibility: {
        role: element.getAttribute('role') || implicitRole(element),
        name: accessibleName(element),
      },
      computedStyles: selectedStyles(computed),
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
      react: {
        componentName: context.componentName,
        filePath: context.filePath,
        lineNumber: context.lineNumber,
        columnNumber: context.columnNumber,
        stack: context.stackString || context.stack.map((frame) => `${frame.functionName ?? 'anonymous'} (${frame.fileName ?? ''}:${frame.lineNumber ?? ''})`).join('\n'),
        snippet: context.snippet,
      },
    });
  } catch (error) {
    post({ type: 'liveStatus', message: `Selected element, but React source context was unavailable: ${error instanceof Error ? error.message : String(error)}` });
  }
}

async function captureScreenshot(): Promise<void> {
  if (!selected) return;
  try {
    const canvas = await html2canvas(selected, {
      backgroundColor: null,
      logging: false,
      useCORS: true,
      scale: Math.min(window.devicePixelRatio, 2),
      ignoreElements: (element) => element.hasAttribute('data-visual-web-canvas-overlay') || element.id === 'react-rewrite-root',
    });
    post({ type: 'screenshot', kind: 'element', dataUrl: canvas.toDataURL('image/png') });
    post({ type: 'commentScreenshotReady' });
  } catch (error) {
    post({ type: 'liveStatus', message: `Screenshot unavailable: ${error instanceof Error ? error.message : String(error)}` });
  }
}

function pickTarget(event: Event): HTMLElement | undefined {
  const path = event.composedPath();
  const target = path.find((candidate) => candidate instanceof HTMLElement) as HTMLElement | undefined;
  if (!target || target === overlay || overlay.contains(target)) return undefined;
  if (target.closest('#react-rewrite-root,[data-visual-web-canvas-overlay]')) return undefined;
  return target;
}

function showOverlay(element: HTMLElement, color: string): void {
  const rect = element.getBoundingClientRect();
  overlay.style.display = 'block';
  overlay.style.borderColor = color;
  overlay.style.left = `${rect.left}px`;
  overlay.style.top = `${rect.top}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  label.style.background = color;
  label.textContent = elementLabel(element);
}

function positionOverlay(): void {
  if (selected && document.contains(selected)) showOverlay(selected, '#7c3aed');
}

function clearHover(): void {
  hovered = undefined;
  if (!selected) overlay.style.display = 'none';
}

function clearSelection(): void {
  selected = undefined;
  overlay.style.display = 'none';
}

function elementLabel(element: HTMLElement): string {
  const id = element.id ? `#${element.id}` : '';
  const classes = [...element.classList].slice(0, 2).map((value) => `.${value}`).join('');
  return `${element.tagName.toLowerCase()}${id}${classes}`;
}

function ancestors(element: HTMLElement): string[] {
  const result: string[] = [];
  let current: HTMLElement | null = element;
  while (current && result.length < 8) {
    result.unshift(elementLabel(current));
    current = current.parentElement;
  }
  return result;
}

function cssSelector(element: HTMLElement): string {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const parts: string[] = [];
  let current: HTMLElement | null = element;
  while (current && current !== document.body && parts.length < 5) {
    let part = current.tagName.toLowerCase();
    const classes = [...current.classList].slice(0, 2);
    if (classes.length) part += classes.map((value) => `.${CSS.escape(value)}`).join('');
    const siblings = current.parentElement ? [...current.parentElement.children].filter((child) => child.tagName === current?.tagName) : [];
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(' > ');
}

function selectedStyles(style: CSSStyleDeclaration): Record<string, string> {
  const properties = [
    'display', 'position', 'width', 'height', 'max-width', 'min-height',
    'margin', 'padding', 'gap', 'grid-template-columns', 'align-items', 'justify-content',
    'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align',
    'color', 'background-color', 'border', 'border-radius', 'box-shadow', 'opacity', 'transform',
  ];
  return Object.fromEntries(properties.map((property) => [property, style.getPropertyValue(property)]).filter(([, value]) => value));
}

function accessibleName(element: HTMLElement): string {
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) return labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ');
  return element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || (element.innerText || '').trim().slice(0, 240);
}

function implicitRole(element: HTMLElement): string {
  const roles: Record<string, string> = { A: 'link', BUTTON: 'button', H1: 'heading', H2: 'heading', H3: 'heading', IMG: 'img', INPUT: 'textbox', NAV: 'navigation', MAIN: 'main' };
  return roles[element.tagName] ?? '';
}

function post(message: Record<string, unknown>): void {
  window.parent.postMessage({ channel: 'visual-web-canvas', token, ...message }, '*');
}
