import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { confirmWarning } from '../core/confirm-warning';
import { buildBranchTree, flattenBranchTree } from '../core/git-branches';
import { GitBranch, GitStash, GitTag } from '../core/models';
import { WorkspaceService } from '../core/workspace.service';
import { GitService } from '../core/git.service';
import { GitBranchMenu } from './git-branch-menu';
import { GitNameDialog, GitNameDialogResult } from './git-name-dialog';
import { TypedInput } from './typed-input';

const EMPTY_COLLAPSED: ReadonlySet<string> = new Set<string>();

@Component({
  selector: 'app-git-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TypedInput, TranslocoPipe, GitBranchMenu, GitNameDialog],
  host: {
    '(document:keydown.escape)': 'onEscape()',
  },
  template: `
    <div class="flex h-full flex-col">
      <div class="shrink-0 space-y-1 px-2 pt-3">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left text-[13px] font-medium transition-colors"
          [class]="
            changesActive() ? 'bg-accent text-ink' : 'text-mist/60 hover:bg-white/5 hover:text-mist'
          "
          (click)="showChanges()"
        >
          <svg
            viewBox="0 0 16 16"
            class="h-3.5 w-3.5 shrink-0"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M8 2.5 3 7.5h3v6h4v-6h3z" />
          </svg>
          <span class="min-w-0 flex-1 truncate">
            {{ 'git.localChanges' | transloco }}
            @if (changeCount() > 0) {
              <span [class]="changesActive() ? 'text-ink/60' : 'text-mist/35'"
                >({{ changeCount() }})</span
              >
            }
          </span>
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left text-[13px] font-medium transition-colors"
          [class]="
            commitsActive() ? 'bg-accent text-ink' : 'text-mist/60 hover:bg-white/5 hover:text-mist'
          "
          (click)="showAllCommits()"
        >
          <svg
            viewBox="0 0 16 16"
            class="h-3.5 w-3.5 shrink-0"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="4" cy="3.5" r="1.5" />
            <circle cx="4" cy="12.5" r="1.5" />
            <circle cx="12" cy="6.5" r="1.5" />
            <path d="M4 5v6M5.5 6.5h3a2 2 0 0 0 2-2" />
          </svg>
          <span class="min-w-0 flex-1 truncate">{{ 'git.allCommits' | transloco }}</span>
        </button>
      </div>

      @if (!project()) {
        <p class="px-3 py-4 text-sm leading-relaxed text-mist/40">
          {{ 'workspace.noSession' | transloco }}
        </p>
      } @else if (!status()?.isRepo) {
        <p class="px-3 py-4 text-sm leading-relaxed text-mist/40">
          {{ 'git.noRepo' | transloco }}
        </p>
      } @else {
        <div class="shrink-0 px-3 pt-3 pb-2">
          <input
            type="text"
            class="w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-mist placeholder:text-mist/30 focus:border-accent/50 focus:outline-none"
            [placeholder]="'git.filter' | transloco"
            [value]="filter()"
            (typedValue)="filter.set($event)"
          />
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <section class="border-t border-white/5 pt-1">
            <div class="flex items-center gap-1 px-2 py-1">
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-mist/40 transition-colors hover:text-mist/70"
                (click)="branchesOpen.set(!branchesOpen())"
              >
                <svg
                  viewBox="0 0 16 16"
                  class="h-3 w-3 transition-transform"
                  [class.rotate-90]="branchesOpen()"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M6 3.5 10.5 8 6 12.5" />
                </svg>
                {{ 'git.branches' | transloco }}
                <span class="ml-auto text-mist/25">{{ localBranches().length }}</span>
              </button>
              <button
                type="button"
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-mist/40 transition-colors hover:bg-white/10 hover:text-accent"
                [title]="'git.createBranch' | transloco"
                (click)="openCreateDialog()"
              >
                <svg
                  viewBox="0 0 16 16"
                  class="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M8 3.5v9M3.5 8h9" />
                </svg>
              </button>
            </div>
            @if (branchesOpen()) {
              <div class="mt-0.5 space-y-0.5">
                @for (row of localBranchRows(); track row.path) {
                  @if (row.kind === 'folder') {
                    <button
                      type="button"
                      class="flex w-full items-center gap-1.5 rounded-lg py-1 text-left text-[13px] text-mist/50 transition-colors hover:bg-white/5 hover:text-mist"
                      [style.padding-left.px]="8 + row.depth * 12"
                      (click)="toggleFolder(row.path)"
                    >
                      <svg
                        viewBox="0 0 16 16"
                        class="h-3 w-3 shrink-0 transition-transform"
                        [class.rotate-90]="!isFolderCollapsed(row.path)"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.6"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M6 3.5 10.5 8 6 12.5" />
                      </svg>
                      <svg
                        viewBox="0 0 16 16"
                        class="h-4 w-4 shrink-0"
                        fill="#6b7280"
                        stroke="#9ca3af"
                        stroke-width="0.8"
                        stroke-linejoin="round"
                      >
                        <path
                          d="M1.75 4.25A1.25 1.25 0 0 1 3 3h3l1.25 1.5H13a1.25 1.25 0 0 1 1.25 1.25v6A1.25 1.25 0 0 1 13 13H3a1.25 1.25 0 0 1-1.25-1.25Z"
                        />
                      </svg>
                      <span class="min-w-0 flex-1 truncate">{{ row.name }}</span>
                    </button>
                  } @else {
                    @if (row.branch; as branch) {
                      <button
                        type="button"
                        class="flex w-full items-center gap-2 rounded-lg py-1 pr-2 text-left text-[13px] transition-colors"
                        [style.padding-left.px]="8 + row.depth * 12"
                        [class]="
                          isBranchSelected(branch)
                            ? 'bg-accent/15 font-medium text-white ring-1 ring-accent/30 ring-inset'
                            : branch.current
                              ? 'text-accent hover:bg-white/5'
                              : 'text-mist/60 hover:bg-white/5 hover:text-mist'
                        "
                        [title]="'git.checkoutHint' | transloco"
                        (click)="openBranch(branch.name)"
                        (dblclick)="checkout(branch)"
                        (contextmenu)="openBranchMenu($event, branch)"
                      >
                        <svg
                          viewBox="0 0 16 16"
                          class="h-3.5 w-3.5 shrink-0"
                          [class]="branch.current ? 'text-accent' : 'text-mist/40'"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.4"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <circle cx="4" cy="3.5" r="1.5" />
                          <circle cx="4" cy="12.5" r="1.5" />
                          <circle cx="12" cy="5" r="1.5" />
                          <path d="M4 5v6" />
                          <path d="M4 8C4 5.5 7 5 10.5 5" />
                        </svg>
                        <span class="min-w-0 flex-1 truncate">{{ row.name }}</span>
                        @if (branch.upstream) {
                          <span class="shrink-0 text-[10px] text-mist/30">{{
                            branch.upstream
                          }}</span>
                        }
                      </button>
                    }
                  }
                } @empty {
                  <p class="px-3 py-2 text-xs text-mist/40">{{ 'git.noBranches' | transloco }}</p>
                }
              </div>
            }
          </section>

          @if (remoteBranches().length > 0) {
            <section class="border-t border-white/5 pt-1">
              <button
                type="button"
                class="flex w-full items-center gap-1.5 px-2 py-1 text-xs font-semibold uppercase tracking-widest text-mist/40 transition-colors hover:text-mist/70"
                (click)="remotesOpen.set(!remotesOpen())"
              >
                <svg
                  viewBox="0 0 16 16"
                  class="h-3 w-3 transition-transform"
                  [class.rotate-90]="remotesOpen()"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M6 3.5 10.5 8 6 12.5" />
                </svg>
                {{ 'git.remotes' | transloco }}
                <span class="ml-auto text-mist/25">{{ filteredRemoteBranches().length }}</span>
              </button>
              @if (remotesOpen()) {
                <div class="mt-0.5 space-y-0.5">
                  @for (row of remoteBranchRows(); track row.path) {
                    @if (row.kind === 'folder') {
                      <button
                        type="button"
                        class="flex w-full items-center gap-1.5 rounded-lg py-1 text-left text-[13px] text-mist/50 transition-colors hover:bg-white/5 hover:text-mist"
                        [style.padding-left.px]="8 + row.depth * 12"
                        (click)="toggleFolder(row.path)"
                      >
                        <svg
                          viewBox="0 0 16 16"
                          class="h-3 w-3 shrink-0 transition-transform"
                          [class.rotate-90]="!isFolderCollapsed(row.path)"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.6"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <path d="M6 3.5 10.5 8 6 12.5" />
                        </svg>
                        <svg
                          viewBox="0 0 16 16"
                          class="h-4 w-4 shrink-0"
                          fill="#6b7280"
                          stroke="#9ca3af"
                          stroke-width="0.8"
                          stroke-linejoin="round"
                        >
                          <path
                            d="M1.75 4.25A1.25 1.25 0 0 1 3 3h3l1.25 1.5H13a1.25 1.25 0 0 1 1.25 1.25v6A1.25 1.25 0 0 1 13 13H3a1.25 1.25 0 0 1-1.25-1.25Z"
                          />
                        </svg>
                        <span class="min-w-0 flex-1 truncate">{{ row.name }}</span>
                      </button>
                    } @else {
                      @if (row.branch; as branch) {
                        <button
                          type="button"
                          class="flex w-full items-center gap-2 rounded-lg py-1 pr-2 text-left text-[13px] transition-colors"
                          [style.padding-left.px]="8 + row.depth * 12"
                          [class]="
                            isBranchSelected(branch)
                              ? 'bg-accent/15 text-white ring-1 ring-accent/30 ring-inset'
                              : 'text-mist/50 hover:bg-white/5 hover:text-mist'
                          "
                          [title]="'git.checkoutHint' | transloco"
                          (click)="openBranch(branch.name)"
                          (dblclick)="checkout(branch)"
                          (contextmenu)="openBranchMenu($event, branch)"
                        >
                          <svg
                            viewBox="0 0 16 16"
                            class="h-3.5 w-3.5 shrink-0 text-mist/30"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.4"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          >
                            <circle cx="4" cy="3.5" r="1.5" />
                            <circle cx="4" cy="12.5" r="1.5" />
                            <circle cx="12" cy="5" r="1.5" />
                            <path d="M4 5v6" />
                            <path d="M4 8C4 5.5 7 5 10.5 5" />
                          </svg>
                          <span class="min-w-0 flex-1 truncate">{{ row.name }}</span>
                        </button>
                      }
                    }
                  }
                </div>
              }
            </section>
          }

          @if (tags().length > 0) {
            <section class="border-t border-white/5 pt-1">
              <button
                type="button"
                class="flex w-full items-center gap-1.5 px-2 py-1 text-xs font-semibold uppercase tracking-widest text-mist/40 transition-colors hover:text-mist/70"
                (click)="tagsOpen.set(!tagsOpen())"
              >
                <svg
                  viewBox="0 0 16 16"
                  class="h-3 w-3 transition-transform"
                  [class.rotate-90]="tagsOpen()"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M6 3.5 10.5 8 6 12.5" />
                </svg>
                {{ 'git.tags' | transloco }}
                <span class="ml-auto text-mist/25">{{ tags().length }}</span>
              </button>
              @if (tagsOpen()) {
                <div class="mt-0.5 space-y-0.5">
                  @for (tag of tags(); track tag.name) {
                    <div class="group flex w-full items-center gap-1 rounded-lg pr-1 hover:bg-white/5">
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-[13px] text-mist/50 transition-colors hover:text-mist"
                        (click)="openTag(tag)"
                      >
                        <svg
                          viewBox="0 0 16 16"
                          class="h-3.5 w-3.5 shrink-0 text-mist/30"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.4"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <path d="M2.5 7.5v-5h5l6 6-5 5z" />
                          <circle cx="5" cy="5" r="1" />
                        </svg>
                        <span class="min-w-0 flex-1 truncate">{{ tag.name }}</span>
                        <span class="shrink-0 font-mono text-[10px] text-mist/25">{{
                          tag.hash.slice(0, 7)
                        }}</span>
                      </button>
                      <button
                        type="button"
                        class="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-mist/40 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/10 hover:text-accent"
                        [title]="'git.tagPush' | transloco"
                        (click)="pushTag(tag)"
                      >
                        {{ 'git.tagPush' | transloco }}
                      </button>
                      <button
                        type="button"
                        class="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-mist/40 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/10 hover:text-rose-400"
                        [title]="'git.menu.delete' | transloco"
                        (click)="deleteTag(tag)"
                      >
                        {{ 'git.menu.delete' | transloco }}
                      </button>
                    </div>
                  }
                </div>
              }
            </section>
          }

          <section class="border-t border-white/5 pt-1">
            <div class="flex items-center gap-1 px-2 py-1">
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-mist/40 transition-colors hover:text-mist/70"
                (click)="stashesOpen.set(!stashesOpen())"
              >
                <svg
                  viewBox="0 0 16 16"
                  class="h-3 w-3 transition-transform"
                  [class.rotate-90]="stashesOpen()"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M6 3.5 10.5 8 6 12.5" />
                </svg>
                {{ 'git.stashes' | transloco }}
                <span class="ml-auto text-mist/25">{{ stashes().length }}</span>
              </button>
              <button
                type="button"
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-mist/40 transition-colors hover:bg-white/10 hover:text-accent"
                [title]="'git.stashCreate' | transloco"
                (click)="createStash()"
              >
                <svg
                  viewBox="0 0 16 16"
                  class="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M8 3.5v9M3.5 8h9" />
                </svg>
              </button>
            </div>
            @if (stashesOpen()) {
              <div class="mt-0.5 space-y-0.5">
                @for (stash of stashes(); track stash.hash) {
                  <div
                    class="group flex w-full items-center gap-1 rounded-lg px-2 py-1 text-[13px] text-mist/50"
                    [title]="stash.name"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      class="h-3.5 w-3.5 shrink-0 text-mist/30"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <rect x="3" y="3" width="10" height="10" rx="1.5" />
                      <path d="M3 6.5h10M3 9.5h10" />
                    </svg>
                    <span class="min-w-0 flex-1 truncate text-xs">{{
                      stash.message || stash.name
                    }}</span>
                    <div
                      class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <button
                        type="button"
                        class="rounded-md px-1.5 py-0.5 text-[10px] text-mist/40 hover:bg-white/10 hover:text-accent"
                        [title]="'git.stashApply' | transloco"
                        (click)="applyStash(stash)"
                      >
                        {{ 'git.stashApply' | transloco }}
                      </button>
                      <button
                        type="button"
                        class="rounded-md px-1.5 py-0.5 text-[10px] text-mist/40 hover:bg-white/10 hover:text-accent"
                        [title]="'git.stashPop' | transloco"
                        (click)="popStash(stash)"
                      >
                        {{ 'git.stashPop' | transloco }}
                      </button>
                      <button
                        type="button"
                        class="rounded-md px-1.5 py-0.5 text-[10px] text-mist/40 hover:bg-white/10 hover:text-rose-400"
                        [title]="'git.menu.delete' | transloco"
                        (click)="dropStash(stash)"
                      >
                        {{ 'git.menu.delete' | transloco }}
                      </button>
                    </div>
                  </div>
                } @empty {
                  <p class="px-2 pb-1 text-xs text-mist/30">{{ 'git.noStashes' | transloco }}</p>
                }
              </div>
            }
          </section>

          @if (submodules().length > 0) {
            <section class="border-t border-white/5 pt-1">
              <button
                type="button"
                class="flex w-full items-center gap-1.5 px-2 py-1 text-xs font-semibold uppercase tracking-widest text-mist/40 transition-colors hover:text-mist/70"
                (click)="submodulesOpen.set(!submodulesOpen())"
              >
                <svg
                  viewBox="0 0 16 16"
                  class="h-3 w-3 transition-transform"
                  [class.rotate-90]="submodulesOpen()"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M6 3.5 10.5 8 6 12.5" />
                </svg>
                {{ 'git.submodules' | transloco }}
                <span class="ml-auto text-mist/25">{{ submodules().length }}</span>
              </button>
              @if (submodulesOpen()) {
                <div class="mt-0.5 space-y-0.5">
                  @for (module of submodules(); track module) {
                    <div
                      class="group flex w-full items-center gap-2 rounded-lg px-2 py-1 text-[13px] text-mist/50"
                    >
                      <svg
                        viewBox="0 0 16 16"
                        class="h-3.5 w-3.5 shrink-0 text-mist/30"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.4"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <rect x="3" y="3" width="10" height="10" rx="1.5" />
                        <path d="M3 8h10" />
                      </svg>
                      <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ module }}</span>
                      <button
                        type="button"
                        class="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-mist/40 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/10 hover:text-accent"
                        [title]="'git.submoduleUpdate' | transloco"
                        (click)="updateSubmodule(module)"
                      >
                        {{ 'git.submoduleUpdate' | transloco }}
                      </button>
                    </div>
                  }
                </div>
              }
            </section>
          }
        </div>
      }
    </div>

    @if (tracking(); as remote) {
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
        (click)="closeTrackDialog()"
      >
        <div
          class="w-[30rem] max-w-full glass-pop rounded-2xl shadow-2xl"
          (click)="$event.stopPropagation()"
        >
          <div class="flex items-start gap-4 p-6">
            <span
              class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-sky-500 text-white"
            >
              <svg
                viewBox="0 0 16 16"
                class="h-6 w-6"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle cx="4" cy="3.5" r="1.6" />
                <circle cx="4" cy="12.5" r="1.6" />
                <circle cx="12" cy="6.5" r="1.6" />
                <path d="M4 5.1v5.8M5.6 6.5h2.9a2 2 0 0 0 2-2v-.4" />
              </svg>
            </span>
            <div class="min-w-0 flex-1">
              <h2 class="text-base font-semibold text-white">
                {{ 'git.trackRemoteTitle' | transloco }}
              </h2>
              <p class="mt-0.5 text-xs text-mist/50">
                {{ 'git.trackRemoteHint' | transloco }}
              </p>

              <div class="mt-4 space-y-3">
                <div class="flex items-center gap-2">
                  <span class="w-28 shrink-0 text-xs font-medium text-mist/70">{{
                    'git.remoteBranch' | transloco
                  }}</span>
                  <span class="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-mist/60">
                    <svg
                      viewBox="0 0 16 16"
                      class="h-3.5 w-3.5 shrink-0 text-mist/30"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M4 2.5v11M4 8.5c0-2 1.5-3.5 3.5-3.5H12" />
                      <path d="M9.5 3 12 5l-2.5 2" />
                    </svg>
                    <span class="truncate font-mono">{{ remote.name }}</span>
                  </span>
                </div>
                <div class="flex items-center gap-2">
                  <label
                    class="w-28 shrink-0 text-xs font-medium text-mist/70"
                    for="git-track-name"
                    >{{ 'git.localBranch' | transloco }}</label
                  >
                  <span
                    class="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-accent/60 bg-white/5 px-2 py-1.5"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      class="h-3.5 w-3.5 shrink-0 text-mist/30"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M4 2.5v11M4 8.5c0-2 1.5-3.5 3.5-3.5H12" />
                      <path d="M9.5 3 12 5l-2.5 2" />
                    </svg>
                    <input
                      id="git-track-name"
                      type="text"
                      autofocus
                      class="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-mist focus:outline-none"
                      [value]="trackName()"
                      (typedValue)="trackName.set($event)"
                      (keydown.enter)="confirmTrack()"
                    />
                  </span>
                </div>
              </div>
              @if (trackError(); as message) {
                <p class="mt-3 text-xs text-rose-400">{{ message }}</p>
              }
            </div>
          </div>
          <footer class="flex items-center justify-end gap-2 border-t border-white/5 px-6 py-4">
            <button
              type="button"
              class="rounded-full px-4 py-2 text-sm text-mist/70 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
              [disabled]="trackBusy()"
              (click)="closeTrackDialog()"
            >
              {{ 'common.cancel' | transloco }}
            </button>
            <button
              type="button"
              class="rounded-full bg-accent px-5 py-2 text-sm font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-50"
              [disabled]="trackBusy() || trackName().trim().length === 0"
              (click)="confirmTrack()"
            >
              {{ 'git.track' | transloco }}
            </button>
          </footer>
        </div>
      </div>
    }

    @if (createOpen()) {
      <app-git-name-dialog
        titleKey="git.createBranch"
        labelKey="git.branchName"
        placeholder="feature/my-branch"
        hintKey="git.createBranchAt"
        [hintParams]="{ branch: currentBranchLabel() }"
        checkoutLabelKey="git.checkoutAfterCreate"
        confirmKey="git.create"
        confirmCheckoutKey="git.createAndCheckout"
        [submit]="createBranch"
        (closed)="createOpen.set(false)"
      />
    }

    @if (branchMenu(); as menu) {
      <app-git-branch-menu
        [branch]="menu.branch"
        [x]="menu.x"
        [y]="menu.y"
        [branches]="refs().branches"
        [currentBranch]="status()?.branch ?? null"
        [remotes]="refs().remotes"
        (closed)="closeBranchMenu()"
      />
    }
  `,
})
export class GitSidebar {
  private readonly workspace = inject(WorkspaceService);
  private readonly git = inject(GitService);
  private readonly transloco = inject(TranslocoService);

