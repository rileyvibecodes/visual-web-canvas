import { describe, expect, it } from 'vitest';
import { escapeHtmlText, instrumentHtml } from '../src/sourceMap.js';

describe('instrumentHtml', () => {
  it('maps elements and text without changing canonical source ranges', () => {
    const source = '<!doctype html><html><body><h1>Hello <em>world</em></h1></body></html>';
    const result = instrumentHtml(source, 'http://127.0.0.1/runtime.js');

    expect(result.elements.size).toBe(4);
    expect(result.textNodes.size).toBe(2);
    expect(result.html).toContain('<h1 data-visual-web-canvas-node-id="e3">');
    expect(result.html).toContain('<!--visual-web-canvas-text:t1-->Hello ');
    expect(result.html).toContain('<script src="http://127.0.0.1/runtime.js" data-visual-web-canvas-runtime></script></body>');

    const heading = [...result.elements.values()].find((element) => element.tagName === 'h1');
    expect(heading?.sourceHtml).toBe('<h1>Hello <em>world</em></h1>');
    expect(source.slice(heading!.startOffset, heading!.endOffset)).toBe(heading?.sourceHtml);
  });

  it('disables authored scripts but leaves the canvas runtime executable', () => {
    const source = '<html><body><script type="module">alert(1)</script></body></html>';
    const result = instrumentHtml(source, 'http://127.0.0.1/runtime.js');
    expect(result.html).toContain('<script type="application/visual-web-canvas-disabled" data-visual-web-canvas-node-id="e3">alert(1)</script>');
    expect(result.html).toContain('<script src="http://127.0.0.1/runtime.js" data-visual-web-canvas-runtime></script>');
    expect(result.textNodes.size).toBe(0);
  });

  it('instruments a large public landing page fixture within the interaction budget', () => {
    const sections = Array.from({ length: 250 }, (_, index) => `<section class="section-${index}"><h2>Section ${index}</h2><p>Useful public demo copy.</p><a href="#cta">Continue</a></section>`).join('');
    const source = `<!doctype html><html><head><title>Demo</title></head><body>${sections}</body></html>`;
    const started = performance.now();
    const result = instrumentHtml(source, 'http://127.0.0.1/runtime.js');
    const elapsed = performance.now() - started;

    // Keep a generous cross-platform ceiling: CI runners vary substantially,
    // while a half-second regression would still be obvious in the canvas.
    expect(elapsed).toBeLessThan(500);
    expect(result.elements.size).toBeGreaterThan(1_000);
    expect(result.textNodes.size).toBeGreaterThan(500);
    expect(result.html).toContain('Useful public demo copy.');
  });
});

describe('escapeHtmlText', () => {
  it('escapes text edits without treating quotes as markup', () => {
    expect(escapeHtmlText('A & B < C > D "quoted"')).toBe('A &amp; B &lt; C &gt; D "quoted"');
  });
});
