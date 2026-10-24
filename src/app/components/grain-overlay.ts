import { Directive } from '@angular/core';

/** Side of the square noise tile in pixels, large enough that its repeat never shows. */
export const GRAIN_TILE = 128;

/**
 * Highest alpha of a grain pixel, out of 255. A white pixel at 4 lifts a dark
 * colour by about four levels and a black one lowers a light colour as much,
 * while either leaves the other end of the scale nearly untouched.
 */
export const GRAIN_STRENGTH = 4;

/** Seeded generator (mulberry32), so the grain is the same on every start. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * RGBA pixels of a `size` square noise tile: every pixel is white or black, at
 * a random alpha between none and `strength`.
 */
export function grainPixels(
  size = GRAIN_TILE,
  strength = GRAIN_STRENGTH,
  seed = 1,
): Uint8ClampedArray {
  const next = random(seed);
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let at = 0; at < pixels.length; at += 4) {
    const shade = next() < 0.5 ? 0 : 255;
    pixels[at] = shade;
    pixels[at + 1] = shade;
    pixels[at + 2] = shade;
    pixels[at + 3] = Math.floor(next() * (strength + 1));
  }
  return pixels;
}

/** The noise tile as a CSS image, or `none` where there is no canvas to encode it. */
function grainImage(): string {
  const canvas = document.createElement('canvas');
  canvas.width = GRAIN_TILE;
  canvas.height = GRAIN_TILE;
  const context = canvas.getContext('2d');
  if (!context) {
    return 'none';
  }
  const image = context.createImageData(GRAIN_TILE, GRAIN_TILE);
  image.data.set(grainPixels());
  context.putImageData(image, 0, 0);
  return `url(${canvas.toDataURL()})`;
}

/**
 * Lays faint noise over the whole window. WebKit does not dither gradients,
 * so the dark theme glows and the glass sheen fade in steps of one colour
 * level, wide enough to see as bands; the noise breaks up their edges.
 */
@Directive({
  selector: 'div[appGrain]',
  host: { '[style.background-image]': 'image' },
})
export class GrainOverlay {
  protected readonly image = grainImage();
}
