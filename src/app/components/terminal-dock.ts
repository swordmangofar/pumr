import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { displayBindings, HotkeyAction, hotkeyBindings } from '../core/hotkeys';
import { SettingsService } from '../core/settings.service';
import { TERMINAL_MIN_HEIGHT, TerminalService } from '../core/terminal.service';
import { WorkspaceService } from '../core/workspace.service';
import { TerminalView } from './terminal-view';

/** Room the chat or editor above the dock keeps when it is resized. */
const MIN_CONTENT_HEIGHT = 160;

/**
 * The terminal dock at the bottom of the main panel. Its terminals stay
 * rendered while the dock is hidden or another project is active, so their
 * shells and scrollback survive.
 */
@Component({
  selector: 'app-terminal-dock',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, TerminalView],
  host: {
    class: 'relative shrink-0 flex-col border-t border-white/10',
    '[class.flex]': 'visible()',
    '[class.hidden]': '!visible()',
    '[style.height.px]': 'terminals.height()',
  },
  template: `
    <div
      [class]="
        'absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize transition-colors ' +
        (resizing() ? 'bg-accent/40' : 'hover:bg-accent/30')
      "
      (mousedown)="startResize($event)"
    ></div>

    <div class="flex shrink-0 items-center gap-1 px-2 pt-1.5">
      <div class="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        @for (tab of terminals.projectTabs(); track tab.key) {
          <div
            class="group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg py-1 pr-1 pl-2.5 text-xs transition-colors"
            [class]="
              tab.key === terminals.activeKey()
                ? 'bg-white/10 text-white'
                : 'text-mist/50 hover:bg-white/5 hover:text-mist'
            "
            (click)="terminals.activate(tab.key)"
          >
            <svg
              class="h-3.5 w-3.5 shrink-0"
              [class]="tab.exitCode === null ? 'text-accent/80' : 'text-rose-400'"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="m4 17 6-6-6-6M12 19h8" />
            </svg>
            <span class="max-w-48 truncate" [title]="tab.title ?? ''">
              {{ tab.title ?? ('terminal.title' | transloco: { number: tab.number }) }}
            </span>
            <button
              type="button"
              class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-mist/40 transition-all hover:bg-white/10 hover:text-white focus-visible:opacity-100"
              [class]="tab.key === terminals.activeKey() ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
              [title]="
                ('terminal.close' | transloco) +
                (tab.key === terminals.activeKey() ? closeHotkeyHint() : '')
              "
              [attr.aria-label]="'terminal.close' | transloco"
              (click)="close($event, tab.key)"
            >
              <svg
                class="h-3 w-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        }
        @if (workspace.activeProject()) {
          <button
            type="button"
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-mist/50 transition-colors hover:bg-white/10 hover:text-accent"
            [title]="('terminal.new' | transloco) + newHotkeyHint()"
            [attr.aria-label]="'terminal.new' | transloco"
            (click)="terminals.createForActiveProject()"
          >
            <svg
              class="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        }
      </div>
      <button
        type="button"
        class="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-mist/50 transition-colors hover:bg-white/10 hover:text-white"
        [title]="'terminal.hide' | transloco"
        [attr.aria-label]="'terminal.hide' | transloco"
        (click)="terminals.setOpen(false)"
      >
        <svg
          class="h-3.5 w-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
    </div>

    <div class="relative min-h-0 flex-1 px-3 pt-1 pb-2">
      @for (tab of terminals.tabs(); track tab.key) {
        <app-terminal-view
          class="absolute inset-x-3 top-1 bottom-2"
          [class.invisible]="tab.key !== terminals.activeKey()"
          [tab]="tab"
          [visible]="tab.key === terminals.activeKey()"
        />
      }
      @if (!workspace.activeProject()) {
        <p class="px-1 py-2 text-sm text-mist/40">{{ 'terminal.noProject' | transloco }}</p>
      }
    </div>
  `,
})
export class TerminalDock {
  protected readonly terminals = inject(TerminalService);
  protected readonly workspace = inject(WorkspaceService);
  private readonly settings = inject(SettingsService);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly resizing = signal(false);
  protected readonly visible = computed(() => this.terminals.open());
  protected readonly newHotkeyHint = computed(() => this.hotkeyHint('terminalNewTab'));
  protected readonly closeHotkeyHint = computed(() => this.hotkeyHint('terminalCloseTab'));

  private startY = 0;
  private startHeight = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopResize());
  }

  private hotkeyHint(action: HotkeyAction): string {
    const hotkey = displayBindings(hotkeyBindings(this.settings.settings(), action));
    return hotkey ? ` (${hotkey})` : '';
  }

  protected close(event: Event, key: string): void {
    event.stopPropagation();
    this.terminals.close(key);
  }

  protected startResize(event: MouseEvent): void {
    event.preventDefault();
    this.resizing.set(true);
    this.startY = event.clientY;
    this.startHeight = this.terminals.height();
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', this.onResize);
    window.addEventListener('mouseup', this.stopResize);
  }

  private readonly onResize = (event: MouseEvent): void => {
    const panel = this.element.nativeElement.parentElement;
    const max = Math.max(
      TERMINAL_MIN_HEIGHT,
      (panel?.clientHeight ?? window.innerHeight) - MIN_CONTENT_HEIGHT,
    );
    const next = this.startHeight + (this.startY - event.clientY);
    this.terminals.setHeight(Math.min(next, max));
  };

  private readonly stopResize = (): void => {
    if (!this.resizing()) {
      return;
    }
    this.resizing.set(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', this.onResize);
    window.removeEventListener('mouseup', this.stopResize);
  };
}
