import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { confirmWarning } from '../core/confirm-warning';
import { displayHotkey, isMacPlatform } from '../core/hotkeys';
import { contextMenuStyle } from '../core/menu-position';
import { GIT_REBASE_ACTIONS, GitBranch, GitRebaseEntry } from '../core/models';
import { WorkspaceService } from '../core/workspace.service';
import { GitService } from '../core/git.service';
import { GitNameDialog, GitNameDialogResult } from './git-name-dialog';
import { TypedInput } from './typed-input';

/** Rendered menu footprint, used to keep it inside the viewport. */
const MENU_WIDTH_PX = 256;
const MENU_HEIGHT_PX = 420;

type PromptKind = 'newBranch' | 'newTag' | 'rename';

interface RebaseEntry extends GitRebaseEntry {
  subject: string;
}

interface RebaseState {
  onto: string;
  entries: RebaseEntry[];
  error: string | null;
  loading: boolean;
}

@Component({
  selector: 'app-git-branch-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TypedInput, TranslocoPipe, GitNameDialog],
  host: {
    '(document:keydown.escape)': 'onEscape()',
    '(document:keydown)': 'onKeydown($event)',
  },
  template: `
    @if (menuVisible()) {
      <div class="fixed inset-0 z-40" (click)="close()" (contextmenu)="onBackdrop($event)"></div>

      <div
        class="glass-pop fixed z-50 max-h-[80vh] w-64 overflow-y-auto rounded-xl py-1 text-[13px] text-mist shadow-2xl"
        [style]="menuStyle()"
      >
        <button
          type="button"
          class="menu-item"
          [disabled]="branch().current"
          (click)="run('checkout')"
        >
          {{ 'git.menu.checkout' | transloco }}
        </button>

        <div class="menu-sep"></div>
        @if (!branch().remote) {
          @if (branch().upstream; as upstream) {
            <button type="button" class="menu-item" (click)="run('fastForward')">
              {{ 'git.menu.fastForward' | transloco: { upstream } }}
            </button>
          }
          <button type="button" class="menu-item" (click)="run('push')">
            {{ 'git.menu.push' | transloco: { remote: remoteName() } }}
          </button>
        }
        <button type="button" class="menu-item" (click)="run('pullRequest')">
          {{ 'git.menu.pullRequest' | transloco: { remote: remoteName() } }}
        </button>

        @if (canTargetCurrent()) {
          <div class="menu-sep"></div>
          <button type="button" class="menu-item" (click)="run('merge')">
            {{ 'git.menu.merge' | transloco: { branch: currentBranch() } }}
          </button>
          <button type="button" class="menu-item" (click)="run('rebase')">
            {{ 'git.menu.rebase' | transloco: { branch: branch().name } }}
          </button>
          <button type="button" class="menu-item" (click)="run('rebaseInteractive')">
            {{ 'git.menu.rebaseInteractive' | transloco: { branch: branch().name } }}
          </button>
        }

        <div class="menu-sep"></div>
        <button type="button" class="menu-item" (click)="openPrompt('newBranch')">
          <span class="flex-1">{{ 'git.menu.newBranch' | transloco }}</span>
          <span class="text-[11px] text-mist/30">{{ shortcuts.newBranch }}</span>
        </button>
        <button type="button" class="menu-item" (click)="openPrompt('newTag')">
          <span class="flex-1">{{ 'git.menu.newTag' | transloco }}</span>
          <span class="text-[11px] text-mist/30">{{ shortcuts.newTag }}</span>
        </button>

        @if (!branch().remote) {
          <div class="menu-sep"></div>
          <button type="button" class="menu-item" (click)="trackingOpen.set(!trackingOpen())">
            <span class="flex-1">{{ 'git.menu.tracking' | transloco }}</span>
            <svg
              viewBox="0 0 16 16"
              class="h-3 w-3 text-mist/40 transition-transform"
              [class.rotate-90]="trackingOpen()"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M6 3.5 10.5 8 6 12.5" />
            </svg>
          </button>
          @if (trackingOpen()) {
            <div class="ml-3 border-l border-white/10">
              @for (remote of remoteBranches(); track remote.name) {
                <button type="button" class="menu-item" (click)="setUpstream(remote.name)">
                  {{ remote.name }}
                </button>
              } @empty {
                <p class="px-3 py-2 text-xs text-mist/40">
                  {{ 'git.menu.noRemoteBranches' | transloco }}
                </p>
              }
            </div>
          }
          <button type="button" class="menu-item" (click)="openPrompt('rename')">
            {{ 'git.menu.rename' | transloco }}
          </button>
        }

        <button
          type="button"
          class="menu-item text-rose-400"
          [disabled]="branch().current"
          (click)="run('delete')"
        >
          {{ 'git.menu.delete' | transloco }}
        </button>

        <div class="menu-sep"></div>
        <button type="button" class="menu-item" (click)="copyName()">
          <span class="flex-1">{{ 'git.menu.copyName' | transloco }}</span>
          <span class="text-[11px] text-mist/30">{{ shortcuts.copyName }}</span>
        </button>
      </div>
    }

    @if (prompt(); as kind) {
      @switch (kind) {
        @case ('newBranch') {
          <app-git-name-dialog
            titleKey="git.menu.newBranch"
            labelKey="git.menu.branchName"
            [placeholder]="branch().name"
            checkoutLabelKey="git.menu.checkoutAfterCreate"
            [submit]="createBranch"
            (closed)="close()"
          />
        }
        @case ('newTag') {
          <app-git-name-dialog
            titleKey="git.menu.newTag"
            labelKey="git.menu.tagName"
            placeholder="v1.0.0"
            messageLabelKey="git.menu.tagMessage"
            [submit]="createTag"
            (closed)="close()"
          />
        }
        @case ('rename') {
          <app-git-name-dialog
            titleKey="git.menu.rename"
            labelKey="git.menu.branchName"
            [initialValue]="branch().name"
            [submit]="renameBranch"
            (closed)="close()"
          />
        }
      }
    }

    @if (rebase(); as state) {
      <div
        class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
        (click)="close()"
      >
        <div
          class="flex max-h-[80vh] w-[36rem] max-w-full flex-col glass-pop rounded-2xl shadow-2xl"
          (click)="$event.stopPropagation()"
        >
          <div class="border-b border-white/5 p-6 pb-4">
            <h2 class="text-base font-semibold text-white">
              {{ 'git.menu.rebaseInteractive' | transloco: { branch: state.onto } }}
            </h2>
            <p class="mt-0.5 text-xs text-mist/50">{{ 'git.menu.rebaseHint' | transloco }}</p>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-3">
            @if (state.loading) {
              <p class="px-3 py-6 text-center text-sm text-mist/40">
                {{ 'common.loading' | transloco }}
              </p>
            } @else if (state.error; as message) {
              <p class="px-3 py-6 text-center text-sm text-rose-400">{{ message }}</p>
            } @else {
              @for (entry of state.entries; track entry.hash; let index = $index) {
                <div class="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5">
                  <div class="flex flex-col">
                    <button
                      type="button"
                      class="text-mist/40 hover:text-mist disabled:opacity-20"
                      [disabled]="index === 0"
                      [attr.aria-label]="'git.menu.moveUp' | transloco"
                      (click)="moveEntry(index, -1)"
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
                        <path d="M4 10 8 6l4 4" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="text-mist/40 hover:text-mist disabled:opacity-20"
                      [disabled]="index === state.entries.length - 1"
                      [attr.aria-label]="'git.menu.moveDown' | transloco"
                      (click)="moveEntry(index, 1)"
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
                        <path d="M4 6l4 4 4-4" />
                      </svg>
                    </button>
                  </div>
                  <select
                    class="rounded-md border border-white/10 bg-white/5 px-1.5 py-1 text-xs text-mist focus:outline-none"
                    [value]="entry.action"
                    (typedValue)="setEntryAction(index, $event)"
                  >
                    @for (action of rebaseActions; track action) {
                      <option [value]="action">
                        {{ 'git.menu.rebaseActions.' + action | transloco }}
                      </option>
                    }
                  </select>
                  <span class="shrink-0 font-mono text-[11px] text-mist/40">{{
                    entry.hash.slice(0, 7)
                  }}</span>
                  <span class="min-w-0 flex-1 truncate text-xs text-mist/70">{{
                    entry.subject
                  }}</span>
                </div>
              } @empty {
                <p class="px-3 py-6 text-center text-sm text-mist/40">
                  {{ 'git.menu.nothingToRebase' | transloco }}
                </p>
              }
            }
          </div>
          @if (squashesFirst()) {
            <p class="px-6 pb-2 text-xs text-amber-300">
              {{ 'git.menu.rebaseSquashFirst' | transloco }}
            </p>
          }
          <footer class="flex items-center justify-end gap-2 border-t border-white/5 px-6 py-4">
            <button
              type="button"
              class="rounded-full px-4 py-2 text-sm text-mist/70 transition-colors hover:bg-white/5 hover:text-white"
              (click)="close()"
            >
              {{ 'common.cancel' | transloco }}
            </button>
            <button
              type="button"
              class="rounded-full bg-accent px-5 py-2 text-sm font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-50"
              [disabled]="state.entries.length === 0 || squashesFirst() || rebaseBusy()"
              (click)="confirmRebase()"
            >
              {{ 'git.menu.confirm' | transloco }}
            </button>
          </footer>
        </div>
      </div>
    }
  `,
  styles: `
    .menu-item {
      display: flex;
      width: 100%;
      align-items: center;
      gap: 0.5rem;
      padding: 0.375rem 0.75rem;
      text-align: left;
      transition: background-color 120ms ease;
    }
    .menu-item:hover:not(:disabled) {
      background: rgb(255 255 255 / 0.08);
      color: #fff;
    }
    .menu-item:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .menu-sep {
      margin: 0.25rem 0.5rem;
      border-top: 1px solid rgb(255 255 255 / 0.08);
    }
  `,
})
export class GitBranchMenu {
  private readonly workspace = inject(WorkspaceService);
  private readonly git = inject(GitService);
  private readonly transloco = inject(TranslocoService);