  protected readonly project = this.workspace.activeProject;
  private readonly gitState = this.git.scope(() => this.project()?.id ?? null);
  protected readonly status = this.gitState.status;
  protected readonly refs = this.gitState.refs;
  protected readonly filter = signal('');
  protected readonly branchesOpen = signal(true);
  protected readonly remotesOpen = signal(true);
  protected readonly tagsOpen = signal(false);
  protected readonly stashesOpen = signal(false);
  protected readonly submodulesOpen = signal(false);
  private readonly collapsed = signal<ReadonlySet<string>>(new Set());
  protected readonly tracking = signal<GitBranch | null>(null);
  protected readonly trackName = signal('');
  protected readonly trackBusy = signal(false);
  protected readonly trackError = signal<string | null>(null);
  protected readonly createOpen = signal(false);
  protected readonly branchMenu = signal<{ branch: GitBranch; x: number; y: number } | null>(null);

  protected readonly changeCount = computed(() => {
    const status = this.status();
    return status ? status.unstaged.length + status.staged.length : 0;
  });

  /** Shown in the create dialog; the branch itself is created from HEAD. */
  protected readonly currentBranchLabel = computed(() => this.status()?.branch ?? 'HEAD');

  protected readonly changesActive = computed(() => this.view() === 'changes');

