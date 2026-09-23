import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { GitService } from './git.service';
import { GitCommit, GitCommitDetail, GitStatus } from './models';

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

const status: GitStatus = {
  isRepo: true,
  branch: 'main',
  head: 'abc',
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  branches: [],
  tags: [],
  stashes: [],
  submodules: [],
  operation: null,
  conflicted: [],
};

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

  it('shares an in-flight status request between callers', async () => {
    const git = service();
    let resolve!: (value: GitStatus) => void;
    const pending = new Promise<GitStatus>((settle) => (resolve = settle));
    const spy = vi.spyOn(api, 'getGitStatus').mockReturnValue(pending);

    const first = git.loadStatus('p1');
    const second = git.loadStatus('p1');
    resolve(status);
    await Promise.all([first, second]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(git.statusFor('p1')).toEqual(status);
  });

  it('maps network failures to a friendly message', async () => {
    const git = service();
    vi.spyOn(api, 'gitFetch').mockRejectedValue(
      'fatal: unable to access: Could not resolve host',
    );
    await expect(git.runOperation('p1', 'fetch')).rejects.toBeDefined();
    expect(git.errorFor('p1')).toBe('git.errors.network');
  });

  it('selects the peeled tag commit without paging', async () => {
    const git = service();
    vi.spyOn(api, 'getGitCommits').mockResolvedValue([commit('aaa')]);
    vi.spyOn(api, 'getGitCommit').mockResolvedValue(detail('bbb'));
    await git.openTag('p1', { name: 'v1', hash: 'bbb' });
    expect(api.getGitCommit).toHaveBeenCalledWith('p1', 'bbb');
    expect(git.selectedCommitFor('p1')).toBe('bbb');
  });

  it('prefills the previous commit for amend', async () => {
    const git = service();
    vi.spyOn(api, 'getGitCommit').mockResolvedValue(detail('head'));
    const head = await git.headMessage('p1');
    expect(head).toEqual({ subject: 'commit head', body: '' });
  });

  it('reloads status after a pull with the chosen strategy', async () => {
    const git = service();
    vi.spyOn(api, 'gitPull').mockResolvedValue('done');
    vi.spyOn(api, 'getGitStatus').mockResolvedValue(status);
    vi.spyOn(api, 'getGitInfo').mockResolvedValue({ isRepo: true, branch: 'main', head: 'abc' });
    vi.spyOn(api, 'getGitBranches').mockResolvedValue([]);
    vi.spyOn(api, 'getGitRemotes').mockResolvedValue([]);
    await git.runOperation('p1', 'pull', 'rebase');
    expect(api.gitPull).toHaveBeenCalledWith('p1', 'rebase');
  });

  it('passes the operation name to abort', async () => {
    const git = service();
    vi.spyOn(api, 'gitOperationAbort').mockResolvedValue('aborted');
    vi.spyOn(api, 'getGitStatus').mockResolvedValue(status);
    vi.spyOn(api, 'getGitInfo').mockResolvedValue({ isRepo: true, branch: 'main', head: 'abc' });
    vi.spyOn(api, 'getGitBranches').mockResolvedValue([]);
    vi.spyOn(api, 'getGitRemotes').mockResolvedValue([]);
    await git.abortOperation('p1', 'merge');
    expect(api.gitOperationAbort).toHaveBeenCalledWith('p1', 'merge');
  });
});