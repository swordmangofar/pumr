import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';
import { AttentionIndicator } from './attention-indicator';

/**
 * Floats over the top of the chat while other chats wait on a permission or
 * an answer: one banner per chat, with a button that switches to it and one
 * that closes the banner. Can be turned off in the settings.
 */
@Component({
  selector: 'app-waiting-chats-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AttentionIndicator, TranslocoPipe],
  template: `
    @if (chats().length > 0) {
      <div
        class="pointer-events-none absolute inset-x-0 top-3 z-30 flex max-h-[calc(100%-1.5rem)] flex-col gap-2 overflow-y-auto px-5"
      >
        @for (chat of chats(); track chat.session.id) {
          <div
            role="status"
            class="pointer-events-auto flex w-full shrink-0 items-center gap-2.5 rounded-xl border border-white/10 bg-navy/95 py-1.5 pr-1.5 pl-4 text-sm shadow-2xl shadow-black/50 backdrop-blur"
          >
            <app-attention-indicator [kind]="chat.kind" />
            <span class="shrink-0 font-medium text-white">
              {{
                (chat.kind === 'question' ? 'chat.waitingQuestion' : 'chat.waitingPermission')
                  | transloco
              }}
            </span>
            <span class="min-w-0 flex-1 truncate text-mist/70">{{ chat.session.title }}</span>
            <button
              type="button"
              class="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-3.5 py-1 text-sm font-medium text-accent transition-colors hover:bg-accent/20"
              (click)="workspace.showWaitingChat(chat.session.id)"
            >
              {{ 'chat.waitingSwitch' | transloco }}
            </button>
            <button
              type="button"
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-mist/50 transition-colors hover:bg-white/10 hover:text-white"
              [title]="'chat.waitingDismiss' | transloco"
              [attr.aria-label]="'chat.waitingDismiss' | transloco"
              (click)="workspace.dismissWaitingChat(chat.session.id)"
            >
              <svg
                viewBox="0 0 16 16"
                class="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        }
      </div>
    }
  `,
})
export class WaitingChatsBanner {
  protected readonly workspace = inject(WorkspaceService);
  private readonly settings = inject(SettingsService);

  protected readonly chats = computed(() =>
    (this.settings.settings()?.waitingChatsBanner ?? true) ? this.workspace.waitingElsewhere() : [],
  );
}
