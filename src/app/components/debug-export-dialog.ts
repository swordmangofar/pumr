import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  OnInit,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { homeDir } from '@tauri-apps/api/path';
import { ANONYMIZE_CANCEL_KEY, api } from '../core/api';
import {
  applyRedactions,
  buildDebugLog,
  chunkDebugLog,
  DebugLogAgent,
  debugLogFileName,
  debugLogSettings,
  diffLineMatches,
  enabledGlobalPrompts,
  planRedactions,
  Redaction,
  rememberedPreferences,
  redactionDiff,
  searchParts,
} from '../core/debug-log';
import { SensitiveFinding, Session } from '../core/models';
import { SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';
import { CopyButton } from './copy-button';
import { ModelSelect } from './model-select';
import { TypedInput } from './typed-input';

/** Redaction kinds with a translated label. */
const REDACTION_KINDS = [
  'home',
  'name',
  'username',
  'email',
  'phone',
  'address',
  'secret',
  'ip',
  'url',
  'path',
  'org',
  'other',
];

/**
 * Exports a chat's debug log as Markdown, with the OS and app versions, so
 * the user can hand it to an AI agent to find out what went wrong. The log
 * holds the whole chat in plain text; a model the user picks can find
 * personal and secret values in it first, which are then replaced with
 * placeholders the user reviews before saving.
 */
@Component({
  selector: 'app-debug-export-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CopyButton, ModelSelect, TranslocoPipe, TypedInput],
  host: {
    '(document:keydown)': 'onDocumentKeydown($event)',
  },
  template: `
    <div
      class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      (click)="close()"
    >
      <div
        class="flex max-h-[88vh] w-[46rem] max-w-full flex-col overflow-hidden glass-pop rounded-2xl shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="debug-export-title"
        data-testid="debug-export"
        (click)="$event.stopPropagation()"
      >
        <header class="shrink-0 px-6 pt-5 pb-3">
          <h2 id="debug-export-title" class="text-base font-semibold text-white">
            {{ 'debug.export.title' | transloco }}
          </h2>
          <p class="mt-1 text-xs leading-relaxed text-mist/50">
            {{ 'debug.export.description' | transloco }}
          </p>
        </header>

        <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-5">
          <div
            class="flex gap-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-xs leading-relaxed text-amber-200"
            role="note"
          >
            <svg
              viewBox="0 0 24 24"
              class="mt-0.5 h-4 w-4 shrink-0"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path
                d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
              />
              <path d="M12 9v4M12 17h.01" />
            </svg>
            <div>
              <p class="font-semibold">{{ 'debug.export.warningTitle' | transloco }}</p>
              <p class="mt-1">{{ 'debug.export.warning' | transloco }}</p>
            </div>
          </div>

          <section class="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <h3 class="text-sm font-medium text-white">
              {{ 'debug.export.anonymize.title' | transloco }}
            </h3>
            <p class="mt-1 text-xs leading-relaxed text-mist/50">
              {{ 'debug.export.anonymize.description' | transloco }}
            </p>
            <div class="mt-3 flex items-center gap-2">
              <app-model-select
                class="min-w-0 flex-1"
                [value]="model()"
                [placeholder]="'debug.export.anonymize.pickModel' | transloco"
                [label]="'debug.export.anonymize.model' | transloco"
                (valueChange)="model.set($event)"
              />
              @if (progress()) {
                <button
                  type="button"
                  class="shrink-0 rounded-full px-4 py-2 text-sm text-mist/70 transition-colors hover:bg-white/5 hover:text-white"
                  (click)="cancelAnonymize()"
                >
                  {{ 'common.cancel' | transloco }}
                </button>
              } @else {
                <button
                  type="button"
                  class="shrink-0 rounded-full border border-accent/40 px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-40"
                  [disabled]="!model() || !log() || saving()"
                  (click)="anonymize()"
                >
                  {{
                    (redactions() ? 'debug.export.anonymize.again' : 'debug.export.anonymize.run')
                      | transloco
                  }}
                </button>
              }
            </div>

            @if (progress(); as step) {
              <div class="mt-3" role="status">
                <p class="text-xs text-mist/60">
                  {{ 'debug.export.anonymize.progress' | transloco: step }}
                </p>
                <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    class="h-full rounded-full bg-accent transition-[width]"
                    [style.width.%]="((step.current - 1) / step.total) * 100"
                  ></div>
                </div>
              </div>
            }

            @if (redactions(); as list) {
              <div class="mt-3" data-testid="redactions">
                @if (list.length === 0) {
                  <p class="text-xs text-emerald-300">
                    {{ 'debug.export.anonymize.none' | transloco }}
                  </p>
                } @else {
                  <div class="flex items-center gap-2">
                    <p class="min-w-0 flex-1 text-xs text-emerald-300" role="status">
                      {{ 'debug.export.anonymize.found' | transloco: { count: enabledCount() } }}
                    </p>
                    <button
                      type="button"
                      class="shrink-0 rounded-full px-2.5 py-0.5 text-xs text-mist/50 transition-colors hover:text-mist"
                      (click)="discardRedactions()"
                    >
                      {{ 'debug.export.anonymize.undo' | transloco }}
                    </button>
                  </div>
                  <ul
                    class="mt-2 max-h-44 space-y-0.5 overflow-y-auto rounded-lg border border-white/5 bg-ink/40 p-1.5"
                  >
                    @for (redaction of list; track redaction.text; let index = $index) {
                      <li>
                        <label
                          class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-white/5"
                        >
                          <input
                            type="checkbox"
                            class="accent-[var(--color-accent)]"
                            [checked]="redaction.enabled"
                            (change)="toggleRedaction(index)"
                          />
                          <code
                            class="min-w-0 flex-1 truncate font-mono text-mist"
                            [class.line-through]="!redaction.enabled"
                            [attr.title]="redaction.text"
                            >{{ redaction.text }}</code
                          >
                          <span class="shrink-0 text-mist/30" aria-hidden="true">→</span>
                          <code class="shrink-0 font-mono text-accent">{{
                            redaction.placeholder
                          }}</code>
                          <span class="w-24 shrink-0 truncate text-right text-[10px] text-mist/40">
                            {{ kindKey(redaction.kind) | transloco }} · {{ redaction.count }}×
                          </span>
                        </label>
                      </li>
                    }
                  </ul>
                }
                <p class="mt-2 text-[11px] leading-relaxed text-mist/40">
                  {{ 'debug.export.anonymize.review' | transloco }}
                </p>
              </div>
            }
          </section>

          <section>
            <div class="mb-1.5 flex items-center gap-2">
              @if (anonymized()) {
                <div class="flex min-w-0 flex-1">
                  <div class="flex gap-0.5 rounded-lg bg-white/5 p-0.5" role="tablist">
                    @for (tab of views; track tab) {
                      <button
                        type="button"
                        role="tab"
                        class="rounded-md px-2.5 py-0.5 text-xs transition-colors"
                        [class]="
                          shownView() === tab
                            ? 'bg-accent/20 text-white'
                            : 'text-mist/50 hover:text-mist'
                        "
                        [attr.aria-selected]="shownView() === tab"
                        (click)="view.set(tab)"
                      >
                        @if (tab === 'log') {
                          {{ 'debug.export.previewAnonymized' | transloco }}
                        } @else {
                          {{ 'debug.export.changes.tab' | transloco: { count: diff().length } }}
                        }
                      </button>
                    }
                  </div>
                </div>
              } @else {
                <h3
                  class="min-w-0 flex-1 text-[10px] font-semibold tracking-wider uppercase text-mist/40"
                >
                  {{ 'debug.export.preview' | transloco }}
                </h3>
              }
              @if (log()) {
                <span class="text-[10px] tabular-nums text-mist/30">
                  {{ 'debug.export.size' | transloco: { size: size() } }}
                </span>
                <app-copy-button [text]="output()" label="debug.export.copy" />
              }
            </div>
            @if (log()) {
              <div class="mb-2 flex items-center gap-2">
                <div class="relative min-w-0 flex-1">
                  <svg
                    viewBox="0 0 24 24"
                    class="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-mist/40"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                  <input
                    #searchField
                    type="search"
                    class="w-full rounded-lg border border-white/10 bg-white/5 py-1.5 pr-2.5 pl-8 text-xs text-mist placeholder:text-mist/30 focus:border-accent/50 focus:outline-none"
                    [placeholder]="'debug.export.search.placeholder' | transloco"
                    [attr.aria-label]="'debug.export.search.placeholder' | transloco"
                    [value]="query()"
                    (typedValue)="query.set($event)"
                    (keydown.enter)="onSearchEnter($event, 1)"
                    (keydown.shift.enter)="onSearchEnter($event, -1)"
                    (keydown.escape)="clearSearch($event)"
                  />
                </div>
                @if (query().trim()) {
                  <span
                    class="shrink-0 text-[11px] tabular-nums text-mist/50"
                    role="status"
                    data-testid="debug-export-matches"
                  >
                    @if (shownView() === 'changes') {
                      {{ 'debug.export.search.lines' | transloco: { count: visibleDiff().length } }}
                    } @else if (search().count > 0) {
                      {{
                        'debug.export.search.matches'
                          | transloco: { current: currentMatch() + 1, total: search().count }
                      }}
                    } @else {
                      {{ 'debug.export.search.none' | transloco }}
                    }
                  </span>
                  @if (shownView() === 'log') {
                    <div class="flex shrink-0 gap-0.5">
                      <button
                        type="button"
                        class="flex h-7 w-7 items-center justify-center rounded-md text-mist/60 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-30"
                        [attr.aria-label]="'debug.export.search.previous' | transloco"
                        [attr.title]="'debug.export.search.previous' | transloco"
                        [disabled]="search().count === 0"
                        (click)="stepMatch(-1)"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          class="h-3.5 w-3.5"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <path d="m18 15-6-6-6 6" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        class="flex h-7 w-7 items-center justify-center rounded-md text-mist/60 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-30"
                        [attr.aria-label]="'debug.export.search.next' | transloco"
                        [attr.title]="'debug.export.search.next' | transloco"
                        [disabled]="search().count === 0"
                        (click)="stepMatch(1)"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          class="h-3.5 w-3.5"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </button>
                    </div>
                  }
                }
              </div>

              @if (shownView() === 'changes') {
                <div
                  class="max-h-72 overflow-auto rounded-xl border border-white/10 bg-ink/60 py-2 font-mono text-[11px] leading-relaxed"
                  data-testid="debug-export-changes"
                >
                  <p class="px-3 pb-2 font-sans text-[11px] leading-relaxed text-mist/40">
                    {{ 'debug.export.changes.description' | transloco }}
                  </p>
                  @for (line of visibleDiff(); track line.number) {
                    <div class="border-t border-white/5 py-1" data-testid="debug-export-change">
                      <div class="flex gap-2 bg-rose-500/10 px-3 py-0.5">
                        <span class="w-10 shrink-0 text-right text-mist/30 select-none">{{
                          line.number
                        }}</span>
                        <span class="w-3 shrink-0 text-rose-300 select-none" aria-hidden="true"
                          >-</span
                        >
                        <span class="min-w-0 flex-1 break-words whitespace-pre-wrap text-mist/70">
                          @for (part of line.before; track $index) {
                            @if (part.match === null) {
                              <span>{{ part.text }}</span>
                            } @else {
                              <del class="rounded-sm bg-rose-500/30 text-rose-100 no-underline">{{
                                part.text
                              }}</del>
                            }
                          }
                        </span>
                      </div>
                      <div class="flex gap-2 bg-emerald-500/10 px-3 py-0.5">
                        <span class="w-10 shrink-0 select-none" aria-hidden="true"></span>
                        <span class="w-3 shrink-0 text-emerald-300 select-none" aria-hidden="true"
                          >+</span
                        >
                        <span class="min-w-0 flex-1 break-words whitespace-pre-wrap text-mist/70">
                          @for (part of line.after; track $index) {
                            @if (part.match === null) {
                              <span>{{ part.text }}</span>
                            } @else {
                              <ins
                                class="rounded-sm bg-emerald-500/30 text-emerald-100 no-underline"
                                >{{ part.text }}</ins
                              >
                            }
                          }
                        </span>
                      </div>
                    </div>
                  } @empty {
                    <p class="border-t border-white/5 px-3 pt-2 font-sans text-xs text-mist/40">
                      {{ 'debug.export.search.none' | transloco }}
                    </p>
                  }
                </div>
              } @else {
                <div
                  #preview
                  class="max-h-72 overflow-auto rounded-xl border border-white/10 bg-ink/60 px-4 py-3 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-mist/70"
                  data-testid="debug-export-preview"
                >
                  @for (part of search().parts; track $index) {
                    @if (part.match === null) {
                      <span>{{ part.text }}</span>
                    } @else {
                      <mark
                        class="rounded-sm"
                        [class]="
                          part.match === currentMatch()
                            ? 'bg-accent text-ink'
                            : 'bg-accent/25 text-white'
                        "
                        [attr.data-match]="part.match"
                        >{{ part.text }}</mark
                      >
                    }
                  }
                </div>
              }
            } @else {
              <div
                class="flex h-32 items-center justify-center rounded-xl border border-white/10 bg-ink/60 text-xs text-mist/40"
              >
                {{ 'common.loading' | transloco }}
              </div>
            }
          </section>

          @if (error(); as text) {
            <p class="text-xs break-words text-rose-400" role="alert">{{ text }}</p>
          }
          @if (savedPath(); as path) {
            <p class="text-xs break-all text-emerald-300" role="status">
              {{ 'debug.export.saved' | transloco: { path } }}
            </p>
          }
        </div>

        <footer
          class="flex shrink-0 items-center justify-end gap-2 border-t border-white/5 px-6 py-4"
        >
          <button
            type="button"
            class="rounded-full px-4 py-2 text-sm text-mist/70 transition-colors hover:bg-white/5 hover:text-white"
            (click)="close()"
          >
            {{ 'common.close' | transloco }}
          </button>
          <button
            type="button"
            class="rounded-full bg-accent px-5 py-2 text-sm font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-50"
            [disabled]="!log() || !!progress() || saving()"
            (click)="save()"
          >
            {{ (anonymized() ? 'debug.export.saveAnonymized' : 'debug.export.save') | transloco }}
          </button>
        </footer>
      </div>
    </div>
  `,
})
export class DebugExportDialog implements OnInit {
  private readonly workspace = inject(WorkspaceService);
  private readonly settings = inject(SettingsService);
  private readonly transloco = inject(TranslocoService);

  /** The session the debugger shows; its subagents are exported with it. */
  readonly sessionId = input.required<string>();
  /** The chat whose permission decisions are exported. */
  readonly conversationId = input<string | null>(null);
  readonly closed = output<void>();

  protected readonly log = signal<string | null>(null);
  protected readonly model = signal<string | null>(null);
  /** The model's findings, once the log was anonymized. */
  protected readonly redactions = signal<Redaction[] | null>(null);
  protected readonly progress = signal<{ current: number; total: number } | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly savedPath = signal<string | null>(null);

  protected readonly anonymized = computed(
    () => this.redactions()?.some((redaction) => redaction.enabled) ?? false,
  );
  protected readonly enabledCount = computed(
    () => this.redactions()?.filter((redaction) => redaction.enabled).length ?? 0,
  );
  protected readonly output = computed(() => {
    const log = this.log() ?? '';
    const redactions = this.redactions();
    return redactions ? applyRedactions(log, redactions) : log;
  });
  protected readonly size = computed(() => formatSize(new Blob([this.output()]).size));

  protected readonly views = ['log', 'changes'] as const;
  protected readonly view = signal<'log' | 'changes'>('log');
  /** The changes view only exists while something is replaced. */
  protected readonly shownView = computed(() => (this.anonymized() ? this.view() : 'log'));
  /** Every line the enabled redactions change, original next to anonymized. */
  protected readonly diff = computed(() => {
    const redactions = this.redactions();
    return redactions ? redactionDiff(this.log() ?? '', redactions) : [];
  });

  protected readonly query = signal('');
  protected readonly search = computed(() => searchParts(this.output(), this.query()));
  protected readonly currentMatch = linkedSignal({
    source: this.search,
    computation: () => 0,
  });
  protected readonly visibleDiff = computed(() =>
    this.diff().filter((line) => diffLineMatches(line, this.query())),
  );
  private readonly searchField = viewChild<ElementRef<HTMLInputElement>>('searchField');
  private readonly preview = viewChild<ElementRef<HTMLElement>>('preview');

  private exportedAt = Date.now();
  private home: string | null = null;
  /** Bumped to abandon a running anonymization. */
  private run = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.progress()) {
        this.cancelAnonymize();
      }
    });
    // Keep the current search match in view, scrolling only the preview.
    effect(() => {
      const index = this.currentMatch();
      if (this.search().count === 0 || this.shownView() !== 'log') {
        return;
      }
      untracked(() => requestAnimationFrame(() => this.scrollToMatch(index)));
    });
  }

  ngOnInit(): void {
    void this.load();
  }

  protected close(): void {
    if (this.progress()) {
      this.cancelAnonymize();
    }
    this.closed.emit();
  }

  private scrollToMatch(index: number): void {
    const container = this.preview()?.nativeElement;
    const mark = container?.querySelector(`[data-match="${index}"]`);
    if (!container || !mark) {
      return;
    }
    const box = container.getBoundingClientRect();
    const target = mark.getBoundingClientRect();
    if (target.top < box.top || target.bottom > box.bottom) {
      container.scrollTop += target.top - box.top - box.height / 2;
    }
  }

  /** Cmd/Ctrl+F searches the log instead of the page. */
  protected onDocumentKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      const field = this.searchField()?.nativeElement;
      if (field) {
        event.preventDefault();
        field.focus();
        field.select();
      }
    }
  }

  /** Enter goes to the next match, Shift+Enter to the previous one. */
  protected onSearchEnter(event: Event, step: number): void {
    event.preventDefault();
    this.stepMatch(step);
  }

  protected stepMatch(step: number): void {
    const count = this.search().count;
    if (count > 0) {
      this.currentMatch.update((index) => (index + step + count) % count);
    }
  }

  /** Escape clears the search first; the next one closes the dialog. */
  protected clearSearch(event: Event): void {
    if (this.query()) {
      event.stopPropagation();
      this.query.set('');
    }
  }

  protected discardRedactions(): void {
    this.redactions.set(null);
    this.view.set('log');
    this.savedPath.set(null);
  }

  protected kindKey(kind: string): string {
    return `debug.export.kinds.${REDACTION_KINDS.includes(kind) ? kind : 'other'}`;
  }

  protected toggleRedaction(index: number): void {
    this.savedPath.set(null);
    this.redactions.update((list) =>
      list
        ? list.map((redaction, at) =>
            at === index ? { ...redaction, enabled: !redaction.enabled } : redaction,
          )
        : list,
    );
  }

  protected async anonymize(): Promise<void> {
    const model = this.model();
    const log = this.log();
    if (!model || !log || this.progress()) {
      return;
    }
    const run = ++this.run;
    this.error.set(null);
    this.savedPath.set(null);
    const chunks = chunkDebugLog(log);
    const findings: SensitiveFinding[] = [];
    try {
      for (const [index, chunk] of chunks.entries()) {
        this.progress.set({ current: index + 1, total: chunks.length });
        const found = await api.findSensitiveData(model, chunk);
        if (run !== this.run) {
          return;
        }
        findings.push(...found);
      }
      this.redactions.set(planRedactions(log, findings, this.home));
    } catch (error) {
      if (run === this.run) {
        this.error.set(String(error));
      }
    } finally {
      if (run === this.run) {
        this.progress.set(null);
      }
    }
  }

  protected cancelAnonymize(): void {
    this.run += 1;
    this.progress.set(null);
    void api.stopGeneration(ANONYMIZE_CANCEL_KEY).catch(() => undefined);
  }

  protected async save(): Promise<void> {
    if (!this.log() || this.progress() || this.saving()) {
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    this.savedPath.set(null);
    try {
      const path = await api.saveDebugLog(
        this.transloco.translate('debug.export.saveDialogTitle'),
        debugLogFileName(this.exportedAt, this.anonymized()),
        this.output(),
      );
      if (path) {
        this.savedPath.set(path);
      }
    } catch (error) {
      this.error.set(String(error));
    } finally {
      this.saving.set(false);
    }
  }

  /** Snapshots the chat, its subagents and the machine into the log. */
  private async load(): Promise<void> {
    const rootId = this.sessionId();
    const conversationId = this.conversationId();
    const [system, audit, home, live] = await Promise.all([
      api.getSystemInfo().catch(() => null),
      conversationId
        ? api.listPermissionAudit(conversationId, 1000).catch(() => null)
        : Promise.resolve([]),
      homeDir().catch(() => null),
      // What holds for this chat without being saved: why a command asked
      // often lies there.
      api
        .getPermissionState(
          conversationId ?? rootId,
          this.workspace.session(rootId)?.projectId ?? null,
        )
        .catch(() => null),
      this.workspace.loadAgentTree(rootId).catch(() => undefined),
    ]);
    this.home = home;

    const agents: DebugLogAgent[] = this.agentSessions(rootId).map((session) => ({
      session,
      messages: this.workspace.messagesFor(session.id),
      liveTools: this.workspace.liveToolsFor(session.id),
      error: this.workspace.errorFor(session.id),
      streaming: this.workspace.isStreaming(session.id),
    }));
    const root = agents[0]?.session ?? null;
    const settings = this.settings.settings();
    const mode = settings
      ? (settings.modes.find((entry) => entry.id === (root?.modeId ?? settings.defaultModeId)) ??
        null)
      : null;
    const ownPrompt = root?.systemPrompt?.trim() ?? '';

    this.model.set(root?.model || settings?.defaultModel || null);
    this.exportedAt = Date.now();
    this.log.set(
      buildDebugLog({
        exportedAt: this.exportedAt,
        system,
        settings: debugLogSettings(settings),
        permissions: { saved: settings, live },
        context: {
          systemPrompt: ownPrompt || settings?.defaultSystemPrompt || '',
          systemPromptSource: ownPrompt ? 'session' : 'default',
          globalPrompts:
            mode?.includeGlobalPrompts && settings ? enabledGlobalPrompts(settings) : [],
          memories: mode?.includeGlobalPrompts && settings ? rememberedPreferences(settings) : [],
          mode,
          rules: this.workspace.rules(),
        },
        agents,
        audit,
      }),
    );
  }

  /** The session followed by every descendant subagent, breadth first. */
  private agentSessions(rootId: string): Session[] {
    const root = this.workspace.session(rootId);
    if (!root) {
      return [];
    }
    const result: Session[] = [root];
    for (let index = 0; index < result.length; index += 1) {
      for (const child of this.workspace.subAgentsFor(result[index].id)) {
        if (!result.some((session) => session.id === child.id)) {
          result.push(child);
        }
      }
    }
    return result;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
