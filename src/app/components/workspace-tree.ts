import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { FileChange, WorkspaceEntry } from '../core/models';
import { WorkspaceService } from '../core/workspace.service';
import { FileIcon } from './file-icon';

interface TreeNode {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  children: TreeNode[];
}

interface TreeRow {
  node: TreeNode;
  depth: number;
  guides: number[];
}

const LIBRARY_ROOTS = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.angular']);

function buildTree(entries: WorkspaceEntry[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', kind: 'directory', children: [] };
  const directories = new Map<string, TreeNode>([['', root]]);
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of sorted) {
    const segments = entry.path.split('/').filter((segment) => segment.length > 0);
    let parent = root;
    let current = '';
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      current = current ? `${current}/${segment}` : segment;
      const isLeaf = index === segments.length - 1;
      if (isLeaf && entry.kind === 'file') {
        parent.children.push({ name: segment, path: current, kind: 'file', children: [] });
      } else {
        let node = directories.get(current);
        if (!node) {
          node = { name: segment, path: current, kind: 'directory', children: [] };
          directories.set(current, node);
          parent.children.push(node);
        }
        parent = node;
      }
    }
  }
  sortTree(root.children);
  return root.children;
}

function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    sortTree(node.children);
  }
}

@Component({
  selector: 'app-workspace-tree',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, FileIcon],
  template: `
    <div class="flex h-full flex-col">
      <div class="flex items-center gap-2 px-3 py-2.5">
        <svg
          viewBox="0 0 16 16"
          class="h-4 w-4 shrink-0 text-accent/70"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path
            d="M1.75 4.25A1.25 1.25 0 0 1 3 3h3l1.25 1.5H13a1.25 1.25 0 0 1 1.25 1.25v6A1.25 1.25 0 0 1 13 13H3a1.25 1.25 0 0 1-1.25-1.25Z"
          />
        </svg>
        <span class="shrink-0 truncate text-[13px] font-semibold text-mist">{{
          project()?.name ?? ('workspace.title' | transloco)
        }}</span>
        @if (project(); as active) {
          <span class="min-w-0 flex-1 truncate text-[11px] text-mist/30">{{ active.path }}</span>
        }
        <button
          type="button"
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-mist/50 transition-colors hover:bg-white/10 hover:text-accent"
          [title]="'app.refresh' | transloco"
          (click)="refresh()"
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
            <path d="M13 8a5 5 0 1 1-1.5-3.55" />
            <path d="M13 2.5V5h-2.5" />
          </svg>
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto pl-1 pb-4">
        @if (!project()) {
          <p class="px-3 py-4 text-sm leading-relaxed text-mist/40">
            {{ 'workspace.noSession' | transloco }}
          </p>
        } @else {
          @for (row of rows(); track row.node.path) {
            <button
              type="button"
              class="group flex h-[22px] w-full items-center pr-2 text-left text-[13px] leading-none transition-colors"
              [class]="rowClass(row.node)"
              (click)="activate(row.node)"
            >
              <span class="flex h-full shrink-0" aria-hidden="true">
                @for (guide of row.guides; track $index) {
                  <span class="h-full w-3 border-l border-white/[0.055]"></span>
                }
              </span>

              <span class="flex w-4 shrink-0 items-center justify-center">
                @if (row.node.kind === 'directory') {
                  <svg
                    viewBox="0 0 16 16"
                    class="h-3 w-3 text-mist/40 transition-transform duration-100"
                    [class.rotate-90]="isExpanded(row.node.path)"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M6 3.5 10.5 8 6 12.5" />
                  </svg>
                }
              </span>

              <span class="mr-1.5 flex shrink-0 items-center justify-center">
                @if (row.node.kind === 'directory') {
                  @if (isExpanded(row.node.path)) {
                    <svg
                      viewBox="0 0 16 16"
                      class="h-4 w-4"
                      fill="#6b7280"
                      stroke="#9ca3af"
                      stroke-width="0.8"
                      stroke-linejoin="round"
                    >
                      <path
                        d="M1.75 4A1.25 1.25 0 0 1 3 2.75h3l1.25 1.5H13A1.25 1.25 0 0 1 14.25 5.5v1.25H2.5a.75.75 0 0 0-.75.75Z"
                      />
                      <path
                        d="M2.1 7h12.05a.75.75 0 0 1 .73.93l-1.2 4.5a1.25 1.25 0 0 1-1.2.82H3a1.25 1.25 0 0 1-1.25-1.25V7.75A.75.75 0 0 1 2.1 7Z"
                      />
                    </svg>
                  } @else {
                    <svg
                      viewBox="0 0 16 16"
                      class="h-4 w-4"
                      fill="#6b7280"
                      stroke="#9ca3af"
                      stroke-width="0.8"
                      stroke-linejoin="round"
                    >
                      <path
                        d="M1.75 4.25A1.25 1.25 0 0 1 3 3h3l1.25 1.5H13a1.25 1.25 0 0 1 1.25 1.25v6A1.25 1.25 0 0 1 13 13H3a1.25 1.25 0 0 1-1.25-1.25Z"
                      />
                    </svg>
                  }
                } @else {
                  <app-file-icon [name]="row.node.name" />
                }
              </span>

              <span class="min-w-0 flex-1 truncate" [class]="nameClass(row.node)">{{
                row.node.name
              }}</span>

              @if (isLibraryRoot(row.node)) {
                <span class="ml-2 shrink-0 text-[10px] text-amber-500/80">{{
                  'workspace.libraryRoot' | transloco
                }}</span>
              }

              @if (changeFor(row.node.path); as change) {
                <span class="ml-2 flex shrink-0 items-center gap-1 text-[10px]">
                  @if (change.additions > 0) {
                    <span class="text-emerald-400">+{{ change.additions }}</span>
                  }
                  @if (change.deletions > 0) {
                    <span class="text-rose-400">-{{ change.deletions }}</span>
                  }
                </span>
              }
            </button>
          } @empty {
            <p class="px-3 py-4 text-sm leading-relaxed text-mist/40">
              {{ 'workspace.empty' | transloco }}
            </p>
          }
        }
      </div>
    </div>
  `,
})
export class WorkspaceTree {
  private readonly workspace = inject(WorkspaceService);
  private readonly expanded = signal<Set<string>>(new Set());

