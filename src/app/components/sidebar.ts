import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { confirm } from '@tauri-apps/plugin-dialog';
import { WorkspaceService } from '../core/workspace.service';
import { Session } from '../core/models';
import { AgentStatus } from './agent-status';
import { AttentionIndicator } from './attention-indicator';
import { GitSidebar } from './git-sidebar';
import { ProjectIcon } from './project-icon';
import { WorkspaceTree } from './workspace-tree';

interface HistoryGroup {
  dayStart: number;
  sessions: Session[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

@Component({
  selector: 'app-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TranslocoPipe,
    NgTemplateOutlet,
    AgentStatus,
    AttentionIndicator,
    WorkspaceTree,
    ProjectIcon,
    GitSidebar,
  ],
  template: `
    <div class="flex h-full flex-col">
      <div class="shrink-0 px-3 pt-3">
        <div class="flex gap-1 rounded-xl bg-white/5 p-1">
          <button
            type="button"
            class="flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
            [class]="
              workspace.leftTab() === 'projects'
                ? 'bg-white/10 text-white shadow-sm'
                : 'text-mist/50 hover:text-mist'
            "
            (click)="workspace.setLeftTab('projects')"
          >
            {{ 'sidebar.projects' | transloco }}
          </button>
          <button
            type="button"
            class="flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
            [class]="
              workspace.leftTab() === 'workspace'
                ? 'bg-white/10 text-white shadow-sm'
                : 'text-mist/50 hover:text-mist'
            "
            (click)="workspace.setLeftTab('workspace')"
          >
            {{ 'sidebar.workspace' | transloco }}
          </button>
          <button
            type="button"
            class="flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
            [class]="
              workspace.leftTab() === 'git'
                ? 'bg-white/10 text-white shadow-sm'
                : 'text-mist/50 hover:text-mist'
            "
            (click)="workspace.setLeftTab('git')"
          >
            {{ 'sidebar.git' | transloco }}
          </button>
        </div>
      </div>

      <ng-template #sessionRow let-session let-showProject="showProject">
        <div>
          <div
            class="group flex items-center gap-1 rounded-xl pr-1 transition-colors"
            [class]="sessionRowClass(session)"
          >
            @if (workspace.subAgentsFor(session.id).length > 0) {
              <button
                type="button"
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-mist/40 transition-colors hover:text-mist"
                [attr.aria-expanded]="subAgentsExpanded(session.id)"
                [title]="
                  (subAgentsExpanded(session.id)
                    ? 'sidebar.collapseSubAgents'
                    : 'sidebar.expandSubAgents'
                  ) | transloco
                "
                (click)="toggleSubAgents(session.id)"
              >
                <svg
                  viewBox="0 0 16 16"
                  class="h-3 w-3 transition-transform duration-100"
                  [class.rotate-90]="subAgentsExpanded(session.id)"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M6 3.5 10.5 8 6 12.5" />
                </svg>
              </button>
            }
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-1.5 text-left text-sm"
              [class]="sessionTextClass(session)"
              (click)="workspace.openTab(session.id)"
            >
              @if (showProject && projectFor(session); as project) {
                <span class="relative inline-flex shrink-0">
                  <app-project-icon [project]="project" [size]="16" />
                  @if (workspace.sessionAttention(session.id); as attention) {
                    <span
                      class="absolute -top-1 -left-1 flex h-2 w-2 items-center justify-center rounded-full ring-2 ring-ink"
                    >
                      <app-attention-indicator [kind]="attention" />
                    </span>
                  }
                </span>
              } @else if (workspace.sessionAttention(session.id); as attention) {
                <app-attention-indicator [kind]="attention" [onAccent]="sessionActive(session)" />
              }
              <span class="min-w-0 flex-1 truncate">{{ session.title }}</span>
              @if (workspace.agentActivity(session.id); as status) {
                <app-agent-status
                  [status]="status"
                  [small]="true"
                  [onAccent]="sessionActive(session)"
                />
              }
            </button>

            <div
              class="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            >
              <button
                type="button"
                class="flex h-6 w-6 items-center justify-center rounded-md border transition-colors"
                [class]="sessionActionClass(session, 'archive')"
                [title]="
                  (session.archived ? 'sidebar.unarchiveSession' : 'sidebar.archiveSession')
                    | transloco
                "
                (click)="archiveSession($event, session)"
              >
                @if (session.archived) {
                  <svg
                    viewBox="0 0 16 16"
                    class="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <rect x="2.5" y="3" width="11" height="3.5" rx="0.75" />
                    <path
                      d="M3.5 6.5v5.75A1.25 1.25 0 0 0 4.75 13.5h6.5a1.25 1.25 0 0 0 1.25-1.25V6.5"
                    />
                    <path d="M8 12V8.5M6.5 10 8 8.5 9.5 10" />
                  </svg>
                } @else {
                  <svg
                    viewBox="0 0 16 16"
                    class="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <rect x="2.5" y="3" width="11" height="3.5" rx="0.75" />
                    <path
                      d="M3.5 6.5v5.75A1.25 1.25 0 0 0 4.75 13.5h6.5a1.25 1.25 0 0 0 1.25-1.25V6.5"
                    />
                    <path d="M6.5 9.5h3" />
                  </svg>
                }
              </button>
              <button
                type="button"
                class="flex h-6 w-6 items-center justify-center rounded-md border transition-colors"
                [class]="sessionActionClass(session, 'delete')"
                [title]="'common.delete' | transloco"
                (click)="removeSession($event, session)"
              >
                <svg
                  viewBox="0 0 16 16"
                  class="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M3 4.5h10" />
                  <path d="M6 4.5V3.25A1.25 1.25 0 0 1 7.25 2h1.5A1.25 1.25 0 0 1 10 3.25V4.5" />
                  <path
                    d="M4.5 4.5l.6 8.1a1.25 1.25 0 0 0 1.25 1.15h3.3a1.25 1.25 0 0 0 1.25-1.15l.6-8.1"
                  />
                  <path d="M6.75 7.5v4M9.25 7.5v4" />
                </svg>
              </button>
            </div>
          </div>

          @if (workspace.subAgentsFor(session.id); as agents) {
            @if (agents.length > 0 && subAgentsExpanded(session.id)) {
              <div class="relative ml-3 mt-1 space-y-0.5 pl-3">
                <span
                  aria-hidden="true"
                  class="pointer-events-none absolute inset-y-0 left-0 w-px bg-linear-to-b from-white/10 to-transparent"
                ></span>
                @for (agent of agents; track agent.id) {
                  <button
                    type="button"
                    class="relative flex w-full items-center gap-2 rounded-lg px-2.5 py-1 text-left text-[13px] transition-colors"
                    [class]="
                      agent.id === workspace.activeAgentId()
                        ? 'bg-accent/15 font-medium text-white ring-1 ring-accent/30 ring-inset'
                        : 'text-mist/60 hover:bg-white/5 hover:text-mist'
                    "
                    (click)="openAgent(session.id, agent.id)"
                  >
                    <span
                      aria-hidden="true"
                      class="pointer-events-none absolute top-1/2 -left-3 h-px w-3 bg-white/10"
                    ></span>
                    @if (workspace.sessionAttention(agent.id); as attention) {
                      <app-attention-indicator [kind]="attention" />
                    }
                    <span class="min-w-0 flex-1 truncate">{{ agent.title }}</span>
                    <app-agent-status [status]="agent.agentStatus" [small]="true" />
                  </button>
                }
              </div>
            }
          }
        </div>
      </ng-template>

      @if (workspace.leftTab() === 'git') {
        <app-git-sidebar class="min-h-0 flex-1" />
      } @else if (workspace.leftTab() === 'projects') {
        <div class="flex items-center justify-between gap-2 px-4 py-3">
          <div class="flex gap-0.5 rounded-lg bg-white/5 p-0.5">
            <button
              type="button"
              class="rounded-md px-2 py-1 text-xs font-medium transition-colors"
              [class]="
                workspace.sessionView() === 'projects'
                  ? 'bg-white/10 text-white shadow-sm'
                  : 'text-mist/50 hover:text-mist'
              "
              (click)="workspace.setSessionView('projects')"
            >
              {{ 'sidebar.viewByProject' | transloco }}
            </button>
            <button
              type="button"
              class="rounded-md px-2 py-1 text-xs font-medium transition-colors"
              [class]="
                workspace.sessionView() === 'history'
                  ? 'bg-white/10 text-white shadow-sm'
                  : 'text-mist/50 hover:text-mist'
              "
              (click)="workspace.setSessionView('history')"
            >
              {{ 'sidebar.viewHistory' | transloco }}
            </button>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              class="flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
              [class]="
                workspace.showArchived()
                  ? 'bg-accent/15 text-accent'
                  : 'bg-white/5 text-mist/60 hover:bg-white/10 hover:text-accent'
              "
              [title]="'sidebar.showArchived' | transloco"
              (click)="toggleArchived()"
            >
              <svg
                viewBox="0 0 16 16"
                class="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <rect x="2.5" y="3" width="11" height="3.5" rx="0.75" />
                <path
                  d="M3.5 6.5v5.75A1.25 1.25 0 0 0 4.75 13.5h6.5a1.25 1.25 0 0 0 1.25-1.25V6.5"
                />
                <path d="M6.5 9.5h3" />
              </svg>
            </button>
            @if (workspace.sessionView() === 'projects') {
              <button
                type="button"
                class="flex h-7 w-7 items-center justify-center rounded-lg bg-white/5 text-mist/60 transition-colors hover:bg-white/10 hover:text-accent"
                [title]="'sidebar.addProject' | transloco"
                (click)="addProject()"
              >
                ＋
              </button>
            }
          </div>
        </div>

        @if (workspace.sessionView() === 'projects') {
          <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            @for (project of workspace.projects(); track project.id) {
              <div class="mb-1">
                <div
                  class="group flex items-center gap-1 rounded-xl px-2 py-1.5 transition-colors hover:bg-white/5"
                >
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-2 text-left"
                    (click)="toggle(project.id)"
                  >
                    <span class="w-3 text-xs text-mist/30">{{
                      isExpanded(project.id) ? '▾' : '▸'
                    }}</span>
                    <app-project-icon [project]="project" [size]="24" />
                    <span class="flex min-w-0 flex-1 items-baseline gap-2">
                      <span class="truncate text-sm font-medium text-mist">{{ project.name }}</span>
                      <span class="shrink-0 text-xs text-mist/30">{{ project.sessionCount }}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-mist/40 opacity-0 transition-opacity group-hover:opacity-100 hover:text-accent"
                    [title]="'projectAppearance.edit' | transloco"
                    (click)="editProject($event, project.id)"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      class="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M2.5 13.5l.9-2.9 7-7a1.4 1.4 0 0 1 2 2l-7 7z" />
                      <path d="M9.75 4.35l1.9 1.9" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-mist/40 opacity-0 transition-opacity group-hover:opacity-100 hover:text-rose-400"
                    [title]="'sidebar.removeProject' | transloco"
                    (click)="removeProject($event, project.id)"
                  >
                    ✕
                  </button>
                  <button
                    type="button"
                    class="flex h-6 shrink-0 items-center gap-1 rounded-full border border-accent/40 bg-accent/15 px-2 text-xs font-semibold text-accent transition-colors hover:border-accent/70 hover:bg-accent/25"
                    [title]="'sidebar.newSession' | transloco"
                    (click)="newSession(project.id)"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      class="h-3 w-3"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                    >
                      <path d="M8 3.5v9M3.5 8h9" />
                    </svg>
                    <span>{{ 'sidebar.new' | transloco }}</span>
                  </button>
                </div>

                @if (isExpanded(project.id)) {
                  <div class="mt-0.5 space-y-0.5 pl-4">
                    @for (session of workspace.sessionsFor(project.id); track session.id) {
                      <ng-container
                        *ngTemplateOutlet="
                          sessionRow;
                          context: { $implicit: session, showProject: false }
                        "
                      />
                    } @empty {
                      <p class="py-1.5 pl-3 text-xs text-mist/30">
                        {{ 'sidebar.noSessions' | transloco }}
                      </p>
                    }
                  </div>
                }
              </div>
            } @empty {
              <p class="px-3 py-4 text-sm leading-relaxed text-mist/40">
                {{ 'sidebar.noProjects' | transloco }}
              </p>
            }
          </div>
        } @else {
          <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            @for (group of historyGroups(); track group.dayStart) {
              <div
                class="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-widest text-mist/40"
              >
                {{ historyLabel(group.dayStart) }}
              </div>
              <div class="space-y-0.5">
                @for (session of group.sessions; track session.id) {
                  <ng-container
                    *ngTemplateOutlet="
                      sessionRow;
                      context: { $implicit: session, showProject: true }
                    "
                  />
                }
              </div>
            } @empty {
              <p class="px-3 py-4 text-sm leading-relaxed text-mist/40">
                {{ 'sidebar.noSessions' | transloco }}
              </p>
            }
          </div>
        }
      } @else {
        <app-workspace-tree class="min-h-0 flex-1" />
      }
    </div>
  `,
})
export class Sidebar {
  protected readonly workspace = inject(WorkspaceService);
  private readonly transloco = inject(TranslocoService);
  private readonly expanded = signal<Set<string> | null>(null);
  private readonly expandedSubAgents = signal<Set<string>>(new Set());
  private readonly now = signal(Date.now());