  protected readonly commitsActive = computed(
    () => this.view() === 'commits' && this.selectedBranch() === null,
  );

  private readonly view = this.gitState.view;

  private readonly selectedBranch = this.gitState.selectedBranch;

  protected readonly localBranches = computed(() => {
    const query = this.filter().trim().toLowerCase();
    const branches = this.refs().branches.filter((branch) => !branch.remote);
    return query
      ? branches.filter((branch) => branch.name.toLowerCase().includes(query))
      : branches;
  });

  protected readonly remoteBranches = computed(() =>
    this.refs().branches.filter((branch) => branch.remote),
  );

  protected readonly filteredRemoteBranches = computed(() => {
    const query = this.filter().trim().toLowerCase();
    const branches = this.remoteBranches();
    return query
      ? branches.filter((branch) => branch.name.toLowerCase().includes(query))
      : branches;
  });

  protected readonly tags = computed(() => {
    const query = this.filter().trim().toLowerCase();
    const tags = this.refs().tags;
    return query ? tags.filter((tag) => tag.name.toLowerCase().includes(query)) : tags;
  });

  protected readonly stashes = computed(() => this.refs().stashes);
  protected readonly submodules = computed(() => this.refs().submodules);

  protected readonly filterActive = computed(() => this.filter().trim().length > 0);
  protected readonly localBranchRows = computed(() =>
    flattenBranchTree(
      buildBranchTree(this.localBranches()),
      this.filterActive() ? EMPTY_COLLAPSED : this.collapsed(),
    ),
  );
  protected readonly remoteBranchRows = computed(() =>
    flattenBranchTree(
      buildBranchTree(this.filteredRemoteBranches()),
      this.filterActive() ? EMPTY_COLLAPSED : this.collapsed(),
    ),
  );

