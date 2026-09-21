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
import { confirm } from '@tauri-apps/plugin-dialog';
import { GitBranch, GitRebaseEntry } from '../core/models';
import { WorkspaceService } from '../core/workspace.service';

type PromptKind = 'newBranch' | 'newTag' | 'rename';

interface PromptState {
  kind: PromptKind;
  value: string;
  message: string;
  checkout: boolean;
}

interface RebaseEntry extends GitRebaseEntry {
  subject: string;
}

interface RebaseState {
  onto: string;
  entries: RebaseEntry[];
}

const REBASE_ACTIONS = ['pick', 'squash', 'fixup', 'drop'] as const;

@Component({
  selector: 'app-git-branch-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  host: {
    '(document:keydown.escape)': 'close()',
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

        @if (!branch().remote) {
          @if (branch().upstream; as upstream) {
            <div class="menu-sep"></div>
            <button type="button" class="menu-item" (click)="run('fastForward')">
              {{ 'git.menu.fastForward' | transloco: { upstream } }}
            </button>
            <button type="button" class="menu-item" (click)="run('push')">
              {{ 'git.menu.push' | transloco: { remote: remoteName() } }}
            </button>
            <button type="button" class="menu-item" (click)="run('pullRequest')">
              {{ 'git.menu.pullRequest' | transloco: { remote: remoteName() } }}
            </button>
          } @else {
            <div class="menu-sep"></div>
            <button type="button" class="menu-item" (click)="run('push')">
              {{ 'git.menu.push' | transloco: { remote: remoteName() } }}
            </button>
            <button type="button" class="menu-item" (click)="run('pullRequest')">
              {{ 'git.menu.pullRequest' | transloco: { remote: remoteName() } }}
            </button>
          }
        } @else {
          <div class="menu-sep"></div>
          <button type="button" class="menu-item" (click)="run('pullRequest')">
            {{ 'git.menu.pullRequest' | transloco: { remote: remoteName() } }}
          </button>
        }

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
          <span class="text-[11px] text-mist/30">⌘B</span>
        </button>
        <button type="button" class="menu-item" (click)="openPrompt('newTag')">
          <span class="flex-1">{{ 'git.menu.newTag' | transloco }}</span>
          <span class="text-[11px] text-mist/30">⌘G</span>
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
          <span class="text-[11px] text-mist/30">⌘C</span>
        </button>
      </div>
    }

    @if (prompt(); as state) {
      <div
        class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
        (click)="close()"
      >
        <div
          class="w-[28rem] max-w-full glass-pop rounded-2xl shadow-2xl"
          (click)="$event.stopPropagation()"
        >
          <div class="p-6">
            <h2 class="text-base font-semibold text-white">
              {{
                (state.kind === 'newBranch'
                  ? 'git.menu.newBranch'
                  : state.kind === 'newTag'
                    ? 'git.menu.newTag'
                    : 'git.menu.rename'
                ) | transloco
              }}
            </h2>
            <label class="mt-4 block text-xs font-medium text-mist/70" for="git-branch-menu-input">
              {{
                (state.kind === 'newTag' ? 'git.menu.tagName' : 'git.menu.branchName') | transloco
              }}
            </label>
            <input
              id="git-branch-menu-input"
              type="text"
              autofocus
              class="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 font-mono text-[13px] text-mist placeholder:text-mist/30 focus:border-accent/50 focus:outline-none"
              [placeholder]="state.kind === 'newTag' ? 'v1.0.0' : branch().name"
              [value]="state.value"
              (input)="patchPrompt({ value: $any($event.target).value })"
              (keydown.enter)="confirmPrompt()"
            />
            @if (state.kind === 'newTag') {
              <label
                class="mt-3 block text-xs font-medium text-mist/70"
                for="git-branch-menu-message"
              >
                {{ 'git.menu.tagMessage' | transloco }}
              </label>
              <textarea
                id="git-branch-menu-message"
                rows="2"
                class="mt-1 w-full resize-none rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[13px] text-mist placeholder:text-mist/30 focus:border-accent/50 focus:outline-none"
                [value]="state.message"
                (input)="patchPrompt({ message: $any($event.target).value })"
              ></textarea>
            }
            @if (state.kind === 'newBranch') {
              <label class="mt-3 flex cursor-pointer items-center gap-2 text-xs text-mist/70">
                <input
                  type="checkbox"
                  class="accent-[var(--color-accent)]"
                  [checked]="state.checkout"
                  (change)="patchPrompt({ checkout: $any($event.target).checked })"
                />
                {{ 'git.menu.checkoutAfterCreate' | transloco }}
              </label>
            }
          </div>
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
              [disabled]="promptValue(state).trim().length === 0"
              (click)="confirmPrompt()"
            >
              {{ 'git.menu.confirm' | transloco }}
            </button>
          </footer>
        </div>
      </div>
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
            @for (entry of state.entries; track entry.hash; let index = $index) {
              <div class="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5">
                <div class="flex flex-col">
                  <button
                    type="button"
                    class="text-mist/40 hover:text-mist disabled:opacity-20"
                    [disabled]="index === 0"
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
                  (change)="setEntryAction(index, $any($event.target).value)"
                >
                  @for (action of rebaseActions; track action) {
                    <option [value]="action">{{ action }}</option>
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
          </div>
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
              [disabled]="state.entries.length === 0"
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
  private readonly transloco = inject(TranslocoService);

  readonly branch = input.required<GitBranch>();
  readonly x = input.required<number>();
  readonly y = input.required<number>();
  readonly branches = input<GitBranch[]>([]);
  readonly currentBranch = input<string | null>(null);
  readonly remotes = input<string[]>([]);
  readonly closed = output<void>();

  protected readonly rebaseActions = REBASE_ACTIONS;
  protected readonly menuVisible = signal(true);
  protected readonly trackingOpen = signal(false);
  protected readonly prompt = signal<PromptState | null>(null);
  protected readonly rebase = signal<RebaseState | null>(null);

  protected readonly shortName = computed(() => {
    const branch = this.branch();
    return branch.remote ? branch.name.split('/').slice(1).join('/') : branch.name;
  });

  protected readonly defaultRemote = computed(() => {
    const remotes = this.remotes();
    return remotes.includes('origin') ? 'origin' : (remotes[0] ?? 'origin');
  });

  protected readonly remoteName = computed(() => {
    const branch = this.branch();
    if (branch.remote) {
      return branch.name.split('/')[0];
    }
    if (branch.upstream) {
      return branch.upstream.split('/')[0];
    }
    return this.defaultRemote();
  });

  protected readonly remoteBranches = computed(() =>
    this.branches().filter((branch) => branch.remote),
  );

  protected readonly canTargetCurrent = computed(() => {
    const current = this.currentBranch();
    return !!current && current !== this.branch().name;
  });

  protected readonly menuStyle = computed(() => {
    if (typeof window === 'undefined') {
      return { left: `${this.x()}px`, top: `${this.y()}px` };
    }
    const width = 256;
    const height = 420;
    const left = Math.max(8, Math.min(this.x(), window.innerWidth - width - 8));
    const flipY = this.y() > window.innerHeight - height;
    return {
      left: `${left}px`,
      top: flipY ? 'auto' : `${this.y()}px`,
      bottom: flipY ? `${Math.max(8, window.innerHeight - this.y())}px` : 'auto',
    };
  });

  protected close(): void {
    this.prompt.set(null);
    this.rebase.set(null);
    this.closed.emit();
  }

  protected onBackdrop(event: MouseEvent): void {
    event.preventDefault();
    this.close();
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (!(event.metaKey || event.ctrlKey) || !this.menuVisible()) {
      return;
    }
    if (event.key === 'c') {
      event.preventDefault();
      void this.copyName();
    } else if (event.key === 'b') {
      event.preventDefault();
      this.openPrompt('newBranch');
    } else if (event.key === 'g') {
      event.preventDefault();
      this.openPrompt('newTag');
    }
  }

  protected run(action: string): void {
    switch (action) {
      case 'checkout':
        void this.runAndClose(() => this.checkout());
        break;
      case 'fastForward':
        void this.runAndClose(() =>
          this.workspace.gitFastForward(this.branch().name, this.branch().upstream ?? ''),
        );
        break;
      case 'push':
        void this.runAndClose(() =>
          this.workspace.gitPushBranch(
            this.branch().name,
            this.remoteName(),
            !this.branch().upstream,
          ),
        );
        break;
      case 'pullRequest':
        void this.runAndClose(() => this.createPullRequest());
        break;
      case 'rebase':
        void this.runAndClose(() => this.workspace.gitRebase(this.branch().name));
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

  private async runAndClose(operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      console.error(error);
    }
    this.close();
  }

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
    try {
      if (branch.remote) {
        const localName = this.shortName();
        const hasLocal =
          localName.length > 0 &&
          this.branches().some((local) => !local.remote && local.name === localName);
        if (hasLocal) {
          await this.workspace.checkoutGitBranch(localName);
        } else {
          await this.workspace.checkoutGitBranch(branch.name, true);
        }
        return;
      }
      await this.workspace.checkoutGitBranch(branch.name);
    } catch (error) {
      console.error(error);
    }
  }

  private async createPullRequest(): Promise<void> {
    try {
      const url = await this.workspace.gitPullRequestUrl(this.remoteName(), this.shortName());
      if (url) {
        await this.workspace.openExternalUrl(url);
      }
    } catch (error) {
      console.error(error);
    }
  }

  private async merge(): Promise<void> {
    const current = this.currentBranch();
    if (!current) {
      this.close();
      return;
    }
    const confirmed = await this.ask(
      this.transloco.translate('git.menu.mergeConfirm', {
        branch: this.branch().name,
        current,
      }),
    );
    if (confirmed) {
      await this.guard(() => this.workspace.gitMerge(this.branch().name));
    }
    this.close();
  }

  private async remove(): Promise<void> {
    const branch = this.branch();
    const message = this.transloco.translate(
      branch.remote ? 'git.menu.deleteRemoteConfirm' : 'git.menu.deleteConfirm',
      { branch: branch.name },
    );
    const confirmed = await this.ask(message);
    if (confirmed) {
      await this.guard(() => this.workspace.gitBranchDelete(branch.name, branch.remote));
    }
    this.close();
  }

  protected async setUpstream(upstream: string): Promise<void> {
    this.trackingOpen.set(false);
    await this.guard(() => this.workspace.gitSetUpstream(this.branch().name, upstream));
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
    const branch = this.branch();
    this.menuVisible.set(false);
    this.prompt.set({
      kind,
      value: kind === 'rename' ? branch.name : '',
      message: '',
      checkout: true,
    });
  }

  protected patchPrompt(patch: Partial<PromptState>): void {
    this.prompt.update((state) => (state ? { ...state, ...patch } : state));
  }

  protected promptValue(state: PromptState): string {
    return state.value;
  }

  protected async confirmPrompt(): Promise<void> {
    const state = this.prompt();
    if (!state) {
      return;
    }
    const value = state.value.trim();
    if (value.length === 0) {
      return;
    }
    if (state.kind === 'rename' && value === this.branch().name) {
      this.close();
      return;
    }
    await this.guard(async () => {
      if (state.kind === 'newBranch') {
        await this.workspace.gitBranchCreate(value, this.branch().name, state.checkout);
      } else if (state.kind === 'newTag') {
        await this.workspace.gitTagCreate(value, this.branch().name, state.message.trim() || null);
      } else {
        await this.workspace.gitBranchRename(this.branch().name, value);
      }
    });
    this.close();
  }

  private async openRebaseInteractive(): Promise<void> {
    const onto = this.branch().name;
    this.menuVisible.set(false);
    const commits = await this.workspace.getGitRebaseCommits(onto);
    this.rebase.set({
      onto,
      entries: commits.map((commit) => ({
        action: 'pick',
        hash: commit.hash,
        subject: commit.subject,
      })),
    });
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

  protected setEntryAction(index: number, action: string): void {
    this.rebase.update((state) => {
      if (!state) {
        return state;
      }
      return {
        ...state,
        entries: state.entries.map((entry, i) => (i === index ? { ...entry, action } : entry)),
      };
    });
  }

  protected async confirmRebase(): Promise<void> {
    const state = this.rebase();
    if (!state) {
      return;
    }
    await this.guard(() =>
      this.workspace.gitRebaseInteractive(
        state.onto,
        state.entries.map((entry) => ({ action: entry.action, hash: entry.hash })),
      ),
    );
    this.close();
  }

  private async ask(message: string): Promise<boolean> {
    try {
      return await confirm(message, { title: 'pumr', kind: 'warning' });
    } catch {
      return false;
    }
  }
}
