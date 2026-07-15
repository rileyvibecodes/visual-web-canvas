import { describe, expect, it } from 'vitest';
import { computeViewportLayout } from '../src/viewportLayout.js';

describe('computeViewportLayout', () => {
  it('keeps the selected desktop layout width when the editor pane is narrow', () => {
    expect(computeViewportLayout(1440, 720, 800)).toEqual({
      layoutWidth: 1440,
      layoutHeight: 1600,
      renderedWidth: 720,
      scale: 0.5,
    });
  });

  it('does not enlarge a fixed viewport beyond its native size', () => {
    expect(computeViewportLayout(390, 1200, 800)).toEqual({
      layoutWidth: 390,
      layoutHeight: 800,
      renderedWidth: 390,
      scale: 1,
    });
  });

  it('uses the actual editor dimensions in responsive mode', () => {
    expect(computeViewportLayout(0, 720, 800)).toEqual({
      layoutWidth: 720,
      layoutHeight: 800,
      renderedWidth: 720,
      scale: 1,
    });
  });
});
