import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

interface Pixel {
  readonly x: number;
  readonly y: number;
}

interface TonedPixel extends Pixel {
  readonly opacity: number;
}

export const SPINNER_CELLS: readonly Pixel[] = [
  { x: 1, y: 0 },
  { x: 2, y: 0 },
  { x: 2, y: 1 },
  { x: 2, y: 2 },
  { x: 1, y: 2 },
  { x: 0, y: 2 },
  { x: 0, y: 1 },
  { x: 0, y: 0 },
];

/** Opacity of a cell by how far it trails the brightest one: a dim gap that runs around the ring. */
const SPINNER_TONES: readonly number[] = [1, 0.78, 0.56, 0.34, 0.12, 0.34, 0.56, 0.78];

/** The ring once per step of the animation, with the tones moved on by a cell each time. */
export const SPINNER_FRAMES: readonly (readonly TonedPixel[])[] = SPINNER_CELLS.map((_, frame) =>
  SPINNER_CELLS.map((cell, index) => ({
    ...cell,
    opacity: SPINNER_TONES[(frame - index + SPINNER_CELLS.length) % SPINNER_CELLS.length],
  })),
);

/**
 * The spinner is a sprite of whole frames (see `.puma-frame`) rather than
 * eight cells that each fade on their own. A frame change repaints the spinner
 * as one area a few times a second. Separately animated cells repaint on every
 * display frame as many small areas, and WebKit without GPU compositing
 * (WebKitGTK on X11) redraws everything between them once a frame has more
 * than ten: two spinners and a streaming caret froze the window that way.
 */
@Component({
  selector: 'app-puma-spinner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      class="puma-spinner"
      viewBox="0 0 3 3"
      shape-rendering="crispEdges"
      aria-hidden="true"
      [class]="sizeClass()"
    >
      @for (frame of frames; track $index) {
        <g [class]="'puma-frame puma-frame-' + $index">
          @for (cell of frame; track $index) {
            <rect
              [attr.x]="cell.x"
              [attr.y]="cell.y"
              width="1"
              height="1"
              fill="currentColor"
              [attr.opacity]="cell.opacity"
            />
          }
        </g>
      }
    </svg>
  `,
})
export class PumaSpinner {
  readonly small = input(false);
  protected readonly frames = SPINNER_FRAMES;
  protected readonly sizeClass = computed(() => (this.small() ? 'h-3 w-3' : 'h-5 w-5'));
}
