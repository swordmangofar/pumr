import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { PendingQuestion, QuestionAnswer } from '../core/models';
import { WorkspaceService } from '../core/workspace.service';

interface QuestionDraft {
  selected: string[];
  custom: string;
  customActive: boolean;
}

import { TypedInput } from './typed-input';

@Component({
  selector: 'app-question-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TypedInput, TranslocoPipe],
  template: `
    <div class="pointer-events-none absolute inset-0 z-40 flex flex-col justify-end px-5 pb-3">
      <div
        class="pointer-events-auto mx-auto flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-white/10 bg-navy/95 shadow-2xl shadow-black/50 backdrop-blur"
      >
        <button
          type="button"
          class="flex w-full shrink-0 items-center justify-between gap-2 px-4 py-2.5 text-left transition-colors hover:bg-white/5"
          (click)="toggleCollapsed()"
        >
          <span class="text-xs font-medium text-white/70">
            {{ 'question.progress' | transloco: { current: index() + 1, total: total() } }}
          </span>
          <svg
            viewBox="0 0 16 16"
            class="h-3.5 w-3.5 shrink-0 text-white/40 transition-transform"
            [class.rotate-180]="collapsed()"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>

        @if (!collapsed()) {
          <div class="min-h-0 flex-1 space-y-3 overflow-y-auto border-t border-white/10 px-4 py-3">
            <div class="space-y-1">
              <p class="text-sm font-semibold leading-snug text-white">{{ current().question }}</p>
              <p class="text-xs text-white/50">
                {{
                  (current().multiSelect ? 'question.multiHint' : 'question.selectAnswer')
                    | transloco
                }}
              </p>
            </div>

            <div class="flex flex-col gap-1.5">
              @for (option of current().options; track option.label) {
                <button
                  type="button"
                  class="flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors"
                  [class]="cardClass(isSelected(option.label))"
                  [attr.aria-pressed]="isSelected(option.label)"
                  (click)="toggleOption(option.label)"
                >
                  <span
                    class="mt-0.5 grid h-4 w-4 shrink-0 place-items-center border transition-colors"
                    [class]="markClass(isSelected(option.label))"
                  >
                    @if (isSelected(option.label)) {
                      <span class="h-1.5 w-1.5 rounded-full bg-accent"></span>
                    }
                  </span>
                  <span class="flex min-w-0 flex-col gap-0.5">
                    <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span class="text-sm font-semibold text-white">{{ option.label }}</span>
                      @if (option.recommended) {
                        <span
                          data-testid="recommended"
                          class="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent"
                        >
                          {{ 'question.recommended' | transloco }}
                        </span>
                      }
                    </span>
                    @if (option.description) {
                      <span class="text-xs leading-snug text-white/50">
                        {{ option.description }}
                      </span>
                    }
                  </span>
                </button>
              }

              <button
                type="button"
                class="flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors"
                [class]="cardClass(customActive())"
                [attr.aria-pressed]="customActive()"
                (click)="toggleCustom()"
              >
                <span
                  class="mt-0.5 grid h-4 w-4 shrink-0 place-items-center border transition-colors"
                  [class]="markClass(customActive())"
                >
                  @if (customActive()) {
                    <span class="h-1.5 w-1.5 rounded-full bg-accent"></span>
                  }
                </span>
                <span class="flex min-w-0 flex-col gap-0.5">
                  <span class="text-sm font-semibold text-white">
                    {{ 'question.customLabel' | transloco }}
                  </span>
                  <span class="text-xs leading-snug text-white/50">
                    {{ 'question.customPlaceholder' | transloco }}
                  </span>
                </span>
              </button>

              @if (customActive()) {
                <input
                  class="field w-full rounded-lg px-3 py-2 text-sm"
                  [placeholder]="'question.customPlaceholder' | transloco"
                  [value]="draft(index()).custom"
                  (typedValue)="setCustom($event)"
                  (keydown.enter)="advanceOrSubmit()"
                />
              }
            </div>
          </div>

          <footer class="flex shrink-0 items-center gap-2 border-t border-white/10 px-4 py-2">
            <button
              type="button"
              class="rounded-full border border-white/15 px-3 py-1.5 text-xs text-mist transition-colors hover:bg-white/5"
              (click)="skip()"
            >
              {{ 'question.skip' | transloco }}
            </button>
            <span class="flex-1"></span>
            @if (index() > 0) {
              <button
                type="button"
                class="rounded-full border border-white/15 px-3.5 py-1.5 text-xs text-mist transition-colors hover:bg-white/5"
                (click)="back()"
              >
                {{ 'question.back' | transloco }}
              </button>
            }
            @if (index() < total() - 1) {
              <button
                type="button"
                class="rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-accent/90"
                (click)="next()"
              >
                {{ 'question.next' | transloco }}
              </button>
            } @else {
              <button
                type="button"
                class="rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-accent/90"
                (click)="submit()"
              >
                {{ 'question.submit' | transloco }}
              </button>
            }
          </footer>
        }
      </div>
    </div>
  `,
})
export class QuestionOverlay {
  readonly request = input.required<PendingQuestion>();
  protected readonly workspace = inject(WorkspaceService);
  private readonly drafts = signal<QuestionDraft[]>([]);
  protected readonly index = signal(0);
  protected readonly collapsed = signal(false);
  private lastRequestId = '';

