import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { TypedInput } from '../typed-input';

/** A list of typed entries (paths, command patterns) with one field to add to it. */
@Component({
  selector: 'app-text-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, TypedInput],
  template: `
    <div class="space-y-1.5">
      @for (item of items(); track item) {
        <div
          class="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-ink/40 px-4 py-2"
        >
          <span class="truncate font-mono text-sm text-mist">{{ item }}</span>
          <button
            type="button"
            class="shrink-0 text-mist/40 transition-colors hover:text-rose-400"
            [attr.aria-label]="'common.remove' | transloco"
            (click)="remove(item)"
          >
            ✕
          </button>
        </div>
      } @empty {
        <p class="text-sm text-mist/30">{{ emptyLabel() | transloco }}</p>
      }
    </div>
    <form class="mt-3 flex gap-2" (submit)="add($event)">
      <input
        type="text"
        class="field min-w-0 flex-1 rounded-xl px-4 py-2 font-mono text-sm"
        autocomplete="off"
        spellcheck="false"
        [value]="entry()"
        [placeholder]="placeholder()"
        [attr.aria-label]="addLabel() | transloco"
        (typedValue)="entry.set($event)"
      />
      <button
        type="submit"
        class="shrink-0 rounded-full border border-white/15 px-4 py-2 text-sm text-mist transition-colors hover:bg-white/5 disabled:opacity-40"
        [disabled]="!entry().trim()"
      >
        ＋ {{ addLabel() | transloco }}
      </button>
    </form>
  `,
})
export class TextList {
  readonly items = input.required<string[]>();
  readonly changed = output<string[]>();
  /** Translation keys of the add button and of the line shown for an empty list. */
  readonly addLabel = input.required<string>();
  readonly emptyLabel = input.required<string>();
  /** An example entry: a path or a command, not a sentence. */
  readonly placeholder = input('');

  protected readonly entry = signal('');

  protected add(event: Event): void {
    event.preventDefault();
    const value = this.entry().trim();
    if (!value) {
      return;
    }
    if (!this.items().includes(value)) {
      this.changed.emit([...this.items(), value]);
    }
    this.entry.set('');
  }

  protected remove(item: string): void {
    this.changed.emit(this.items().filter((entry) => entry !== item));
  }
}
