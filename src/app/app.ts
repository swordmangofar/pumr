import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { ChatView } from './components/chat-view';
import { ProcessIndicator } from './components/process-indicator';
import { PumaLoader } from './components/puma-loader';
import { RightPanel } from './components/right-panel';
import { SettingsDialog } from './components/settings/settings-dialog';
import { Sidebar } from './components/sidebar';
import { isTauri } from './core/api';
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
    TranslocoPipe,
  ],
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

    <div class="flex h-screen w-screen flex-col overflow-hidden bg-ink text-mist">
      @if (!tauri) {
        <div class="border-b border-accent/25 bg-accent/10 px-5 py-2.5 text-sm text-accent">
          {{ 'app.notTauri' | transloco }}
        </div>
      }

      <header class="flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-5">
        <div class="flex min-w-0 items-center gap-3">
          <img src="logo.svg" alt="" class="h-7 w-7 shrink-0 rounded-lg" />
          <span class="text-base font-bold tracking-tight text-white">pumr</span>
          <button
            type="button"
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/10 text-mist/60 transition-colors hover:border-accent/60 hover:text-accent"
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
        <div class="flex items-center gap-4 text-sm text-mist/50">
          @if (spend(); as summary) {
            <span class="hidden items-center gap-1.5 lg:flex">
              {{ 'app.spent' | transloco }}
              <span class="font-medium text-white">{{ money(summary.totalCost) }}</span>
            </span>
            @if (summary.remainingUsd !== null) {
              <span class="hidden items-center gap-1.5 lg:flex">
                {{ 'app.remaining' | transloco }}
                <span class="font-medium text-emerald-400">{{ money(summary.remainingUsd) }}</span>
                <span class="text-mist/30">/ {{ money(summary.budgetUsd) }}</span>
              </span>
            }
          }
          <app-process-indicator />
          <button
            type="button"
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/10 text-mist/60 transition-colors hover:border-accent/60 hover:text-accent"
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
            class="rounded-full border border-white/15 px-4 py-1.5 text-sm text-mist transition-colors hover:border-accent/60 hover:text-accent"
            (click)="settings.open()"
          >
            {{ 'app.settings' | transloco }}
          </button>
        </div>
      </header>

      <div class="flex min-h-0 flex-1">
        @if (leftPanelOpen()) {
          <app-sidebar class="w-72 shrink-0 border-r border-white/10" />
        }

        <main class="flex min-w-0 flex-1 flex-col">
          <div
            class="flex gap-1 border-b border-white/10 bg-navy/20 px-2.5 py-2"
            [class]="
              settings.settings()?.tabsMultiline ?? true
                ? 'flex-wrap items-center'
                : 'items-center overflow-x-auto'
            "
          >
            @for (session of workspace.tabs(); track session.id) {
              <div
                class="group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors"
                [class]="
                  session.id === workspace.activeSessionId()
                    ? 'border-accent/30 bg-accent/15 text-white'
                    : 'border-white/10 bg-white/5 text-mist/50 hover:border-white/20 hover:bg-white/10 hover:text-mist'
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
          </div>

          <app-chat-view class="min-h-0 flex-1" />
        </main>

        @if (rightPanelOpen()) {
          <div
            [class]="
              'w-1.5 shrink-0 cursor-col-resize transition-colors ' +
              (resizing() ? 'bg-accent/50' : 'hover:bg-accent/50')
            "
            (mousedown)="startResize($event)"
          ></div>

          <app-right-panel
            [style.width.px]="rightPanelWidth()"
            class="shrink-0 border-l border-white/10"
          />
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
  protected readonly spend = this.workspace.spend;

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

  protected money(value: number | null | undefined): string {
    if (value === null || value === undefined) {
      return '—';
    }
    if (value === 0) {
      return '$0.00';
    }
    return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
  }
}
