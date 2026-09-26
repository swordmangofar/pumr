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
import { contextMenuStyle } from '../core/menu-position';
import { GitCommit, GitResetMode } from '../core/models';
import { GitService } from '../core/git.service';
import { WorkspaceService } from '../core/workspace.service';
import { GitNameDialog, GitNameDialogResult } from './git-name-dialog';

/** Rendered menu footprint, used to keep it inside the viewport. */
const MENU_WIDTH_PX = 256;
const MENU_HEIGHT_PX = 380;
/** Subjects are cut to this length in confirmations. */
const SUBJECT_MAX_CHARS = 60;

type PromptKind = 'newBranch' | 'newTag';

/** The right-click menu of a commit in the history. */
@Component({
  selector: 'app-git-commit-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, GitNameDialog],
  host: {
    '(document:keydown.escape)': 'onEscape()',
  },
  template: `
    @if (menuVisible()) {
      <div class="fixed inset-0 z-40" (click)="close()" (contextmenu)="onBackdrop($event)"></div>

      <div
        class="glass-pop fixed z-50 max-h-[80vh] w-64 overflow-y-auto rounded-xl py-1 text-[13px] text-mist shadow-2xl"
        [style]="menuStyle()"
      >
        <button type="button" class="menu-item" (click)="checkout()">
          {{ 'git.commitMenu.checkout' | transloco }}
        </button>
        <button type="button" class="menu-item" (click)="openPrompt('newBranch')">
          {{ 'git.commitMenu.newBranch' | transloco }}
        </button>
        <button type="button" class="menu-item" (click)="openPrompt('newTag')">
          {{ 'git.commitMenu.newTag' | transloco }}
        </button>

        <div class="menu-sep"></div>
        <button type="button" class="menu-item" (click)="cherryPick()">
          {{ 'git.commitMenu.cherryPick' | transloco: { branch: branchLabel() } }}
        </button>
        <button type="button" class="menu-item" (click)="revert()">
          {{ 'git.commitMenu.revert' | transloco }}
        </button>
        <button type="button" class="menu-item" (click)="resetOpen.set(!resetOpen())">
          <span class="flex-1">{{
            'git.commitMenu.reset' | transloco: { branch: branchLabel() }
          }}</span>
          <svg
            viewBox="0 0 16 16"
            class="h-3 w-3 text-mist/40 transition-transform"
            [class.rotate-90]="resetOpen()"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M6 3.5 10.5 8 6 12.5" />
          </svg>
        </button>
        @if (resetOpen()) {
          <div class="ml-3 border-l border-white/10">
            @for (mode of resetModes; track mode) {
              <button
                type="button"
                class="menu-item flex-col !items-start !gap-0"
                [class.text-rose-400]="mode === 'hard'"
                (click)="reset(mode)"
              >
                <span>{{ 'git.commitMenu.resetModes.' + mode | transloco }}</span>
                <span class="text-[11px] text-mist/40">{{
                  'git.commitMenu.resetHints.' + mode | transloco
                }}</span>
              </button>
            }
          </div>
        }

        <div class="menu-sep"></div>
        <button type="button" class="menu-item" (click)="copy(commit().hash)">
          {{ 'git.commitMenu.copySha' | transloco }}
        </button>
        <button type="button" class="menu-item" (click)="copy(commit().subject)">
          {{ 'git.commitMenu.copyMessage' | transloco }}
        </button>
      </div>
    }

    @if (prompt(); as kind) {
      @switch (kind) {
        @case ('newBranch') {
          <app-git-name-dialog
            titleKey="git.commitMenu.newBranch"
            labelKey="git.menu.branchName"
            hintKey="git.commitMenu.startsAt"
            [hintParams]="{ commit: commit().shortHash }"
            checkoutLabelKey="git.menu.checkoutAfterCreate"
            [submit]="createBranch"
            (closed)="close()"
          />
        }
        @case ('newTag') {
          <app-git-name-dialog
            titleKey="git.commitMenu.newTag"
            labelKey="git.menu.tagName"
            placeholder="v1.0.0"
            hintKey="git.commitMenu.startsAt"
            [hintParams]="{ commit: commit().shortHash }"
            messageLabelKey="git.menu.tagMessage"
            [submit]="createTag"
            (closed)="close()"
          />
        }
      }
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
    .menu-sep {
      margin: 0.25rem 0.5rem;
      border-top: 1px solid rgb(255 255 255 / 0.08);
    }
  `,
})
export class GitCommitMenu {
  private readonly workspace = inject(WorkspaceService);
  private readonly git = inject(GitService);
  private readonly transloco = inject(TranslocoService);

