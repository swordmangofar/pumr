import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { SIDE_QUESTION_COMMAND, SideQuestionService } from '../core/side-question.service';
import { TerminalService } from '../core/terminal.service';
import { WorkspaceService } from '../core/workspace.service';
import { CopyButton } from './copy-button';
import { MarkdownView } from './markdown-view';
import { PumaSpinner } from './puma-spinner';
import { StickToBottom } from './stick-to-bottom';

/**
 * The answer to the active session's side question (`/btw`), docked below the
 * chat box. It takes no room while there is no side question.
 */
@Component({
  selector: 'app-side-answer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, MarkdownView, CopyButton, PumaSpinner, StickToBottom],
  host: { class: 'block shrink-0' },
  template: `
    @if (entry(); as entry) {
      <section
        class="border-t border-white/10"
        data-testid="side-answer"
        [attr.aria-label]="'chat.sideQuestion' | transloco"
      >
        <div class="mx-auto w-full max-w-4xl px-5 pt-2 pb-3">
          <header class="flex items-center gap-2">
            <span
              class="flex shrink-0 items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 font-mono text-[11px] text-accent"
            >
              @if (entry.status === 'running') {
                <app-puma-spinner [small]="true" />
              }
              {{ command }}
            </span>
            <span class="min-w-0 flex-1 truncate text-xs text-mist/60" [attr.title]="entry.question">
              {{ entry.question }}
            </span>
            <span class="hidden shrink-0 text-[11px] text-mist/35 sm:inline">
              {{ 'chat.sideQuestionPrivate' | transloco }}
            </span>
            @if (entry.status === 'running') {
              <button
                type="button"
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-rose-300/80 transition-colors hover:bg-rose-500/15 hover:text-rose-200"
                [attr.title]="'chat.stop' | transloco"
                [attr.aria-label]="'chat.stop' | transloco"
                (click)="stop()"
              >
                <svg class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <rect x="5" y="5" width="10" height="10" rx="1.5" />
                </svg>
              </button>
            } @else if (entry.answer) {
              <app-copy-button
                [text]="entry.answer"
                buttonClass="h-6 w-6 border-transparent text-mist/50 hover:bg-white/10 hover:text-white"
              />
            }
            <button
              type="button"
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-mist/50 transition-colors hover:bg-white/10 hover:text-white"
              [attr.title]="'common.close' | transloco"
              [attr.aria-label]="'common.close' | transloco"
              (click)="dismiss()"
            >
              <svg
                class="h-3 w-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </header>

          <div
            class="mt-2 overflow-y-auto pr-1"
            [class]="terminals.open() ? 'max-h-36' : 'max-h-[min(40vh,20rem)]'"
            aria-live="polite"
            [appStickToBottom]="entry.answer"
          >
            @if (entry.answer) {
              <app-markdown
                class="text-sm leading-relaxed break-words text-mist"
                [content]="entry.answer"
                [streaming]="entry.status === 'running'"
              />
            } @else if (entry.status === 'running') {
              <p class="text-sm text-mist/40">{{ 'chat.sideQuestionAnswering' | transloco }}</p>
            }
            @if (entry.status === 'stopped') {
              <p class="mt-1 text-xs text-mist/40">{{ 'chat.sideQuestionStopped' | transloco }}</p>
            }
            @if (entry.error) {
              <p class="text-sm break-words text-rose-300">{{ entry.error }}</p>
            }
          </div>
        </div>
      </section>
    }
  `,
})
export class SideAnswer {
  private readonly sideQuestions = inject(SideQuestionService);
  private readonly workspace = inject(WorkspaceService);
  /** With the terminal docked below as well, the answer leaves the chat more room. */
  protected readonly terminals = inject(TerminalService);

  protected readonly command = `/${SIDE_QUESTION_COMMAND}`;
  protected readonly entry = computed(() => this.sideQuestions.active());

  protected stop(): void {
    const session = this.workspace.activeAgent();
    if (session) {
      void this.sideQuestions.stop(session.id);
    }
  }

  protected dismiss(): void {
    const session = this.workspace.activeAgent();
    if (session) {
      this.sideQuestions.dismiss(session.id);
      this.workspace.requestComposerFocus();
    }
  }
}
