import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { confirm } from '@tauri-apps/plugin-dialog';
import { WorkspaceService } from '../core/workspace.service';
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
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 text-mist/60 transition-colors hover:border-accent/60 hover:text-accent"
          [title]="'sidebar.addProject' | transloco"
          (click)="addProject()"
        >
          ＋
        </button>
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
                    <button
                      type="button"
                      class="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left text-sm transition-colors"
                      [class]="
                        session.id === workspace.activeSessionId() &&
                        session.id === workspace.activeAgentId()
                          ? 'bg-accent font-medium text-ink'
                          : 'text-mist/50 hover:bg-white/5 hover:text-mist'
                      "
                      (click)="workspace.openTab(session.id)"
                    >
                      <span class="min-w-0 flex-1 truncate">{{ session.title }}</span>
                      @if (session.cost > 0) {
                        <span
                          class="shrink-0 text-xs"
                          [class]="
                            session.id === workspace.activeSessionId() &&
                            session.id === workspace.activeAgentId()
                              ? 'text-ink/60'
                              : 'text-mist/30'
                          "
                        >
                          {{ money(session.cost) }}
                        </span>
                      }
                    </button>

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
                        @if (agent.cost > 0) {
                          <span class="shrink-0 text-xs text-mist/30">{{ money(agent.cost) }}</span>
                        }
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

  protected money(value: number): string {
    return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
  }
}
