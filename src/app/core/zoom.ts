export const ZOOM_DEFAULT = 1;
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.1;

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) {
    return ZOOM_DEFAULT;
  }
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));
}

export function stepZoom(current: number, direction: 1 | -1): number {
  return clampZoom(clampZoom(current) + direction * ZOOM_STEP);
}
