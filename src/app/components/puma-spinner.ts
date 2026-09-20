import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

interface Pixel {
  readonly x: number;
  readonly y: number;
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

@Component({
  selector: 'app-puma-spinner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg viewBox="0 0 3 3" shape-rendering="crispEdges" aria-hidden="true" [class]="sizeClass()">
      @for (cell of spinnerCells; track $index) {
        <rect
          class="puma-spinner-dot"
          [attr.x]="cell.x"
          [attr.y]="cell.y"
          width="1"
          height="1"
          fill="currentColor"
          [style.animation-delay.ms]="$index * 90"
        />
      }
    </svg>
  `,
})
export class PumaSpinner {
  readonly small = input(false);
  protected readonly spinnerCells = SPINNER_CELLS;
  protected readonly sizeClass = computed(() => (this.small() ? 'h-3 w-3' : 'h-5 w-5'));
}
