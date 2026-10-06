import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { TypedInput } from './typed-input';

export interface GitStashDialogResult {
  /** Empty when git should describe the stash itself. */
  message: string;
  includeUntracked: boolean;
}

/**
 * Asks how to stash the local changes and runs `submit` with the answer. While
 * it runs the dialog is busy; when it fails, the dialog stays open with the
 * error, as nothing was stashed.
 */
@Component({
  selector: 'app-git-stash-dialog',
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
          <h2 class="text-base font-semibold text-white">{{ 'git.stashCreate' | transloco }}</h2>
          <label class="mt-4 block text-xs font-medium text-mist/70" for="git-stash-dialog-message">
            {{ 'git.stashMessage' | transloco }}
          </label>
          <input
            #field
            id="git-stash-dialog-message"
            type="text"
            class="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[13px] text-mist placeholder:text-mist/30 focus:border-accent/50 focus:outline-none"
            [value]="message()"
            (typedValue)="message.set($event)"
            (keydown.enter)="confirm()"
          />
          <label class="mt-3 flex cursor-pointer items-center gap-2 text-xs text-mist/70">
            <input
              type="checkbox"
              class="accent-[var(--color-accent)]"
              [checked]="includeUntracked()"
              (typedChecked)="includeUntracked.set($event)"
            />
            {{ 'git.stashIncludeUntracked' | transloco }}
          </label>
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
            [disabled]="busy()"
            (click)="confirm()"
          >
            {{ 'git.stash' | transloco }}
          </button>
        </footer>
      </div>
    </div>
  `,
})
export class GitStashDialog {
  readonly submit = input.required<(result: GitStashDialogResult) => Promise<unknown>>();
  readonly closed = output<void>();

  protected readonly message = signal('');
  /** New files are part of the work that is put aside, unless unticked. */
  protected readonly includeUntracked = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');

  constructor() {
    // `autofocus` is only honoured for the first dialog a page shows.
    afterNextRender(() => this.field()?.nativeElement.focus());
  }

  protected cancel(): void {
    if (!this.busy()) {
      this.closed.emit();
    }
  }

  protected async confirm(): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.submit()({
        message: this.message().trim(),
        includeUntracked: this.includeUntracked(),
      });
      this.closed.emit();
    } catch (error) {
      this.error.set(String(error));
    } finally {
      this.busy.set(false);
    }
  }
}
