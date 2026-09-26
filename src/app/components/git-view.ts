import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { confirmWarning } from '../core/confirm-warning';
import {
  FileChange,
  GIT_WHOLE_FILE_CONTEXT,
  GitCommit,
  GitConflictSide,
  GitDiffOptions,
  GitOperation,
  GitPullStrategy,
} from '../core/models';
import {
  GIT_GRAPH_RADIUS,
  GIT_GRAPH_ROW_HEIGHT,
  buildGitGraph,
  linearGitGraph,
} from '../core/git-graph';
import { WorkspaceService } from '../core/workspace.service';
import { GitService } from '../core/git.service';
import { ChangeStatusIcon } from './change-status-icon';
import { DiffView } from './diff-view';
import { FileIcon } from './file-icon';
import { GitCommitMenu } from './git-commit-menu';
import { GitFileMenu } from './git-file-menu';
import { DiffQuestion, HunkDiffView, LineActionRequest } from './hunk-diff-view';
import { TypedInput } from './typed-input';

/** Fixed height of a changed-file row, shared by the list and its spacers. */
const FILE_ROW_HEIGHT = 30;
/** Extra rows rendered above and below the viewport to smooth fast scrolling. */
const FILE_OVERSCAN = 8;
/** Initial viewport estimate before the first scroll event reports the real size. */
const FILE_VIEWPORT_FALLBACK = 1600;

interface VirtualRow {
  change: FileChange;
  index: number;
}

interface VirtualWindow {
  rows: VirtualRow[];
  top: number;
  bottom: number;
}

