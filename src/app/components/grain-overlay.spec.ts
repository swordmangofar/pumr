import { GRAIN_STRENGTH, grainPixels } from './grain-overlay';

describe('grainPixels', () => {
  const pixels = grainPixels(64);
  const channel = (offset: number): number[] =>
    Array.from(pixels).filter((_, index) => index % 4 === offset);

  it('is a square tile of white and black pixels', () => {
    expect(pixels).toHaveLength(64 * 64 * 4);
    const [red, green, blue] = [channel(0), channel(1), channel(2)];
    expect(new Set(red)).toEqual(new Set([0, 255]));
    expect(green).toEqual(red);
    expect(blue).toEqual(red);
    // About as much of each, so it neither lightens nor darkens on the whole.
    const white = red.filter((shade) => shade === 255).length;
    expect(white / red.length).toBeCloseTo(0.5, 1);
  });

  it('stays faint, spread over every alpha up to the strength', () => {
    const alphas = channel(3);
    expect(new Set(alphas)).toEqual(
      new Set(Array.from({ length: GRAIN_STRENGTH + 1 }, (_, at) => at)),
    );
    const mean = alphas.reduce((sum, alpha) => sum + alpha, 0) / alphas.length;
    expect(mean).toBeCloseTo(GRAIN_STRENGTH / 2, 0);
  });

  it('is the same on every start', () => {
    expect(grainPixels(64)).toEqual(pixels);
    expect(grainPixels(64, GRAIN_STRENGTH, 2)).not.toEqual(pixels);
  });
});
