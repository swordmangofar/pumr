import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

@Component({
  selector: 'app-agent-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (status()) {
      @case ('running') {
        <span
          class="inline-block animate-spin rounded-full border-2 border-accent border-t-transparent"
          [class]="sizeClass()"
        ></span>
      }
      @case ('done') {
        <span
          class="flex items-center justify-center rounded-full bg-emerald-500/20 text-emerald-300"
          [class]="sizeClass()"
        >
          <svg
            viewBox="0 0 12 12"
            class="h-2.5 w-2.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M2.5 6.5 5 9l4.5-5" />
          </svg>
        </span>
      }
      @case ('error') {
        <span
          class="flex items-center justify-center rounded-full bg-rose-500/20 text-rose-300"
          [class]="sizeClass()"
        >
          <svg
            viewBox="0 0 12 12"
            class="h-2.5 w-2.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </span>
      }
      @case ('stopped') {
        <span
          class="flex items-center justify-center rounded-full bg-white/10 text-mist/60"
          [class]="sizeClass()"
        >
          <svg viewBox="0 0 12 12" class="h-2 w-2" fill="currentColor">
            <rect x="3" y="3" width="6" height="6" rx="1" />
          </svg>
        </span>
      }
      @default {
        <span class="inline-block rounded-full border border-white/20" [class]="sizeClass()"></span>
      }
    }
  `,
})
export class AgentStatus {
  readonly status = input<string | null>(null);
  readonly small = input(false);
  protected readonly sizeClass = computed(() => (this.small() ? 'h-3 w-3' : 'h-3.5 w-3.5'));
}