@Component({
  selector: 'app-git-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TypedInput,
    TranslocoPipe,
    ChangeStatusIcon,
    DiffView,
    FileIcon,
    GitCommitMenu,
    GitFileMenu,
    HunkDiffView,
  ],
  template: `
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2">
        <div class="flex min-w-0 items-center gap-2">
          <svg
            viewBox="0 0 16 16"
            class="h-4 w-4 shrink-0 text-accent/70"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="4" cy="3.5" r="1.6" />
            <circle cx="4" cy="12.5" r="1.6" />
            <circle cx="12" cy="6.5" r="1.6" />
            <path d="M4 5.1v5.8M5.6 6.5h2.9a2 2 0 0 0 2-2v-.4" />
          </svg>
          @if (status(); as current) {
            <span class="truncate text-[13px] font-semibold text-mist">
              {{ current.branch ?? ('git.detached' | transloco) }}
            </span>
          }
          @if (status()?.upstream; as upstream) {
            <span class="shrink-0 text-[11px] text-mist/30">{{ upstream }}</span>
          }
          @if (ahead() > 0) {
            <span
              class="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-400"
            >
              ↑{{ ahead() }}
            </span>
          }
          @if (behind() > 0) {
            <span
              class="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-400"
            >
              ↓{{ behind() }}
            </span>
          }
        </div>

        <div class="ml-auto flex items-center gap-1">
          @if (message(); as text) {
            <span class="max-w-72 truncate px-2 text-[11px] text-mist/50" [title]="text">{{
              text
            }}</span>
          }
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1 text-xs text-mist/60 transition-colors hover:bg-white/10 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
            [disabled]="busy()"
            [title]="'git.fetch' | transloco"
            (click)="run('fetch')"
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
              <path d="M8 2.5v8M5 7.5 8 10.5l3-3" />
              <path d="M3 12.5h10" />
            </svg>
            <span>{{ 'git.fetch' | transloco }}</span>
          </button>
          <select
            class="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-mist/60 focus:border-accent/50 focus:outline-none"
            [title]="'git.pullStrategy.label' | transloco"
            [value]="pullStrategy()"
            (change)="setPullStrategy($any($event.target).value)"
          >
            <option value="ff-only">{{ 'git.pullStrategy.ffOnly' | transloco }}</option>
            <option value="merge">{{ 'git.pullStrategy.merge' | transloco }}</option>
            <option value="rebase">{{ 'git.pullStrategy.rebase' | transloco }}</option>
          </select>
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1 text-xs text-mist/60 transition-colors hover:bg-white/10 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
            [disabled]="busy()"
            [title]="'git.pull' | transloco"
            (click)="run('pull')"
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
              <path d="M8 2.5v8M5 7.5 8 10.5l3-3" />
              <path d="M3 12.5h10" />
            </svg>
            <span>{{ 'git.pull' | transloco }}</span>
          </button>
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1 text-xs text-mist/60 transition-colors hover:bg-white/10 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
            [disabled]="busy()"
            [title]="'git.push' | transloco"
            (click)="run('push')"
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
              <path d="M8 13.5v-8M5 8.5 8 5.5l3 3" />
              <path d="M3 3.5h10" />
            </svg>
            <span>{{ 'git.push' | transloco }}</span>
          </button>
          <button
            type="button"
            class="flex h-7 w-7 items-center justify-center rounded-lg bg-white/5 text-mist/60 transition-colors hover:bg-white/10 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
            [disabled]="busy()"
            [title]="'git.refresh' | transloco"
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
      </div>

        @if (error(); as text) {
          <div
            class="flex shrink-0 items-center gap-2 border-y border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-[11px] text-rose-300"
          >
            <span class="min-w-0 flex-1 truncate" [title]="text">{{ text }}</span>
          </div>
        }

        @if (operation(); as op) {
          <div
            class="flex shrink-0 items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-300"
          >
            <span>{{
              'git.conflict.banner'
                | transloco: { operation: (operationLabels[op] | transloco) }
            }}</span>
            @if (conflicted().length > 0) {
              <span class="text-amber-300/70">{{
                'git.conflict.files' | transloco: { count: conflicted().length }
              }}</span>
            }
            <div class="ml-auto flex items-center gap-1">
              <button
                type="button"
                class="rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-amber-200 transition-colors hover:bg-white/10 disabled:opacity-40"
                [disabled]="busy() || conflicted().length > 0"
                [attr.title]="
                  conflicted().length > 0 ? ('git.conflict.resolveFirst' | transloco) : null
                "
                (click)="continueOperation()"
              >
                {{ 'git.conflict.continue' | transloco }}
              </button>
              <button
                type="button"
                class="rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-amber-200 transition-colors hover:bg-white/10 disabled:opacity-40"
                [disabled]="busy()"
                (click)="abortOperation()"
              >
                {{ 'git.conflict.abort' | transloco }}
              </button>
            </div>
          </div>
        }

        @if (!project()) {
          <p class="p-4 text-sm text-mist/40">{{ 'workspace.noSession' | transloco }}</p>
        } @else if (!status()?.isRepo) {
          <div class="flex flex-col items-start gap-3 p-4">
            <p class="text-sm text-mist/40">{{ 'git.noRepo' | transloco }}</p>
            <button
              type="button"
              class="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-accent/90 disabled:opacity-40"
              [disabled]="busy()"
              (click)="initRepo()"
            >
              {{ 'git.initRepo' | transloco }}
            </button>
          </div>
        } @else if (view() === 'commits') {
        <div class="flex min-h-0 flex-1 flex-col">
          <div
            class="flex min-h-0 flex-[3] flex-col overflow-y-auto"
            (scroll)="onCommitsScroll($event)"
          >
            <header class="flex shrink-0 items-center gap-2 border-b border-white/5 px-4 py-2">
              <span class="text-xs font-semibold uppercase tracking-widest text-mist/40">
                {{ 'git.history' | transloco }}
              </span>
              <span class="text-[11px] text-mist/30">
                {{ selectedBranch() ?? ('git.allBranches' | transloco) }}
              </span>
              @if (commitPath(); as path) {
                <span
                  class="flex min-w-0 items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 font-mono text-[11px] text-mist/50"
                >
                  <span class="max-w-56 truncate" [title]="path">{{ path }}</span>
                  <button
                    type="button"
                    class="shrink-0 text-mist/40 transition-colors hover:text-rose-400"
                    [attr.aria-label]="'common.close' | transloco"
                    (click)="clearCommitPath()"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      class="h-3 w-3"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.6"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </span>
              }
              <div class="relative ml-auto">
                <svg
                  viewBox="0 0 16 16"
                  class="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-mist/30"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <circle cx="7" cy="7" r="4.5" />
                  <path d="m10.5 10.5 3 3" />
                </svg>
                <input
                  type="text"
                  class="w-56 rounded-lg border border-white/10 bg-white/5 py-1 pr-2 pl-7 text-xs text-mist placeholder:text-mist/30 focus:border-accent/50 focus:outline-none"
                  [placeholder]="'git.searchCommits' | transloco"
                  [value]="searchTerm()"
                  (typedValue)="onSearchInput($event)"
                />
              </div>
              <span class="w-8 shrink-0 text-right text-[11px] text-mist/25">{{
                commits().length
              }}</span>
            </header>
            @for (row of graph().rows; track row.commit.hash) {
              <button
                type="button"
                class="flex h-7 w-full items-center gap-2 pr-4 text-left transition-colors [contain-intrinsic-size:auto_28px] [content-visibility:auto]"
                [attr.data-git-commit]="row.commit.hash"
                [class]="
                  row.commit.hash === selectedCommit()
                    ? 'bg-accent/10 text-white'
                    : 'text-mist/70 hover:bg-white/5'
                "
                (click)="selectCommit(row.commit)"
                (contextmenu)="openCommitMenu($event, row.commit)"
              >
                <svg
                  class="shrink-0"
                  [attr.width]="graph().width"
                  [attr.height]="rowHeight"
                  aria-hidden="true"
                >
                  @for (path of row.paths; track $index) {
                    <path
                      [attr.d]="path.d"
                      [attr.stroke]="path.color"
                      fill="none"
                      stroke-width="2"
                      stroke-linecap="round"
                    />
                  }
                  <circle
                    [attr.cx]="row.nodeX"
                    [attr.cy]="rowHeight / 2"
                    [attr.r]="radius"
                    [attr.fill]="row.nodeColor"
                    [attr.stroke]="row.commit.hash === selectedCommit() ? '#ffffff' : 'none'"
                    stroke-width="1"
                  />
                </svg>
                <span class="flex min-w-0 flex-1 items-center gap-1.5">
                  @for (ref of row.commit.refs; track ref) {
                    <span
                      class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                      [style.color]="row.nodeColor"
                      [style.background]="row.nodeColor + '22'"
                    >
                      {{ ref }}
                    </span>
                  }
                  <span class="min-w-0 flex-1 truncate text-[13px]">{{ row.commit.subject }}</span>
                </span>
                <span class="w-40 shrink-0 truncate text-[11px] text-mist/40">{{
                  row.commit.author
                }}</span>
                <span class="w-16 shrink-0 font-mono text-[11px] text-mist/30">{{
                  row.commit.shortHash
                }}</span>
                <span class="w-32 shrink-0 text-right text-[11px] text-mist/30">{{
                  absoluteTime(row.commit.timestamp)
                }}</span>
              </button>
            } @empty {
              @if (!commitsLoading()) {
                <p class="p-4 text-sm text-mist/40">{{ 'git.noCommits' | transloco }}</p>
              }
            }
            @if (commitsLoading()) {
              <p class="px-4 py-3 text-center text-[11px] text-mist/30">
                {{ 'common.loading' | transloco }}
              </p>
            }
          </div>

          <div class="flex min-h-0 flex-[2] flex-col border-t border-white/10">
            @if (commitDetail(); as detail) {
              <div class="flex shrink-0 items-center gap-1 border-b border-white/5 px-3 py-1.5">
                <div class="flex gap-0.5 rounded-lg bg-white/5 p-0.5">
                  <button
                    type="button"
                    class="rounded-md px-2.5 py-0.5 text-xs font-medium transition-colors"
                    [class]="
                      detailTab() === 'commit'
                        ? 'bg-white/10 text-white'
                        : 'text-mist/50 hover:text-mist'
                    "
                    (click)="detailTab.set('commit')"
                  >
                    {{ 'git.commitTab' | transloco }}
                  </button>
                  <button
                    type="button"
                    class="rounded-md px-2.5 py-0.5 text-xs font-medium transition-colors"
                    [class]="
                      detailTab() === 'changes'
                        ? 'bg-white/10 text-white'
                        : 'text-mist/50 hover:text-mist'
                    "
                    (click)="detailTab.set('changes')"
                  >
                    {{ 'git.changesTab' | transloco }}
                    <span class="ml-1 text-mist/40">{{ detail.changes.length }}</span>
                  </button>
                </div>
                <span class="ml-auto font-mono text-[11px] text-mist/40">{{
                  detail.shortHash
                }}</span>
              </div>

              @if (detailTab() === 'commit') {
                <div class="min-h-0 flex-1 overflow-y-auto p-4">
                  <dl class="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-xs">
                    <dt class="text-mist/40">{{ 'git.author' | transloco }}</dt>
                    <dd class="text-mist">
                      {{ detail.author }}
                      <span class="text-mist/40">&lt;{{ detail.authorEmail }}&gt;</span>
                    </dd>
                    <dt class="text-mist/40">{{ 'git.date' | transloco }}</dt>
                    <dd class="text-mist">{{ absoluteTime(detail.timestamp) }}</dd>
                    <dt class="text-mist/40">{{ 'git.refs' | transloco }}</dt>
                    <dd class="flex flex-wrap gap-1">
                      @for (ref of detail.refs; track ref) {
                        <span
                          class="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent"
                          >{{ ref }}</span
                        >
                      } @empty {
                        <span class="text-mist/30">—</span>
                      }
                    </dd>
                    <dt class="text-mist/40">{{ 'git.sha' | transloco }}</dt>
                    <dd class="font-mono text-mist/70">{{ detail.hash }}</dd>
                    <dt class="text-mist/40">{{ 'git.parents' | transloco }}</dt>
                    <dd class="font-mono text-mist/50">
                      @for (parent of detail.parents; track parent) {
                        <span class="mr-2">{{ short(parent) }}</span>
                      } @empty {
                        <span class="text-mist/30">—</span>
                      }
                    </dd>
                  </dl>

                  <div class="mt-4 border-t border-white/5 pt-3">
                    <h4 class="text-sm font-medium text-mist">{{ detail.subject }}</h4>
                    @if (detail.body) {
                      <pre class="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-mist/60">{{
                        detail.body
                      }}</pre>
                    }
                  </div>

                  <div class="mt-4 border-t border-white/5 pt-2">
                    @for (change of detail.changes; track change.path) {
                      <div class="flex items-center gap-2 py-1 text-xs text-mist/60">
                        <app-change-status-icon [status]="change.status" />
                        <app-file-icon [name]="baseName(change.path)" />
                        <span class="min-w-0 flex-1 truncate font-mono">{{ change.path }}</span>
                        @if (change.additions > 0) {
                          <span class="text-emerald-400">+{{ change.additions }}</span>
                        }
                        @if (change.deletions > 0) {
                          <span class="text-rose-400">-{{ change.deletions }}</span>
                        }
                      </div>
                    }
                  </div>
                </div>
              } @else {
                <div class="flex min-h-0 flex-1">
                  <div class="w-72 shrink-0 overflow-y-auto border-r border-white/5 py-1">
                    @for (change of detail.changes; track change.path) {
                      <button
                        type="button"
                        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors"
                        [class]="
                          selectedCommitFile() === change.path
                            ? 'bg-accent/10 text-white'
                            : 'text-mist/60 hover:bg-white/5'
                        "
                        (click)="selectCommitFile(change.path)"
                      >
                        <app-change-status-icon [status]="change.status" />
                        <app-file-icon [name]="baseName(change.path)" />
                        <span class="min-w-0 flex-1 truncate font-mono">{{ change.path }}</span>
                      </button>
                    }
                  </div>
                  <div class="min-h-0 flex-1">
                    @if (commitFileDiff(); as diff) {
                      <app-diff-view [diff]="diff" />
                    } @else {
                      <p class="p-4 text-sm text-mist/40">{{ 'git.selectFile' | transloco }}</p>
                    }
                  </div>
                </div>
              }
            } @else {
              <div class="flex h-full items-center justify-center">
                <p class="text-sm text-mist/40">{{ 'git.selectCommit' | transloco }}</p>
              </div>
            }
          </div>
        </div>
      } @else {
        <div class="flex min-h-0 flex-1">
          <aside class="flex w-80 shrink-0 flex-col border-r border-white/5">
            <section class="flex min-h-0 flex-1 flex-col border-b border-white/5">
              <header class="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
                <span class="text-xs font-semibold uppercase tracking-widest text-mist/40">
                  {{ 'git.unstaged' | transloco }}
                  <span class="ml-1 text-mist/25">{{ unstaged().length }}</span>
                </span>
                @if (unstaged().length > 0) {
                  <div class="flex items-center gap-1">
                    @if (markedUnstaged().length > 1) {
                      <button
                        type="button"
                        class="rounded-md bg-accent/15 px-2 py-0.5 text-[11px] text-accent transition-colors hover:bg-accent/25"
                        (click)="stageMarked()"
                      >
                        {{ 'git.stageSelected' | transloco: { count: markedUnstaged().length } }}
                      </button>
                    }
                    <button
                      type="button"
                      class="rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-mist/60 transition-colors hover:bg-white/10 hover:text-accent"
                      (click)="stageAll()"
                    >
                      {{ 'git.stageAll' | transloco }}
                    </button>
                  </div>
                }
              </header>
              <div
                class="min-h-0 flex-1 overflow-y-auto focus:outline-none"
                tabindex="0"
                data-git-list
                (keydown)="onFileKeydown($event, false)"
                (scroll)="onListScroll($event, false)"
              >
                @if (unstaged().length === 0) {
                  <p class="px-3 pb-3 text-xs text-mist/30">{{ 'git.noChanges' | transloco }}</p>
                } @else {
                  <div [style.height.px]="unstagedWindow().top"></div>
                  @for (row of unstagedWindow().rows; track row.change.path) {
                    <div
                      class="group flex items-center gap-2 px-3 text-[13px] transition-colors hover:bg-white/5"
                      [style.height.px]="fileRowHeight"
                      [class]="
                        isMarked(row.change.path, false) || isSelected(row.change.path, false)
                          ? 'bg-accent/10 text-white'
                          : 'text-mist/70'
                      "
                      [attr.data-git-file]="fileKey(row.change.path, false)"
                      (contextmenu)="openFileMenu($event, row.change.path, false)"
                    >
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-2 text-left"
                        (click)="onFileClick($event, row.change.path, false)"
                      >
                        <app-change-status-icon [status]="row.change.status" />
                        <app-file-icon [name]="baseName(row.change.path)" />
                        <span class="min-w-0 flex-1 truncate font-mono text-xs">{{
                          row.change.path
                        }}</span>
                        @if (row.change.additions > 0) {
                          <span class="shrink-0 text-[10px] text-emerald-400"
                            >+{{ row.change.additions }}</span
                          >
                        }
                        @if (row.change.deletions > 0) {
                          <span class="shrink-0 text-[10px] text-rose-400"
                            >-{{ row.change.deletions }}</span
                          >
                        }
                      </button>
                      <div
                        class="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                      >
                        <button
                          type="button"
                          class="rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-mist/60 transition-colors hover:bg-white/10 hover:text-accent"
                          [title]="'git.stage' | transloco"
                          (click)="stage(row.change.path)"
                        >
                          {{ 'git.stage' | transloco }}
                        </button>
                        <button
                          type="button"
                          class="flex h-6 w-6 items-center justify-center rounded-md text-mist/40 transition-colors hover:bg-white/10 hover:text-rose-400"
                          [title]="'git.discard' | transloco"
                          (click)="discard(row.change.path)"
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
                          </svg>
                        </button>
                      </div>
                    </div>
                  }
                  <div [style.height.px]="unstagedWindow().bottom"></div>
                }
              </div>
            </section>

            <section class="flex min-h-0 flex-1 flex-col">
              <header class="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
                <span class="text-xs font-semibold uppercase tracking-widest text-mist/40">
                  {{ 'git.staged' | transloco }}
                  <span class="ml-1 text-mist/25">{{ staged().length }}</span>
                </span>
                @if (staged().length > 0) {
                  <div class="flex items-center gap-1">
                    @if (markedStaged().length > 1) {
                      <button
                        type="button"
                        class="rounded-md bg-accent/15 px-2 py-0.5 text-[11px] text-accent transition-colors hover:bg-accent/25"
                        (click)="unstageMarked()"
                      >
                        {{ 'git.unstageSelected' | transloco: { count: markedStaged().length } }}
                      </button>
                    }
                    <button
                      type="button"
                      class="rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-mist/60 transition-colors hover:bg-white/10 hover:text-accent"
                      (click)="unstageAll()"
                    >
                      {{ 'git.unstageAll' | transloco }}
                    </button>
                  </div>
                }
              </header>
              <div
                class="min-h-0 flex-1 overflow-y-auto focus:outline-none"
                tabindex="0"
                data-git-list
                (keydown)="onFileKeydown($event, true)"
                (scroll)="onListScroll($event, true)"
              >
                @if (staged().length === 0) {
                  <p class="px-3 pb-3 text-xs text-mist/30">{{ 'git.noStaged' | transloco }}</p>
                } @else {
                  <div [style.height.px]="stagedWindow().top"></div>
                  @for (row of stagedWindow().rows; track row.change.path) {
                    <div
                      class="group flex items-center gap-2 px-3 text-[13px] transition-colors hover:bg-white/5"
                      [style.height.px]="fileRowHeight"
                      [class]="
                        isMarked(row.change.path, true) || isSelected(row.change.path, true)
                          ? 'bg-accent/10 text-white'
                          : 'text-mist/70'
                      "
                      [attr.data-git-file]="fileKey(row.change.path, true)"
                      (contextmenu)="openFileMenu($event, row.change.path, true)"
                    >
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-2 text-left"
                        (click)="onFileClick($event, row.change.path, true)"
                      >
                        <app-change-status-icon [status]="row.change.status" />
                        <app-file-icon [name]="baseName(row.change.path)" />
                        <span class="min-w-0 flex-1 truncate font-mono text-xs">{{
                          row.change.path
                        }}</span>
                        @if (row.change.additions > 0) {
                          <span class="shrink-0 text-[10px] text-emerald-400"
                            >+{{ row.change.additions }}</span
                          >
                        }
                        @if (row.change.deletions > 0) {
                          <span class="shrink-0 text-[10px] text-rose-400"
                            >-{{ row.change.deletions }}</span
                          >
                        }
                      </button>
                      <div
                        class="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                      >
                        <button
                          type="button"
                          class="rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-mist/60 transition-colors hover:bg-white/10 hover:text-accent"
                          [title]="'git.unstage' | transloco"
                          (click)="unstage(row.change.path)"
                        >
                          {{ 'git.unstage' | transloco }}
                        </button>
                      </div>
                    </div>
                  }
                  <div [style.height.px]="stagedWindow().bottom"></div>
                }
              </div>
            </section>
          </aside>

          <section class="flex min-w-0 flex-1 flex-col">
            <div class="min-h-0 flex-1">
              @if (diff(); as active) {
                <div class="flex h-full flex-col">
                  <header
                    class="flex shrink-0 items-center gap-3 border-b border-white/5 px-4 py-1.5"
                  >
                    <span
                      class="min-w-0 flex-1 truncate font-mono text-xs text-mist/60"
                      [title]="active.path"
                      >{{ active.path }}</span
                    >
                    @if (active.staged) {
                      <span
                        class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] text-accent"
                      >
                        {{ 'git.staged' | transloco }}
                      </span>
                    }
                    <span class="shrink-0 text-xs text-emerald-400"
                      >+{{ active.hunks.additions }}</span
                    >
                    <span class="shrink-0 text-xs text-rose-400"
                      >-{{ active.hunks.deletions }}</span
                    >
                    @if (!active.conflict) {
                      <div class="flex shrink-0 items-center gap-0.5">
                        <select
                          class="mr-1 rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[11px] text-mist/60 focus:border-accent/50 focus:outline-none"
                          [title]="'git.diff.context' | transloco"
                          [value]="diffOptions().context"
                          (change)="onContextChange($any($event.target).value)"
                        >
                          @for (choice of contextChoices; track choice) {
                            <option [value]="choice">
                              {{
                                choice === wholeFile
                                  ? ('git.diff.wholeFile' | transloco)
                                  : ('git.diff.contextLines' | transloco: { count: choice })
                              }}
                            </option>
                          }
                        </select>
                        <button
                          type="button"
                          class="diff-tool"
                          [class.diff-tool-active]="diffOptions().ignoreWhitespace"
                          [attr.aria-pressed]="diffOptions().ignoreWhitespace"
                          [title]="'git.diff.ignoreWhitespace' | transloco"
                          (click)="setDiffOption({ ignoreWhitespace: !diffOptions().ignoreWhitespace })"
                        >
                          <span class="text-[13px] leading-none">¶</span>
                        </button>
                        <button
                          type="button"
                          class="diff-tool"
                          [class.diff-tool-active]="diffOptions().layout === 'split'"
                          [attr.aria-pressed]="diffOptions().layout === 'split'"
                          [title]="'git.diff.splitView' | transloco"
                          (click)="
                            setDiffOption({
                              layout: diffOptions().layout === 'split' ? 'unified' : 'split',
                            })
                          "
                        >
                          <svg
                            viewBox="0 0 16 16"
                            class="h-3.5 w-3.5"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.4"
                            stroke-linejoin="round"
                          >
                            <rect x="2" y="3" width="12" height="10" rx="1.5" />
                            <path d="M8 3v10" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          class="diff-tool"
                          [class.diff-tool-active]="diffOptions().wrap"
                          [attr.aria-pressed]="diffOptions().wrap"
                          [title]="'git.diff.wrapLines' | transloco"
                          (click)="setDiffOption({ wrap: !diffOptions().wrap })"
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
                            <path d="M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H8m1.5-1.5L8 12l1.5 1.5M2.5 12h3" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          class="diff-tool"
                          [title]="'git.diff.findTitle' | transloco"
                          (click)="openFind()"
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
                            <circle cx="7" cy="7" r="4.5" />
                            <path d="m10.5 10.5 3 3" />
                          </svg>
                        </button>
                        <span
                          class="diff-tool cursor-help text-[11px]"
                          [title]="'git.diff.shortcuts' | transloco"
                          >?</span
                        >
                      </div>
                    }
                  </header>
                  @if (active.conflict; as conflict) {
                    <div
                      class="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-1.5 text-[11px] text-amber-200"
                    >
                      <span class="min-w-0 flex-1">{{ 'git.conflict.fileHint' | transloco }}</span>
                      <button
                        type="button"
                        class="rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-amber-100 transition-colors hover:bg-white/10 disabled:opacity-40"
                        [disabled]="busy()"
                        (click)="resolveConflict(active.path, 'ours')"
                      >
                        {{ 'git.conflict.useOurs' | transloco }}
                      </button>
                      <button
                        type="button"
                        class="rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-amber-100 transition-colors hover:bg-white/10 disabled:opacity-40"
                        [disabled]="busy()"
                        (click)="resolveConflict(active.path, 'theirs')"
                      >
                        {{ 'git.conflict.useTheirs' | transloco }}
                      </button>
                      <button
                        type="button"
                        class="rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-amber-100 transition-colors hover:bg-white/10 disabled:opacity-40"
                        [disabled]="busy()"
                        (click)="markResolved(active.path, conflict.newContent)"
                      >
                        {{ 'git.conflict.markResolved' | transloco }}
                      </button>
                    </div>
                    <div class="min-h-0 flex-1">
                      <app-diff-view [diff]="conflict" />
                    </div>
                  } @else {
                    <div class="min-h-0 flex-1">
                      <app-hunk-diff-view
                        [diff]="active.hunks"
                        [layout]="diffOptions().layout"
                        [wrap]="diffOptions().wrap"
                        [busy]="busy()"
                        (lineAction)="onLineAction($event)"
                        (ask)="askPumr($event)"
                        (showWhitespace)="setDiffOption({ ignoreWhitespace: false })"
                      />
                    </div>
                  }
                </div>
              } @else {
                <div class="flex h-full items-center justify-center">
                  <p class="text-sm text-mist/40">{{ 'git.selectFile' | transloco }}</p>
                </div>
              }
            </div>

            <div class="shrink-0 border-t border-white/10 p-3">
              <div class="flex items-center gap-1.5">
                <input
                  type="text"
                  class="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-mist placeholder:text-mist/30 focus:border-accent/50 focus:outline-none"
                  [placeholder]="'git.commitSubject' | transloco"
                  [value]="subject()"
                  (typedValue)="subject.set($event)"
                />
                <button
                  type="button"
                  class="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-mist/60 transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                  [disabled]="staged().length === 0 || generating()"
                  [title]="'git.generateMessage' | transloco"
                  [attr.aria-label]="'git.generateMessage' | transloco"
                  (click)="generateMessage()"
                >
                  @if (generating()) {
                    <svg viewBox="0 0 16 16" class="h-3.5 w-3.5 animate-spin" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
                      <path d="M8 2a6 6 0 1 1-6 6" />
                    </svg>
                  } @else {
                    <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M8 2.5 9.2 6 12.5 7.2 9.2 8.4 8 12 6.8 8.4 3.5 7.2 6.8 6z" />
                      <path d="M12.5 2v2.5M11.25 3.25h2.5" />
                    </svg>
                  }
                </button>
              </div>
              <textarea
                rows="2"
                class="mt-1.5 w-full resize-none rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-mist placeholder:text-mist/30 focus:border-accent/50 focus:outline-none"
                [placeholder]="'git.commitDescription' | transloco"
                [value]="description()"
                (typedValue)="description.set($event)"
              ></textarea>
              <div class="mt-2 flex items-center gap-2">
                <label class="flex cursor-pointer items-center gap-2 text-xs text-mist/60">
                  <input
                    type="checkbox"
                    class="accent-[var(--color-accent)]"
                    [checked]="amend()"
                    (change)="toggleAmend()"
                  />
                  {{ 'git.amend' | transloco }}
                </label>
                <div class="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    class="rounded-lg bg-white/5 px-3 py-1.5 text-sm font-medium text-mist transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                    [disabled]="!canCommit()"
                    (click)="commit(false)"
                  >
                    {{ 'git.commit' | transloco }}
                  </button>
                  <button
                    type="button"
                    class="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
                    [disabled]="!canCommit()"
                    (click)="commit(true)"
                  >
                    {{ 'git.commitAndPush' | transloco }}
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>
      }
    </div>

    @if (fileMenu(); as menu) {
      <app-git-file-menu
        [path]="menu.path"
        [paths]="menu.paths"
        [staged]="menu.staged"
        [conflicted]="conflicted().includes(menu.path)"
        [x]="menu.x"
        [y]="menu.y"
        (closed)="closeFileMenu()"
      />
    }

    @if (commitMenu(); as menu) {
      <app-git-commit-menu
        [commit]="menu.commit"
        [x]="menu.x"
        [y]="menu.y"
        [currentBranch]="status()?.branch ?? null"
        (closed)="commitMenu.set(null)"
      />
    }
  `,
  styles: `
    .diff-tool {
      display: flex;
      height: 1.5rem;
      width: 1.5rem;
      align-items: center;
      justify-content: center;
      border-radius: 0.375rem;
      color: rgb(from var(--color-mist) r g b / 0.45);
      transition:
        background-color 120ms ease,
        color 120ms ease;
    }
    .diff-tool:hover {
      background: rgb(255 255 255 / 0.08);
      color: var(--color-mist);
    }
    .diff-tool-active {
      background: rgb(from var(--color-accent) r g b / 0.15);
      color: var(--color-accent);
    }
  `,
})
export class GitView {
  private readonly workspace = inject(WorkspaceService);
  private readonly git = inject(GitService);
  private readonly transloco = inject(TranslocoService);

