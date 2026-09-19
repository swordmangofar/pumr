import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

@Component({
  selector: 'app-tool-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    @if (labelKey(); as key) {
      <span
        class="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap"
        [class]="pillClass()"
      >
        {{ key | transloco }}
      </span>
    }
  `,
})
export class ToolStatus {
  readonly status = input.required<string>();

  protected readonly labelKey = computed<string | null>(() => {
    switch (this.status()) {
      case 'denied':
        return 'tools.permissionDenied';
      case 'canceled':
        return 'tools.canceled';
      case 'error':
        return 'tools.error';
      default:
        return null;
    }
  });

  protected readonly pillClass = computed(() => {
    switch (this.status()) {
      case 'error':
        return 'bg-rose-500/15 text-rose-300';
      case 'denied':
        return 'bg-amber-500/15 text-amber-300';
      case 'canceled':
        return 'bg-white/10 text-mist/50';
      default:
        return 'bg-white/10 text-mist/50';
    }
  });
}
