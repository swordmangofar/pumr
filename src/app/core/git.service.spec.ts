import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { GitService } from './git.service';
import { GitBranch, GitCommit, GitCommitDetail, GitRefs, GitStatus } from './models';

function commit(hash: string): GitCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    author: 'Test',
    timestamp: 0,
    subject: `commit ${hash}`,
    refs: [],
    parents: [],
  };
}

function detail(hash: string): GitCommitDetail {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    author: 'Test',
    authorEmail: 'test@example.com',
    timestamp: 0,
    subject: `commit ${hash}`,
    body: '',
    parents: [],
    refs: [],
    changes: [],
  };
}

function branch(name: string, hash: string): GitBranch {
  return {
    name,
    current: false,
    remote: false,
    upstream: null,
    remoteName: null,
    remoteBranch: null,
    hash,
    subject: null,
    timestamp: null,
  };
}

const status: GitStatus = {
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
};

const refs: GitRefs = { branches: [], tags: [], stashes: [], submodules: [], remotes: [] };

/** A promise the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

function service(): GitService {
  TestBed.configureTestingModule({
    providers: [
      GitService,
      {
        provide: TranslocoService,
        useValue: { translate: (key: string) => key, getActiveLang: () => 'en' },
      },
    ],
  });
  return TestBed.inject(GitService);
}

/** Stubs the loads every successful action triggers afterwards. */
function stubReloads(): void {
  vi.spyOn(api, 'getGitStatus').mockResolvedValue(status);
  vi.spyOn(api, 'getGitInfo').mockResolvedValue({ isRepo: true, branch: 'main', head: 'abc' });
  vi.spyOn(api, 'getGitRefs').mockResolvedValue(refs);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GitService', () => {
  it('keeps commit history isolated per project', async () => {
    const git = service();
    vi.spyOn(api, 'getGitCommits').mockImplementation(async (projectId: string) =>
      projectId === 'p1' ? [commit('a')] : [commit('b'), commit('c')],
    );

    await git.loadCommits('p1', true);
    await git.loadCommits('p2', true);

    expect(git.commitsFor('p1').map((c) => c.hash)).toEqual(['a']);
    expect(git.commitsFor('p2').map((c) => c.hash)).toEqual(['b', 'c']);
  });

  it('clears only the given project view', async () => {
    const git = service();
    vi.spyOn(api, 'getGitCommits').mockResolvedValue([commit('a')]);
    vi.spyOn(api, 'getGitCommit').mockResolvedValue(detail('a'));
    await git.openHistory('p1', null);
    await git.openHistory('p2', null);
    expect(git.viewFor('p1')).toBe('commits');

    git.resetView('p1');
    expect(git.viewFor('p1')).toBe('changes');
    expect(git.commitsFor('p1')).toEqual([]);
    expect(git.viewFor('p2')).toBe('commits');
  });

  it('maps authentication failures to a friendly message', async () => {
    const git = service();
    vi.spyOn(api, 'getGitStatus').mockRejectedValue('fatal: Authentication failed for repo');
    await git.loadStatus('p1');
    expect(git.errorFor('p1')).toBe('git.errors.auth');
  });

  it('does not mistake a local permission error for an authentication failure', async () => {
    const git = service();
    const message = "error: unable to unlink old 'a.txt': Permission denied";
    vi.spyOn(api, 'getGitStatus').mockRejectedValue(message);
    await git.loadStatus('p1');
    expect(git.errorFor('p1')).toBe(message);
  });

  it('shares an in-flight status request between callers', async () => {
    const git = service();
    const pending = deferred<GitStatus>();
    const spy = vi.spyOn(api, 'getGitStatus').mockReturnValue(pending.promise);

    const first = git.loadStatus('p1');
    const second = git.loadStatus('p1');
    pending.resolve(status);
    await Promise.all([first, second]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(git.statusFor('p1')).toEqual(status);
  });

  it('reloads status after a mutation instead of reusing an older request', async () => {
    const git = service();
    const before = deferred<GitStatus>();
    const after: GitStatus = {
      ...status,
      staged: [{ path: 'a', additions: 1, deletions: 0, status: 'A' }],
    };
    vi.spyOn(api, 'getGitStatus').mockReturnValueOnce(before.promise).mockResolvedValueOnce(after);
    vi.spyOn(api, 'gitStage').mockResolvedValue();

    const mount = git.loadStatus('p1');
    await git.stagePath('p1', 'a');
    // The request from before the stage answers last; it must not win.
    before.resolve(status);
    await mount;

    expect(api.getGitStatus).toHaveBeenCalledTimes(2);
    expect(git.statusFor('p1')).toEqual(after);
  });

  it('maps network failures to a friendly message', async () => {
    const git = service();
    vi.spyOn(api, 'gitFetch').mockRejectedValue('fatal: unable to access: Could not resolve host');
    stubReloads();
    await expect(git.runOperation('p1', 'fetch')).rejects.toBeDefined();
    expect(git.errorFor('p1')).toBe('git.errors.network');
  });

  it('reloads the work tree when an operation fails, so a started merge shows up', async () => {
    const git = service();
    vi.spyOn(api, 'gitMerge').mockRejectedValue('CONFLICT (content): Merge conflict in a.txt');
    stubReloads();
    await expect(git.merge('p1', 'feature')).rejects.toBeDefined();
    expect(api.getGitStatus).toHaveBeenCalled();
    expect(git.busyFor('p1')).toBe(false);
  });

  it('selects a tag commit that is not in the loaded page', async () => {
    const git = service();
    vi.spyOn(api, 'getGitCommits').mockResolvedValue([commit('aaa')]);
    vi.spyOn(api, 'getGitCommit').mockResolvedValue(detail('bbb'));
    await git.openTag('p1', { name: 'v1', hash: 'bbb' });
    expect(api.getGitCommit).toHaveBeenCalledWith('p1', 'bbb');
    expect(git.selectedCommitFor('p1')).toBe('bbb');
  });

  it('pages through the history to reveal an older branch tip', async () => {
    const git = service();
    const firstPage = Array.from({ length: 50 }, (_, index) => commit(`new-${index}`));
    vi.spyOn(api, 'getGitRefs').mockResolvedValue({ ...refs, branches: [branch('old', 'tip')] });
    const commits = vi
      .spyOn(api, 'getGitCommits')
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([commit('tip')]);
    vi.spyOn(api, 'getGitCommit').mockResolvedValue(detail('tip'));

    await git.openHistory('p1', 'old');

    expect(commits).toHaveBeenCalledTimes(2);
    expect(git.selectedCommitFor('p1')).toBe('tip');
    expect(git.commitDetailFor('p1')?.hash).toBe('tip');
  });

  it('ignores a commit detail that arrives after a newer selection', async () => {
    const git = service();
    const slow = deferred<GitCommitDetail>();
    vi.spyOn(api, 'getGitCommit')
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(detail('b'));

    const first = git.selectCommit('p1', 'a');
    await git.selectCommit('p1', 'b');
    slow.resolve(detail('a'));
    await first;

    expect(git.selectedCommitFor('p1')).toBe('b');
    expect(git.commitDetailFor('p1')?.hash).toBe('b');
  });

  it('ignores a file diff that arrives after a newer selection', async () => {
    const git = service();
    const slow = deferred<Awaited<ReturnType<typeof api.getGitFileDiff>>>();
    const diff = (path: string) => ({
      path,
      oldContent: '',
      newContent: path,
      language: 'plaintext',
      additions: 1,
      deletions: 0,
      status: 'A',
    });
    vi.spyOn(api, 'getGitFileDiff')
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(diff('b'));

    const first = git.selectChange('p1', 'a', false);
    await git.selectChange('p1', 'b', false);
    slow.resolve(diff('a'));
    await first;

    expect(git.diffFor('p1')?.path).toBe('b');
  });

  it('prefills the previous commit for amend', async () => {
    const git = service();
    vi.spyOn(api, 'getGitCommit').mockResolvedValue(detail('head'));
    const head = await git.headMessage('p1');
    expect(head).toEqual({ subject: 'commit head', body: '' });
  });

  it('stays busy while a commit runs', async () => {
    const git = service();
    const pending = deferred<string>();
    vi.spyOn(api, 'gitCommit').mockReturnValue(pending.promise);
    stubReloads();

    const running = git.commit('p1', 'message', false);
    expect(git.busyFor('p1')).toBe(true);
    pending.resolve('[main abc] message');
    await running;

    expect(git.busyFor('p1')).toBe(false);
    expect(git.messageFor('p1')).toBe('[main abc] message');
    expect(api.getGitRefs).toHaveBeenCalledWith('p1');
  });

  it('reloads status after a pull with the chosen strategy', async () => {
    const git = service();
    vi.spyOn(api, 'gitPull').mockResolvedValue('done');
    stubReloads();
    await git.runOperation('p1', 'pull', 'rebase');
    expect(api.gitPull).toHaveBeenCalledWith('p1', 'rebase');
    expect(api.getGitStatus).toHaveBeenCalledWith('p1');
  });

  it('passes the operation name to abort and continue', async () => {
    const git = service();
    vi.spyOn(api, 'gitOperationAbort').mockResolvedValue('aborted');
    vi.spyOn(api, 'gitOperationContinue').mockResolvedValue('continued');
    stubReloads();
    await git.abortOperation('p1', 'merge');
    await git.continueOperation('p1', 'cherry-pick');
    expect(api.gitOperationAbort).toHaveBeenCalledWith('p1', 'merge');
    expect(api.gitOperationContinue).toHaveBeenCalledWith('p1', 'cherry-pick');
  });

  it('recognizes a delete refused for unmerged work', () => {
    const git = service();
    expect(git.isUnmergedBranchError("error: the branch 'wip' is not fully merged")).toBe(true);
    expect(git.isUnmergedBranchError("error: branch 'wip' not found")).toBe(false);
  });

  it('stages a batch in one call and reloads status once', async () => {
    const git = service();
    const stage = vi.spyOn(api, 'gitStagePaths').mockResolvedValue();
    vi.spyOn(api, 'getGitStatus').mockResolvedValue(status);

    await git.stagePaths('p1', ['a', 'b', 'c']);

    expect(stage).toHaveBeenCalledWith('p1', ['a', 'b', 'c']);
    expect(api.getGitStatus).toHaveBeenCalledTimes(1);
  });

  it('discards a batch in one call and reloads status', async () => {
    const git = service();
    const discard = vi.spyOn(api, 'gitDiscardPaths').mockResolvedValue();
    const loadStatus = vi.spyOn(git, 'loadStatus').mockResolvedValue();

    await git.discardPaths('p1', ['a', 'b', 'c']);

    expect(discard).toHaveBeenCalledWith('p1', ['a', 'b', 'c']);
    expect(loadStatus).toHaveBeenCalledWith('p1', true);
  });

  it('reloads status after a batch discard even when the command fails', async () => {
    const git = service();
    vi.spyOn(api, 'gitDiscardPaths').mockRejectedValue(new Error('boom'));
    const loadStatus = vi.spyOn(git, 'loadStatus').mockResolvedValue();

    await git.discardPaths('p1', ['a', 'b', 'c']);

    expect(loadStatus).toHaveBeenCalledWith('p1', true);
    expect(git.errorFor('p1')).not.toBeNull();
  });
});
