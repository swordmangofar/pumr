const VIEWPORT_MARGIN_PX = 8;

/**
 * Positions a context menu opened at (`x`, `y`) so a menu of the given size
 * stays inside the viewport: clamped horizontally, flipped upwards near the
 * bottom edge.
 */
export function contextMenuStyle(
  x: number,
  y: number,
  width: number,
  height: number,
): Record<string, string> {
  if (typeof window === 'undefined') {
    return { left: `${x}px`, top: `${y}px` };
  }
  const left = Math.max(
    VIEWPORT_MARGIN_PX,
    Math.min(x, window.innerWidth - width - VIEWPORT_MARGIN_PX),
  );
  const flipY = y > window.innerHeight - height;
  return {
    left: `${left}px`,
    top: flipY ? 'auto' : `${y}px`,
    bottom: flipY ? `${Math.max(VIEWPORT_MARGIN_PX, window.innerHeight - y)}px` : 'auto',
  };
}
