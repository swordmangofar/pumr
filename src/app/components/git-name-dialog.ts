import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { TypedInput } from './typed-input';

export interface GitNameDialogResult {
  name: string;
  message: string;
  checkout: boolean;
}

/**
 * Asks for a branch or tag name and runs `submit` with it. While it runs the
 * dialog is busy; when it fails, the dialog stays open with the error so the
 * name can be corrected.
 */
@Component({
  selector: 'app-git-name-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TypedInput, TranslocoPipe],
  host: {
    '(document:keydown.escape)': 'cancel()',
  },
  template: `
    <div
      class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      (click)="cancel()"
    >
      <div
        class="w-[28rem] max-w-full glass-pop rounded-2xl shadow-2xl"
        (click)="$event.stopPropagation()"
      >
        <div class="p-6">
          <h2 class="text-base font-semibold text-white">{{ titleKey() | transloco }}</h2>
          <label class="mt-4 block text-xs font-medium text-mist/70" for="git-name-dialog-input">
            {{ labelKey() | transloco }}
          </label>
          <input
            #field
            id="git-name-dialog-input"
            type="text"
            class="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 font-mono text-[13px] text-mist placeholder:text-mist/30 focus:border-accent/50 focus:outline-none"
            [placeholder]="placeholder()"
            [value]="name()"
            (typedValue)="name.set($event)"
            (keydown.enter)="confirm()"
          />
          @if (hintKey(); as hint) {
            <p class="mt-3 text-xs text-mist/50">{{ hint | transloco: hintParams() }}</p>
          }
          @if (messageLabelKey(); as label) {
            <label
              class="mt-3 block text-xs font-medium text-mist/70"
              for="git-name-dialog-message"
            >
              {{ label | transloco }}
            </label>
            <textarea
              id="git-name-dialog-message"
              rows="2"
              class="mt-1 w-full resize-none rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[13px] text-mist placeholder:text-mist/30 focus:border-accent/50 focus:outline-none"
              [value]="message()"
              (typedValue)="message.set($event)"
            ></textarea>
          }
          @if (checkoutLabelKey(); as label) {
            <label class="mt-3 flex cursor-pointer items-center gap-2 text-xs text-mist/70">
              <input
                type="checkbox"
                class="accent-[var(--color-accent)]"
                [checked]="checkout()"
                (typedChecked)="checkout.set($event)"
              />
              {{ label | transloco }}
            </label>
          }
          @if (error(); as text) {
            <p class="mt-3 text-xs text-rose-400">{{ text }}</p>
          }
        </div>
        <footer class="flex items-center justify-end gap-2 border-t border-white/5 px-6 py-4">
          <button
            type="button"
            class="rounded-full px-4 py-2 text-sm text-mist/70 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
            [disabled]="busy()"
            (click)="cancel()"
          >
            {{ 'common.cancel' | transloco }}
          </button>
          <button
            type="button"
            class="rounded-full bg-accent px-5 py-2 text-sm font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-50"
            [disabled]="busy() || name().trim().length === 0"
            (click)="confirm()"
          >
            {{ confirmLabel() | transloco }}
          </button>
        </footer>
      </div>
    </div>
  `,
})
export class GitNameDialog {
  readonly titleKey = input.required<string>();
  readonly labelKey = input.required<string>();
  readonly placeholder = input('');
  readonly initialValue = input('');
  readonly hintKey = input<string | null>(null);
  readonly hintParams = input<Record<string, unknown>>({});
  /** Shows an optional message field (annotated tags). */
  readonly messageLabelKey = input<string | null>(null);
  /** Shows a "check out" checkbox, checked by default. */
  readonly checkoutLabelKey = input<string | null>(null);
  readonly confirmKey = input('git.menu.confirm');
  /** Confirm label while the checkout box is ticked. */
  readonly confirmCheckoutKey = input<string | null>(null);
  readonly submit = input.required<(result: GitNameDialogResult) => Promise<unknown>>();
  readonly closed = output<void>();

  protected readonly name = linkedSignal(() => this.initialValue());
  protected readonly message = signal('');
  protected readonly checkout = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly confirmLabel = computed(() => {
    const checkoutKey = this.confirmCheckoutKey();
    return checkoutKey && this.checkoutLabelKey() && this.checkout()
      ? checkoutKey
      : this.confirmKey();
  });
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');

  constructor() {
    // `autofocus` is only honoured for the first dialog a page shows.
    afterNextRender(() => {
      const field = this.field()?.nativeElement;
      field?.focus();
      field?.select();
    });
  }

  protected cancel(): void {
    if (!this.busy()) {
      this.closed.emit();
    }
  }

  protected async confirm(): Promise<void> {
    const name = this.name().trim();
    if (name.length === 0 || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.submit()({
        name,
        message: this.message().trim(),
        checkout: this.checkoutLabelKey() !== null && this.checkout(),
      });
      this.closed.emit();
    } catch (error) {
      this.error.set(String(error));
    } finally {
      this.busy.set(false);
    }
  }
}
