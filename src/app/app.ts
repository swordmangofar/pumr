import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { AgentStatus } from './components/agent-status';
import { AttentionIndicator } from './components/attention-indicator';
import { ChatView } from './components/chat-view';
import { DebugView } from './components/debug-view';
import { GitView } from './components/git-view';
import { ProcessIndicator } from './components/process-indicator';
import { PumaLoader } from './components/puma-loader';
import { ProjectAppearanceDialog } from './components/project-appearance-dialog';
import { ProjectIcon } from './components/project-icon';
import { RightPanel } from './components/right-panel';
import { SettingsDialog } from './components/settings/settings-dialog';
import { Sidebar } from './components/sidebar';
import { SpendIndicator } from './components/spend-indicator';
import { WorkspaceEditor } from './components/workspace-editor';
import { isTauri } from './core/api';
import { matchesHotkey } from './core/hotkeys';
import { Session } from './core/models';
import { ModelsService } from './core/models.service';
import { SettingsService } from './core/settings.service';
import { WorkspaceService } from './core/workspace.service';

const EMPTY_IDS: ReadonlySet<string> = new Set();

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Sidebar,
    ChatView,
    GitView,
    RightPanel,
    SettingsDialog,
    DebugView,
    ProcessIndicator,
    PumaLoader,
    SpendIndicator,
    WorkspaceEditor,
    TranslocoPipe,
    AgentStatus,
    AttentionIndicator,
    ProjectIcon,
    ProjectAppearanceDialog,
  ],
  host: {
    '(document:keydown)': 'onHotkey($event)',
  },
  template: `
    <div class="app-background" aria-hidden="true"></div>

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
            (click)="workspace.toggleLeftPanel()"
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
            <app-project-icon [project]="project" [size]="22" />
            <span
              class="flex min-w-0 max-w-[220px] items-baseline gap-1.5"
              [title]="project.path"
            >
              @if (parentPath(project.path); as parent) {
                <span class="truncate text-xs text-mist/30">{{ parent }}</span>
              }
              <span class="truncate text-sm font-medium text-mist/80">{{ project.name }}</span>
            </span>
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
          #tabsBar
          class="no-scrollbar relative flex min-w-0 flex-1 items-center gap-1 glass-inset rounded-2xl p-1"
          [class]="
            (settings.settings()?.tabsMultiline ?? true)
              ? 'flex-wrap'
              : 'flex-nowrap overflow-x-auto'
          "
        >
          @for (session of workspace.tabs(); track session.id; let i = $index) {
            @if (i > 0 && !isCollapsed(session.id)) {
              <span class="mx-0.5 h-5 w-px shrink-0 bg-white/10" aria-hidden="true"></span>
            }
            <div
              class="group flex shrink-0 cursor-pointer items-center gap-2 rounded-xl px-3 py-1.5 text-sm font-medium transition-colors"
              [class]="
                session.id === workspace.activeSessionId()
                  ? 'bg-accent/15 text-white ring-1 ring-inset ring-accent/30'
                  : 'text-mist/50 hover:bg-white/5 hover:text-mist'
              "
              [class.relative]="!isCollapsed(session.id)"
              [class.absolute]="isCollapsed(session.id)"
              [class.invisible]="isCollapsed(session.id)"
              [class.pointer-events-none]="isCollapsed(session.id)"
              [class.w-max]="isCollapsed(session.id)"
              [attr.data-session-tab]="session.id"
              (click)="workspace.openTab(session.id)"
            >
              @if (session.id === workspace.activeSessionId()) {
                <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true"></span>
              }
              @if (projectFor(session.projectId); as project) {
                <span class="relative inline-flex shrink-0">
                  <app-project-icon [project]="project" [size]="20" />
                  @if (workspace.sessionAttention(session.id); as attention) {
                    <span
                      class="absolute -top-1 -left-1 flex h-2 w-2 items-center justify-center rounded-full ring-2 ring-ink"
                    >
                      <app-attention-indicator [kind]="attention" />
                    </span>
                  }
                </span>
              } @else if (workspace.sessionAttention(session.id); as attention) {
                <app-attention-indicator
                  [kind]="attention"
                  [onAccent]="session.id === workspace.activeSessionId()"
                />
              }
              <span class="max-w-48 truncate">{{ session.title }}</span>
              @if (workspace.agentActivity(session.id); as status) {
                <app-agent-status [status]="status" [small]="true" />
              }
              <button
                type="button"
                class="-mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-mist/40 transition-all hover:bg-white/10 hover:text-white focus-visible:opacity-100"
                [class]="
                  session.id === workspace.activeSessionId()
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100'
                "
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

          @if (collapsedTabs().length > 0) {
            <div class="relative shrink-0">
              <button
                type="button"
                data-tab-overflow
                class="flex h-8 shrink-0 items-center gap-1 rounded-xl px-2 text-sm font-medium transition-colors"
                [class]="
                  activeTabCollapsed()
                    ? 'bg-accent/15 text-white ring-1 ring-inset ring-accent/30'
                    : 'text-mist/50 hover:bg-white/5 hover:text-mist'
                "
                [attr.aria-expanded]="overflowOpen()"
                [title]="'tabs.more' | transloco"
                [attr.aria-label]="'tabs.more' | transloco"
                (click)="overflowOpen.set(!overflowOpen())"
              >
                <span class="text-xs">{{ collapsedTabs().length }}</span>
                <svg
                  class="h-4 w-4"
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

              @if (overflowOpen()) {
                <div class="fixed inset-0 z-30" (click)="overflowOpen.set(false)"></div>
                <div
                  class="absolute right-0 top-full z-40 mt-2 max-h-[min(20rem,50vh)] w-72 max-w-[80vw] overflow-y-auto glass-pop rounded-2xl p-1 shadow-2xl"
                >
                  @for (session of collapsedTabs(); track session.id) {
                    <div
                      class="group flex items-center gap-1 rounded-xl pr-1 transition-colors"
                      [class]="
                        session.id === workspace.activeSessionId()
                          ? 'bg-accent/15'
                          : 'hover:bg-white/5'
                      "
                    >
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-1.5 text-left text-sm"
                        [class]="
                          session.id === workspace.activeSessionId()
                            ? 'font-medium text-white'
                            : 'text-mist/50 hover:text-mist'
                        "
                        (click)="openFromOverflow(session.id)"
                      >
                        @if (projectFor(session.projectId); as project) {
                          <span class="relative inline-flex shrink-0">
                            <app-project-icon [project]="project" [size]="20" />
                            @if (workspace.sessionAttention(session.id); as attention) {
                              <span
                                class="absolute -top-1 -left-1 flex h-2 w-2 items-center justify-center rounded-full ring-2 ring-ink"
                              >
                                <app-attention-indicator [kind]="attention" />
                              </span>
                            }
                          </span>
                        } @else if (workspace.sessionAttention(session.id); as attention) {
                          <app-attention-indicator
                            [kind]="attention"
                            [onAccent]="session.id === workspace.activeSessionId()"
                          />
                        }
                        <span class="min-w-0 flex-1 truncate">{{ session.title }}</span>
                        @if (workspace.agentActivity(session.id); as status) {
                          <app-agent-status
                            [status]="status"
                            [small]="true"
                            [onAccent]="session.id === workspace.activeSessionId()"
                          />
                        }
                      </button>
                      <button
                        type="button"
                        class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-mist/40 transition-all hover:bg-white/10 hover:text-white"
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
              }
            </div>
          }

          @if (workspace.tabs().length > 0) {
            <span class="mx-0.5 h-5 w-px shrink-0 bg-white/10" aria-hidden="true"></span>
          }
          <button
            type="button"
            data-tab-plus
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-mist/60 transition-colors hover:bg-white/10 hover:text-accent"
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
            (click)="workspace.toggleRightPanel()"
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
        @if (workspace.leftPanelOpen()) {
          <div class="relative shrink-0" [style.width.px]="workspace.leftPanelWidth()">
            <app-sidebar class="glass block h-full w-full overflow-hidden rounded-2xl" />
            <div
              [class]="
                'absolute inset-y-0 -right-2 w-2 cursor-col-resize rounded-full transition-colors ' +
                (resizing() === 'left' ? 'bg-accent/40' : 'hover:bg-accent/30')
              "
              (mousedown)="startResize($event, 'left')"
            ></div>
          </div>
        }

        <main class="glass flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl">
          @if (workspace.leftTab() === 'workspace') {
            <app-workspace-editor class="min-h-0 flex-1" />
          } @else if (workspace.leftTab() === 'git') {
            <app-git-view class="min-h-0 flex-1" />
          } @else {
            <app-chat-view class="min-h-0 flex-1" />
          }
        </main>

        @if (workspace.rightPanelOpen() && workspace.leftTab() !== 'git') {
          <div class="relative shrink-0" [style.width.px]="workspace.rightPanelWidth()">
            <div
              [class]="
                'absolute inset-y-0 -left-2 w-2 cursor-col-resize rounded-full transition-colors ' +
                (resizing() === 'right' ? 'bg-accent/40' : 'hover:bg-accent/30')
              "
              (mousedown)="startResize($event, 'right')"
            ></div>
            <app-right-panel class="glass block h-full w-full overflow-hidden rounded-2xl" />
          </div>
        }
      </div>

      @if (settings.dialogOpen()) {
        <app-settings-dialog (closed)="settings.close()" />
      }

      @if (workspace.debugOpen()) {
        <app-debug-view />
      }

      @if (workspace.projectEditorId()) {
        <app-project-appearance-dialog />
      }
    </div>
  `,
})
export class App implements OnInit {
  protected readonly settings = inject(SettingsService);
  protected readonly workspace = inject(WorkspaceService);
  private readonly models = inject(ModelsService);

