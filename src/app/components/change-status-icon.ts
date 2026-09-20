import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

@Component({
  selector: 'app-change-status-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex h-3.5 w-3.5 shrink-0 items-center justify-center' },
  template: `
    <svg viewBox="0 0 12 12" class="h-full w-full" [attr.aria-label]="kind()">
      @switch (kind()) {
        @case ('A') {
          <circle cx="6" cy="6" r="6" fill="#34d399" />
          <path
            d="M6 3.3 6 8.7M3.3 6 8.7 6"
            fill="none"
            stroke="#04140d"
            stroke-width="1.3"
            stroke-linecap="round"
          />
        }
        @case ('D') {
          <circle cx="6" cy="6" r="6" fill="#fb7185" />
          <path
            d="M3.9 3.9 8.1 8.1M8.1 3.9 3.9 8.1"
            fill="none"
            stroke="#1a0508"
            stroke-width="1.3"
            stroke-linecap="round"
          />
        }
        @default {
          <circle cx="6" cy="6" r="6" fill="#ca8a04" />
          <path
            d="M3.4 6 8.6 6"
            fill="none"
            stroke="#1a1002"
            stroke-width="1.3"
            stroke-linecap="round"
          />
        }
      }
    </svg>
  `,
})
export class ChangeStatusIcon {
  readonly status = input<string | null>(null);
  protected readonly kind = computed(() => {
    switch (this.status()) {
      case 'A':
        return 'A';
      case 'D':
        return 'D';
      default:
        return 'M';
    }
  });
}