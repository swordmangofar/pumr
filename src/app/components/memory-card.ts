import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { MEMORY_MAX_CHARS } from '../core/memory';
import { MemoryDecision, MemorySuggestion } from '../core/models';
import { SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';
import { TypedInput } from './typed-input';

/**
 * Asks whether pumr should remember a preference the agent proposed. It sits
 * at the end of the chat once the turn is over and waits there. Nothing
 * depends on the answer, so it takes neither the focus nor the keyboard, and
 * the chat is not marked as waiting.
 */
@Component({
  selector: 'app-memory-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, TypedInput],
  template: `
    <div
      class="glass-inset mb-6 rounded-xl px-4 py-3 text-sm"
      role="group"
      [attr.aria-label]="'memory.title' | transloco"
      data-testid="memory-card"
    >
      <p class="font-semibold text-white">{{ 'memory.title' | transloco }}</p>
      <p class="mt-0.5 text-xs text-mist/50" data-testid="memory-origin">
        {{ (suggestion().requested ? 'memory.requested' : 'memory.noticed') | transloco }}
      </p>
      @if (suggestion().replaces; as replaced) {
        <p class="mt-2 text-xs leading-relaxed text-mist/50" data-testid="memory-replaces">
          {{ 'memory.replaces' | transloco: { text: replaced.text } }}
        </p>
      }
      <textarea
        class="field mt-2 w-full resize-none rounded-xl px-4 py-2 text-sm leading-relaxed"
        rows="1"
        [attr.maxlength]="maxChars"
        [attr.aria-label]="'memory.textLabel' | transloco"
        [value]="text()"
        (typedValue)="text.set($event)"
      ></textarea>
      <p class="mt-2 text-xs leading-relaxed text-mist/30">{{ 'memory.hint' | transloco }}</p>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-ink transition-colors hover:bg-accent/90 disabled:opacity-40"
          data-action="save"
          [disabled]="busy() || !text().trim()"
          (click)="answer('save')"
        >
          {{ 'memory.save' | transloco }}
        </button>
        <button
          type="button"
          class="rounded-full border border-white/15 px-4 py-1.5 text-sm text-mist transition-colors hover:bg-white/5 disabled:opacity-40"
          data-action="decline"
          [disabled]="busy()"
          (click)="answer('decline')"
        >
          {{ 'memory.decline' | transloco }}
        </button>
        <span class="flex-1"></span>
        @if (suggestionsOn()) {
          <button
            type="button"
            class="rounded-full px-3 py-1.5 text-xs text-mist/50 transition-colors hover:bg-white/5 hover:text-mist disabled:opacity-40"
            data-action="disable"
            [attr.title]="'memory.disableHint' | transloco"
            [disabled]="busy()"
            (click)="answer('disable')"
          >
            {{ 'memory.disable' | transloco }}
          </button>
        }
      </div>
      @if (error(); as message) {
        <p class="mt-2 text-xs leading-relaxed break-words text-rose-300" role="alert">
          {{ 'chat.error' | transloco }}: {{ message }}
        </p>
      }
    </div>
  `,
})
export class MemoryCard {
  /** The session the suggestion was made in. */
  readonly sessionId = input.required<string>();
  readonly suggestion = input.required<MemorySuggestion>();

  private readonly workspace = inject(WorkspaceService);
  private readonly settings = inject(SettingsService);

  protected readonly maxChars = MEMORY_MAX_CHARS;
  /** The text as the user left it; another suggestion starts from its own. */
  protected readonly text = linkedSignal(() => this.suggestion().text);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** "Don't ask again" has nothing to switch off once the suggestions are off. */
  protected readonly suggestionsOn = computed(
    () => this.settings.settings()?.memorySuggestions ?? true,
  );

  protected async answer(decision: MemoryDecision): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.workspace.resolveMemorySuggestion(
        this.sessionId(),
        this.suggestion().id,
        decision,
        decision === 'save' ? this.text() : null,
      );
    } catch (error) {
      this.error.set(String(error));
    } finally {
      this.busy.set(false);
    }
  }
}
