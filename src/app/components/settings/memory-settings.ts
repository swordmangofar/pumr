import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { MEMORY_MAX_CHARS, MEMORY_MAX_ENTRIES } from '../../core/memory';
import { MemoryEntry } from '../../core/models';
import { Toggle } from '../toggle';
import { TypedInput } from '../typed-input';
import { SettingsDraftService } from './settings-draft.service';

/**
 * What pumr remembers of how the user likes to work: whether it is used,
 * whether the agent may propose more, and the entries themselves. An entry
 * comes from a card the user answered in a chat, or is written here.
 */
@Component({
  selector: 'app-memory-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, TypedInput, Toggle],
  template: `
    <section>
      <h3 class="mb-2 text-sm font-semibold text-white">
        {{ 'settings.memory.title' | transloco }}
      </h3>
      <p class="text-xs leading-relaxed text-mist/30">{{ 'settings.memory.hint' | transloco }}</p>

      <div
        class="mt-4 rounded-xl border border-white/10 bg-ink/40 px-4 py-3"
        data-testid="memory-enabled"
      >
        <div class="flex items-start gap-3">
          <app-toggle
            class="mt-0.5"
            [checked]="enabled()"
            (toggled)="draft.patch('memoryEnabled', $event)"
          />
          <div>
            <label class="block text-sm font-medium text-mist">
              {{ 'settings.memory.enabled' | transloco }}
            </label>
            <p class="mt-1 text-xs leading-relaxed text-mist/30">
              {{ 'settings.memory.enabledHint' | transloco }}
            </p>
          </div>
        </div>
      </div>

      <div
        class="mt-3 rounded-xl border border-white/10 bg-ink/40 px-4 py-3"
        data-testid="memory-suggestions"
      >
        <div class="flex items-start gap-3">
          <app-toggle
            class="mt-0.5"
            [checked]="enabled() && draft.draft().memorySuggestions"
            [disabled]="!enabled()"
            (toggled)="draft.patch('memorySuggestions', $event)"
          />
          <div>
            <label class="block text-sm font-medium text-mist">
              {{ 'settings.memory.suggestions' | transloco }}
            </label>
            <p class="mt-1 text-xs leading-relaxed text-mist/30">
              {{ 'settings.memory.suggestionsHint' | transloco }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <section class="mt-8">
      <div class="mb-3 flex items-center justify-between gap-3">
        <h3 class="text-sm font-semibold text-white">
          {{ 'settings.memory.list' | transloco }}
          <span class="ml-1 font-normal text-mist/40" data-testid="memory-count">
            {{ entries().length }}/{{ maxEntries }}
          </span>
        </h3>
        <button
          type="button"
          data-testid="add-memory"
          class="shrink-0 rounded-full border border-white/15 px-4 py-2 text-sm text-mist transition-colors hover:bg-white/5 disabled:opacity-40"
          [disabled]="entries().length >= maxEntries"
          (click)="add()"
        >
          ＋ {{ 'settings.memory.add' | transloco }}
        </button>
      </div>
      <div class="space-y-3">
        @for (entry of entries(); track entry.id) {
          <div class="glass-inset flex items-start gap-2 rounded-xl p-3" data-testid="memory-entry">
            <textarea
              class="field min-w-0 flex-1 resize-none rounded-xl px-4 py-2 text-sm leading-relaxed"
              rows="1"
              [attr.maxlength]="maxChars"
              [attr.aria-label]="'settings.memory.list' | transloco"
              [attr.placeholder]="'settings.memory.placeholder' | transloco"
              [value]="entry.text"
              (typedValue)="edit(entry.id, $event)"
            ></textarea>
            <button
              type="button"
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-mist/40 transition-colors hover:bg-white/5 hover:text-rose-400"
              [attr.aria-label]="'settings.memory.remove' | transloco"
              (click)="remove(entry.id)"
            >
              ✕
            </button>
          </div>
        } @empty {
          <p class="text-sm text-mist/30" data-testid="no-memories">
            {{ 'settings.memory.empty' | transloco }}
          </p>
        }
      </div>
    </section>
  `,
})
export class MemorySettings {
  protected readonly draft = inject(SettingsDraftService);

  protected readonly maxChars = MEMORY_MAX_CHARS;
  protected readonly maxEntries = MEMORY_MAX_ENTRIES;
  protected readonly enabled = computed(() => this.draft.draft().memoryEnabled);
  protected readonly entries = computed(() => this.draft.draft().memories ?? []);

  protected add(): void {
    const entry: MemoryEntry = { id: crypto.randomUUID(), text: '' };
    this.draft.patch('memories', [...this.entries(), entry]);
  }

  protected edit(id: string, text: string): void {
    this.draft.patch(
      'memories',
      this.entries().map((entry) => (entry.id === id ? { ...entry, text } : entry)),
    );
  }

  protected remove(id: string): void {
    this.draft.patch(
      'memories',
      this.entries().filter((entry) => entry.id !== id),
    );
  }
}