  readonly commit = input.required<GitCommit>();
  readonly x = input.required<number>();
  readonly y = input.required<number>();
  /** The checked-out branch; `null` while HEAD is detached. */
  readonly currentBranch = input<string | null>(null);
  readonly closed = output<void>();

  protected readonly resetModes: GitResetMode[] = ['soft', 'mixed', 'hard'];
  protected readonly menuVisible = signal(true);
  protected readonly resetOpen = signal(false);
  protected readonly prompt = signal<PromptKind | null>(null);

  protected readonly menuStyle = computed(() =>
    contextMenuStyle(this.x(), this.y(), MENU_WIDTH_PX, MENU_HEIGHT_PX),
  );

  protected readonly branchLabel = computed(() => this.currentBranch() ?? 'HEAD');

  /** The commit as confirmations name it: short hash and subject. */
  private readonly commitLabel = computed(() => {
    const commit = this.commit();
    const subject =
      commit.subject.length > SUBJECT_MAX_CHARS
        ? `${commit.subject.slice(0, SUBJECT_MAX_CHARS)}…`
        : commit.subject;
    return `${commit.shortHash} “${subject}”`;
  });

  protected readonly createBranch = (result: GitNameDialogResult) =>
    this.inProject((id) =>
      this.git.branchCreate(id, result.name, this.commit().hash, result.checkout),
    );

  protected readonly createTag = (result: GitNameDialogResult) =>
    this.inProject((id) =>
      this.git.tagCreate(id, result.name, this.commit().hash, result.message || null),
    );

  protected close(): void {
    this.prompt.set(null);
    this.closed.emit();
  }

  protected onEscape(): void {
    // The name dialog handles its own escape.
    if (!this.prompt()) {
      this.close();
    }
  }

  protected onBackdrop(event: MouseEvent): void {
    event.preventDefault();
    this.close();
  }

  protected openPrompt(kind: PromptKind): void {
    this.menuVisible.set(false);
    this.prompt.set(kind);
  }

  protected async checkout(): Promise<void> {
    await this.confirmAndRun('git.commitMenu.checkoutConfirm', {}, (id) =>
      this.git.checkoutCommit(id, this.commit().hash),
    );
  }

  protected async cherryPick(): Promise<void> {
    await this.confirmAndRun(
      'git.commitMenu.cherryPickConfirm',
      { branch: this.branchLabel() },
      (id) => this.git.cherryPick(id, this.commit().hash),
    );
  }

  protected async revert(): Promise<void> {
    await this.confirmAndRun('git.commitMenu.revertConfirm', {}, (id) =>
      this.git.revert(id, this.commit().hash),
    );
  }

  protected async reset(mode: GitResetMode): Promise<void> {
    const key = mode === 'hard' ? 'git.commitMenu.resetHardConfirm' : 'git.commitMenu.resetConfirm';
    const params = {
      branch: this.branchLabel(),
      mode: this.transloco.translate(`git.commitMenu.resetModes.${mode}`),
    };
    await this.confirmAndRun(key, params, (id) => this.git.reset(id, this.commit().hash, mode));
  }

  protected async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // The clipboard may be unavailable.
    }
    this.close();
  }

  private async confirmAndRun(
    key: string,
    params: Record<string, unknown>,
    action: (projectId: string) => Promise<unknown>,
  ): Promise<void> {
    this.menuVisible.set(false);
    const confirmed = await confirmWarning(
      this.transloco.translate(key, { ...params, commit: this.commitLabel() }),
    );
    if (confirmed) {
      try {
        await this.inProject(action);
      } catch (error) {
        // The git view's banner shows the error.
        console.error(error);
      }
    }
    this.close();
  }

  private inProject<T>(action: (projectId: string) => Promise<T>): Promise<T | undefined> {
    const projectId = this.workspace.activeProject()?.id;
    return projectId ? action(projectId) : Promise.resolve(undefined);
  }
}
