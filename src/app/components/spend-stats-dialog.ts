import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  output,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { api, isTauri } from '../core/api';
import { SessionSpend, SpendStats } from '../core/models';

type RangeFilter = 'today' | 'week' | 'month' | 'custom';

interface Bar {
  key: string;
  label: string;
  cost: number;
  height: number;
}

interface SessionNode {
  session: SessionSpend;
  depth: number;
}

import { TypedInput } from './typed-input';

@Component({
  selector: 'app-spend-stats-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TypedInput, TranslocoPipe],
  host: {
    '(document:keydown.escape)': 'close()',
  },
  template: `
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      (click)="close()"
    >
      <div
        class="flex h-[86vh] w-[68rem] max-w-full flex-col overflow-hidden glass-pop rounded-2xl shadow-2xl"
        (click)="$event.stopPropagation()"
      >
        <header class="flex shrink-0 items-center justify-between border-b border-white/5 px-6 py-4">
          <div class="flex items-center gap-3">
            <span class="flex h-8 w-8 items-center justify-center rounded-full bg-accent/15 text-accent">
              <svg
                viewBox="0 0 24 24"
                class="h-4 w-4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M3 3v18h18" />
                <path d="M18 17V9M13 17V5M8 17v-3" />
              </svg>
            </span>
            <h2 class="text-base font-semibold text-white">{{ 'stats.title' | transloco }}</h2>
          </div>
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-full text-mist/50 transition-colors hover:bg-white/5 hover:text-white"
            (click)="close()"
          >
            ✕
          </button>
        </header>

        <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/5 px-6 py-3">
          @for (option of filters; track option.id) {
            <button
              type="button"
              class="rounded-full px-4 py-1.5 text-sm transition-colors"
              [class]="
                option.id === filter()
                  ? 'bg-accent font-medium text-ink'
                  : 'text-mist/50 hover:bg-white/5 hover:text-mist'
              "
              (click)="selectFilter(option.id)"
            >
              {{ option.label | transloco }}
            </button>
          }
          @if (filter() === 'custom') {
            <div class="ml-auto flex items-center gap-2 text-sm">
              <label class="text-mist/40" for="stats-from">{{ 'stats.from' | transloco }}</label>
              <input
                id="stats-from"
                type="date"
                class="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-mist outline-none focus:border-accent/50"
                [value]="customFrom()"
                (typedValue)="customFrom.set($event)"
              />
              <label class="text-mist/40" for="stats-to">{{ 'stats.to' | transloco }}</label>
              <input
                id="stats-to"
                type="date"
                class="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-mist outline-none focus:border-accent/50"
                [value]="customTo()"
                (typedValue)="customTo.set($event)"
              />
            </div>
          }
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          @if (error()) {
            <div class="py-16 text-center text-sm text-rose-300">{{ 'stats.error' | transloco }}</div>
          } @else if (loading() && !stats()) {
            <div class="py-16 text-center text-sm text-mist/40">{{ 'stats.loading' | transloco }}</div>
          } @else if (stats(); as summary) {
            @if (summary.messages === 0) {
              <div class="py-16 text-center text-sm text-mist/40">{{ 'stats.noData' | transloco }}</div>
            } @else {
              <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div class="glass-inset rounded-xl px-4 py-3">
                  <div class="text-xs tracking-wide text-mist/40 uppercase">
                    {{ 'stats.totalSpend' | transloco }}
                  </div>
                  <div class="mt-1 text-2xl font-semibold text-white">{{ money(summary.totalCost) }}</div>
                  <div class="mt-0.5 text-xs text-mist/40">
                    {{ 'stats.average' | transloco }} {{ money(average()) }} /
                    {{ averageUnitKey() | transloco }}
                  </div>
                </div>
                <div class="glass-inset rounded-xl px-4 py-3">
                  <div class="text-xs tracking-wide text-mist/40 uppercase">
                    {{ 'stats.tokens' | transloco }}
                  </div>
                  <div class="mt-1 text-2xl font-semibold text-white">
                    {{ tokens(summary.promptTokens + summary.completionTokens) }}
                  </div>
                  <div class="mt-0.5 flex gap-3 text-xs text-mist/40">
                    <span>{{ 'stats.tokensIn' | transloco }} {{ tokens(summary.promptTokens) }}</span>
                    <span>{{ 'stats.tokensOut' | transloco }} {{ tokens(summary.completionTokens) }}</span>
                  </div>
                </div>
                <div class="glass-inset rounded-xl px-4 py-3">
                  <div class="text-xs tracking-wide text-mist/40 uppercase">
                    {{ 'stats.cached' | transloco }}
                  </div>
                  <div class="mt-1 text-2xl font-semibold text-white">{{ tokens(summary.cachedTokens) }}</div>
                  <div class="mt-0.5 text-xs text-mist/40">
                    {{ cacheRate(summary) }}% {{ 'stats.cacheRate' | transloco }}
                  </div>
                </div>
                <div class="glass-inset rounded-xl px-4 py-3">
                  <div class="text-xs tracking-wide text-mist/40 uppercase">
                    {{ 'stats.messages' | transloco }}
                  </div>
                  <div class="mt-1 text-2xl font-semibold text-white">{{ summary.messages }}</div>
                  <div class="mt-0.5 text-xs text-mist/40">
                    {{ summary.sessions }} {{ 'stats.sessions' | transloco }}
                  </div>
                </div>
              </div>

              <section class="mt-6">
                <h3 class="mb-3 text-sm font-medium text-mist/70">{{ spendTitleKey() | transloco }}</h3>
                <div class="glass-inset overflow-x-auto rounded-xl px-4 py-4">
                  <div class="relative flex h-40 items-end gap-1" [style.minWidth.px]="bars().length * 22">
                    <div
                      class="pointer-events-none absolute inset-x-0 border-t border-dashed border-accent/40"
                      [style.bottom.%]="averageHeight()"
                    ></div>
                    @for (bar of bars(); track bar.key) {
                      <div
                        class="group h-full min-w-5 flex-1 cursor-default"
                        (mouseenter)="hovered.set(bar)"
                        (mouseleave)="hovered.set(null)"
                      >
                        <div class="flex h-full flex-col justify-end">
                          <div
                            class="w-full rounded-t-md bg-accent/40 transition-colors group-hover:bg-accent"
                            [style.height.%]="bar.height"
                          ></div>
                        </div>
                      </div>
                    }
                  </div>
                  <div class="mt-2 flex justify-between text-[10px] text-mist/30">
                    <span>{{ bars().length > 0 ? bars()[0].label : '' }}</span>
                    <span class="text-mist/50">
                      @if (hovered(); as bar) {
                        {{ bar.label }} · <span class="text-accent">{{ money(bar.cost) }}</span>
                      } @else {
                        {{ 'stats.average' | transloco }} {{ money(average()) }}
                      }
                    </span>
                    <span>{{ bars().length > 0 ? bars()[bars().length - 1].label : '' }}</span>
                  </div>
                </div>
              </section>

              <section class="mt-6">
                <h3 class="mb-3 text-sm font-medium text-mist/70">{{ 'stats.byModel' | transloco }}</h3>
                <div class="space-y-2">
                  @for (model of summary.byModel; track model.model + (model.provider ?? '')) {
                    <div class="glass-inset rounded-xl px-4 py-3">
                      <div class="flex items-baseline justify-between gap-3">
                        <span class="truncate text-sm text-mist">{{ model.model }}</span>
                        <span class="shrink-0 text-sm font-medium text-white">
                          {{ money(model.cost) }}
                          <span class="ml-1 text-xs text-mist/40">
                            {{ percent(model.cost, summary.totalCost) }}%
                          </span>
                        </span>
                      </div>
                      <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                        <div
                          class="h-full rounded-full bg-accent/70"
                          [style.width.%]="percent(model.cost, summary.totalCost)"
                        ></div>
                      </div>
                      <div class="mt-2 flex flex-wrap gap-3 text-xs text-mist/40">
                        @if (model.provider) {
                          <span>{{ model.provider }}</span>
                        }
                        <span>{{ 'stats.tokens' | transloco }} {{ tokens(model.promptTokens + model.completionTokens) }}</span>
                        <span>{{ model.messages }} {{ 'stats.messages' | transloco }}</span>
                      </div>
                    </div>
                  }
                </div>
              </section>

              <section class="mt-6 pb-2">
                <h3 class="mb-3 text-sm font-medium text-mist/70">{{ 'stats.bySession' | transloco }}</h3>
                <div class="space-y-1">
                  @for (node of sessionTree(); track node.session.sessionId) {
                    <div
                      class="flex items-center gap-3 rounded-xl px-4 py-2.5"
                      [class]="node.depth > 0 ? 'ml-6 bg-white/[0.03]' : 'glass-inset'"
                    >
                      <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/5 text-xs text-mist/50">
                        @if (node.depth > 0) {
                          ↳
                        } @else {
                          {{ sessionInitial(node.session) }}
                        }
                      </span>
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-sm text-mist">{{ node.session.title }}</div>
                        <div class="mt-0.5 text-xs text-mist/40">
                          @if (node.depth > 0) {
                            {{ 'stats.subagent' | transloco }} ·
                          }
                          {{ node.session.messages }} {{ 'stats.messages' | transloco }} ·
                          {{ tokens(node.session.promptTokens + node.session.completionTokens) }}
                          {{ 'stats.tokens' | transloco }}
                        </div>
                      </div>
                      <span class="shrink-0 text-sm font-medium text-white">
                        {{ money(node.session.cost) }}
                      </span>
                    </div>
                  }
                </div>
              </section>
            }
          }
        </div>
      </div>
    </div>
  `,
})
export class SpendStatsDialog {
  readonly closed = output<void>();

