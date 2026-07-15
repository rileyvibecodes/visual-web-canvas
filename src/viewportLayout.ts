export interface ViewportLayout {
  layoutWidth: number;
  layoutHeight: number;
  renderedWidth: number;
  scale: number;
}

export function computeViewportLayout(
  presetWidth: number,
  availableWidth: number,
  availableHeight: number,
): ViewportLayout {
  const safeWidth = Math.max(1, availableWidth);
  const safeHeight = Math.max(1, availableHeight);

  if (presetWidth <= 0) {
    return {
      layoutWidth: safeWidth,
      layoutHeight: safeHeight,
      renderedWidth: safeWidth,
      scale: 1,
    };
  }

  const scale = Math.min(1, safeWidth / presetWidth);
  return {
    layoutWidth: presetWidth,
    layoutHeight: safeHeight / scale,
    renderedWidth: presetWidth * scale,
    scale,
  };
}
