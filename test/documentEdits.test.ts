import { describe, expect, it } from 'vitest';
import { inlineStyleEdit, responsiveOverrideDocument } from '../src/documentEdits.js';
import { instrumentHtml } from '../src/sourceMap.js';

function editStyle(source: string, property: string, value: string): string {
  const mapped = instrumentHtml(source, '/runtime.js');
  const element = [...mapped.elements.values()].find((candidate) => candidate.tagName === 'h1')!;
  const edit = inlineStyleEdit(source, element, property, value);
  return source.slice(0, edit.start) + edit.text + source.slice(edit.end);
}

describe('inlineStyleEdit', () => {
  it('adds and updates a source style without touching the element body', () => {
    const source = '<html><body><h1 class="hero">Hello</h1></body></html>';
    const added = editStyle(source, 'font-size', '48px');
    expect(added).toContain('<h1 class="hero" style="font-size: 48px;">Hello</h1>');
    expect(editStyle(added, 'font-size', '42px')).toContain('style="font-size: 42px;"');
  });

  it('preserves CSS values that contain semicolons inside syntax', () => {
    const source = '<h1 style="background: url(&quot;data:image/svg+xml;a;b&quot;); color: red;">Hello</h1>';
    const updated = editStyle(source, 'font-size', '32px');
    expect(updated).toContain('background: url(&quot;data:image/svg+xml;a;b&quot;);');
    expect(updated).toContain('font-size: 32px;');
  });
});

describe('responsiveOverrideDocument', () => {
  it('creates and replaces a deterministic mobile override', () => {
    const source = '<html><head><style>h1{font-size:48px}</style></head><body><h1>Hello</h1></body></html>';
    const first = responsiveOverrideDocument(source, 'body > h1', 'mobile', 'font-size', '32px');
    expect(first).toContain('data-visual-web-canvas-overrides');
    expect(first).toContain('@media (max-width: 767px)');
    const second = responsiveOverrideDocument(first, 'body > h1', 'mobile', 'font-size', '30px');
    expect(second.match(/\/\* visual-web-canvas:[a-f0-9]+ \*\//g)).toHaveLength(1);
    expect(second).not.toContain('32px');
    expect(second).toContain('30px');
  });
});