  protected readonly createBranch = (result: GitNameDialogResult) => {
    const projectId = this.project()?.id;
    return projectId
      ? this.git.branchCreate(projectId, result.name, null, result.checkout)
      : Promise.resolve();
  };

  constructor() {
    effect(() => {
      const project = this.project();
      if (project) {
        void this.git.loadStatus(project.id);
        void this.git.loadRefs(project.id);
      }
    });
  }

  protected isBranchSelected(branch: GitBranch): boolean {
    return this.view() === 'commits' && this.selectedBranch() === branch.name;
  }

  protected isFolderCollapsed(path: string): boolean {
    return this.collapsed().has(path);
  }

  protected toggleFolder(path: string): void {
    this.collapsed.update((state) => {
      const next = new Set(state);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  protected openBranch(name: string): void {
    const projectId = this.project()?.id;
    if (projectId) {
      void this.git.openHistory(projectId, name);
    }
  }

  protected openBranchMenu(event: MouseEvent, branch: GitBranch): void {
    event.preventDefault();
    this.branchMenu.set({ branch, x: event.clientX, y: event.clientY });
  }

  protected closeBranchMenu(): void {
    this.branchMenu.set(null);
  }

  protected openTag(tag: GitTag): void {
    const projectId = this.project()?.id;
    if (projectId) {
      void this.git.openTag(projectId, tag);
    }
  }

  protected showChanges(): void {
    const projectId = this.project()?.id;
    if (projectId) {
      this.git.showChanges(projectId);
    }
  }

  protected showAllCommits(): void {
    const projectId = this.project()?.id;
    if (projectId) {
      void this.git.openHistory(projectId, null);
    }
  }

  protected async checkout(branch: GitBranch): Promise<void> {
    if (branch.current) {
      return;
    }
    if (branch.remote) {
      this.openTrackDialog(branch);
      return;
    }
    try {
      const projectId = this.project()?.id;
      if (!projectId) {
        return;
      }
      await this.git.checkoutBranch(projectId, branch.name);
    } catch (error) {
      console.error(error);
    }
  }

  protected openTrackDialog(branch: GitBranch): void {
    this.trackError.set(null);
    this.trackBusy.set(false);
    this.trackName.set(branch.remoteBranch ?? localNameFor(branch.name));
    this.tracking.set(branch);
  }

  protected closeTrackDialog(): void {
    if (this.trackBusy()) {
      return;
    }
    this.tracking.set(null);
  }

  protected async confirmTrack(): Promise<void> {
    const branch = this.tracking();
    const name = this.trackName().trim();
    if (!branch || name.length === 0 || this.trackBusy()) {
      return;
    }
    this.trackBusy.set(true);
    this.trackError.set(null);
    try {
      const projectId = this.project()?.id;
      if (!projectId) {
        return;
      }
      await this.git.checkoutBranch(projectId, branch.name, true, name);
      this.tracking.set(null);
    } catch (error) {
      this.trackError.set(String(error));
    } finally {
      this.trackBusy.set(false);
    }
  }

  /** The create dialog handles its own escape. */
  protected onEscape(): void {
    this.closeTrackDialog();
  }

  protected openCreateDialog(): void {
    this.createOpen.set(true);
  }

  protected async createStash(): Promise<void> {
    const projectId = this.project()?.id;
    if (!projectId) {
      return;
    }
    try {
      await this.git.stashPush(projectId, null, true);
    } catch (error) {
      console.error(error);
    }
  }

  protected async applyStash(stash: GitStash): Promise<void> {
    const projectId = this.project()?.id;
    if (!projectId) {
      return;
    }
    try {
      await this.git.stashApply(projectId, stash);
    } catch (error) {
      console.error(error);
    }
  }

  protected async popStash(stash: GitStash): Promise<void> {
    const projectId = this.project()?.id;
    if (!projectId) {
      return;
    }
    try {
      await this.git.stashPop(projectId, stash);
    } catch (error) {
      console.error(error);
    }
  }

  protected async dropStash(stash: GitStash): Promise<void> {
    const projectId = this.project()?.id;
    if (!projectId) {
      return;
    }
    const label = stash.message ? `${stash.name}: ${stash.message}` : stash.name;
    const confirmed = await confirmWarning(
      this.transloco.translate('git.stashDropConfirm', { stash: label }),
    );
    if (!confirmed) {
      return;
    }
    try {
      await this.git.stashDrop(projectId, stash);
    } catch (error) {
      console.error(error);
    }
  }

  protected async deleteTag(tag: GitTag): Promise<void> {
    const projectId = this.project()?.id;
    if (!projectId) {
      return;
    }
    const confirmed = await confirmWarning(
      this.transloco.translate('git.tagDeleteConfirm', { tag: tag.name }),
    );
    if (!confirmed) {
      return;
    }
    try {
      await this.git.tagDelete(projectId, tag.name);
    } catch (error) {
      console.error(error);
    }
  }

  protected async pushTag(tag: GitTag): Promise<void> {
    const projectId = this.project()?.id;
    if (!projectId) {
      return;
    }
    const remotes = this.refs().remotes;
    const remote = remotes.includes('origin') ? 'origin' : (remotes[0] ?? 'origin');
    try {
      await this.git.tagPush(projectId, remote, tag.name);
    } catch (error) {
      console.error(error);
    }
  }

  protected async updateSubmodule(module: string): Promise<void> {
    const projectId = this.project()?.id;
    if (!projectId) {
      return;
    }
    try {
      await this.git.submoduleUpdate(projectId, module);
    } catch (error) {
      console.error(error);
    }
  }
}

function localNameFor(remoteName: string): string {
  const segments = remoteName.split('/');
  return segments.length > 1 ? segments.slice(1).join('/') : remoteName;
}
