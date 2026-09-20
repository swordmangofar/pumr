import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { ChatView } from './components/chat-view';
import { ProcessIndicator } from './components/process-indicator';
import { PumaLoader } from './components/puma-loader';
import { RightPanel } from './components/right-panel';
import { SettingsDialog } from './components/settings/settings-dialog';
import { Sidebar } from './components/sidebar';
import { SpendIndicator } from './components/spend-indicator';
import { WorkspaceEditor } from './components/workspace-editor';
import { isTauri } from './core/api';
import { matchesHotkey } from './core/hotkeys';
import { ModelsService } from './core/models.service';
import { SettingsService } from './core/settings.service';
import { WorkspaceService } from './core/workspace.service';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Sidebar,
    ChatView,
    RightPanel,
    SettingsDialog,
    ProcessIndicator,
    PumaLoader,
    SpendIndicator,
    WorkspaceEditor,
    TranslocoPipe,
  ],
  host: {
    '(document:keydown)': 'onHotkey($event)',
  },
  template: `
    @if (splashVisible()) {
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-ink transition-opacity duration-300"
        [class.pointer-events-none]="!booting()"
        [class.opacity-0]="!booting()"
      >
        <app-puma-loader />
      </div>
    }

    <div class="flex h-screen w-screen flex-col overflow-hidden text-mist">
      @if (!tauri) {
        <div class="border-b border-accent/25 bg-accent/10 px-5 py-2.5 text-sm text-accent">
          {{ 'app.notTauri' | transloco }}
        </div>
      }

      <header class="flex min-h-14 shrink-0 items-center justify-between gap-3 px-4 py-2">
        <div class="flex min-w-0 items-center gap-3">
          <img src="logo.svg" alt="" class="h-7 w-7 shrink-0 rounded-lg" />
          <span class="text-base font-bold tracking-tight text-white">pumr</span>
          <button
            type="button"
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/5 text-mist/60 transition-colors hover:bg-white/10 hover:text-accent"
            [title]="'app.toggleSidebar' | transloco"
            (click)="leftPanelOpen.set(!leftPanelOpen())"
          >
            <svg
              viewBox="0 0 24 24"
              class="h-4 w-4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path
                d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
              />
            </svg>
          </button>
          @if (workspace.activeProject(); as project) {
            <span class="truncate text-sm text-mist/40">{{ project.path }}</span>
          }
          @if (workspace.activeGitInfo(); as git) {
            @if (git.branch) {
              <span
                class="shrink-0 rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs text-mist/60"
              >
                ⎇ {{ git.branch }}
              </span>
            }
          }
        </div>
        <div
          class="no-scrollbar flex min-w-0 flex-1 items-center gap-1"
          [class]="
            (settings.settings()?.tabsMultiline ?? true)
              ? 'flex-wrap'
              : 'flex-nowrap overflow-x-auto'
          "
        >
          @for (session of workspace.tabs(); track session.id) {
            <div
              class="group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors"
              [class]="
                session.id === workspace.activeSessionId()
                  ? 'bg-accent/15 text-white ring-1 ring-accent/30'
                  : 'text-mist/50 hover:bg-white/5 hover:text-mist'
              "
              (click)="workspace.openTab(session.id)"
            >
              <span class="max-w-48 truncate">{{ session.title }}</span>
              <button
                type="button"
                class="-mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-mist/40 transition-colors hover:bg-white/10 hover:text-white"
                [attr.aria-label]="'tabs.close' | transloco"
                (click)="closeTab($event, session.id)"
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

          <button
            type="button"
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/5 text-mist/60 transition-colors hover:bg-white/10 hover:text-accent"
            [title]="'tabs.new' | transloco"
            [attr.aria-label]="'tabs.new' | transloco"
            (click)="startNewSession()"
          >
            <svg
              class="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
        <div class="flex shrink-0 items-center gap-4 text-sm text-mist/50">
          <app-spend-indicator class="hidden lg:block" />
          <app-process-indicator />
          <button
            type="button"
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/5 text-mist/60 transition-colors hover:bg-white/10 hover:text-accent"
            [title]="'app.toggleRightPanel' | transloco"
            (click)="rightPanelOpen.set(!rightPanelOpen())"
          >
            <svg
              viewBox="0 0 24 24"
              class="h-4 w-4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M15 3v18" />
            </svg>
          </button>
          <button
            type="button"
            class="rounded-full bg-white/5 px-4 py-1.5 text-sm text-mist transition-colors hover:bg-white/10 hover:text-accent"
            (click)="settings.open()"
          >
            {{ 'app.settings' | transloco }}
          </button>
        </div>
      </header>

      <div class="flex min-h-0 flex-1 gap-2 px-2 pb-2">
        @if (leftPanelOpen()) {
          <app-sidebar class="glass w-72 shrink-0 overflow-hidden rounded-2xl" />
        }

        <main class="glass flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl">
          @if (workspace.leftTab() === 'workspace') {
            <app-workspace-editor class="min-h-0 flex-1" />
          } @else {
            <app-chat-view class="min-h-0 flex-1" />
          }
        </main>

        @if (rightPanelOpen()) {
          <div class="relative shrink-0" [style.width.px]="rightPanelWidth()">
            <div
              [class]="
                'absolute inset-y-0 -left-2 w-2 cursor-col-resize rounded-full transition-colors ' +
                (resizing() ? 'bg-accent/40' : 'hover:bg-accent/30')
              "
              (mousedown)="startResize($event)"
            ></div>
            <app-right-panel class="glass block h-full w-full overflow-hidden rounded-2xl" />
          </div>
        }
      </div>

      @if (settings.dialogOpen()) {
        <app-settings-dialog (closed)="settings.close()" />
      }
    </div>
  `,
})
export class App implements OnInit {
  protected readonly settings = inject(SettingsService);
  protected readonly workspace = inject(WorkspaceService);
  private readonly models = inject(ModelsService);

