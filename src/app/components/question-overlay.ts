import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
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

const POSITION_KEY = 'pumr.questionPosition';
/** How far the pointer travels before a press on the header becomes a drag. */
const DRAG_THRESHOLD = 4;
/** The gap a dragged panel keeps to the edges of the window. */
const EDGE_GAP = 8;

/**
 * Where a dragged panel floats in the window, and the width it had when it
 * was picked up: away from the chat there is nothing left to size it.
 */
interface Placement {
  x: number;
  y: number;
  width: number;
}

function loadPlacement(): Placement | null {
  try {
    const { x, y, width } = (JSON.parse(localStorage.getItem(POSITION_KEY) ?? 'null') ??
      {}) as Partial<Placement>;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && width! > 0) {
      return { x: x!, y: y!, width: width! };
    }
  } catch {
    // A broken entry falls back to the usual place.
  }
  return null;
}

@Component({
  selector: 'app-question-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TypedInput, TranslocoPipe],
  template: `
    <div
      #frame
      class="pointer-events-none absolute inset-0 z-40 flex flex-col justify-end px-5 pb-3"
    >
      <!-- The listeners sit on the panel, not on the host: a dragged panel
           leaves the host for the window. -->
      <div
        #panel
        tabindex="-1"
        data-testid="question-panel"
        class="pointer-events-auto flex flex-col overflow-hidden rounded-xl border border-white/10 bg-navy/95 shadow-2xl shadow-black/50 outline-none backdrop-blur"
        [class]="shown() ? 'fixed z-40' : 'mx-auto max-h-full w-full max-w-2xl'"
        (keydown)="onKeydown($event)"
        (click)="onClick($event)"
        (focusin)="onFocusIn($event)"
        (mousedown)="onMouseDown()"
        [style.left.px]="shown()?.x"
        [style.top.px]="shown()?.y"
        [style.width.px]="shown()?.width"
        [style.max-height]="shown() ? 'calc(100vh - ' + 2 * edgeGap + 'px)' : null"
      >
        <div
          class="relative shrink-0"
          data-testid="question-header"
          (mousedown)="startDrag($event)"
        >
          <button
            type="button"
            class="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left transition-colors hover:bg-white/5"
            [class]="dragging() ? 'cursor-grabbing' : 'cursor-grab'"
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
          @if (shown()) {
            <button
              type="button"
              data-testid="question-reset-position"
              class="absolute top-1/2 right-10 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-white/40 transition-colors hover:bg-white/10 hover:text-white"
              [title]="'question.resetPosition' | transloco"
              [attr.aria-label]="'question.resetPosition' | transloco"
              (mousedown)="$event.stopPropagation()"
              (click)="resetPosition()"
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
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          }
        </div>

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
  private readonly destroyRef = inject(DestroyRef);
  private readonly frame = viewChild.required<ElementRef<HTMLElement>>('frame');
  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');
  private readonly drafts = signal<QuestionDraft[]>([]);
  protected readonly index = signal(0);
  protected readonly collapsed = signal(false);
  private lastRequestId = '';

  /**
   * Where the user dragged the panel, kept across questions and restarts, and
   * where it is shown: the window may have become too small for the former.
   * Without one the panel sits at the bottom of the chat. A dragged panel is
   * fixed to the window and a child of the body, so it can leave the chat for
   * any place in the app: inside the chat, WebKit clips it to the chat's box.
   */
  private readonly placement = signal(loadPlacement());
  protected readonly shown = signal(this.placement());
  protected readonly dragging = signal(false);
  protected readonly edgeGap = EDGE_GAP;
  private dragStart = { x: 0, y: 0 };
  private dragOrigin: Placement = { x: 0, y: 0, width: 0 };
  /** The panel, to take it out of the window again with the question. */
  private attached: HTMLElement | null = null;
  /** Set by a drag, so that the click ending it leaves the panel as it is. */
  private dragged = false;

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
      // A question with one answer starts on its first option, so it can be
      // sent as it is. Several answers start empty.
      this.drafts.set(
        request.questions.map((question) => ({
          selected: question.multiSelect
            ? []
            : question.options.slice(0, 1).map((option) => option.label),
          custom: '',
          customActive: false,
        })),
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

    afterRenderEffect(() => {
      const parent = this.shown() ? document.body : this.frame().nativeElement;
      const panel = this.panel().nativeElement;
      this.attached = panel;
      if (panel.parentElement === parent) {
        return;
      }
      // Moving the panel takes the focus and the scroll position off it.
      const focused = document.activeElement;
      const held = focused instanceof HTMLElement && panel.contains(focused) ? focused : null;
      const scrolled = [...panel.querySelectorAll('.overflow-y-auto')].map(
        (area) => [area, area.scrollTop] as const,
      );
      parent.appendChild(panel);
      scrolled.forEach(([area, top]) => (area.scrollTop = top));
      held?.focus();
    });
    this.destroyRef.onDestroy(() => this.attached?.remove());

    // A dragged panel stays in the window when that is made smaller or the
    // next question is a longer one.
    afterNextRender(() => {
      const settle = () => {
        const placement = this.placement();
        if (placement && !this.dragging()) {
          this.shown.set(this.clamp(placement));
        }
      };
      settle();
      window.addEventListener('resize', settle);
      this.destroyRef.onDestroy(() => window.removeEventListener('resize', settle));
      if (typeof ResizeObserver === 'undefined') {
        return;
      }
      const observer = new ResizeObserver(settle);
      observer.observe(this.panel().nativeElement);
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
    this.destroyRef.onDestroy(() => this.endDrag());
  }

  /**
   * Whether focus should stay where it is: in a dialog, or in a field the user
   * is typing in. The message box gives focus up while it is empty, which it
   * is right after the prompt that led to the question was sent.
   */
  private focusBelongsElsewhere(): boolean {
    const focused = document.activeElement;
    if (!focused || this.panel().nativeElement.contains(focused)) {
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

  /** A press on the panel in the window does not reach the chat it belongs to. */
  protected onMouseDown(): void {
    if (this.shown()) {
      this.workspace.setFocusedPanel('center');
    }
  }

  protected onFocusIn(event: FocusEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && this.stops().some((stop) => stop.nativeElement === target)) {
      this.lastStop = target;
    }
  }

  /**
   * The header moves the panel anywhere in the window, so the chat behind it
   * can be read without collapsing it. A press that stays in place still
   * collapses it.
   */
  protected startDrag(event: MouseEvent): void {
    if (event.button !== 0) {
      return;
    }
    this.dragged = false;
    this.dragStart = { x: event.clientX, y: event.clientY };
    const box = this.panel().nativeElement.getBoundingClientRect();
    this.dragOrigin = this.shown() ?? { x: box.left, y: box.top, width: box.width };
    window.addEventListener('mousemove', this.onDrag);
    window.addEventListener('mouseup', this.stopDrag);
  }

  private readonly onDrag = (event: MouseEvent): void => {
    const x = event.clientX - this.dragStart.x;
    const y = event.clientY - this.dragStart.y;
    if (!this.dragging()) {
      if (Math.hypot(x, y) < DRAG_THRESHOLD) {
        return;
      }
      this.dragging.set(true);
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
    }
    const next = this.clamp({
      ...this.dragOrigin,
      x: this.dragOrigin.x + x,
      y: this.dragOrigin.y + y,
    });
    this.placement.set(next);
    this.shown.set(next);
  };

  private readonly stopDrag = (): void => {
    if (!this.dragging()) {
      this.endDrag();
      return;
    }
    this.endDrag();
    this.dragged = true;
    // The click that follows the release comes before this timer.
    setTimeout(() => (this.dragged = false));
    this.savePlacement();
    // Chromium focuses the pressed header, and the move to the window may drop
    // the focus: the keyboard stays on the answers.
    const focused = document.activeElement;
    const ours =
      !focused || focused === document.body || this.panel().nativeElement.contains(focused);
    if (this.lastStop?.isConnected && ours) {
      this.lastStop.focus();
    }
  };

  private endDrag(): void {
    window.removeEventListener('mousemove', this.onDrag);
    window.removeEventListener('mouseup', this.stopDrag);
    if (this.dragging()) {
      this.dragging.set(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  }

  /** Puts the panel back at the bottom of the chat and forgets the drag. */
  protected resetPosition(): void {
    this.placement.set(null);
    this.shown.set(null);
    this.savePlacement();
  }

  /**
   * Keeps the whole panel inside the window, a little off its edges. One that
   * does not fit keeps its header in reach.
   */
  private clamp(placement: Placement): Placement {
    const width = Math.min(placement.width, window.innerWidth - 2 * EDGE_GAP);
    const height = this.panel().nativeElement.offsetHeight;
    const within = (value: number, room: number) =>
      Math.round(Math.max(EDGE_GAP, Math.min(value, room - EDGE_GAP)));
    return {
      x: within(placement.x, window.innerWidth - width),
      y: within(placement.y, window.innerHeight - height),
      width,
    };
  }

  private savePlacement(): void {
    const placement = this.placement();
    try {
      if (placement) {
        localStorage.setItem(POSITION_KEY, JSON.stringify(placement));
      } else {
        localStorage.removeItem(POSITION_KEY);
      }
    } catch {
      // Without storage the next question starts at the bottom again.
    }
  }

  protected toggleCollapsed(): void {
    if (this.dragged) {
      this.dragged = false;
      return;
    }
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
        // Pressing the picked option keeps it: the keyboard starts on the
        // preselected one, where Enter would otherwise clear the answer.
        return { ...draft, selected: [label], customActive: false };
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