  readonly branch = input.required<GitBranch>();
  readonly x = input.required<number>();
  readonly y = input.required<number>();
  readonly branches = input<GitBranch[]>([]);
  /** The checked-out branch; `null` while HEAD is detached. */
  readonly currentBranch = input<string | null>(null);
  readonly remotes = input<string[]>([]);
  readonly closed = output<void>();

  protected readonly rebaseActions = GIT_REBASE_ACTIONS;
  protected readonly shortcuts = shortcutLabels();
  protected readonly menuVisible = signal(true);
  protected readonly trackingOpen = signal(false);
  protected readonly prompt = signal<PromptKind | null>(null);
  protected readonly rebase = signal<RebaseState | null>(null);
  protected readonly rebaseBusy = signal(false);

  private readonly defaultRemote = computed(() => {
    const remotes = this.remotes();
    return remotes.includes('origin') ? 'origin' : (remotes[0] ?? 'origin');
  });

  /** The remote a remote branch lives on, or a local branch's upstream remote. */
  protected readonly remoteName = computed(() => this.branch().remoteName ?? this.defaultRemote());

  protected readonly remoteBranches = computed(() =>
    this.branches().filter((branch) => branch.remote),
  );

  protected readonly canTargetCurrent = computed(() => {
    const current = this.currentBranch();
    return !!current && current !== this.branch().name;
  });

