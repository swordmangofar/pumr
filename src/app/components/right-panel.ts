import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { ModelsService } from '../core/models.service';
import { WorkspaceService } from '../core/workspace.service';
import { DiffView } from './diff-view';
import { ModesPanel } from './modes-panel';
import { SystemPromptsPanel } from './system-prompts-panel';

@Component({
  selector: 'app-right-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, DiffView, SystemPromptsPanel, ModesPanel],
  template: `
    <div class="flex h-full flex-col">
      <div class="shrink-0 p-2.5">
        <div class="flex gap-1 rounded-xl bg-white/5 p-1">
          <button
            type="button"
            class="flex flex-1 items-center justify-center rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
            [class]="
              tab() === 'changes'
                ? 'bg-white/10 text-white shadow-sm'
                : 'text-mist/50 hover:text-mist'
            "
            (click)="tab.set('changes')"
          >
            {{ 'right.files' | transloco }}
            @if (changes().length > 0) {
              <span class="ml-1.5 rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent">
                {{ changes().length }}
              </span>
            }
          </button>
          <button
            type="button"
            class="flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
            [class]="
              tab() === 'session'
                ? 'bg-white/10 text-white shadow-sm'
                : 'text-mist/50 hover:text-mist'
            "
            (click)="tab.set('session')"
          >
            {{ 'right.session' | transloco }}
          </button>
          <button
            type="button"
            class="flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
            [class]="
              tab() === 'prompts'
                ? 'bg-white/10 text-white shadow-sm'
                : 'text-mist/50 hover:text-mist'
            "
            (click)="tab.set('prompts')"
          >
            {{ 'right.systemPrompts' | transloco }}
          </button>
          <button
            type="button"
            class="flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
            [class]="
              tab() === 'modes'
                ? 'bg-white/10 text-white shadow-sm'
                : 'text-mist/50 hover:text-mist'
            "
            (click)="tab.set('modes')"
          >
            {{ 'right.modes' | transloco }}
          </button>
        </div>
      </div>

      @if (tab() === 'changes') {
        <section class="max-h-56 shrink-0 overflow-y-auto border-b border-white/5 py-1">
          @for (change of changes(); track change.path) {
            <button
              type="button"
              class="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm transition-colors hover:bg-white/5"
              [class]="isSelected(change.path) ? 'bg-accent/10 text-white' : 'text-mist/60'"
              (click)="select(change.path)"
            >
              <span class="w-3 shrink-0 text-xs font-semibold" [class]="statusColor(change.status)">
                {{ change.status || 'M' }}
              </span>
              <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ change.path }}</span>
              @if (change.additions > 0) {
                <span class="shrink-0 text-xs text-emerald-400">+{{ change.additions }}</span>
              }
              @if (change.deletions > 0) {
                <span class="shrink-0 text-xs text-rose-400">-{{ change.deletions }}</span>
              }
            </button>
          } @empty {
            <p class="px-4 py-4 text-sm leading-relaxed text-mist/40">
              {{ 'right.noFiles' | transloco }}
            </p>
          }
        </section>

        <section class="relative min-h-0 flex-1">
          @if (workspace.activeDiff(); as diff) {
            <button
              type="button"
              class="absolute right-3 top-3 z-10 rounded-full border border-white/10 bg-navy/90 px-3 py-1 text-xs text-mist backdrop-blur transition-colors hover:border-accent/50 hover:text-white"
              (click)="overlay.set(true)"
            >
              ⛶ {{ 'right.expand' | transloco }}
            </button>
            <app-diff-view [diff]="diff" />
          } @else {
            <p class="px-4 py-5 text-sm text-mist/40">{{ 'right.selectFile' | transloco }}</p>
          }
        </section>
      } @else if (tab() === 'session') {
        <div class="min-h-0 flex-1 overflow-y-auto">
          @if (session(); as active) {
            <section class="border-b border-white/5 p-4">
              <h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-mist/40">
                {{ 'right.prompts' | transloco }}
              </h3>
              <div class="max-h-80 space-y-1.5 overflow-y-auto pr-1">
                @for (prompt of prompts(); track prompt.id) {
                  <button
                    type="button"
                    class="line-clamp-2 w-full glass-inset rounded-xl px-3 py-2 text-left text-sm leading-snug text-mist/60 transition-colors hover:border-accent/40 hover:bg-white/5 hover:text-white"
                    [title]="prompt.content"
                    (click)="goToPrompt(prompt.id)"
                  >
                    {{ prompt.content }}
                  </button>
                } @empty {
                  <p class="text-sm leading-relaxed text-mist/40">
                    {{ 'right.noPrompts' | transloco }}
                  </p>
                }
              </div>
            </section>

            <section class="border-b border-white/5 p-4">
              <h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-mist/40">
                {{ 'right.stats' | transloco }}
              </h3>
              <dl class="space-y-2 text-sm">
                <div class="flex items-start justify-between gap-3">
                  <dt class="text-mist/40">{{ 'right.model' | transloco }}</dt>
                  <dd class="max-w-56 truncate text-right text-mist">{{ active.model ?? '—' }}</dd>
                </div>
                <div class="flex items-start justify-between gap-3">
                  <dt class="text-mist/40">{{ 'right.provider' | transloco }}</dt>
                  <dd class="text-right text-mist">
                    @if (providerKey(active.provider); as key) {
                      {{ key | transloco }}
                    } @else {
                      {{ active.provider || ('provider.auto' | transloco) }}
                    }
                  </dd>
                </div>
                <div class="flex items-start justify-between gap-3">
                  <dt class="text-mist/40">{{ 'right.cacheRate' | transloco }}</dt>
                  <dd class="text-right text-mist">{{ cacheRate() }}%</dd>
                </div>
                <div class="flex items-start justify-between gap-3">
                  <dt class="text-mist/40">{{ 'right.tokensIn' | transloco }}</dt>
                  <dd class="text-right text-mist">{{ active.promptTokens.toLocaleString() }}</dd>
                </div>
                <div class="flex items-start justify-between gap-3">
                  <dt class="text-mist/40">{{ 'right.tokensOut' | transloco }}</dt>
                  <dd class="text-right text-mist">
                    {{ active.completionTokens.toLocaleString() }}
                  </dd>
                </div>
                <div class="flex items-start justify-between gap-3">
                  <dt class="text-mist/40">{{ 'right.contextLength' | transloco }}</dt>
                  <dd class="text-right text-mist">{{ contextLength() }}</dd>
                </div>
                <div class="flex items-start justify-between gap-3">
                  <dt class="text-mist/40">{{ 'right.cost' | transloco }}</dt>
                  <dd class="text-right font-medium text-accent">{{ money(active.cost) }}</dd>
                </div>
              </dl>
            </section>

            <section class="p-4">
              <h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-mist/40">
                {{ 'right.rules' | transloco }}
              </h3>
              @for (rule of workspace.rules(); track rule.path) {
                <details class="mb-1.5 glass-inset rounded-xl">
                  <summary class="cursor-pointer px-3 py-2 text-xs text-mist/60">
                    <span class="mr-1.5 rounded-full bg-white/5 px-2 py-0.5 text-mist/50">{{
                      rule.scope
                    }}</span>
                    <span class="font-mono">{{ rule.path }}</span>
                  </summary>
                  <pre
                    class="max-h-60 overflow-auto border-t border-white/5 px-3 py-2 text-xs whitespace-pre-wrap text-mist/60"
                    >{{ rule.content }}</pre>
                </details>
              } @empty {
                <p class="text-sm leading-relaxed text-mist/40">
                  {{ 'right.noRules' | transloco }}
                </p>
              }
            </section>
          } @else {
            <p class="p-4 text-sm text-mist/40">{{ 'right.session' | transloco }}</p>
          }
        </div>
      } @else if (tab() === 'prompts') {
        <app-system-prompts-panel />
      } @else {
        <app-modes-panel />
      }
    </div>

    @if (overlay() && workspace.activeDiff(); as diff) {
      <div class="fixed inset-0 z-50 flex flex-col bg-ink">
        <header
          class="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-3"
        >
          <span class="font-mono text-sm text-mist">{{ diff.path }}</span>
          <div class="flex items-center gap-4 text-sm">
            <span class="text-emerald-400">+{{ diff.additions }}</span>
            <span class="text-rose-400">-{{ diff.deletions }}</span>
            <button
              type="button"
              class="rounded-full border border-white/15 px-4 py-1.5 text-sm text-mist transition-colors hover:bg-white/5"
              (click)="overlay.set(false)"
            >
              {{ 'common.close' | transloco }}
            </button>
          </div>
        </header>
        <div class="min-h-0 flex-1">
          <app-diff-view [diff]="diff" [sideBySide]="true" />
        </div>
      </div>
    }
  `,
})
export class RightPanel {
  protected readonly workspace = inject(WorkspaceService);
  private readonly models = inject(ModelsService);