  protected readonly filters: { id: RangeFilter; label: string }[] = [
    { id: 'today', label: 'stats.today' },
    { id: 'week', label: 'stats.week' },
    { id: 'month', label: 'stats.month' },
    { id: 'custom', label: 'stats.custom' },
  ];

  protected readonly filter = signal<RangeFilter>('week');
  protected readonly customFrom = signal(this.dateValue(this.startOfDaysAgo(6)));
  protected readonly customTo = signal(this.dateValue(new Date()));
  protected readonly stats = signal<SpendStats | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal(false);
  protected readonly hovered = signal<Bar | null>(null);

  private requestToken = 0;
  private readonly tauri = isTauri();

  constructor() {
    effect(() => {
      const { from, to } = this.range();
      void this.load(from, to, this.bucket());
    });
  }

  protected selectFilter(id: RangeFilter): void {
    this.filter.set(id);
  }

  protected readonly bucket = computed<'day' | 'hour'>(() =>
    this.filter() === 'today' ? 'hour' : 'day',
  );

  protected readonly averageUnitKey = computed(() =>
    this.bucket() === 'hour' ? 'stats.hour' : 'stats.day',
  );

  protected readonly spendTitleKey = computed(() =>
    this.bucket() === 'hour' ? 'stats.spendPerHour' : 'stats.spendPerDay',
  );