  protected readonly tauri = isTauri();

  protected readonly resizing = signal<'left' | 'right' | null>(null);
  protected readonly booting = signal(true);
  protected readonly splashVisible = signal(true);
  private readonly minSplashMs = 900;
  private readonly splashFadeMs = 300;
  private readonly minLeftPanelWidth = 240;
  private readonly minRightPanelWidth = 320;
  private readonly minMainWidth = 360;

  private readonly tabsBar = viewChild<ElementRef<HTMLDivElement>>('tabsBar');
  private readonly collapsedTabIds = signal<ReadonlySet<string>>(EMPTY_IDS);
  protected readonly overflowOpen = signal(false);
  protected readonly collapsedTabs = computed(() => {
    const ids = this.collapsedTabIds();
    return ids.size === 0 ? [] : this.workspace.tabs().filter((session) => ids.has(session.id));
  });
  protected readonly activeTabCollapsed = computed(() =>
    this.collapsedTabIds().has(this.workspace.activeSessionId() ?? ''),
  );

  private readonly destroyRef = inject(DestroyRef);
  private resizeObserver?: ResizeObserver;
  private lastBarWidth = -1;

  constructor() {
    afterRenderEffect({
      read: () => {
        this.workspace.tabs();
        this.settings.settings()?.tabsMultiline;
        this.measureTabs();
      },
    });

    afterNextRender(() => {
      const bar = this.tabsBar()?.nativeElement;
      if (!bar || typeof ResizeObserver === 'undefined') {
        return;
      }
      this.resizeObserver = new ResizeObserver(() => {
        const width = bar.clientWidth;
        if (width === this.lastBarWidth) {
          return;
        }
        this.lastBarWidth = width;
        this.measureTabs();
      });
      this.resizeObserver.observe(bar);
    });

    this.destroyRef.onDestroy(() => this.resizeObserver?.disconnect());
  }

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

