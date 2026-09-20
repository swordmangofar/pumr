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
}

@Component({
  selector: 'app-question-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <div class="pointer-events-none absolute inset-x-0 bottom-full z-40 px-5 pb-3">
      <div
        class="pointer-events-auto mx-auto w-full max-w-2xl overflow-hidden rounded-2xl border border-accent/30 bg-navy/95 shadow-2xl shadow-black/50 backdrop-blur"
      >
        <header class="flex items-center gap-2.5 border-b border-white/10 px-4 py-2">
          <span
            class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent"
          >
            {{ 'question.title' | transloco }}
          </span>
          <span class="min-w-0 flex-1 truncate text-xs text-mist/50">
            {{ current().header }}
            @if (current().multiSelect) {
              <span class="text-mist/30">· {{ 'question.multiHint' | transloco }}</span>
            }
          </span>

          @if (total() > 1) {
            <div class="flex shrink-0 items-center gap-1">
              @for (question of request().questions; track $index) {
                <button
                  type="button"
                  class="grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[10px] font-semibold tabular-nums transition-colors"
                  [class]="dotClass($index)"
                  [title]="question.header"
                  (click)="goTo($index)"
                >
                  {{ $index + 1 }}
                </button>
              }
            </div>
            <span class="shrink-0 text-[10px] tabular-nums text-mist/40">
              {{ answeredCount() }}/{{ total() }}
            </span>
          }
        </header>

        <div class="space-y-2 px-4 py-3">
          <p class="text-sm leading-snug text-mist">{{ current().question }}</p>

          @if (current().options.length > 0) {
            <div class="flex flex-wrap gap-1.5">
              @for (option of current().options; track option.label) {
                <button
                  type="button"
                  class="flex max-w-full items-baseline gap-1.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors"
                  [class]="
                    isSelected(option.label)
                      ? 'border-accent/60 bg-accent/15 text-white'
                      : 'border-white/10 bg-white/5 text-mist hover:border-accent/40 hover:bg-white/10'
                  "
                  [attr.aria-pressed]="isSelected(option.label)"
                  (click)="toggleOption(option.label)"
                >
                  <span class="text-xs font-medium">{{ option.label }}</span>
                  @if (option.description) {
                    <span class="text-[10px] text-mist/50">{{ option.description }}</span>
                  }
                </button>
              }
            </div>
          }

          <input
            class="field w-full rounded-lg px-3 py-1.5 text-sm"
            [placeholder]="'question.customPlaceholder' | transloco"
            [value]="draft(index()).custom"
            (input)="setCustom($any($event.target).value)"
            (keydown.enter)="advanceOrSubmit()"
          />
        </div>

        <footer class="flex items-center gap-2 border-t border-white/10 px-4 py-2">
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
      </div>
    </div>
  `,
})
export class QuestionOverlay {
  readonly request = input.required<PendingQuestion>();
  protected readonly workspace = inject(WorkspaceService);
  private readonly drafts = signal<QuestionDraft[]>([]);
  protected readonly index = signal(0);
  private lastRequestId = '';

  protected readonly total = computed(() => this.request().questions.length);
  protected readonly current = computed(
    () => this.request().questions[this.index()] ?? this.request().questions[0],
  );
  protected readonly answeredCount = computed(
    () => this.drafts().filter((draft) => this.isAnswered(draft)).length,
  );

  constructor() {
    effect(() => {
      const request = this.request();
      if (request.requestId === this.lastRequestId) {
        return;
      }
      this.lastRequestId = request.requestId;
      this.index.set(0);
      this.drafts.set(request.questions.map(() => ({ selected: [], custom: '' })));
    });
  }

  protected draft(index: number): QuestionDraft {
    return this.drafts()[index] ?? { selected: [], custom: '' };
  }

  protected isSelected(label: string): boolean {
    return this.draft(this.index()).selected.includes(label);
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
        return { ...draft, selected };
      }),
    );
  }

  protected setCustom(value: string): void {
    const index = this.index();
    this.drafts.update((drafts) =>
      drafts.map((draft, position) => (position === index ? { ...draft, custom: value } : draft)),
    );
  }

  protected dotClass(index: number): string {
    if (index === this.index()) {
      return 'bg-accent text-ink';
    }
    if (this.isAnswered(this.draft(index))) {
      return 'bg-accent/25 text-accent hover:bg-accent/35';
    }
    return 'bg-white/5 text-mist/50 hover:bg-white/10';
  }

  protected submit(): void {
    const request = this.request();
    const answers: QuestionAnswer[] = request.questions.map((question, index) => {
      const draft = this.draft(index);
      const custom = draft.custom.trim();
      return {
        header: question.header,
        question: question.question,
        selected: draft.selected,
        custom: custom.length > 0 ? custom : null,
      };
    });
    void this.workspace.resolveQuestion(request.requestId, answers);
  }

  protected skip(): void {
    void this.workspace.resolveQuestion(this.request().requestId, null);
  }

  private isAnswered(draft: QuestionDraft): boolean {
    return draft.selected.length > 0 || draft.custom.trim().length > 0;
  }
}