  protected readonly project = this.workspace.activeProject;
  protected readonly tree = computed(() => buildTree(this.entries()));
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
  protected readonly changedDirs = computed(() => {
    const dirs = new Set<string>();
    for (const path of this.changes().keys()) {
      const segments = path.split('/');
      let current = '';
      for (let index = 0; index < segments.length - 1; index += 1) {
        current = current ? `${current}/${segments[index]}` : segments[index];
        dirs.add(current);
      }
    }
    return dirs;
  });
  protected readonly rows = computed<TreeRow[]>(() => {
    const expanded = this.expanded();
    const rows: TreeRow[] = [];
    const walk = (nodes: TreeNode[], depth: number): void => {
      for (const node of nodes) {
        rows.push({ node, depth, guides: Array.from({ length: depth }, (_, i) => i) });
        if (node.kind === 'directory' && expanded.has(node.path)) {
          walk(node.children, depth + 1);
        }
      }
    };
    walk(this.tree(), 0);
    return rows;
  });

  private readonly entries = computed(() => {
    const project = this.project();
    return project ? this.workspace.workspaceEntriesFor(project.id) : [];
  });

  constructor() {
    effect(() => {
      const project = this.project();
      if (project) {
        void this.workspace.loadWorkspaceEntries(project.id);
      }
    });
    effect(() => {
      const dirs = this.changedDirs();
      this.expanded.update((state) => {
        const next = new Set(state);
        for (const dir of dirs) {
          next.add(dir);
        }
        return next;
      });
    });
  }

  protected isExpanded(path: string): boolean {
    return this.expanded().has(path);
  }

  protected isActive(node: TreeNode): boolean {
    const project = this.project();
    return (
      node.kind === 'file' && !!project && this.workspace.activeFileFor(project.id) === node.path
    );
  }

  protected isLibraryRoot(node: TreeNode): boolean {
    return node.kind === 'directory' && LIBRARY_ROOTS.has(node.name.toLowerCase());
  }

  protected changeFor(path: string): FileChange | undefined {
    return this.changes().get(path);
  }

  protected rowClass(node: TreeNode): string {
    if (this.isActive(node)) {
      return 'bg-accent/20 text-white';
    }
    if (this.isLibraryRoot(node)) {
      return 'text-mist/50 hover:bg-white/[0.035]';
    }
    return 'text-mist/80 hover:bg-white/[0.05]';
  }

  protected nameClass(node: TreeNode): string {
    if (this.isActive(node)) {
      return 'text-white';
    }
    if (node.kind === 'directory') {
      return this.isLibraryRoot(node) ? 'text-mist/50' : 'text-mist/90';
    }
    switch (this.changeFor(node.path)?.status) {
      case 'A':
        return 'text-emerald-400';
      case 'D':
        return 'text-rose-400/80 line-through';
      case 'M':
        return 'text-sky-300';
      default:
        return 'text-mist/70';
    }
  }

  protected activate(node: TreeNode): void {
    if (node.kind === 'directory') {
      this.expanded.update((state) => {
        const next = new Set(state);
        if (next.has(node.path)) {
          next.delete(node.path);
        } else {
          next.add(node.path);
        }
        return next;
      });
      return;
    }
    void this.workspace.openWorkspaceFile(node.path);
  }

  protected refresh(): void {
    const project = this.project();
    if (project) {
      void this.workspace.loadWorkspaceEntries(project.id, true);
    }
  }
}
