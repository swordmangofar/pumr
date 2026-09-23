import { clampZoom, stepZoom, ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN } from './zoom';

describe('zoom helpers', () => {
  it('clamps to the supported range', () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(9)).toBe(ZOOM_MAX);
    expect(clampZoom(Number.NaN)).toBe(ZOOM_DEFAULT);
  });

  it('rounds to two decimals', () => {
    expect(clampZoom(1.234)).toBe(1.23);
  });

  it('steps by ten percent in both directions', () => {
    expect(stepZoom(1, 1)).toBeCloseTo(1.1);
    expect(stepZoom(1, -1)).toBeCloseTo(0.9);
  });

  it('never steps past the bounds', () => {
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
  });
});