  /** A squash or fixup needs an earlier picked commit to fold into. */
  protected readonly squashesFirst = computed(() => {
    const first = this.rebase()?.entries.find((entry) => entry.action !== 'drop');
    return first?.action === 'squash' || first?.action === 'fixup';
  });

  protected readonly menuStyle = computed(() =>
    contextMenuStyle(this.x(), this.y(), MENU_WIDTH_PX, MENU_HEIGHT_PX),
  );

  protected readonly createBranch = (result: GitNameDialogResult) =>
    this.inProject((id) =>
      this.git.branchCreate(id, result.name, this.branch().name, result.checkout),
    );

  protected readonly createTag = (result: GitNameDialogResult) =>
    this.inProject((id) =>
      this.git.tagCreate(id, result.name, this.branch().name, result.message || null),
    );

  protected readonly renameBranch = async (result: GitNameDialogResult) => {
    if (result.name !== this.branch().name) {
      await this.inProject((id) => this.git.branchRename(id, this.branch().name, result.name));
    }
  };

  protected close(): void {
    this.prompt.set(null);
    this.rebase.set(null);
    this.closed.emit();
  }

  protected onEscape(): void {
    // The name dialog handles its own escape (and ignores it while busy).
    if (!this.prompt()) {
      this.close();
    }
  }

