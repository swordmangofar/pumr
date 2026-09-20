import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  FRAME_DATA,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  SIT_FRAME_DATA,
  SIT_HEIGHT,
  SIT_WIDTH,
} from '../core/puma-art';
import { PumaSpinner } from './puma-spinner';

interface Pixel {
  readonly x: number;
  readonly y: number;
}

function toPixels(rows: readonly string[]): readonly Pixel[] {
  const pixels: Pixel[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] === '#') {
        pixels.push({ x, y });
      }
    }
  });
  return pixels;
}

const FRAMES = FRAME_DATA.map(toPixels);
const SIT_FRAME = toPixels(SIT_FRAME_DATA);

@Component({
  selector: 'app-puma-loader',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, PumaSpinner],
  template: `
    <div [class]="compact() ? 'flex items-center' : 'flex flex-col items-center gap-6'">
      <svg
        class="puma-sprite text-accent"
        [class.puma-sprite-sm]="compact() && pose() === 'run'"
        [class.puma-sprite-sit]="pose() === 'sit'"
        [attr.viewBox]="viewBox()"
        shape-rendering="crispEdges"
        [attr.role]="pose() === 'sit' ? null : 'img'"
        [attr.aria-hidden]="pose() === 'sit' ? 'true' : null"
        [attr.aria-label]="pose() === 'sit' ? null : ('common.loading' | transloco)"
      >
        @if (pose() === 'sit') {
          @for (pixel of sitFrame; track pixel.y * width + pixel.x) {
            <rect [attr.x]="pixel.x" [attr.y]="pixel.y" width="1" height="1" fill="currentColor" />
          }
        } @else {
          @for (frame of frames; track $index) {
            <g [class]="'puma-frame puma-frame-' + $index">
              @for (pixel of frame; track pixel.y * width + pixel.x) {
                <rect
                  [attr.x]="pixel.x"
                  [attr.y]="pixel.y"
                  width="1"
                  height="1"
                  fill="currentColor"
                />
              }
            </g>
          }
        }
      </svg>

      @if (!compact() && pose() === 'run') {
        <div class="flex items-center gap-2.5">
          <app-puma-spinner class="text-accent" />
          <span class="text-sm tracking-wide text-mist/50">{{ 'common.loading' | transloco }}</span>
        </div>
      }
    </div>
  `,
})
export class PumaLoader {
  readonly compact = input(false);
  readonly pose = input<'run' | 'sit'>('run');
  protected readonly width = FRAME_WIDTH;
  protected readonly viewBox = computed(() =>
    this.pose() === 'sit' ? `0 0 ${SIT_WIDTH} ${SIT_HEIGHT}` : `0 0 ${FRAME_WIDTH} ${FRAME_HEIGHT}`,
  );
  protected readonly frames = FRAMES;
  protected readonly sitFrame = SIT_FRAME;
}
