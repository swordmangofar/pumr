import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChildren,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { PendingQuestion, QuestionAnswer } from '../core/models';
import { WorkspaceService } from '../core/workspace.service';

interface QuestionDraft {
  selected: string[];
  custom: string;
  customActive: boolean;
}

import { isEditable } from './permission-overlay';
import { TypedInput } from './typed-input';

@Component({
  selector: 'app-question-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TypedInput, TranslocoPipe],
  host: {
    '(keydown)': 'onKeydown($event)',
    '(click)': 'onClick($event)',
    '(focusin)': 'onFocusIn($event)',
  },
  template: `
    <div class="pointer-events-none absolute inset-0 z-40 flex flex-col justify-end px-5 pb-3">
      <div
        tabindex="-1"
        class="pointer-events-auto mx-auto flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-white/10 bg-navy/95 shadow-2xl shadow-black/50 outline-none backdrop-blur"
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
                  #stop
                  type="button"
                  class="flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-accent/70"
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
                #stop
                type="button"
                class="flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-accent/70"
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
                  #stop
                  class="field w-full rounded-lg px-3 py-2 text-sm"
                  [placeholder]="'question.customPlaceholder' | transloco"
                  [value]="draft(index()).custom"
                  (typedValue)="setCustom($event)"
                  (keydown.enter)="onCustomEnter($event)"
                />
              }
            </div>
          </div>

          <footer class="flex shrink-0 items-center gap-2 border-t border-white/10 px-4 py-2">
            <button
              #stop
              type="button"
              class="rounded-full border border-white/15 px-3 py-1.5 text-xs text-mist transition-colors hover:bg-white/5 focus:outline-2 focus:outline-offset-2 focus:outline-accent/70"
              (click)="skip()"
            >
              {{ 'question.skip' | transloco }}
            </button>
            <span class="flex-1"></span>
            @if (index() > 0) {
              <button
                #stop
                type="button"
                class="rounded-full border border-white/15 px-3.5 py-1.5 text-xs text-mist transition-colors hover:bg-white/5 focus:outline-2 focus:outline-offset-2 focus:outline-accent/70"
                (click)="back()"
              >
                {{ 'question.back' | transloco }}
              </button>
            }
            @if (index() < total() - 1) {
              <button
                #stop
                type="button"
                class="rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-accent/90 focus:outline-2 focus:outline-offset-2 focus:outline-accent/70"
                (click)="next()"
              >
                {{ 'question.next' | transloco }}
              </button>
            } @else {
              <button
                #stop
                type="button"
                class="rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-accent/90 focus:outline-2 focus:outline-offset-2 focus:outline-accent/70"
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
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly drafts = signal<QuestionDraft[]>([]);
  protected readonly index = signal(0);
  protected readonly collapsed = signal(false);
  private lastRequestId = '';

  /**
   * The answers, the custom answer's field and the buttons below, top to
   * bottom. The buttons mark focus on `:focus`: the global ring needs
   * `:focus-visible`, which a script-focused button lacks after a click.
   */
  private readonly stops = viewChildren<ElementRef<HTMLElement>>('stop');
  private focusedStep = '';
  private focusedNonce = this.workspace.composerFocusNonce();
  /** Where the keyboard last was, to return there within the same question. */
  private lastStop: HTMLElement | null = null;

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

    // Each question starts with the keyboard on its first answer. Going on to
    // the next question would otherwise drop focus with the replaced button.
    // The chat being asked to take the keyboard (the window is summoned, the
    // terminal closes) hands it back to the open question, where it was.
    afterRenderEffect(() => {
      const step = `${this.request().requestId}:${this.index()}`;
      const nonce = this.workspace.composerFocusNonce();
      const stops = this.stops().map((stop) => stop.nativeElement);
      if ((step === this.focusedStep && nonce === this.focusedNonce) || stops.length === 0) {
        return;
      }
      const resume = step === this.focusedStep && this.lastStop;
      const target = resume && stops.includes(resume) ? resume : stops[0];
      this.focusedStep = step;
      this.focusedNonce = nonce;
      if (this.focusBelongsElsewhere()) {
        return;
      }
      // Another panel that holds the keyboard would take the arrows and Enter.
      untracked(() => {
        if (this.workspace.focusedPanel()) {
          this.workspace.setFocusedPanel('center');
        }
      });
      target.focus();
    });
  }

  /**
   * Whether focus should stay where it is: in a dialog, or in a field the user
   * is typing in. The message box gives focus up while it is empty, which it
   * is right after the prompt that led to the question was sent.
   */
  private focusBelongsElsewhere(): boolean {
    const focused = document.activeElement;
    if (!focused || this.element.nativeElement.contains(focused)) {
      return false;
    }
    if (focused.closest('[role="dialog"]')) {
      return true;
    }
    if (!isEditable(focused)) {
      return false;
    }
    const text =
      focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
        ? focused.value
        : (focused.textContent ?? '');
    return !focused.closest('app-composer') || text.trim().length > 0;
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

  /**
   * Arrow keys walk the answers and the buttons below them; Enter and Space
   * press the focused one. Tab cannot be relied on, it may be the shortcut
   * that switches panels. Left and right stay with the caret while a field
   * has focus.
   */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
      return;
    }
    const target = event.target as HTMLElement | null;
    const vertical = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    const horizontal = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const delta = vertical || (isEditable(target) ? 0 : horizontal);
    const stops = this.stops().map((stop) => stop.nativeElement);
    if (delta === 0 || stops.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const position = target ? stops.indexOf(target) : -1;
    // From the panel itself the keys enter the list at its near end.
    const next = position < 0 ? (delta > 0 ? 0 : -1) : position + delta;
    stops[(next + stops.length) % stops.length].focus();
  }

  /**
   * Keeps the keyboard on what was clicked. WebKit on macOS does not focus a
   * button on a click, which would leave the arrow keys without a start.
   */
  protected onClick(event: MouseEvent): void {
    const target = event.target as Node | null;
    this.stops()
      .find((stop) => target !== null && stop.nativeElement.contains(target))
      ?.nativeElement.focus();
  }

  protected onFocusIn(event: FocusEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && this.stops().some((stop) => stop.nativeElement === target)) {
      this.lastStop = target;
    }
  }

  protected toggleCollapsed(): void {
    this.collapsed.update((value) => !value);
    // Opening the panel again starts over on the first answer.
    this.focusedStep = '';
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

  /**
   * Enter in the custom answer goes on to the next question. The Enter that
   * confirms an input method's composition only commits the text: WebKit
   * reports it as an Enter keydown too, marked as composing or by the key
   * code 229.
   */
  protected onCustomEnter(event: Event): void {
    const key = event as KeyboardEvent;
    if (key.isComposing || key.keyCode === 229) {
      return;
    }
    this.advanceOrSubmit();
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
    void this.resolve(request.requestId, answers);
  }

  protected skip(): void {
    void this.resolve(this.request().requestId, null);
  }

  /** Answers the question and puts the caret back in the message box. */
  private async resolve(requestId: string, answers: QuestionAnswer[] | null): Promise<void> {
    await this.workspace.resolveQuestion(requestId, answers);
    this.workspace.requestComposerFocus();
  }
}
