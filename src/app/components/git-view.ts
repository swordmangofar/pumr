import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { confirm } from '@tauri-apps/plugin-dialog';
import { GitCommit, GitPullStrategy } from '../core/models';
import { GIT_GRAPH_RADIUS, GIT_GRAPH_ROW_HEIGHT, buildGitGraph } from '../core/git-graph';
import { WorkspaceService } from '../core/workspace.service';
import { GitService } from '../core/git.service';
import { ChangeStatusIcon } from './change-status-icon';
import { DiffView } from './diff-view';
import { FileIcon } from './file-icon';

import { TypedInput } from './typed-input';

@Component({
  selector: 'app-git-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TypedInput, TranslocoPipe, ChangeStatusIcon, DiffView, FileIcon],
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
          <span class="truncate text-[13px] font-semibold text-mist">
            {{ status()?.branch ?? ('git.detached' | transloco) }}
          </span>
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
            <span>{{ 'git.conflict.banner' | transloco: { operation: op } }}</span>
            @if (conflicted().length > 0) {
              <span class="text-amber-300/70">{{
                'git.conflict.files' | transloco: { count: conflicted().length }
              }}</span>
            }
            <div class="ml-auto flex items-center gap-1">
              @if (op === 'rebase') {
                <button
                  type="button"
                  class="rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-amber-200 transition-colors hover:bg-white/10"
                  (click)="continueOperation()"
                >
                  {{ 'git.conflict.continue' | transloco }}
                </button>
              }
              <button
                type="button"
                class="rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-amber-200 transition-colors hover:bg-white/10"
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
            <div class="min-h-0 flex-1 overflow-y-auto">
              <section class="border-b border-white/5">
                <header class="flex items-center justify-between gap-2 px-3 py-2">
                  <span class="text-xs font-semibold uppercase tracking-widest text-mist/40">
                    {{ 'git.unstaged' | transloco }}
                    <span class="ml-1 text-mist/25">{{ unstaged().length }}</span>
                  </span>
                  @if (unstaged().length > 0) {
                    <button
                      type="button"
                      class="rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-mist/60 transition-colors hover:bg-white/10 hover:text-accent"
                      (click)="stageAll()"
                    >
                      {{ 'git.stageAll' | transloco }}
                    </button>
                  }
                </header>
                @for (change of unstaged(); track change.path) {
                  <div
                    class="group flex items-center gap-2 px-3 py-1.5 text-[13px] transition-colors hover:bg-white/5"
                    [class]="
                      isSelected(change.path, false) ? 'bg-accent/10 text-white' : 'text-mist/70'
                    "
                  >
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 items-center gap-2 text-left"
                      (click)="select(change.path, false)"
                    >
                      <app-change-status-icon [status]="change.status" />
                      <app-file-icon [name]="baseName(change.path)" />
                      <span class="min-w-0 flex-1 truncate font-mono text-xs">{{
                        change.path
                      }}</span>
                      @if (change.additions > 0) {
                        <span class="shrink-0 text-[10px] text-emerald-400"
                          >+{{ change.additions }}</span
                        >
                      }
                      @if (change.deletions > 0) {
                        <span class="shrink-0 text-[10px] text-rose-400"
                          >-{{ change.deletions }}</span
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
                        (click)="stage(change.path)"
                      >
                        {{ 'git.stage' | transloco }}
                      </button>
                      <button
                        type="button"
                        class="flex h-6 w-6 items-center justify-center rounded-md text-mist/40 transition-colors hover:bg-white/10 hover:text-rose-400"
                        [title]="'git.discard' | transloco"
                        (click)="discard(change.path)"
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
                } @empty {
                  <p class="px-3 pb-3 text-xs text-mist/30">{{ 'git.noChanges' | transloco }}</p>
                }
              </section>

              <section>
                <header class="flex items-center justify-between gap-2 px-3 py-2">
                  <span class="text-xs font-semibold uppercase tracking-widest text-mist/40">
                    {{ 'git.staged' | transloco }}
                    <span class="ml-1 text-mist/25">{{ staged().length }}</span>
                  </span>
                  @if (staged().length > 0) {
                    <button
                      type="button"
                      class="rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-mist/60 transition-colors hover:bg-white/10 hover:text-accent"
                      (click)="unstageAll()"
                    >
                      {{ 'git.unstageAll' | transloco }}
                    </button>
                  }
                </header>
                @for (change of staged(); track change.path) {
                  <div
                    class="group flex items-center gap-2 px-3 py-1.5 text-[13px] transition-colors hover:bg-white/5"
                    [class]="
                      isSelected(change.path, true) ? 'bg-accent/10 text-white' : 'text-mist/70'
                    "
                  >
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 items-center gap-2 text-left"
                      (click)="select(change.path, true)"
                    >
                      <app-change-status-icon [status]="change.status" />
                      <app-file-icon [name]="baseName(change.path)" />
                      <span class="min-w-0 flex-1 truncate font-mono text-xs">{{
                        change.path
                      }}</span>
                      @if (change.additions > 0) {
                        <span class="shrink-0 text-[10px] text-emerald-400"
                          >+{{ change.additions }}</span
                        >
                      }
                      @if (change.deletions > 0) {
                        <span class="shrink-0 text-[10px] text-rose-400"
                          >-{{ change.deletions }}</span
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
                        (click)="unstage(change.path)"
                      >
                        {{ 'git.unstage' | transloco }}
                      </button>
                    </div>
                  </div>
                } @empty {
                  <p class="px-3 pb-3 text-xs text-mist/30">{{ 'git.noStaged' | transloco }}</p>
                }
              </section>
            </div>
          </aside>

          <section class="flex min-w-0 flex-1 flex-col">
            <div class="min-h-0 flex-1">
              @if (diff(); as active) {
                <div class="flex h-full flex-col">
                  <header
                    class="flex shrink-0 items-center gap-3 border-b border-white/5 px-4 py-1.5"
                  >
                    <span class="min-w-0 flex-1 truncate font-mono text-xs text-mist/60">{{
                      active.path
                    }}</span>
                    @if (active.staged) {
                      <span
                        class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] text-accent"
                      >
                        {{ 'git.staged' | transloco }}
                      </span>
                    }
                    <span class="shrink-0 text-xs text-emerald-400"
                      >+{{ active.diff.additions }}</span
                    >
                    <span class="shrink-0 text-xs text-rose-400">-{{ active.diff.deletions }}</span>
                  </header>
                  <div class="min-h-0 flex-1">
                    <app-diff-view [diff]="active.diff" />
                  </div>
                </div>
              } @else {
                <div class="flex h-full items-center justify-center">
                  <p class="text-sm text-mist/40">{{ 'git.selectFile' | transloco }}</p>
                </div>
              }
            </div>

            <div class="shrink-0 border-t border-white/10 p-3">
              <input
                type="text"
                class="w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-mist placeholder:text-mist/30 focus:border-accent/50 focus:outline-none"
                [placeholder]="'git.commitSubject' | transloco"
                [value]="subject()"
                (typedValue)="subject.set($event)"
              />
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
  `,
})
export class GitView {
  private readonly workspace = inject(WorkspaceService);
  private readonly git = inject(GitService);
  private readonly transloco = inject(TranslocoService);

  protected readonly project = this.workspace.activeProject;
  protected readonly status = this.workspace.activeGitStatus;
  protected readonly busy = this.workspace.gitBusy;
  protected readonly message = this.workspace.gitMessage;
  protected readonly error = this.workspace.gitError;
  protected readonly diff = this.workspace.gitDiff;
  protected readonly view = this.workspace.gitView;
  protected readonly selectedBranch = this.workspace.selectedGitBranch;
  protected readonly commits = this.workspace.gitCommits;
  protected readonly commitsLoading = this.workspace.gitCommitsLoading;
  protected readonly selectedCommit = this.workspace.selectedGitCommit;
  protected readonly commitDetail = this.workspace.gitCommitDetail;
  protected readonly commitFileDiff = this.workspace.gitCommitFileDiff;

  protected readonly subject = signal('');
  protected readonly description = signal('');
  protected readonly amend = signal(false);
  protected readonly detailTab = signal<'commit' | 'changes'>('commit');
  protected readonly selectedCommitFile = signal<string | null>(null);
  protected readonly searchTerm = signal('');
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const project = this.project();
      if (project) {
        void this.git.loadStatus(project.id);
      }
    });
    effect(() => {
      const project = this.project();
      this.searchTerm.set(project ? this.git.commitSearchFor(project.id) : '');
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
  }

  protected readonly unstaged = computed(() => this.status()?.unstaged ?? []);
  protected readonly staged = computed(() => this.status()?.staged ?? []);
  protected readonly ahead = computed(() => this.status()?.ahead ?? 0);
  protected readonly behind = computed(() => this.status()?.behind ?? 0);
  private readonly branches = this.workspace.activeGitBranches;
  protected readonly branchTips = computed(() => {
    const seen = new Set<string>();
    const tips: string[] = [];
    const sorted = [...this.branches()].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    for (const branch of sorted) {
      if (branch.hash && !seen.has(branch.hash)) {
        seen.add(branch.hash);
        tips.push(branch.hash);
      }
    }
    return tips;
  });
  protected readonly graph = computed(() => buildGitGraph(this.commits(), this.branchTips()));
  protected readonly rowHeight = GIT_GRAPH_ROW_HEIGHT;
  protected readonly radius = GIT_GRAPH_RADIUS;
  protected readonly canCommit = computed(
    () =>
      (this.staged().length > 0 || this.amend()) && this.subject().trim().length > 0,
  );
  protected readonly operation = computed(() => this.status()?.operation ?? null);
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

  protected select(path: string, staged: boolean): void {
    const projectId = this.project()?.id;
    if (projectId) {
      void this.git.selectChange(projectId, path, staged);
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
    const projectId = this.project()?.id;
    if (projectId) {
      void this.git.stagePath(projectId, path);
    }
  }

  protected unstage(path: string): void {
    const projectId = this.project()?.id;
    if (projectId) {
      void this.git.unstagePath(projectId, path);
    }
  }

  protected async discard(path: string): Promise<void> {
    const projectId = this.project()?.id;
    if (!projectId) {
      return;
    }
    const confirmed = await confirm(
      this.transloco.translate('git.discardConfirm', { path }),
      {
        title: 'pumr',
        kind: 'warning',
      },
    );
    if (!confirmed) {
      return;
    }
    try {
      await this.git.discardPath(projectId, path);
    } catch (error) {
      console.error(error);
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
    if (head) {
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
    if (!projectId) {
      return;
    }
    try {
      await this.git.continueOperation(projectId);
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

  protected absoluteTime(timestamp: number): string {
    return new Intl.DateTimeFormat(this.transloco.getActiveLang(), {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(timestamp));
  }
}