  protected readonly project = this.workspace.activeProject;
  private readonly gitState = this.git.scope(() => this.project()?.id ?? null);
  protected readonly status = this.gitState.status;
  protected readonly busy = this.gitState.busy;
  protected readonly message = this.gitState.message;
  protected readonly error = this.gitState.error;
  protected readonly diff = this.gitState.diff;
  protected readonly view = this.gitState.view;
  protected readonly selectedBranch = this.gitState.selectedBranch;
  protected readonly commits = this.gitState.commits;
  protected readonly commitsLoading = this.gitState.commitsLoading;
  protected readonly selectedCommit = this.gitState.selectedCommit;
  protected readonly commitDetail = this.gitState.commitDetail;
  protected readonly commitFileDiff = this.gitState.commitFileDiff;
  protected readonly commitPath = this.gitState.commitPath;
  protected readonly operationLabels: Record<GitOperation, string> = {
    merge: 'git.operation.merge',
    rebase: 'git.operation.rebase',
    'cherry-pick': 'git.operation.cherryPick',
    revert: 'git.operation.revert',
  };

  protected readonly subject = signal('');
  protected readonly description = signal('');
  protected readonly amend = signal(false);
  protected readonly detailTab = signal<'commit' | 'changes'>('commit');
  protected readonly selectedCommitFile = signal<string | null>(null);
  protected readonly searchTerm = signal('');
  protected readonly markedKeys = signal<ReadonlySet<string>>(new Set());
  protected readonly anchorKey = signal<string | null>(null);
  protected readonly cursorKey = signal<string | null>(null);
  protected readonly unstagedScrollTop = signal(0);
  protected readonly stagedScrollTop = signal(0);
  protected readonly unstagedViewport = signal(FILE_VIEWPORT_FALLBACK);
  protected readonly stagedViewport = signal(FILE_VIEWPORT_FALLBACK);
  protected readonly fileRowHeight = FILE_ROW_HEIGHT;
  protected readonly fileMenu = signal<{
    path: string;
    paths: string[];
    staged: boolean;
    x: number;
    y: number;
  } | null>(null);
  protected readonly commitMenu = signal<{ commit: GitCommit; x: number; y: number } | null>(
    null,
  );
  protected readonly generating = signal(false);
  protected readonly diffOptions = this.git.diffOptions;
  protected readonly wholeFile = GIT_WHOLE_FILE_CONTEXT;
  protected readonly contextChoices = [3, 10, 25, GIT_WHOLE_FILE_CONTEXT];
  private readonly hunkView = viewChild(HunkDiffView);
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private dateFormat: { lang: string; format: Intl.DateTimeFormat } | null = null;