  private readonly range = computed(() => {
    const now = new Date();
    const endOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
      999,
    ).getTime();
    switch (this.filter()) {
      case 'today':
        return { from: this.startOfDay(now).getTime(), to: endOfToday };
      case 'month':
        return { from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), to: endOfToday };
      case 'custom': {
        const from = this.parseDate(this.customFrom());
        const to = this.parseDate(this.customTo());
        if (from === null || to === null) {
          return { from: this.startOfDaysAgo(6).getTime(), to: endOfToday };
        }
        return {
          from: Math.min(from, to),
          to: this.endOfDay(new Date(Math.max(from, to))),
        };
      }
      case 'week':
      default:
        return { from: this.startOfDaysAgo(6).getTime(), to: endOfToday };
    }
  });

  protected readonly bars = computed<Bar[]>(() => {
    const summary = this.stats();
    const { from, to } = this.range();
    if (!summary) {
      return [];
    }
    const costs = new Map(summary.daily.map((entry) => [entry.date, entry.cost]));
    const end = new Date(to);
    const out: { key: string; label: string; cost: number }[] = [];
    if (this.bucket() === 'hour') {
      const cursor = new Date(from);
      cursor.setMinutes(0, 0, 0);
      let guard = 0;
      while (cursor.getTime() <= end.getTime() && guard < 24) {
        const key = this.hourKey(cursor);
        out.push({ key, label: this.hourLabel(cursor), cost: costs.get(key) ?? 0 });
        cursor.setHours(cursor.getHours() + 1);
        guard += 1;
      }
    } else {
      const cursor = new Date(from);
      cursor.setHours(0, 0, 0, 0);
      let guard = 0;
      while (cursor.getTime() <= end.getTime() && guard < 1500) {
        const key = this.dateKey(cursor);
        out.push({ key, label: this.shortDate(cursor), cost: costs.get(key) ?? 0 });
        cursor.setDate(cursor.getDate() + 1);
        guard += 1;
      }
    }
    const max = Math.max(...out.map((item) => item.cost), 0.0001);
    return out.map((item) => ({ ...item, height: (item.cost / max) * 100 }));
  });

  protected readonly average = computed(() => {
    const list = this.bars();
    if (list.length === 0) {
      return 0;
    }
    return list.reduce((sum, bar) => sum + bar.cost, 0) / list.length;
  });

  protected readonly averageHeight = computed(() => {
    const max = Math.max(...this.bars().map((bar) => bar.cost), 0.0001);
    return (this.average() / max) * 100;
  });

  protected readonly sessionTree = computed<SessionNode[]>(() => {
    const summary = this.stats();
    if (!summary) {
      return [];
    }
    const ids = new Set(summary.bySession.map((session) => session.sessionId));
    const children = new Map<string, SessionSpend[]>();
    const roots: SessionSpend[] = [];
    for (const session of summary.bySession) {
      if (session.parentSessionId && ids.has(session.parentSessionId)) {
        const list = children.get(session.parentSessionId) ?? [];
        list.push(session);
        children.set(session.parentSessionId, list);
      } else {
        roots.push(session);
      }
    }
    const out: SessionNode[] = [];
    const visit = (session: SessionSpend, depth: number): void => {
      out.push({ session, depth });
      for (const child of children.get(session.sessionId) ?? []) {
        visit(child, depth + 1);
      }
    };
    for (const root of roots) {
      visit(root, 0);
    }
    return out;
  });

  private async load(from: number, to: number, bucket: 'day' | 'hour'): Promise<void> {
    if (!this.tauri) {
      this.error.set(true);
      return;
    }
    const token = ++this.requestToken;
    this.loading.set(true);
    this.error.set(false);
    try {
      const result = await api.getSpendStats(from, to, bucket);
      if (token === this.requestToken) {
        this.stats.set(result);
      }
    } catch {
      if (token === this.requestToken) {
        this.error.set(true);
      }
    } finally {
      if (token === this.requestToken) {
        this.loading.set(false);
      }
    }
  }

  protected close(): void {
    this.closed.emit();
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

  protected tokens(value: number): string {
    if (value >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(1)}M`;
    }
    if (value >= 1_000) {
      return `${(value / 1_000).toFixed(1)}k`;
    }
    return `${value}`;
  }

  protected percent(value: number, total: number): number {
    if (total <= 0) {
      return 0;
    }
    return Math.round((value / total) * 100);
  }

  protected cacheRate(summary: SpendStats): number {
    if (summary.promptTokens <= 0) {
      return 0;
    }
    return Math.round((summary.cachedTokens / summary.promptTokens) * 100);
  }

  protected sessionInitial(session: SessionSpend): string {
    return session.title.trim().charAt(0).toUpperCase() || '·';
  }

  private startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  private endOfDay(date: Date): number {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).getTime();
  }

  private startOfDaysAgo(days: number): Date {
    const date = this.startOfDay(new Date());
    date.setDate(date.getDate() - days);
    return date;
  }

  private parseDate(value: string): number | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
      return null;
    }
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  }

  private dateValue(date: Date): string {
    return this.dateKey(date);
  }

  private dateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private hourKey(date: Date): string {
    const hour = String(date.getHours()).padStart(2, '0');
    return `${this.dateKey(date)} ${hour}:00`;
  }

  private hourLabel(date: Date): string {
    return `${String(date.getHours()).padStart(2, '0')}:00`;
  }

  private shortDate(date: Date): string {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}.${month}.`;
  }
}