  protected startResize(event: MouseEvent, side: 'left' | 'right'): void {
    event.preventDefault();
    this.resizing.set(side);
    this.resizeSide = side;
    this.startX = event.clientX;
    this.startWidth =
      side === 'left' ? this.workspace.leftPanelWidth() : this.workspace.rightPanelWidth();

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', this.onResize);
    window.addEventListener('mouseup', this.stopResize);
  }

  private startX = 0;
  private startWidth = 0;
  private resizeSide: 'left' | 'right' = 'right';

  private readonly onResize = (event: MouseEvent): void => {
    const side = this.resizeSide;
    const left = side === 'left';
    const delta = left ? event.clientX - this.startX : this.startX - event.clientX;
    const min = left ? this.minLeftPanelWidth : this.minRightPanelWidth;
    const other = left
      ? this.workspace.rightPanelOpen()
        ? this.workspace.rightPanelWidth()
        : 0
      : this.workspace.leftPanelOpen()
        ? this.workspace.leftPanelWidth()
        : 0;
    const max = window.innerWidth - this.minMainWidth - other;
    const next = Math.min(Math.max(this.startWidth + delta, min), Math.max(min, max));
    if (left) {
      this.workspace.setLeftPanelWidth(next);
    } else {
      this.workspace.setRightPanelWidth(next);
    }
  };

  private readonly stopResize = (): void => {
    this.resizing.set(null);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', this.onResize);
    window.removeEventListener('mouseup', this.stopResize);
  };