  protected readonly tab = signal<'changes' | 'session' | 'prompts' | 'modes'>('changes');
  protected readonly overlay = signal(false);
  protected readonly session = this.workspace.activeSession;
  protected readonly sessionId = computed(() => this.session()?.id ?? null);
  protected readonly changes = computed(() => {
    const id = this.sessionId();
    return id ? this.workspace.changesFor(id) : [];
  });

  protected readonly prompts = computed(() => {
    const id = this.sessionId();
    if (!id) {
      return [];
    }
    return this.workspace.messagesFor(id).filter((message) => message.role === 'user');
  });

  protected readonly cacheRate = computed(() => {
    const session = this.session();
    if (!session || !session.promptTokens) {
      return '0.0';
    }
    return ((session.cachedTokens / session.promptTokens) * 100).toFixed(1);
  });

  protected readonly contextLength = computed(() => {
    const model = this.models.byId(this.session()?.model);
    if (!model?.contextLength) {
      return '—';
    }
    return `${Math.round(model.contextLength / 1000)}k`;
  });

  protected isSelected(path: string): boolean {
    const id = this.sessionId();
    return id ? path === this.workspace.selectedPathFor(id) : false;
  }

  protected statusColor(status: string): string {
    switch (status) {
      case 'A':
        return 'text-emerald-400';
      case 'D':
        return 'text-rose-400';
      default:
        return 'text-accent';
    }
  }

  protected select(path: string): void {
    const id = this.sessionId();
    if (id) {
      void this.workspace.selectChange(id, path);
    }
  }

  protected goToPrompt(messageId: string): void {
    this.workspace.scrollToMessage(messageId);
  }

  protected money(value: number): string {
    return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
  }

  protected providerKey(provider: string | null | undefined): string | null {
    switch (provider) {
      case 'auto:throughput':
        return 'provider.presetThroughput';
      case 'auto:price':
        return 'provider.presetPrice';
      case 'auto:value':
        return 'provider.presetValue';
      default:
        return null;
    }
  }
}