  protected readonly total = computed(() => this.request().questions.length);
  protected readonly current = computed(
    () => this.request().questions[this.index()] ?? this.request().questions[0],
  );

  constructor() {
    effect(() => {
      const request = this.request();
      if (request.requestId === this.lastRequestId) {
        return;
      }
      this.lastRequestId = request.requestId;
      this.index.set(0);
      this.collapsed.set(false);
      this.drafts.set(
        request.questions.map(() => ({ selected: [], custom: '', customActive: false })),
      );
    });
  }

  protected draft(index: number): QuestionDraft {
    return this.drafts()[index] ?? { selected: [], custom: '', customActive: false };
  }

  protected isSelected(label: string): boolean {
    return this.draft(this.index()).selected.includes(label);
  }

  protected customActive(): boolean {
    return this.draft(this.index()).customActive;
  }

  protected cardClass(selected: boolean): string {
    return selected
      ? 'border-accent/70 bg-accent/10'
      : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]';
  }

  protected markClass(selected: boolean): string {
    const shape = this.current().multiSelect ? 'rounded-[5px]' : 'rounded-full';
    return `${shape} ${selected ? 'border-accent bg-accent/15' : 'border-white/30'}`;
  }

  protected toggleCollapsed(): void {
    this.collapsed.update((value) => !value);
  }

  protected goTo(index: number): void {
    if (index < 0 || index >= this.total()) {
      return;
    }
    this.index.set(index);
  }

  protected next(): void {
    this.goTo(this.index() + 1);
  }

  protected back(): void {
    this.goTo(this.index() - 1);
  }

  protected advanceOrSubmit(): void {
    if (this.index() < this.total() - 1) {
      this.next();
    } else {
      this.submit();
    }
  }

  protected toggleOption(label: string): void {
    const index = this.index();
    const multi = this.current().multiSelect;
    this.drafts.update((drafts) =>
      drafts.map((draft, position) => {
        if (position !== index) {
          return draft;
        }
        if (multi) {
          const selected = draft.selected.includes(label)
            ? draft.selected.filter((entry) => entry !== label)
            : [...draft.selected, label];
          return { ...draft, selected };
        }
        const selected = draft.selected.includes(label) ? [] : [label];
        return { ...draft, selected, customActive: false };
      }),
    );
  }

  /** Toggles the custom answer, which behaves like one more option. */
  protected toggleCustom(): void {
    const index = this.index();
    const multi = this.current().multiSelect;
    this.drafts.update((drafts) =>
      drafts.map((draft, position) => {
        if (position !== index) {
          return draft;
        }
        if (draft.customActive) {
          return { ...draft, customActive: false };
        }
        return { ...draft, customActive: true, selected: multi ? draft.selected : [] };
      }),
    );
  }

  protected setCustom(value: string): void {
    const index = this.index();
    this.drafts.update((drafts) =>
      drafts.map((draft, position) => (position === index ? { ...draft, custom: value } : draft)),
    );
  }

  protected submit(): void {
    const request = this.request();
    const answers: QuestionAnswer[] = request.questions.map((question, index) => {
      const draft = this.draft(index);
      // Text typed before switching to an option is not part of the answer.
      const custom = draft.customActive ? draft.custom.trim() : '';
      return {
        header: question.header,
        question: question.question,
        // Report picks in the order the options were offered, not click order.
        selected: question.options
          .map((option) => option.label)
          .filter((label) => draft.selected.includes(label)),
        custom: custom.length > 0 ? custom : null,
      };
    });
    void this.workspace.resolveQuestion(request.requestId, answers);
  }

  protected skip(): void {
    void this.workspace.resolveQuestion(this.request().requestId, null);
  }
}
