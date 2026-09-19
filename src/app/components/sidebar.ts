import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { confirm } from '@tauri-apps/plugin-dialog';
import { WorkspaceService } from '../core/workspace.service';
import { Session } from '../core/models';
import { AgentStatus } from './agent-status';

@Component({
  selector: 'app-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, AgentStatus],
  template: `
    <div class="flex h-full flex-col">
      <div class="flex items-center justify-between px-4 py-3">
        <span class="text-xs font-semibold uppercase tracking-widest text-mist/40">
          {{ 'sidebar.projects' | transloco }}
        </span>
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="flex h-7 w-7 items-center justify-center rounded-md border transition-colors"
            [class]="
              workspace.showArchived()
                ? 'border-accent/60 text-accent'
                : 'border-white/10 text-mist/60 hover:border-accent/60 hover:text-accent'
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
              <path d="M3.5 6.5v5.75A1.25 1.25 0 0 0 4.75 13.5h6.5a1.25 1.25 0 0 0 1.25-1.25V6.5" />
              <path d="M6.5 9.5h3" />
            </svg>
          </button>
          <button
            type="button"
            class="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 text-mist/60 transition-colors hover:border-accent/60 hover:text-accent"
            [title]="'sidebar.addProject' | transloco"
            (click)="addProject()"
          >
            ＋
          </button>
        </div>
      </div>

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
                <span class="truncate text-sm font-medium text-mist">{{ project.name }}</span>
                <span class="shrink-0 text-xs text-mist/30">{{ project.sessionCount }}</span>
              </button>
              <button
                type="button"
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-mist/40 opacity-0 transition-opacity group-hover:opacity-100 hover:text-accent"
                [title]="'sidebar.newSession' | transloco"
                (click)="newSession(project.id)"
              >
                ＋
              </button>
              <button
                type="button"
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-mist/40 opacity-0 transition-opacity group-hover:opacity-100 hover:text-rose-400"
                [title]="'sidebar.removeProject' | transloco"
                (click)="removeProject($event, project.id)"
              >
                ✕
              </button>
            </div>

            @if (isExpanded(project.id)) {
              <div class="mt-0.5 space-y-0.5 pl-4">
                @for (session of workspace.sessionsFor(project.id); track session.id) {
                  <div>
                    <div
                      class="group flex items-center gap-1 rounded-xl pr-1 transition-colors"
                      [class]="sessionRowClass(session)"
                    >
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-1.5 text-left text-sm"
                        [class]="sessionTextClass(session)"
                        (click)="workspace.openTab(session.id)"
                      >
                        <span class="min-w-0 flex-1 truncate">{{ session.title }}</span>
                      </button>

                      <div
                        class="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                      >
                        <button
                          type="button"
                          class="flex h-6 w-6 items-center justify-center rounded-md border transition-colors"
                          [class]="sessionActionClass(session, 'archive')"
                          [title]="
                            (session.archived
                              ? 'sidebar.unarchiveSession'
                              : 'sidebar.archiveSession'
                            ) | transloco
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
                            <path
                              d="M6 4.5V3.25A1.25 1.25 0 0 1 7.25 2h1.5A1.25 1.25 0 0 1 10 3.25V4.5"
                            />
                            <path
                              d="M4.5 4.5l.6 8.1a1.25 1.25 0 0 0 1.25 1.15h3.3a1.25 1.25 0 0 0 1.25-1.15l.6-8.1"
                            />
                            <path d="M6.75 7.5v4M9.25 7.5v4" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    @for (agent of workspace.subAgentsFor(session.id); track agent.id) {
                      <button
                        type="button"
                        class="ml-3 flex w-[calc(100%-0.75rem)] items-center gap-2 rounded-xl border-l border-white/10 px-3 py-1.5 pl-4 text-left text-sm transition-colors"
                        [class]="
                          agent.id === workspace.activeAgentId()
                            ? 'bg-accent/20 text-white'
                            : 'text-mist/50 hover:bg-white/5 hover:text-mist'
                        "
                        (click)="openAgent(session.id, agent.id)"
                      >
                        <app-agent-status [status]="agent.agentStatus" [small]="true" />
                        <span class="min-w-0 flex-1 truncate">{{ agent.title }}</span>
                      </button>
                    }
                  </div>
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
    </div>
  `,
})
export class Sidebar {
  protected readonly workspace = inject(WorkspaceService);
  private readonly expanded = signal<Set<string> | null>(null);

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
