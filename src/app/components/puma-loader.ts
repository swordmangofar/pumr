import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  FRAME_DATA,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  PROMPT_FRAME_DATA,
  PROMPT_HEIGHT,
  PROMPT_WIDTH,
  SIT_FRAME_DATA,
  SIT_HEIGHT,
  SIT_WIDTH,
} from '../core/puma-art';
import { PumaSpinner } from './puma-spinner';

interface Pixel {
  readonly x: number;
  readonly y: number;
}

interface TonePixels {
  readonly primary: readonly Pixel[];
  readonly secondary: readonly Pixel[];
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

function toTonePixels(rows: readonly string[]): TonePixels {
  const primary: Pixel[] = [];
  const secondary: Pixel[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      const cell = row[x];
      if (cell === '#') {
        primary.push({ x, y });
      } else if (cell === 'o') {
        secondary.push({ x, y });
      }
    }
  });
  return { primary, secondary };
}

const FRAMES = FRAME_DATA.map(toPixels);
const SIT_FRAME = toPixels(SIT_FRAME_DATA);
const PROMPT_FRAMES = toTonePixels(PROMPT_FRAME_DATA);

type PumaPose = 'run' | 'sit' | 'prompt';

@Component({
  selector: 'app-puma-loader',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, PumaSpinner],
  template: `
    <div [class]="compact() ? 'flex items-center' : 'flex flex-col items-center gap-6'">
      <svg
        class="puma-sprite"
        [class.text-accent]="pose() !== 'prompt'"
        [class.text-sky-400]="pose() === 'prompt'"
        [class.puma-sprite-sm]="compact() && pose() === 'run'"
        [class.puma-sprite-sit]="pose() === 'sit'"
        [class.puma-sprite-prompt]="pose() === 'prompt'"
        [attr.viewBox]="viewBox()"
        shape-rendering="crispEdges"
        [attr.role]="pose() === 'run' ? 'img' : null"
        [attr.aria-hidden]="pose() === 'run' ? null : 'true'"
        [attr.aria-label]="pose() === 'run' ? ('common.loading' | transloco) : null"
      >
        @switch (pose()) {
          @case ('prompt') {
            @for (pixel of promptPrimary; track pixel.y * width + pixel.x) {
              <rect [attr.x]="pixel.x" [attr.y]="pixel.y" width="1" height="1" fill="currentColor" />
            }
            @for (pixel of promptSecondary; track pixel.y * width + pixel.x) {
              <rect
                class="text-sky-200"
                [attr.x]="pixel.x"
                [attr.y]="pixel.y"
                width="1"
                height="1"
                fill="currentColor"
              />
            }
          }
          @case ('sit') {
            @for (pixel of sitFrame; track pixel.y * width + pixel.x) {
              <rect [attr.x]="pixel.x" [attr.y]="pixel.y" width="1" height="1" fill="currentColor" />
            }
          }
          @default {
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
  readonly pose = input<PumaPose>('run');
  protected readonly width = FRAME_WIDTH;
  protected readonly viewBox = computed(() => {
    switch (this.pose()) {
      case 'sit':
        return `0 0 ${SIT_WIDTH} ${SIT_HEIGHT}`;
      case 'prompt':
        return `0 0 ${PROMPT_WIDTH} ${PROMPT_HEIGHT}`;
      default:
        return `0 0 ${FRAME_WIDTH} ${FRAME_HEIGHT}`;
    }
  });
  protected readonly frames = FRAMES;
  protected readonly sitFrame = SIT_FRAME;
  protected readonly promptPrimary = PROMPT_FRAMES.primary;
  protected readonly promptSecondary = PROMPT_FRAMES.secondary;
}