  protected readonly historyGroups = computed<HistoryGroup[]>(() => {
    const groups: HistoryGroup[] = [];
    const byDay = new Map<number, HistoryGroup>();
    for (const session of this.workspace.allSessions()) {
      const dayStart = startOfDay(session.updatedAt);
      let group = byDay.get(dayStart);
      if (!group) {
        group = { dayStart, sessions: [] };
        byDay.set(dayStart, group);
        groups.push(group);
      }
      group.sessions.push(session);
    }
    return groups;
  });

  protected historyLabel(dayStart: number): string {
    const today = startOfDay(this.now());
    const diff = Math.round((today - dayStart) / DAY_MS);
    if (diff <= 0) {
      return this.transloco.translate('sidebar.today');
    }
    if (diff === 1) {
      return this.transloco.translate('sidebar.yesterday');
    }
    const date = new Date(dayStart);
    const locale = this.transloco.getActiveLang();
    if (diff < 7) {
      return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(date);
    }
    const sameYear = date.getFullYear() === new Date(today).getFullYear();
    return new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      ...(sameYear ? {} : { year: 'numeric' }),
    }).format(date);
  }

  protected projectFor(session: Session) {
    return this.workspace.projectFor(session.projectId);
  }

  protected isExpanded(projectId: string): boolean {
    const state = this.expanded();
    return state === null ? true : state.has(projectId);
  }

  protected toggle(projectId: string): void {
    this.expanded.update((state) => {
      const next = new Set(state ?? this.workspace.projects().map((project) => project.id));
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  protected async addProject(): Promise<void> {
    try {
      await this.workspace.addProject();
    } catch (error) {
      console.error(error);
    }
  }

  protected async newSession(projectId: string): Promise<void> {
    try {
      await this.workspace.newSession(projectId);
    } catch (error) {
      console.error(error);
    }
  }

  protected editProject(event: Event, projectId: string): void {
    event.stopPropagation();
    this.workspace.openProjectEditor(projectId);
  }

  protected subAgentsExpanded(sessionId: string): boolean {
    return this.expandedSubAgents().has(sessionId);
  }

  protected toggleSubAgents(sessionId: string): void {
    this.expandedSubAgents.update((state) => {
      const next = new Set(state);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }

  protected openAgent(rootSessionId: string, agentSessionId: string): void {
    this.workspace.openTab(rootSessionId);
    this.workspace.viewAgent(rootSessionId, agentSessionId);
  }

  protected sessionActive(session: Session): boolean {
    return (
      session.id === this.workspace.activeSessionId() &&
      session.id === this.workspace.activeAgentId()
    );
  }

  protected sessionRowClass(session: Session): string {
    const base = this.sessionActive(session) ? 'bg-accent' : 'hover:bg-white/5';
    return session.archived ? `${base} opacity-60` : base;
  }

  protected sessionTextClass(session: Session): string {
    return this.sessionActive(session) ? 'font-medium text-ink' : 'text-mist/50 hover:text-mist';
  }

  protected sessionActionClass(session: Session, kind: 'archive' | 'delete'): string {
    if (this.sessionActive(session)) {
      return 'border-ink/25 text-ink/80 hover:border-ink/50 hover:text-ink';
    }
    return kind === 'delete'
      ? 'border-white/10 text-mist/50 hover:border-rose-400/60 hover:text-rose-400'
      : 'border-white/10 text-mist/50 hover:border-accent/60 hover:text-accent';
  }

  protected async archiveSession(event: Event, session: Session): Promise<void> {
    event.stopPropagation();
    try {
      await this.workspace.archiveSession(session.id, !session.archived);
    } catch (error) {
      console.error(error);
    }
  }

  protected async removeSession(event: Event, session: Session): Promise<void> {
    event.stopPropagation();
    const confirmed = await confirm(`Delete session "${session.title}"? This cannot be undone.`, {
      title: 'pumr',
      kind: 'warning',
    });
    if (!confirmed) {
      return;
    }
    try {
      await this.workspace.deleteSession(session.id);
    } catch (error) {
      console.error(error);
    }
  }

  protected async toggleArchived(): Promise<void> {
    try {
      await this.workspace.toggleShowArchived();
    } catch (error) {
      console.error(error);
    }
  }

  protected async removeProject(event: Event, projectId: string): Promise<void> {
    event.stopPropagation();
    const project = this.workspace.projects().find((entry) => entry.id === projectId);
    if (!project) {
      return;
    }
    const confirmed = await confirm(
      `Remove project "${project.name}"? Sessions are kept in the database but hidden.`,
      {
        title: 'pumr',
        kind: 'warning',
      },
    );
    if (!confirmed) {
      return;
    }
    try {
      await this.workspace.removeProject(projectId);
    } catch (error) {
      console.error(error);
    }
  }
}
