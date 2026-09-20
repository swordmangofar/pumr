import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { SpendSummary } from '../core/models';
import { WorkspaceService } from '../core/workspace.service';
import { SpendStatsDialog } from './spend-stats-dialog';

@Component({
  selector: 'app-spend-indicator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, SpendStatsDialog],
  template: `
    @if (workspace.spend(); as summary) {
      <button
        type="button"
        class="flex items-center gap-3 rounded-full border border-white/10 bg-white/5 py-1.5 pr-3.5 pl-3 text-sm transition-colors hover:border-accent/40 hover:bg-white/10"
        [attr.aria-label]="'stats.title' | transloco"
        (click)="open.set(true)"
      >
        <span class="flex h-6 w-6 items-center justify-center rounded-full bg-accent/15 text-accent">
          <svg
            viewBox="0 0 24 24"
            class="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
          </svg>
        </span>

        <span class="flex flex-col items-start leading-none">
          <span class="text-[10px] font-medium tracking-wide text-mist/40 uppercase">
            {{ 'app.today' | transloco }}
          </span>
          <span class="mt-0.5 font-medium text-white">{{ money(summary.todayCost) }}</span>
        </span>

        @if (hasBudget(summary)) {
          <span class="h-6 w-px bg-white/10"></span>
          <span class="flex flex-col items-start gap-1 leading-none">
            <span class="flex items-baseline gap-1.5">
              <span class="font-medium" [class]="accentClass(summary)">
                {{ money(summary.remainingUsd) }}
              </span>
              <span class="text-[10px] tracking-wide text-mist/40 uppercase">
                {{ 'app.remaining' | transloco }}
              </span>
            </span>
            <span class="flex items-center gap-2">
              <span class="block h-1 w-20 overflow-hidden rounded-full bg-white/10">
                <span
                  class="block h-full rounded-full transition-all"
                  [class]="barClass(summary)"
                  [style.width.%]="usedPercent(summary)"
                ></span>
              </span>
              <span class="text-[10px] text-mist/40">
                {{ money(summary.totalCost) }} / {{ money(summary.budgetUsd) }}
              </span>
            </span>
          </span>
        }
      </button>

      @if (open()) {
        <app-spend-stats-dialog (closed)="open.set(false)" />
      }
    }
  `,
})
export class SpendIndicator {
  protected readonly workspace = inject(WorkspaceService);
  protected readonly open = signal(false);

  protected hasBudget(summary: SpendSummary): boolean {
    return summary.budgetUsd > 0 && summary.remainingUsd !== null;
  }

  protected usedPercent(summary: SpendSummary): number {
    if (summary.budgetUsd <= 0) {
      return 0;
    }
    return Math.min(100, Math.round((summary.totalCost / summary.budgetUsd) * 100));
  }

  protected barClass(summary: SpendSummary): string {
    const percent = this.usedPercent(summary);
    if (percent >= 90) {
      return 'bg-rose-400';
    }
    if (percent >= 70) {
      return 'bg-amber-400';
    }
    return 'bg-emerald-400';
  }

  protected accentClass(summary: SpendSummary): string {
    const percent = this.usedPercent(summary);
    if (percent >= 90) {
      return 'text-rose-400';
    }
    if (percent >= 70) {
      return 'text-amber-400';
    }
    return 'text-emerald-400';
  }

  protected money(value: number | null | undefined): string {
    if (value === null || value === undefined) {
      return '—';
    }
    if (value === 0) {
      return '$0.00';
    }
    return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
  }
}