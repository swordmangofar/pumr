import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { FileChange } from '../core/models';
import { WorkspaceService } from '../core/workspace.service';
import { WorkspaceEditorService } from '../core/workspace-editor.service';
import { ChangeStatusIcon } from './change-status-icon';
import { DiffView } from './diff-view';
import { FileIcon } from './file-icon';
import { FileView } from './file-view';

@Component({
  selector: 'app-workspace-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, ChangeStatusIcon, DiffView, FileIcon, FileView],
  host: {
    '(document:keydown)': 'onKeydown($event)',
  },
  template: `
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-white/5 px-2">
        @for (path of tabs(); track path) {
          <div
            class="group flex max-w-56 shrink-0 cursor-pointer items-center gap-2 border-b-2 px-3 py-2 text-[13px] transition-colors"
            [class]="
              path === activePath()
                ? 'border-accent bg-white/[0.03] text-white'
                : 'border-transparent text-mist/50 hover:bg-white/[0.03] hover:text-mist'
            "
            [title]="path"
            (click)="activate(path)"
          >
            <app-file-icon [name]="baseName(path)" />
            <span class="truncate">{{ baseName(path) }}</span>
            @if (statusFor(path); as status) {
              <app-change-status-icon [status]="status" />
            }
            <button
              type="button"
              class="-mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-mist/40 hover:bg-white/10 hover:text-white"
              [attr.aria-label]="'workspace.closeFile' | transloco"
              (click)="close($event, path)"
            >
              @if (isDirty(path)) {
                <span class="h-2 w-2 rounded-full bg-accent group-hover:hidden"></span>
                <svg
                  class="hidden h-3 w-3 group-hover:block"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              } @else {
                <svg
                  class="h-3 w-3 opacity-0 group-hover:opacity-100"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              }
            </button>
          </div>
        } @empty {
          <span class="px-2 py-2 text-[13px] text-mist/30">{{
            'workspace.noOpenFiles' | transloco
          }}</span>
        }
      </div>

      <div class="min-h-0 flex-1">
        @if (activePath(); as path) {
          <div class="flex h-full flex-col">
            <div
              class="flex shrink-0 items-center justify-between gap-3 border-b border-white/5 px-4 py-1.5"
            >
              <span class="min-w-0 flex-1 truncate font-mono text-xs text-mist/60">{{ path }}</span>
              <div class="flex shrink-0 items-center gap-3 text-xs">
                @if (activeDiff(); as diff) {
                  <span class="text-emerald-400">+{{ diff.additions }}</span>
                  <span class="text-rose-400">-{{ diff.deletions }}</span>
                  <div class="flex gap-0.5 rounded-lg bg-white/5 p-0.5">
                    <button
                      type="button"
                      class="rounded-md px-2.5 py-0.5 font-medium transition-colors"
                      [class]="
                        mode() === 'diff'
                          ? 'bg-white/10 text-white'
                          : 'text-mist/50 hover:text-mist'
                      "
                      (click)="mode.set('diff')"
                    >
                      {{ 'workspace.diff' | transloco }}
                    </button>
                    <button
                      type="button"
                      class="rounded-md px-2.5 py-0.5 font-medium transition-colors"
                      [class]="
                        mode() === 'file'
                          ? 'bg-white/10 text-white'
                          : 'text-mist/50 hover:text-mist'
                      "
                      (click)="mode.set('file')"
                    >
                      {{ 'workspace.code' | transloco }}
                    </button>
                  </div>
                  @if (mode() === 'diff') {
                    <div class="flex gap-0.5 rounded-lg bg-white/5 p-0.5">
                      <button
                        type="button"
                        class="rounded-md px-2.5 py-0.5 font-medium transition-colors"
                        [class]="
                          diffLayout() === 'single'
                            ? 'bg-white/10 text-white'
                            : 'text-mist/50 hover:text-mist'
                        "
                        (click)="diffLayout.set('single')"
                      >
                        {{ 'workspace.single' | transloco }}
                      </button>
                      <button
                        type="button"
                        class="rounded-md px-2.5 py-0.5 font-medium transition-colors"
                        [class]="
                          diffLayout() === 'split'
                            ? 'bg-white/10 text-white'
                            : 'text-mist/50 hover:text-mist'
                        "
                        (click)="diffLayout.set('split')"
                      >
                        {{ 'workspace.split' | transloco }}
                      </button>
                    </div>
                  }
                }
              </div>
            </div>
            <div class="min-h-0 flex-1">
              @if (liveDiff(); as diff) {
                @if (mode() === 'diff') {
                  <app-diff-view
                    [diff]="diff"
                    [editable]="true"
                    [sideBySide]="diffLayout() === 'split'"
                    (contentChange)="onContentChange($event)"
                  />
                } @else if (activeContent(); as content) {
                  <app-file-view
                    [file]="content"
                    [readOnly]="false"
                    (contentChange)="onContentChange($event)"
                  />
                }
              } @else if (activeContent(); as content) {
                <app-file-view
                  [file]="content"
                  [readOnly]="false"
                  (contentChange)="onContentChange($event)"
                />
              }
            </div>
          </div>
        } @else {
          <p class="p-4 text-sm text-mist/40">{{ 'workspace.selectFile' | transloco }}</p>
        }
      </div>
    </div>
  `,
})
export class WorkspaceEditor {
  private readonly workspace = inject(WorkspaceService);
  private readonly editor = inject(WorkspaceEditorService);

