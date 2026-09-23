import { Injectable, WritableSignal, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { api } from './api';
import {
  FileDiff,
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitInfo,
  GitPullStrategy,
  GitRebaseEntry,
  GitStatus,
  GitTag,
} from './models';

const GIT_COMMIT_PAGE_SIZE = 50;

type ChangeDiff = { path: string; staged: boolean; diff: FileDiff };

/**
 * Owns all git state and operations for the workspace. Every method takes an
 * explicit `projectId`; all transient view/history state is keyed by project so
 * switching projects cannot show another project's commits or diffs.
 */
@Injectable({ providedIn: 'root' })
export class GitService {
  private readonly infoState = signal<Record<string, GitInfo>>({});
  private readonly statusState = signal<Record<string, GitStatus>>({});
  private readonly branchesState = signal<Record<string, GitBranch[]>>({});
  private readonly remotesState = signal<Record<string, string[]>>({});
  private readonly commitsState = signal<Record<string, GitCommit[]>>({});
  private readonly commitsLoadingState = signal<Record<string, boolean>>({});
  private readonly commitsHasMoreState = signal<Record<string, boolean>>({});
  private readonly commitSearchState = signal<Record<string, string>>({});
  private readonly commitDetailState = signal<Record<string, GitCommitDetail | null>>({});
  private readonly commitFileDiffState = signal<Record<string, FileDiff | null>>({});
  private readonly selectedCommitState = signal<Record<string, string | null>>({});
  private readonly viewState = signal<Record<string, 'changes' | 'commits'>>({});
  private readonly selectedBranchState = signal<Record<string, string | null>>({});
  private readonly diffState = signal<Record<string, ChangeDiff | null>>({});
  private readonly busyState = signal<Record<string, boolean>>({});
  private readonly messageState = signal<Record<string, string | null>>({});
  private readonly errorState = signal<Record<string, string | null>>({});
  private readonly commitsRequest = new Map<string, number>();

  readonly infoByProject = this.infoState.asReadonly();
  readonly statusByProject = this.statusState.asReadonly();
  readonly branchesByProject = this.branchesState.asReadonly();
  readonly remotesByProject = this.remotesState.asReadonly();

  constructor(private readonly transloco: TranslocoService) {}

  viewFor(projectId: string): 'changes' | 'commits' {
    return this.viewState()[projectId] ?? 'changes';
  }

  selectedBranchFor(projectId: string): string | null {
    return this.selectedBranchState()[projectId] ?? null;
  }

  commitsFor(projectId: string): GitCommit[] {
    return this.commitsState()[projectId] ?? [];
  }

  commitsLoadingFor(projectId: string): boolean {
    return this.commitsLoadingState()[projectId] ?? false;
  }

  commitsHasMoreFor(projectId: string): boolean {
    return this.commitsHasMoreState()[projectId] ?? false;
  }

  commitSearchFor(projectId: string): string {
    return this.commitSearchState()[projectId] ?? '';
  }

  commitDetailFor(projectId: string): GitCommitDetail | null {
    return this.commitDetailState()[projectId] ?? null;
  }

  commitFileDiffFor(projectId: string): FileDiff | null {
    return this.commitFileDiffState()[projectId] ?? null;
  }

  selectedCommitFor(projectId: string): string | null {
    return this.selectedCommitState()[projectId] ?? null;
  }

  diffFor(projectId: string): ChangeDiff | null {
    return this.diffState()[projectId] ?? null;
  }

  busyFor(projectId: string): boolean {
    return this.busyState()[projectId] ?? false;
  }

  messageFor(projectId: string): string | null {
    return this.messageState()[projectId] ?? null;
  }

  errorFor(projectId: string): string | null {
    return this.errorState()[projectId] ?? null;
  }

  statusFor(projectId: string): GitStatus | null {
    return this.statusState()[projectId] ?? null;
  }

  /** Clears the transient git view for one project. */
  resetView(projectId: string): void {
    this.set(this.viewState, projectId, 'changes');
    this.set(this.diffState, projectId, null);
    this.set(this.selectedBranchState, projectId, null);
    this.set(this.selectedCommitState, projectId, null);
    this.set(this.commitDetailState, projectId, null);
    this.set(this.commitFileDiffState, projectId, null);
    this.set(this.commitsState, projectId, []);
    this.set(this.commitsHasMoreState, projectId, false);
    this.set(this.commitSearchState, projectId, '');
    this.set(this.errorState, projectId, null);
  }

  async loadInfo(projectId: string): Promise<void> {
    return this.loadInto(this.infoState, projectId, () => api.getGitInfo(projectId));
  }

  async loadStatus(projectId: string): Promise<void> {
    return this.loadInto(this.statusState, projectId, () => api.getGitStatus(projectId));
  }

  async loadBranches(projectId: string): Promise<void> {
    return this.loadInto(this.branchesState, projectId, () => api.getGitBranches(projectId));
  }

  async loadRemotes(projectId: string): Promise<void> {
    return this.loadInto(this.remotesState, projectId, () => api.getGitRemotes(projectId));
  }

  async refresh(projectId: string): Promise<void> {
    await Promise.all([
      this.loadStatus(projectId),
      this.loadInfo(projectId),
      this.loadBranches(projectId),
      this.loadRemotes(projectId),
    ]);
  }

  async loadCommits(projectId: string, reset = true): Promise<void> {
    const request = this.nextRequest(projectId);
    this.set(this.commitsLoadingState, projectId, true);
    try {
      const query = this.commitSearchFor(projectId).trim() || null;
      const skip = reset ? 0 : this.commitsFor(projectId).length;
      const commits = await api.getGitCommits(projectId, query, skip, GIT_COMMIT_PAGE_SIZE);
      if (request !== this.commitsRequest.get(projectId)) {
        return;
      }
      this.errorState.update((state) => ({ ...state, [projectId]: null }));
      this.set(
        this.commitsState,
        projectId,
        reset ? commits : [...this.commitsFor(projectId), ...commits],
      );
      this.set(this.commitsHasMoreState, projectId, commits.length === GIT_COMMIT_PAGE_SIZE);
    } catch (error) {
      if (request === this.commitsRequest.get(projectId)) {
        if (reset) {
          this.set(this.commitsState, projectId, []);
        }
        this.set(this.commitsHasMoreState, projectId, false);
        this.setError(projectId, error);
      }
    } finally {
      if (request === this.commitsRequest.get(projectId)) {
        this.set(this.commitsLoadingState, projectId, false);
      }
    }
  }

  async loadMoreCommits(projectId: string): Promise<void> {
    if (this.commitsLoadingFor(projectId) || !this.commitsHasMoreFor(projectId)) {
      return;
    }
    await this.loadCommits(projectId, false);
  }

  async searchCommits(projectId: string, query: string): Promise<void> {
    this.set(this.commitSearchState, projectId, query);
    this.set(this.selectedCommitState, projectId, null);
    this.set(this.commitDetailState, projectId, null);
    this.set(this.commitFileDiffState, projectId, null);
    await this.loadCommits(projectId, true);
    const first = this.commitsFor(projectId)[0];
    if (first) {
      await this.selectCommit(projectId, first.hash);
    }
  }

  async openHistory(projectId: string, branch: string | null): Promise<void> {
    this.set(this.viewState, projectId, 'commits');
    this.set(this.selectedBranchState, projectId, branch);
    this.set(this.selectedCommitState, projectId, null);
    this.set(this.commitDetailState, projectId, null);
    this.set(this.commitFileDiffState, projectId, null);
    this.set(this.commitsState, projectId, []);
    this.set(this.commitsHasMoreState, projectId, false);
    this.set(this.commitSearchState, projectId, '');
    await this.loadBranches(projectId);
    await this.loadCommits(projectId, true);
    const tip = branch
      ? (this.branchesState()[projectId] ?? []).find((entry) => entry.name === branch)
      : null;
    const target =
      (tip ? this.commitsFor(projectId).find((commit) => commit.hash === tip.hash) : null) ??
      this.commitsFor(projectId)[0];
    if (target) {
      await this.selectCommit(projectId, target.hash);
    }
  }

  /** Tag hashes are peeled to commits by the backend, so no paging is needed. */
  async openTag(projectId: string, tag: GitTag): Promise<void> {
    await this.openHistory(projectId, null);
    const match = this.commitsFor(projectId).find(
      (commit) => commit.hash === tag.hash || commit.hash.startsWith(tag.hash),
    );
    await this.selectCommit(projectId, match?.hash ?? tag.hash);
  }

  async selectCommit(projectId: string, hash: string): Promise<void> {
    this.set(this.selectedCommitState, projectId, hash);
    this.set(this.commitFileDiffState, projectId, null);
    try {
      this.set(this.commitDetailState, projectId, await api.getGitCommit(projectId, hash));
    } catch (error) {
      this.set(this.commitDetailState, projectId, null);
      this.setError(projectId, error);
    }
  }

  async selectCommitFile(projectId: string, path: string): Promise<void> {
    const hash = this.selectedCommitFor(projectId);
    if (!hash) {
      return;
    }
    try {
      this.set(
        this.commitFileDiffState,
        projectId,
        await api.getGitCommitFileDiff(projectId, hash, path),
      );
    } catch (error) {
      this.set(this.commitFileDiffState, projectId, null);
      this.setError(projectId, error);
    }
  }

  showChanges(projectId: string): void {
    this.set(this.viewState, projectId, 'changes');
    this.set(this.selectedBranchState, projectId, null);
    this.set(this.selectedCommitState, projectId, null);
    this.set(this.commitDetailState, projectId, null);
    this.set(this.commitFileDiffState, projectId, null);
    this.set(this.commitsState, projectId, []);
    this.set(this.commitsHasMoreState, projectId, false);
    this.set(this.commitSearchState, projectId, '');
  }

  async selectChange(projectId: string, path: string, staged: boolean): Promise<void> {
    try {
      const diff = await api.getGitFileDiff(projectId, path, staged);
      this.set(this.diffState, projectId, { path, staged, diff });
    } catch (error) {
      this.set(this.diffState, projectId, null);
      this.setError(projectId, error);
    }
  }

  async stagePath(projectId: string, path: string | null): Promise<void> {
    try {
      await api.gitStage(projectId, path);
      await this.afterMutation(projectId, path, true);
    } catch (error) {
      this.setError(projectId, error);
    }
  }

  async unstagePath(projectId: string, path: string | null): Promise<void> {
    try {
      await api.gitUnstage(projectId, path);
      await this.afterMutation(projectId, path, false);
    } catch (error) {
      this.setError(projectId, error);
    }
  }

  async discardPath(projectId: string, path: string): Promise<void> {
    try {
      await api.gitDiscard(projectId, path);
      if (this.diffFor(projectId)?.path === path) {
        this.set(this.diffState, projectId, null);
      }
      await this.loadStatus(projectId);
    } catch (error) {
      this.setError(projectId, error);
    }
  }

  async commit(projectId: string, message: string, amend: boolean): Promise<string> {
    try {
      const output = await api.gitCommit(projectId, message, amend);
      this.set(this.messageState, projectId, output || null);
      this.set(this.diffState, projectId, null);
      await this.loadStatus(projectId);
      return output;
    } catch (error) {
      this.setError(projectId, error);
      throw error;
    }
  }

  /** Loads the current HEAD commit so the amend form can prefill it. */
  async headMessage(
    projectId: string,
  ): Promise<{ subject: string; body: string } | null> {
    try {
      const commit = await api.getGitCommit(projectId, 'HEAD');
      return { subject: commit.subject, body: commit.body };
    } catch {
      return null;
    }
  }

  async checkoutBranch(
    projectId: string,
    branch: string,
    track = false,
    localBranch?: string,
  ): Promise<string> {
    try {
      const output = await api.gitCheckout(projectId, branch, track, localBranch);
      this.set(this.diffState, projectId, null);
      await Promise.all([
        this.loadStatus(projectId),
        this.loadInfo(projectId),
        this.loadBranches(projectId),
      ]);
      if (this.viewFor(projectId) === 'commits') {
        await this.loadCommits(projectId, true);
      }
      return output;
    } catch (error) {
      this.setError(projectId, error);
      throw error;
    }
  }

  async runOperation(
    projectId: string,
    operation: 'fetch' | 'pull' | 'push',
    strategy: GitPullStrategy = 'ff-only',
  ): Promise<string> {
    return this.runAction(projectId, () =>
      operation === 'fetch'
        ? api.gitFetch(projectId)
        : operation === 'pull'
          ? api.gitPull(projectId, strategy)
          : api.gitPush(projectId),
    );
  }

  async fastForward(projectId: string, branch: string, upstream: string): Promise<string> {
    return this.runAction(projectId, () => api.gitFastForward(projectId, branch, upstream));
  }

  async merge(projectId: string, branch: string): Promise<string> {
    return this.runAction(projectId, () => api.gitMerge(projectId, branch));
  }

  async rebase(projectId: string, onto: string): Promise<string> {
    return this.runAction(projectId, () => api.gitRebase(projectId, onto));
  }

  async rebaseInteractive(
    projectId: string,
    onto: string,
    todo: GitRebaseEntry[],
  ): Promise<string> {
    return this.runAction(projectId, () => api.gitRebaseInteractive(projectId, onto, todo));
  }

  async getRebaseCommits(projectId: string, onto: string): Promise<GitCommit[]> {
    try {
      return await api.getGitRebaseCommits(projectId, onto);
    } catch {
      return [];
    }
  }

  async branchCreate(
    projectId: string,
    name: string,
    startPoint: string | null,
    checkout: boolean,
  ): Promise<string> {
    return this.runAction(projectId, () =>
      api.gitBranchCreate(projectId, name, startPoint, checkout),
    );
  }

  async tagCreate(
    projectId: string,
    name: string,
    target: string | null,
    message: string | null,
  ): Promise<string> {
    return this.runAction(projectId, () => api.gitTagCreate(projectId, name, target, message));
  }

  async tagDelete(projectId: string, name: string): Promise<string> {
    return this.runAction(projectId, () => api.gitTagDelete(projectId, name));
  }

  async tagPush(projectId: string, remote: string, name: string): Promise<string> {
    return this.runAction(projectId, () => api.gitTagPush(projectId, remote, name));
  }

  async branchRename(projectId: string, from: string, to: string): Promise<string> {
    return this.runAction(projectId, () => api.gitBranchRename(projectId, from, to));
  }

  async branchDelete(projectId: string, branch: string, remote: boolean): Promise<string> {
    return this.runAction(projectId, () => api.gitBranchDelete(projectId, branch, remote));
  }

  async setUpstream(projectId: string, branch: string, upstream: string): Promise<string> {
    return this.runAction(projectId, () => api.gitSetUpstream(projectId, branch, upstream));
  }

  async pushBranch(
    projectId: string,
    branch: string,
    remote: string,
    setUpstream: boolean,
  ): Promise<string> {
    return this.runAction(projectId, () =>
      api.gitPushBranch(projectId, branch, remote, setUpstream),
    );
  }

  async abortOperation(projectId: string, operation: string): Promise<string> {
    return this.runAction(projectId, () => api.gitOperationAbort(projectId, operation));
  }

  async continueOperation(projectId: string): Promise<string> {
    return this.runAction(projectId, () => api.gitOperationContinue(projectId));
  }

  async stashPush(
    projectId: string,
    message: string | null,
    includeUntracked: boolean,
  ): Promise<string> {
    return this.runAction(projectId, () => api.gitStashPush(projectId, message, includeUntracked));
  }

  async stashApply(projectId: string, stash: string): Promise<string> {
    return this.runAction(projectId, () => api.gitStashApply(projectId, stash));
  }

  async stashPop(projectId: string, stash: string): Promise<string> {
    return this.runAction(projectId, () => api.gitStashPop(projectId, stash));
  }

  async stashDrop(projectId: string, stash: string): Promise<string> {
    return this.runAction(projectId, () => api.gitStashDrop(projectId, stash));
  }

  async init(projectId: string): Promise<string> {
    return this.runAction(projectId, () => api.gitInit(projectId));
  }

  async submoduleUpdate(projectId: string, path: string | null): Promise<string> {
    return this.runAction(projectId, () => api.gitSubmoduleUpdate(projectId, path));
  }

  async pullRequestUrl(projectId: string, remote: string, branch: string): Promise<string> {
    return api.gitPullRequestUrl(projectId, remote, branch);
  }

  async openExternalUrl(url: string): Promise<void> {
    try {
      await api.openExternalUrl(url);
    } catch (error) {
      // No project context here; surface through the console only.
      console.error(error);
    }
  }

  private async runAction(
    projectId: string,
    operation: () => Promise<string>,
  ): Promise<string> {
    this.set(this.busyState, projectId, true);
    this.set(this.messageState, projectId, null);
    this.set(this.errorState, projectId, null);
    try {
      const output = await operation();
      this.set(this.messageState, projectId, output || null);
      await this.reloadState(projectId);
      return output;
    } catch (error) {
      this.setError(projectId, error);
      throw error;
    } finally {
      this.set(this.busyState, projectId, false);
    }
  }

  private async reloadState(projectId: string): Promise<void> {
    await Promise.all([
      this.loadStatus(projectId),
      this.loadInfo(projectId),
      this.loadBranches(projectId),
      this.loadRemotes(projectId),
    ]);
    if (this.viewFor(projectId) === 'commits') {
      await this.loadCommits(projectId, true);
    }
  }

  private async afterMutation(
    projectId: string,
    path: string | null,
    staged: boolean,
  ): Promise<void> {
    await this.loadStatus(projectId);
    const selected = this.diffFor(projectId);
    if (path && selected?.path === path) {
      await this.selectChange(projectId, path, staged);
    }
  }

  private async loadInto<T>(
    state: WritableSignal<Record<string, T>>,
    projectId: string,
    load: () => Promise<T>,
  ): Promise<void> {
    try {
      const value = await load();
      state.update((current) => ({ ...current, [projectId]: value }));
    } catch (error) {
      this.setError(projectId, error);
    }
  }

  private nextRequest(projectId: string): number {
    const next = (this.commitsRequest.get(projectId) ?? 0) + 1;
    this.commitsRequest.set(projectId, next);
    return next;
  }

  private set<T>(state: WritableSignal<Record<string, T>>, projectId: string, value: T): void {
    state.update((current) => ({ ...current, [projectId]: value }));
  }

  private setError(projectId: string, error: unknown): void {
    this.errorState.update((state) => ({ ...state, [projectId]: this.describeError(error) }));
  }

  private describeError(error: unknown): string {
    const text = String(error);
    const lower = text.toLowerCase();
    const auth =
      lower.includes('authentication failed') ||
      lower.includes('could not read username') ||
      lower.includes('could not read password') ||
      lower.includes('permission denied') ||
      lower.includes('terminal prompts disabled') ||
      lower.includes('invalid username or password');
    if (auth) {
      return this.transloco.translate('git.errors.auth');
    }
    if (
      lower.includes('could not resolve host') ||
      lower.includes('unable to access') ||
      lower.includes('network is unreachable') ||
      lower.includes('connection timed out')
    ) {
      return this.transloco.translate('git.errors.network');
    }
    return text;
  }
}