  constructor() {
    effect(() => {
      const project = this.project();
      if (project) {
        void this.git.loadStatus(project.id);
        void this.git.loadRefs(project.id);
      }
    });
    effect(() => {
      this.searchTerm.set(this.gitState.commitSearch());
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.searchTimer) {
        clearTimeout(this.searchTimer);
      }
    });
    effect(() => {
      const diff = this.commitFileDiff();
      this.selectedCommitFile.set(diff?.path ?? null);
    });
    effect(() => {
      const hash = this.selectedCommit();
      if (!hash) {
        return;
      }
      setTimeout(() => {
        document.querySelector(`[data-git-commit="${hash}"]`)?.scrollIntoView({ block: 'nearest' });
      }, 0);
    });
    effect(() => {
      const current = this.markedKeys();
      if (current.size === 0) {
        return;
      }
      const status = this.status();
      const valid = new Set<string>();
      for (const change of status?.unstaged ?? []) {
        valid.add(this.fileKey(change.path, false));
      }
      for (const change of status?.staged ?? []) {
        valid.add(this.fileKey(change.path, true));
      }
      if ([...current].some((key) => !valid.has(key))) {
        this.markedKeys.set(new Set([...current].filter((key) => valid.has(key))));
      }
    });
  }

  protected readonly unstaged = computed(() => this.status()?.unstaged ?? []);
  protected readonly staged = computed(() => this.status()?.staged ?? []);
  protected readonly unstagedWindow = computed(() =>
    this.buildWindow(this.unstaged(), this.unstagedScrollTop(), this.unstagedViewport()),
  );
  protected readonly stagedWindow = computed(() =>
    this.buildWindow(this.staged(), this.stagedScrollTop(), this.stagedViewport()),
  );
  protected readonly markedUnstaged = computed(() =>
    this.unstaged().filter((change) => this.isMarked(change.path, false)),
  );
  protected readonly markedStaged = computed(() =>
    this.staged().filter((change) => this.isMarked(change.path, true)),
  );
  protected readonly ahead = computed(() => this.status()?.ahead ?? 0);
  protected readonly behind = computed(() => this.status()?.behind ?? 0);
  protected readonly branchTips = computed(() => {
    const seen = new Set<string>();
    const tips: string[] = [];
    const sorted = [...this.gitState.refs().branches].sort(
      (a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0),
    );
    for (const branch of sorted) {
      if (branch.hash && !seen.has(branch.hash)) {
        seen.add(branch.hash);
        tips.push(branch.hash);
      }
    }
    return tips;
  });
  /** Search results and file history are not connected histories; draw them flat. */
  protected readonly graph = computed(() =>
    this.gitState.commitSearch().trim() || this.commitPath()
      ? linearGitGraph(this.commits())
      : buildGitGraph(this.commits(), this.branchTips()),
  );
  protected readonly rowHeight = GIT_GRAPH_ROW_HEIGHT;
  protected readonly radius = GIT_GRAPH_RADIUS;
  protected readonly operation = computed(() => this.status()?.operation ?? null);
  /** A merge can be concluded with nothing new staged; everything else needs staged changes. */
  protected readonly canCommit = computed(
    () =>
      !this.busy() &&
      (this.staged().length > 0 || this.amend() || this.operation() === 'merge') &&
      this.subject().trim().length > 0,
  );
  protected readonly conflicted = computed(() => this.status()?.conflicted ?? []);
  protected readonly pullStrategy = this.workspace.gitPullStrategy;

  protected baseName(path: string): string {
    const segments = path.split('/');
    return segments[segments.length - 1] || path;
  }

  protected short(hash: string): string {
    return hash.slice(0, 7);
  }

  protected isSelected(path: string, staged: boolean): boolean {
    const diff = this.diff();
    return !!diff && diff.path === path && diff.staged === staged;
  }

  protected fileKey(path: string, staged: boolean): string {
    return `${staged ? 's' : 'u'}:${path}`;
  }

  protected isMarked(path: string, staged: boolean): boolean {
    return this.markedKeys().has(this.fileKey(path, staged));
  }

  protected onFileClick(event: MouseEvent, path: string, staged: boolean): void {
    const key = this.fileKey(path, staged);
    const anchor = this.anchorKey();
    if (event.shiftKey && anchor && anchor.charAt(0) === key.charAt(0)) {
      this.markRange(anchor, key, staged);
      this.cursorKey.set(key);
    } else if (event.metaKey || event.ctrlKey) {
      const next = new Set(this.markedKeys());
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      this.markedKeys.set(next);
      this.anchorKey.set(key);
      this.cursorKey.set(key);
    } else {
      this.setSingleSelection(key);
    }
    this.focusList(event);
    this.select(path, staged);
  }

  protected onFileKeydown(event: KeyboardEvent, staged: boolean): void {
    const list = staged ? this.staged() : this.unstaged();
    if (list.length === 0) {
      return;
    }
    // Enter and Space on a focused row button activate that button, not the
    // list shortcut for the marked files.
    const onButton =
      event.target !== event.currentTarget && event.target instanceof HTMLButtonElement;
    if (onButton && (event.key === 'Enter' || event.key === ' ')) {
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.markAll(staged);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (staged) {
        return;
      }
      event.preventDefault();
      void this.discardMarked();
      return;
    }
    const cursor = this.cursorKey();
    const index = list.findIndex((change) => this.fileKey(change.path, staged) === cursor);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex =
        index < 0
          ? delta > 0
            ? 0
            : list.length - 1
          : Math.min(list.length - 1, Math.max(0, index + delta));
      const nextKey = this.fileKey(list[nextIndex].path, staged);
      if (event.shiftKey) {
        let anchor = this.anchorKey();
        if (!anchor || anchor.charAt(0) !== nextKey.charAt(0)) {
          anchor = cursor ?? nextKey;
          this.anchorKey.set(anchor);
        }
        this.markRange(anchor, nextKey, staged);
        this.cursorKey.set(nextKey);
      } else {
        this.setSingleSelection(nextKey);
      }
      this.select(list[nextIndex].path, staged);
      this.scrollFileIntoView(nextKey, event.currentTarget as HTMLElement, list, staged);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (staged) {
        this.unstageMarked();
      } else {
        this.stageMarked();
      }
    }
  }

  private setSingleSelection(key: string): void {
    this.markedKeys.set(new Set([key]));
    this.anchorKey.set(key);
    this.cursorKey.set(key);
  }

  private markAll(staged: boolean): void {
    const list = staged ? this.staged() : this.unstaged();
    const next = new Set<string>();
    for (const change of list) {
      next.add(this.fileKey(change.path, staged));
    }
    this.markedKeys.set(next);
    this.anchorKey.set(list.length > 0 ? this.fileKey(list[0].path, staged) : null);
    this.cursorKey.set(
      list.length > 0 ? this.fileKey(list[list.length - 1].path, staged) : null,
    );
  }

  protected async discardMarked(): Promise<void> {
    const projectId = this.project()?.id;
    const paths = this.markedUnstaged().map((change) => change.path);
    if (!projectId || paths.length === 0) {
      return;
    }
    const confirmed = await confirmWarning(
      paths.length > 1
        ? this.transloco.translate('git.discardSelectedConfirm', { count: paths.length })
        : this.transloco.translate('git.discardConfirm', { path: paths[0] }),
    );
    if (!confirmed) {
      return;
    }
    await this.git.discardPaths(projectId, paths);
    this.clearMarked();
  }

  private focusList(event: Event): void {
    const target = event.currentTarget as HTMLElement | null;
    target?.closest<HTMLElement>('[data-git-list]')?.focus({ preventScroll: true });
  }

  private markRange(fromKey: string, toKey: string, staged: boolean): void {
    const list = staged ? this.staged() : this.unstaged();
    const from = list.findIndex((change) => this.fileKey(change.path, staged) === fromKey);
    const to = list.findIndex((change) => this.fileKey(change.path, staged) === toKey);
    if (from < 0 || to < 0) {
      this.markedKeys.set(new Set([toKey]));
      return;
    }
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    const next = new Set<string>();
    for (let i = start; i <= end; i += 1) {
      next.add(this.fileKey(list[i].path, staged));
    }
    this.markedKeys.set(next);
  }

  private buildWindow(list: FileChange[], scrollTop: number, viewport: number): VirtualWindow {
    const total = list.length;
    const start = Math.max(0, Math.floor(scrollTop / FILE_ROW_HEIGHT) - FILE_OVERSCAN);
    const count = Math.ceil(viewport / FILE_ROW_HEIGHT) + FILE_OVERSCAN * 2;
    const end = Math.min(total, start + count);
    const rows: VirtualRow[] = [];
    for (let i = start; i < end; i += 1) {
      rows.push({ change: list[i], index: i });
    }
    return {
      rows,
      top: start * FILE_ROW_HEIGHT,
      bottom: Math.max(0, (total - end) * FILE_ROW_HEIGHT),
    };
  }

  protected onListScroll(event: Event, staged: boolean): void {
    const element = event.target as HTMLElement;
    if (staged) {
      this.stagedScrollTop.set(element.scrollTop);
      this.stagedViewport.set(element.clientHeight);
    } else {
      this.unstagedScrollTop.set(element.scrollTop);
      this.unstagedViewport.set(element.clientHeight);
    }
  }

  private scrollFileIntoView(
    key: string,
    container: HTMLElement,
    list: FileChange[],
    staged: boolean,
  ): void {
    const index = list.findIndex((change) => this.fileKey(change.path, staged) === key);
    if (index < 0 || !container) {
      return;
    }
    const rowTop = index * FILE_ROW_HEIGHT;
    const rowBottom = rowTop + FILE_ROW_HEIGHT;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;
    if (rowTop < viewTop) {
      container.scrollTop = rowTop;
    } else if (rowBottom > viewBottom) {
      container.scrollTop = rowBottom - container.clientHeight;
    }
    if (staged) {
      this.stagedScrollTop.set(container.scrollTop);
      this.stagedViewport.set(container.clientHeight);
    } else {
      this.unstagedScrollTop.set(container.scrollTop);
      this.unstagedViewport.set(container.clientHeight);
    }
  }

  private clearMarked(): void {
    this.markedKeys.set(new Set());
    this.anchorKey.set(null);
    this.cursorKey.set(null);
  }

  protected select(path: string, staged: boolean): void {
    const projectId = this.project()?.id;
    if (projectId) {
      void this.git.selectChange(projectId, path, staged);
    }
  }

  protected openFileMenu(event: MouseEvent, path: string, staged: boolean): void {
    event.preventDefault();
    if (!this.isMarked(path, staged)) {
      this.setSingleSelection(this.fileKey(path, staged));
    }
    const marked = (staged ? this.markedStaged() : this.markedUnstaged()).map(
      (change) => change.path,
    );
    const paths = marked.length > 1 ? marked : [path];
    this.fileMenu.set({ path, paths, staged, x: event.clientX, y: event.clientY });
  }

  protected closeFileMenu(): void {
    this.fileMenu.set(null);
  }

  protected openCommitMenu(event: MouseEvent, commit: GitCommit): void {
    event.preventDefault();
    this.commitMenu.set({ commit, x: event.clientX, y: event.clientY });
  }

  protected setDiffOption(patch: Partial<GitDiffOptions>): void {
    this.git.setDiffOptions(this.project()?.id ?? null, patch);
  }

  protected onContextChange(value: string): void {
    const context = Number(value);
    if (Number.isInteger(context) && context > 0) {
      this.setDiffOption({ context });
    }
  }

  protected openFind(): void {
    this.hunkView()?.openFind();
  }

  /** Discarding lines cannot be undone, so it is confirmed like a whole-file discard. */
  protected async onLineAction(request: LineActionRequest): Promise<void> {
    const projectId = this.project()?.id;
    if (!projectId) {
      return;
    }
    if (
      request.action === 'discard' &&
      !(await confirmWarning(
        this.transloco.translate('git.diff.discardConfirm', { count: request.lines.length }),
      ))
    ) {
      return;
    }
    await this.git.applyLines(projectId, request.action, request.lines);
  }

  protected askPumr(question: DiffQuestion): void {
    this.workspace.askInChat({
      mention: { kind: 'file', value: question.path, label: this.baseName(question.path) },
      text: question.text,
    });
  }

  protected async resolveConflict(path: string, side: GitConflictSide): Promise<void> {
    const projectId = this.project()?.id;
    if (projectId) {
      await this.git.resolveConflict(projectId, path, side);
    }
  }

  /** Marks a conflict resolved, after asking when conflict markers are still in the file. */
  protected async markResolved(path: string, content: string): Promise<void> {
    const projectId = this.project()?.id;
    if (!projectId) {
      return;
    }
    const markers = /^(<{7}|>{7})(\s|$)/m.test(content);
    if (markers && !(await confirmWarning(this.transloco.translate('git.conflict.markersLeft')))) {
      return;
    }
    await this.git.stagePath(projectId, path);
  }

  protected async generateMessage(): Promise<void> {
    const projectId = this.project()?.id;
    if (!projectId || this.generating()) {
      return;
    }
    this.generating.set(true);
    try {
      const message = await this.git.generateCommitMessage(projectId);
      if (message) {
        this.subject.set(message.subject);
        this.description.set(message.body);
      }
    } finally {
      this.generating.set(false);
    }
  }

  protected clearCommitPath(): void {
    const projectId = this.project()?.id;
    if (projectId) {
      void this.git.openHistory(projectId, null);
    }
  }

  protected selectCommit(commit: GitCommit): void {
    this.detailTab.set('commit');
    const projectId = this.project()?.id;
    if (projectId) {
      void this.git.selectCommit(projectId, commit.hash);
    }
  }

  protected onCommitsScroll(event: Event): void {
    const element = event.target as HTMLElement;
    if (element.scrollHeight - element.scrollTop - element.clientHeight > 240) {
      return;
    }
    const projectId = this.project()?.id;
    if (projectId) {
      void this.git.loadMoreCommits(projectId);
    }
  }

  protected onSearchInput(value: string): void {
    this.searchTerm.set(value);
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      const projectId = this.project()?.id;
      if (projectId) {
        void this.git.searchCommits(projectId, this.searchTerm());
      }
    }, 300);
  }

  protected selectCommitFile(path: string): void {
    const projectId = this.project()?.id;
    if (projectId) {
      void this.git.selectCommitFile(projectId, path);
    }
  }

  protected refresh(): void {
    const projectId = this.project()?.id;
    if (projectId) {
      void this.git.refresh(projectId);
    }
  }

  protected stageAll(): void {
    const projectId = this.project()?.id;
    if (projectId) {
      void this.git.stagePath(projectId, null);
    }
  }

  protected unstageAll(): void {
    const projectId = this.project()?.id;
    if (projectId) {
      void this.git.unstagePath(projectId, null);
    }
  }

  protected stage(path: string): void {
    if (this.isMarked(path, false) && this.markedUnstaged().length > 1) {
      this.stageMarked();
      return;
    }
    const projectId = this.project()?.id;
    if (projectId) {
      void this.git.stagePath(projectId, path);
    }
  }

  protected unstage(path: string): void {
    if (this.isMarked(path, true) && this.markedStaged().length > 1) {
      this.unstageMarked();
      return;
    }
    const projectId = this.project()?.id;
    if (projectId) {
      void this.git.unstagePath(projectId, path);
    }
  }

  protected stageMarked(): void {
    const projectId = this.project()?.id;
    const paths = this.markedUnstaged().map((change) => change.path);
    if (!projectId || paths.length === 0) {
      return;
    }
    if (paths.length === this.unstaged().length) {
      void this.git.stagePath(projectId, null);
    } else {
      void this.git.stagePaths(projectId, paths);
    }
    this.clearMarked();
  }

  protected unstageMarked(): void {
    const projectId = this.project()?.id;
    const paths = this.markedStaged().map((change) => change.path);
    if (!projectId || paths.length === 0) {
      return;
    }
    if (paths.length === this.staged().length) {
      void this.git.unstagePath(projectId, null);
    } else {
      void this.git.unstagePaths(projectId, paths);
    }
    this.clearMarked();
  }

  protected async discard(path: string): Promise<void> {
    const projectId = this.project()?.id;
    if (!projectId) {
      return;
    }
    if (await confirmWarning(this.transloco.translate('git.discardConfirm', { path }))) {
      await this.git.discardPaths(projectId, [path]);
    }
  }

  protected async commit(push: boolean): Promise<void> {
    if (!this.canCommit()) {
      return;
    }
    const projectId = this.project()?.id;
    if (!projectId) {
      return;
    }
    const message = [this.subject().trim(), this.description().trim()]
      .filter((part) => part.length > 0)
      .join('\n\n');
    try {
      await this.git.commit(projectId, message, this.amend());
      this.subject.set('');
      this.description.set('');
      this.amend.set(false);
      if (push) {
        await this.git.runOperation(projectId, 'push');
      }
    } catch (error) {
      console.error(error);
    }
  }

  protected async toggleAmend(): Promise<void> {
    const next = !this.amend();
    this.amend.set(next);
    const projectId = this.project()?.id;
    if (!next || !projectId || this.subject().trim().length > 0) {
      return;
    }
    const head = await this.git.headMessage(projectId);
    // The user may have unticked amend or started typing meanwhile.
    if (head && this.amend() && this.subject().trim().length === 0) {
      this.subject.set(head.subject);
      this.description.set(head.body);
    }
  }

  protected setPullStrategy(strategy: GitPullStrategy): void {
    this.workspace.setGitPullStrategy(strategy);
  }

  protected async abortOperation(): Promise<void> {
    const projectId = this.project()?.id;
    const operation = this.operation();
    if (!projectId || !operation) {
      return;
    }
    try {
      await this.git.abortOperation(projectId, operation);
    } catch (error) {
      console.error(error);
    }
  }

  protected async continueOperation(): Promise<void> {
    const projectId = this.project()?.id;
    const operation = this.operation();
    if (!projectId || !operation) {
      return;
    }
    try {
      await this.git.continueOperation(projectId, operation);
    } catch (error) {
      console.error(error);
    }
  }

  protected async initRepo(): Promise<void> {
    const projectId = this.project()?.id;
    if (!projectId) {
      return;
    }
    try {
      await this.git.init(projectId);
    } catch (error) {
      console.error(error);
    }
  }

  protected async run(operation: 'fetch' | 'pull' | 'push'): Promise<void> {
    const projectId = this.project()?.id;
    if (!projectId) {
      return;
    }
    try {
      await this.git.runOperation(projectId, operation, this.pullStrategy());
    } catch (error) {
      console.error(error);
    }
  }

  /** Formats a timestamp; the formatter is built once per language, not per row. */
  protected absoluteTime(timestamp: number): string {
    const lang = this.transloco.getActiveLang();
    if (this.dateFormat?.lang !== lang) {
      this.dateFormat = {
        lang,
        format: new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }),
      };
    }
    return this.dateFormat.format.format(new Date(timestamp));
  }
}