  protected readonly project = this.workspace.activeProject;
  protected readonly mode = signal<'diff' | 'file'>('diff');
  protected readonly diffLayout = signal<'single' | 'split'>('single');
  protected readonly tabs = computed(() => {
    const project = this.project();
    return project ? this.editor.openFilesFor(project.id) : [];
  });
  protected readonly activePath = computed(() => {
    const project = this.project();
    return project ? this.editor.activeFileFor(project.id) : null;
  });
  protected readonly activeKey = computed(() => {
    const project = this.project();
    const path = this.activePath();
    return project && path ? this.editor.editorKey(project.id, path) : null;
  });
  protected readonly activeContent = computed(() => {
    const key = this.activeKey();
    return key ? (this.editor.editorContent()[key] ?? null) : null;
  });
  protected readonly activeDiff = computed(() => {
    const key = this.activeKey();
    return key ? (this.editor.editorDiff()[key] ?? null) : null;
  });
  protected readonly liveDiff = computed(() => {
    const diff = this.activeDiff();
    const content = this.activeContent();
    if (!diff) {
      return null;
    }
    return content && content.content !== diff.newContent
      ? { ...diff, newContent: content.content }
      : diff;
  });
  protected readonly changes = computed(() => {
    const session = this.workspace.activeSession();
    const map = new Map<string, FileChange>();
    if (session) {
      for (const change of this.workspace.changesFor(session.id)) {
        map.set(change.path, change);
      }
    }
    return map;
  });

  constructor() {
    effect(() => {
      const project = this.project();
      const path = this.activePath();
      this.mode.set('diff');
      if (project && path) {
        untracked(() => void this.workspace.loadEditorFile(project.id, path));
      }
    });
  }

  protected baseName(path: string): string {
    const segments = path.split('/');
    return segments[segments.length - 1] || path;
  }

  protected statusFor(path: string): string | null {
    return this.changes().get(path)?.status ?? null;
  }

  protected isDirty(path: string): boolean {
    const project = this.project();
    return project ? this.editor.isDirty(project.id, path) : false;
  }

  protected activate(path: string): void {
    const project = this.project();
    if (project) {
      this.editor.setActive(project.id, path);
    }
  }

  protected onContentChange(content: string): void {
    const project = this.project();
    const path = this.activePath();
    if (project && path) {
      this.editor.updateContent(project.id, path, content);
    }
  }

  protected async save(): Promise<void> {
    const project = this.project();
    const path = this.activePath();
    if (project && path && this.isDirty(path)) {
      await this.editor.save(project.id, path);
    }
  }

  protected close(event: Event, path: string): void {
    event.stopPropagation();
    const project = this.project();
    if (project) {
      this.editor.close(project.id, path);
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.save();
    }
  }
}
