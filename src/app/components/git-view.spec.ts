import { Component, Pipe, PipeTransform, input, output, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../core/api';
import {
  FileChange,
  FileDiff,
  GitCommitDetail,
  GitHunkDiff,
  GitStatus,
  Project,
} from '../core/models';
import { FALLBACK_SETTINGS, SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';
import { DiffView } from './diff-view';
import { GitFileMenu } from './git-file-menu';
import { GitView } from './git-view';
import { HunkDiffView, LineActionRequest } from './hunk-diff-view';

@Pipe({ name: 'transloco', standalone: true })
class StubTranslocoPipe implements PipeTransform {
  transform(value: string): string {
    return value;
  }
}

@Component({ selector: 'app-hunk-diff-view', standalone: true, template: '' })
class StubHunkDiffView {
  readonly diff = input.required<GitHunkDiff>();
  readonly layout = input<'unified' | 'split'>('unified');
  readonly wrap = input(false);
  readonly busy = input(false);
  readonly lineAction = output<LineActionRequest>();
  readonly ask = output<unknown>();
  readonly showWhitespace = output<void>();
}

@Component({ selector: 'app-diff-view', standalone: true, template: '' })
class StubDiffView {
  readonly diff = input<FileDiff | null>(null);
}

@Component({ selector: 'app-git-file-menu', standalone: true, template: '' })
class StubGitFileMenu {
  readonly path = input('');
  readonly paths = input<string[]>([]);
  readonly staged = input(false);
  readonly conflicted = input(false);
  readonly conflictedPaths = input<ReadonlySet<string>>(new Set());
  readonly x = input(0);
  readonly y = input(0);
  readonly closed = output<void>();
}

function project(id: string): Project {
  return {
    id,
    path: `/work/${id}`,
    name: id,
    createdAt: 0,
    lastOpenedAt: 0,
    sessionCount: 0,
    totalCost: 0,
    color: null,
    icon: null,
    iconImage: null,
  };
}

function change(path: string, status = 'M'): FileChange {
  return { path, additions: 1, deletions: 0, status };
}

function status(patch: Partial<GitStatus> = {}): GitStatus {
  return {
    isRepo: true,
    branch: 'main',
    head: 'abc',
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    operation: null,
    conflicted: [],
    ...patch,
  };
}

function hunks(path: string, staged: boolean): GitHunkDiff {
  return {
    path,
    staged,
    status: 'M',
    language: 'plaintext',
    hunks: [],
    additions: 1,
    deletions: 0,
    binary: false,
    tooLarge: false,
    blocked: null,
    fingerprint: `fp-${path}`,
  };
}

function lastCommit(subject: string): GitCommitDetail {
  return {
    hash: 'abc',
    shortHash: 'abc',
    author: 'Test',
    authorEmail: 'test@example.com',
    timestamp: 0,
    subject,
    body: '',
    parents: [],
    refs: [],
    changes: [],
  };
}

/** A merge that stopped: one file came in cleanly, the other is conflicted. */
const MERGING = status({
  staged: [change('feature.txt', 'A'), change('shared.txt', 'U')],
  unstaged: [change('shared.txt', 'U')],
  operation: 'merge',
  conflicted: ['shared.txt'],
});

describe('GitView', () => {
  let fixture: ComponentFixture<GitView>;
  let shown: ReturnType<typeof signal<Project | null>>;
  let statuses: Record<string, GitStatus>;
  /** What the native confirm dialogs asked, and how the next ones are answered. */
  let asked: string[];
  let confirm: () => boolean | Promise<boolean>;

  beforeEach(() => {
    localStorage.clear();
    statuses = { alpha: status(), beta: status() };
    asked = [];
    confirm = () => true;
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {
      invoke: async (command: string, args: { message?: string }) => {
        if (command !== 'plugin:dialog|message') {
          throw new Error(`the spec does not answer ${command}`);
        }
        asked.push(String(args.message));
        return (await confirm()) ? 'Ok' : 'Cancel';
      },
    };
    vi.spyOn(api, 'getGitStatus').mockImplementation(async (id) => statuses[id]);
    vi.spyOn(api, 'getGitRefs').mockResolvedValue({
      branches: [],
      tags: [],
      stashes: [],
      submodules: [],
      remotes: [],
    });
    vi.spyOn(api, 'getGitInfo').mockResolvedValue({ isRepo: true, branch: 'main', head: 'abc' });
    vi.spyOn(api, 'getGitFileHunks').mockImplementation(async (_id, path, staged) =>
      hunks(path, staged),
    );
    vi.spyOn(api, 'getGitCommit').mockImplementation(async (id) =>
      lastCommit(`Last commit of ${id}`),
    );
    vi.spyOn(api, 'gitCommit').mockResolvedValue('');
    vi.spyOn(api, 'gitStage').mockResolvedValue();
    vi.spyOn(api, 'gitStagePaths').mockResolvedValue();
    vi.spyOn(api, 'gitUnstage').mockResolvedValue();
    vi.spyOn(api, 'gitUnstagePaths').mockResolvedValue();
    vi.spyOn(api, 'gitApplyLines').mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  });

  /** Lets the loads that were started finish and shows their result. */
  async function settle(): Promise<void> {
    for (let round = 0; round < 3; round += 1) {
      await new Promise((resolve) => setTimeout(resolve));
      fixture.detectChanges();
      await fixture.whenStable();
    }
  }

  async function create(): Promise<void> {
    shown = signal<Project | null>(project('alpha'));
    TestBed.configureTestingModule({
      providers: [
        {
          provide: WorkspaceService,
          useValue: {
            browseProject: shown,
            gitPullStrategy: signal('ff-only'),
            setGitPullStrategy: vi.fn(),
            askInChat: vi.fn(),
          },
        },
        { provide: SettingsService, useValue: { settings: signal(FALLBACK_SETTINGS) } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key, getActiveLang: () => 'en' },
        },
      ],
    });
    TestBed.overrideComponent(GitView, {
      remove: { imports: [TranslocoPipe, HunkDiffView, DiffView, GitFileMenu] },
      add: { imports: [StubTranslocoPipe, StubHunkDiffView, StubDiffView, StubGitFileMenu] },
    });
    fixture = TestBed.createComponent(GitView);
    await settle();
  }

  async function show(id: string): Promise<void> {
    shown.set(project(id));
    await settle();
  }

  function element(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function button(text: string, within: ParentNode = element()): HTMLButtonElement | null {
    return (
      ([...within.querySelectorAll('button')] as HTMLButtonElement[]).find(
        (candidate) => candidate.textContent?.trim() === text,
      ) ?? null
    );
  }

  function row(path: string, staged: boolean): HTMLElement {
    const found = element().querySelector(`[data-git-file="${staged ? 's' : 'u'}:${path}"]`);
    if (!found) {
      throw new Error(`no ${staged ? 'staged' : 'unstaged'} row for ${path}`);
    }
    return found as HTMLElement;
  }

  /** Clicks the name of a changed file, which selects it and marks its row. */
  async function clickRow(path: string, staged: boolean, init: MouseEventInit = {}): Promise<void> {
    row(path, staged)
      .querySelector('button')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
    await settle();
  }

  async function pressOnList(staged: boolean, key: string): Promise<void> {
    const lists = element().querySelectorAll('[data-git-list]');
    lists[staged ? 1 : 0].dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
    await settle();
  }

  function subject(): HTMLInputElement {
    return element().querySelector('input[type="text"]') as HTMLInputElement;
  }

  function amend(): HTMLInputElement {
    return element().querySelector('input[type="checkbox"]') as HTMLInputElement;
  }

  async function type(value: string): Promise<void> {
    subject().value = value;
    subject().dispatchEvent(new Event('input'));
    await settle();
  }

  async function tickAmend(): Promise<void> {
    amend().click();
    await settle();
  }

  describe('the commit form', () => {
    it('does not take a ticked Amend and its message to another project', async () => {
      await create();
      await tickAmend();
      expect(subject().value).toBe('Last commit of alpha');
      expect(button('git.commit')?.disabled).toBe(false);

      await show('beta');

      expect(amend().checked).toBe(false);
      expect(subject().value).toBe('');
      // Nothing is staged in the other project, so there is nothing to commit.
      expect(button('git.commit')?.disabled).toBe(true);
      button('git.commit')?.click();
      await settle();
      expect(api.gitCommit).not.toHaveBeenCalled();
    });

    it('keeps the message of each project for when it is shown again', async () => {
      await create();
      await type('Fix alpha');

      await show('beta');
      expect(subject().value).toBe('');
      await type('Fix beta');

      await show('alpha');
      expect(subject().value).toBe('Fix alpha');
    });

    it('fills in the last message of the project Amend was ticked in', async () => {
      let answer!: (commit: GitCommitDetail) => void;
      vi.mocked(api.getGitCommit).mockReturnValue(
        new Promise<GitCommitDetail>((resolve) => (answer = resolve)),
      );
      await create();
      await tickAmend();

      // The other project is shown before the last commit was read.
      await show('beta');
      answer(lastCommit('Last commit of alpha'));
      await settle();

      expect(subject().value).toBe('');
      await show('alpha');
      expect(subject().value).toBe('Last commit of alpha');
      expect(amend().checked).toBe(true);
    });

    it('empties the form of the project that was committed in', async () => {
      statuses['alpha'] = status({ staged: [change('a.txt')] });
      await create();
      await type('Fix alpha');

      button('git.commit')?.click();
      await settle();

      expect(api.gitCommit).toHaveBeenCalledWith('alpha', 'Fix alpha', false);
      expect(subject().value).toBe('');
    });

    it('forgets the rows marked in another project', async () => {
      const both = status({ unstaged: [change('README.md'), change('notes.txt')] });
      statuses = { alpha: both, beta: both };
      await create();
      // Both were shown before, so the changes of either are known already.
      await show('beta');
      await show('alpha');
      await clickRow('README.md', false);
      await clickRow('notes.txt', false, { shiftKey: true });
      expect(element().textContent).toContain('git.stageSelected');

      await show('beta');

      expect(element().textContent).not.toContain('git.stageSelected');
      await pressOnList(false, 'Enter');
      expect(api.gitStage).not.toHaveBeenCalled();
      expect(api.gitStagePaths).not.toHaveBeenCalled();
    });
  });

  describe('conflicted files', () => {
    beforeEach(() => {
      statuses['alpha'] = MERGING;
    });

    it('have no Unstage on their row', async () => {
      await create();

      expect(button('git.unstage', row('feature.txt', true))).not.toBeNull();
      expect(button('git.unstage', row('shared.txt', true))).toBeNull();
    });

    it('are left out of Unstage all', async () => {
      await create();

      button('git.unstageAll')?.click();
      await settle();

      expect(api.gitUnstagePaths).toHaveBeenCalledWith('alpha', ['feature.txt']);
      expect(api.gitUnstage).not.toHaveBeenCalled();
    });

    it('leave no Unstage all when nothing else is staged', async () => {
      statuses['alpha'] = { ...MERGING, staged: [change('shared.txt', 'U')] };
      await create();

      expect(button('git.unstageAll')).toBeNull();
    });

    it('are not unstaged by the stage-toggle key', async () => {
      await create();

      await clickRow('shared.txt', true);
      await pressOnList(true, 'Enter');
      expect(api.gitUnstage).not.toHaveBeenCalled();
      expect(api.gitUnstagePaths).not.toHaveBeenCalled();

      // Marked together with another file, only that one is unstaged.
      await clickRow('feature.txt', true, { shiftKey: true });
      await pressOnList(true, 'Enter');
      expect(api.gitUnstage).not.toHaveBeenCalled();
      expect(api.gitUnstagePaths).toHaveBeenCalledWith('alpha', ['feature.txt']);
    });

    it('are named to the file menu, which offers no Unstage for them', async () => {
      await create();

      row('shared.txt', true).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      await settle();

      const menu = fixture.debugElement.query(
        (node) => node.componentInstance instanceof StubGitFileMenu,
      ).componentInstance as StubGitFileMenu;
      expect(menu.conflicted()).toBe(true);
      expect([...menu.conflictedPaths()]).toEqual(['shared.txt']);
    });

    it('are asked about before Stage all resolves one that still has conflict markers', async () => {
      vi.spyOn(api, 'getGitFileDiff').mockResolvedValue({
        path: 'shared.txt',
        oldContent: 'ours\n',
        newContent: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n',
        language: 'plaintext',
        additions: 0,
        deletions: 0,
        status: 'M',
      });
      confirm = () => false;
      await create();

      button('git.stageAll')?.click();
      await settle();
      expect(asked).toEqual(['git.conflict.markersLeftIn']);
      expect(api.gitStage).not.toHaveBeenCalled();

      confirm = () => true;
      button('git.stageAll')?.click();
      await settle();
      expect(api.gitStage).toHaveBeenCalledWith('alpha', null);
    });
  });

  describe('everything staged without a conflict', () => {
    it('is unstaged in one call', async () => {
      statuses['alpha'] = status({ staged: [change('a.txt'), change('b.txt')] });
      await create();

      button('git.unstageAll')?.click();
      await settle();

      expect(api.gitUnstage).toHaveBeenCalledWith('alpha', null);
      expect(api.gitUnstagePaths).not.toHaveBeenCalled();
    });
  });

  describe('discarding lines', () => {
    function diffView(): StubHunkDiffView {
      return fixture.debugElement.query(
        (node) => node.componentInstance instanceof StubHunkDiffView,
      ).componentInstance as StubHunkDiffView;
    }

    it('discards the lines of the diff they were chosen in, whatever is shown by then', async () => {
      statuses['alpha'] = status({ unstaged: [change('a.txt'), change('b.txt')] });
      let answer!: (confirmed: boolean) => void;
      confirm = () => new Promise<boolean>((resolve) => (answer = resolve));
      await create();
      await clickRow('a.txt', false);
      const shownDiff = diffView().diff();

      diffView().lineAction.emit({
        action: 'discard',
        lines: [4, 5],
        path: shownDiff.path,
        staged: shownDiff.staged,
        fingerprint: shownDiff.fingerprint,
      });
      await settle();
      expect(asked).toEqual(['git.diff.discardConfirm']);

      // Another file is shown while the question is still open.
      await clickRow('b.txt', false);
      expect(diffView().diff().path).toBe('b.txt');
      answer(true);
      await settle();

      expect(api.gitApplyLines).toHaveBeenCalledTimes(1);
      expect(api.gitApplyLines).toHaveBeenCalledWith(
        'alpha',
        'a.txt',
        false,
        'discard',
        3,
        'fp-a.txt',
        [4, 5],
      );
    });

    it('discards nothing when the question is declined', async () => {
      statuses['alpha'] = status({ unstaged: [change('a.txt')] });
      confirm = () => false;
      await create();
      await clickRow('a.txt', false);

      diffView().lineAction.emit({
        action: 'discard',
        lines: [4],
        path: 'a.txt',
        staged: false,
        fingerprint: 'fp-a.txt',
      });
      await settle();

      expect(api.gitApplyLines).not.toHaveBeenCalled();
    });
  });
});