  protected onBackdrop(event: MouseEvent): void {
    event.preventDefault();
    this.close();
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (!(event.metaKey || event.ctrlKey) || !this.menuVisible()) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'c') {
      event.preventDefault();
      void this.copyName();
    } else if (key === 'b') {
      event.preventDefault();
      this.openPrompt('newBranch');
    } else if (key === 'g') {
      event.preventDefault();
      this.openPrompt('newTag');
    }
  }

  protected run(action: string): void {
    const branch = this.branch();
    switch (action) {
      case 'checkout':
        void this.runAndClose(() => this.checkout());
        break;
      case 'fastForward':
        void this.runAndClose(() => this.inProject((id) => this.git.fastForward(id, branch.name)));
        break;
      case 'push':
        void this.runAndClose(() =>
          this.inProject((id) =>
            this.git.pushBranch(id, branch.name, this.remoteName(), !branch.upstream),
          ),
        );
        break;
      case 'pullRequest':
        void this.runAndClose(() => this.createPullRequest());
        break;
      case 'rebase':
        void this.rebaseOnto();
        break;
      case 'merge':
        void this.merge();
        break;
      case 'rebaseInteractive':
        void this.openRebaseInteractive();
        break;
      case 'delete':
        void this.remove();
        break;
    }
  }

  private inProject<T>(action: (projectId: string) => Promise<T>): Promise<T | undefined> {
    const projectId = this.workspace.activeProject()?.id;
    return projectId ? action(projectId) : Promise.resolve(undefined);
  }

  private async runAndClose(operation: () => Promise<unknown>): Promise<void> {
    await this.guard(operation);
    this.close();
  }

  /** Errors are already shown in the git view's banner by the service. */
  private async guard(operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      console.error(error);
    }
  }

  private async checkout(): Promise<void> {
    const branch = this.branch();
    if (branch.current) {
      return;
    }
    if (!branch.remote) {
      await this.inProject((id) => this.git.checkoutBranch(id, branch.name));
      return;
    }
    const localName = branch.remoteBranch ?? branch.name;
    const hasLocal = this.branches().some((local) => !local.remote && local.name === localName);
    await this.inProject((id) =>
      hasLocal
        ? this.git.checkoutBranch(id, localName)
        : this.git.checkoutBranch(id, branch.name, true, localName),
    );
  }

  private async createPullRequest(): Promise<void> {
    const branch = this.branch();
    await this.inProject(async (id) => {
      const url = await this.git.pullRequestUrl(
        id,
        this.remoteName(),
        branch.remoteBranch ?? branch.name,
      );
      await this.git.openExternalUrl(url, id);
    });
  }

  private async merge(): Promise<void> {
    const current = this.currentBranch();
    const branch = this.branch().name;
    if (current && (await this.ask('git.menu.mergeConfirm', { branch, current }))) {
      await this.guard(() => this.inProject((id) => this.git.merge(id, branch)));
    }
    this.close();
  }

  private async rebaseOnto(): Promise<void> {
    const current = this.currentBranch();
    const branch = this.branch().name;
    if (current && (await this.ask('git.menu.rebaseConfirm', { branch, current }))) {
      await this.guard(() => this.inProject((id) => this.git.rebase(id, branch)));
    }
    this.close();
  }

  private async remove(): Promise<void> {
    const branch = this.branch();
    const confirmKey = branch.remote ? 'git.menu.deleteRemoteConfirm' : 'git.menu.deleteConfirm';
    if (!(await this.ask(confirmKey, { branch: branch.name }))) {
      this.close();
      return;
    }
    try {
      await this.inProject((id) => this.git.branchDelete(id, branch.name, branch.remote));
    } catch (error) {
      // Git keeps branches with unmerged commits; only force after asking.
      const unmerged = !branch.remote && this.git.isUnmergedBranchError(error);
      if (unmerged && (await this.ask('git.menu.forceDeleteConfirm', { branch: branch.name }))) {
        await this.guard(() =>
          this.inProject((id) => this.git.branchDelete(id, branch.name, false, true)),
        );
      }
    }
    this.close();
  }

  protected async setUpstream(upstream: string): Promise<void> {
    this.trackingOpen.set(false);
    await this.guard(() =>
      this.inProject((id) => this.git.setUpstream(id, this.branch().name, upstream)),
    );
    this.close();
  }

  protected async copyName(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.branch().name);
    } catch {
      // clipboard may be unavailable
    }
    this.close();
  }

  protected openPrompt(kind: PromptKind): void {
    this.menuVisible.set(false);
    this.prompt.set(kind);
  }

  private async openRebaseInteractive(): Promise<void> {
    const onto = this.branch().name;
    this.menuVisible.set(false);
    this.rebase.set({ onto, entries: [], error: null, loading: true });
    try {
      const commits = await this.inProject((id) => this.git.getRebaseCommits(id, onto));
      this.rebase.update((state) =>
        state
          ? {
              ...state,
              loading: false,
              entries: (commits ?? []).map((commit) => ({
                action: 'pick' as const,
                hash: commit.hash,
                subject: commit.subject,
              })),
            }
          : state,
      );
    } catch (error) {
      this.rebase.update((state) =>
        state ? { ...state, loading: false, error: String(error) } : state,
      );
    }
  }

  protected moveEntry(index: number, delta: number): void {
    this.rebase.update((state) => {
      if (!state) {
        return state;
      }
      const target = index + delta;
      if (target < 0 || target >= state.entries.length) {
        return state;
      }
      const entries = [...state.entries];
      const [entry] = entries.splice(index, 1);
      entries.splice(target, 0, entry);
      return { ...state, entries };
    });
  }

  protected setEntryAction(index: number, value: string): void {
    const action = GIT_REBASE_ACTIONS.find((candidate) => candidate === value);
    if (!action) {
      return;
    }
    this.rebase.update((state) =>
      state
        ? {
            ...state,
            entries: state.entries.map((entry, i) => (i === index ? { ...entry, action } : entry)),
          }
        : state,
    );
  }

  protected async confirmRebase(): Promise<void> {
    const state = this.rebase();
    if (!state || this.rebaseBusy() || this.squashesFirst()) {
      return;
    }
    this.rebaseBusy.set(true);
    try {
      await this.guard(() =>
        this.inProject((id) =>
          this.git.rebaseInteractive(
            id,
            state.onto,
            state.entries.map((entry) => ({ action: entry.action, hash: entry.hash })),
          ),
        ),
      );
    } finally {
      this.rebaseBusy.set(false);
    }
    this.close();
  }

  private ask(key: string, params: Record<string, unknown>): Promise<boolean> {
    return confirmWarning(this.transloco.translate(key, params));
  }
}

/** Shortcut hints in the platform's notation (the handler accepts Cmd or Ctrl). */
function shortcutLabels(): { newBranch: string; newTag: string; copyName: string } {
  const modifier = isMacPlatform() ? 'Cmd' : 'Ctrl';
  return {
    newBranch: displayHotkey(`${modifier}+B`),
    newTag: displayHotkey(`${modifier}+G`),
    copyName: displayHotkey(`${modifier}+C`),
  };
}