  protected closeTab(event: Event, sessionId: string): void {
    event.stopPropagation();
    this.workspace.closeTab(sessionId);
  }

  protected projectFor(projectId: string) {
    return this.workspace.projectFor(projectId);
  }

  protected parentPath(path: string): string {
    const parent = path.split(/[\\/]/).filter(Boolean).slice(0, -1);
    const home = parent.findIndex((part) => part === 'Users' || part === 'home');
    if (home !== -1 && parent.length > home + 1) {
      const rest = parent.slice(home + 2);
      return rest.length ? `~/${rest.join('/')}` : '~';
    }
    return parent.join('/');
  }

  protected isCollapsed(sessionId: string): boolean {
    return this.collapsedTabIds().has(sessionId);
  }

  protected openFromOverflow(sessionId: string): void {
    this.workspace.openTab(sessionId);
    this.overflowOpen.set(false);
  }

  private measureTabs(): void {
    const bar = this.tabsBar()?.nativeElement;
    const tabs = this.workspace.tabs();
    const multiline = this.settings.settings()?.tabsMultiline ?? true;
    if (!bar || !multiline || tabs.length === 0 || bar.clientWidth === 0) {
      this.setCollapsedIds(EMPTY_IDS);
      return;
    }

    const widths = new Map<string, number>();
    bar.querySelectorAll<HTMLElement>('[data-session-tab]').forEach((element) => {
      const id = element.dataset['sessionTab'];
      if (id) {
        widths.set(id, element.offsetWidth);
      }
    });

    const plus = bar.querySelector<HTMLElement>('[data-tab-plus]');
    const overflow = bar.querySelector<HTMLElement>('[data-tab-overflow]');
    this.setCollapsedIds(
      this.computeCollapsed(
        tabs,
        widths,
        bar.clientWidth - 8,
        plus?.offsetWidth ?? 32,
        overflow?.offsetWidth ?? 40,
      ),
    );
  }

  private computeCollapsed(
    tabs: Session[],
    widths: Map<string, number>,
    contentWidth: number,
    plusWidth: number,
    overflowWidth: number,
  ): ReadonlySet<string> {
    const gap = 4;
    const tabGap = 13;
    const widthOf = (session: Session): number => widths.get(session.id) ?? 0;

    const layout = (visible: number) => {
      const rows: number[] = [];
      let used = 0;
      for (let i = 0; i < visible; i++) {
        const width = widthOf(tabs[i]);
        const lead = used === 0 ? 0 : tabGap;
        if (used + lead + width <= contentWidth) {
          used += lead + width;
        } else {
          rows.push(used);
          used = width;
        }
      }
      rows.push(used);

      if (visible < tabs.length) {
        let last = rows[rows.length - 1];
        const lead = last === 0 ? 0 : gap;
        if (last + lead + overflowWidth <= contentWidth) {
          rows[rows.length - 1] = last + lead + overflowWidth;
        } else {
          rows.push(overflowWidth);
        }
      }

      const last = rows[rows.length - 1];
      const plusLead = last === 0 ? 0 : tabGap;
      if (last + plusLead + plusWidth > contentWidth) {
        rows.push(plusWidth);
      }

      return {
        rowCount: rows.length,
        firstGap: contentWidth - rows[0],
        lastGap: contentWidth - rows[rows.length - 1],
      };
    };

    let twoRows = tabs.length;
    while (twoRows > 0 && layout(twoRows).rowCount > 2) {
      twoRows--;
    }

    let oneRow = twoRows;
    while (oneRow > 0 && layout(oneRow).rowCount > 1) {
      oneRow--;
    }

    let visible = twoRows;
    if (twoRows > oneRow) {
      const wide = layout(twoRows);
      const narrow = layout(oneRow);
      if (narrow.lastGap <= wide.firstGap) {
        visible = oneRow;
      }
    }

    return visible === tabs.length
      ? EMPTY_IDS
      : new Set(tabs.slice(visible).map((session) => session.id));
  }

  private setCollapsedIds(next: ReadonlySet<string>): void {
    const current = untracked(this.collapsedTabIds);
    if (next.size === current.size && [...next].every((id) => current.has(id))) {
      return;
    }
    this.collapsedTabIds.set(next);
    if (next.size === 0) {
      this.overflowOpen.set(false);
    }
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
    if (this.workspace.debugOpen()) {
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