  protected readonly tauri = isTauri();

  protected readonly rightPanelWidth = signal(512);
  protected readonly resizing = signal(false);
  protected readonly leftPanelOpen = signal(true);
  protected readonly rightPanelOpen = signal(true);
  protected readonly booting = signal(true);
  protected readonly splashVisible = signal(true);
  private readonly minSplashMs = 900;
  private readonly splashFadeMs = 300;
  private readonly minRightPanelWidth = 320;
  private readonly minMainWidth = 360;

  async ngOnInit(): Promise<void> {
    const started = Date.now();
    await this.settings.init();
    if (this.tauri) {
      await Promise.all([this.models.load(), this.workspace.init()]);
    }
    const remaining = this.minSplashMs - (Date.now() - started);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    this.booting.set(false);
    setTimeout(() => this.splashVisible.set(false), this.splashFadeMs);
  }

  protected startResize(event: MouseEvent): void {
    event.preventDefault();
    this.resizing.set(true);
    this.startX = event.clientX;
    this.startWidth = this.rightPanelWidth();

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', this.onResize);
    window.addEventListener('mouseup', this.stopResize);
  }

  private startX = 0;
  private startWidth = 0;

  private readonly onResize = (event: MouseEvent): void => {
    const delta = this.startX - event.clientX;
    const max = window.innerWidth - this.minMainWidth;
    const next = Math.min(
      Math.max(this.startWidth + delta, this.minRightPanelWidth),
      Math.max(this.minRightPanelWidth, max),
    );
    this.rightPanelWidth.set(next);
  };

  private readonly stopResize = (): void => {
    this.resizing.set(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', this.onResize);
    window.removeEventListener('mouseup', this.stopResize);
  };

  protected closeTab(event: Event, sessionId: string): void {
    event.stopPropagation();
    this.workspace.closeTab(sessionId);
  }

  protected async startNewSession(): Promise<void> {
    let project = this.workspace.activeProject() ?? this.workspace.projects()[0] ?? null;
    if (!project) {
      await this.workspace.addProject();
      project = this.workspace.projects()[0] ?? null;
      if (!project) {
        return;
      }
    }
    await this.workspace.newSession(project.id);
  }

  protected onHotkey(event: KeyboardEvent): void {
    if (event.repeat || event.isComposing) {
      return;
    }
    if (this.settings.dialogOpen()) {
      return;
    }
    const settings = this.settings.settings();
    if (!settings) {
      return;
    }
    if (matchesHotkey(settings.openTabHotkey, event)) {
      event.preventDefault();
      void this.startNewSession();
      return;
    }
    if (matchesHotkey(settings.closeTabHotkey, event)) {
      event.preventDefault();
      const sessionId = this.workspace.activeSessionId();
      if (sessionId) {
        this.workspace.closeTab(sessionId);
      }
    }
  }
}
