import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { WorkspaceService } from '../core/workspace.service';
import { ProjectIcon } from './project-icon';

/** Picks the project the Workspace and Git tabs show, see `WorkspaceService.browseProject`. */
@Component({
  selector: 'app-project-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, ProjectIcon],
  host: {
    class: 'relative block',
    '(document:keydown.escape)': 'open.set(false)',
  },
  template: `
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-white/5 disabled:pointer-events-none"
      [class]="open() ? 'bg-white/5' : ''"
      aria-haspopup="menu"
      [attr.aria-expanded]="open()"
      [title]="'tabs.selectProject' | transloco"
      [disabled]="workspace.projects().length === 0"
      (click)="open.set(!open())"
    >
      @if (workspace.browseProject(); as project) {
        <app-project-icon [project]="project" [size]="22" />
        <span class="max-w-[60%] shrink-0 truncate text-[13px] font-semibold text-mist">{{
          project.name
        }}</span>
        <span class="min-w-0 flex-1 truncate text-[11px] text-mist/30">{{ project.path }}</span>
      } @else {
        <span class="min-w-0 flex-1 truncate text-[13px] font-semibold text-mist/50">{{
          'tabs.selectProject' | transloco
        }}</span>
      }
      <svg
        class="h-3.5 w-3.5 shrink-0 text-mist/40"
        viewBox="0 0 20 20"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M5 7.5 10 12.5 15 7.5"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    @if (open()) {
      <div class="fixed inset-0 z-30" (click)="open.set(false)"></div>
      <div
        role="menu"
        class="absolute top-full right-0 left-0 z-40 mt-1 max-h-[min(20rem,50vh)] overflow-y-auto glass-pop rounded-xl p-1 shadow-2xl"
      >
        @for (project of workspace.projects(); track project.id) {
          <button
            type="button"
            role="menuitemradio"
            class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors"
            [class]="
              project.id === workspace.browseProject()?.id ? 'bg-accent/15' : 'hover:bg-white/5'
            "
            [attr.aria-checked]="project.id === workspace.browseProject()?.id"
            (click)="select(project.id)"
          >
            <app-project-icon [project]="project" [size]="26" radius="rounded-lg" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[13px] text-white">{{ project.name }}</span>
              <span class="block truncate text-[11px] text-mist/40">{{ project.path }}</span>
            </span>
            @if (project.id === workspace.browseProject()?.id) {
              <svg
                viewBox="0 0 16 16"
                class="h-3.5 w-3.5 shrink-0 text-accent"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="m3.5 8.5 3 3 6-7" />
              </svg>
            }
          </button>
        }
      </div>
    }
  `,
})
export class ProjectSelect {
  protected readonly workspace = inject(WorkspaceService);
  protected readonly open = signal(false);

  protected select(projectId: string): void {
    this.open.set(false);
    this.workspace.setBrowseProject(projectId);
  }
}
