import { Injectable, Signal, WritableSignal, computed, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { api } from './api';
import {
  FileDiff,
  GitBlameLine,
  GitCommit,
  GitCommitDetail,
  GitInfo,
  GitOperation,
  GitPullStrategy,
  GitRebaseEntry,
  GitRefs,
  GitStash,
  GitStatus,
  GitTag,
} from './models';

const GIT_COMMIT_PAGE_SIZE = 50;
/** Pages loaded at most while looking for a branch tip or tag in the history. */
const GIT_REVEAL_MAX_PAGES = 20;

export type GitChangeDiff = { path: string; staged: boolean; diff: FileDiff };
export type GitViewMode = 'changes' | 'commits';

const EMPTY_REFS: GitRefs = { branches: [], tags: [], stashes: [], submodules: [], remotes: [] };

/** The git state of one project, as signals that follow the project. */
export interface GitScope {
  status: Signal<GitStatus | null>;
  refs: Signal<GitRefs>;
  busy: Signal<boolean>;
  message: Signal<string | null>;
  error: Signal<string | null>;
  diff: Signal<GitChangeDiff | null>;
  view: Signal<GitViewMode>;
  selectedBranch: Signal<string | null>;
  commits: Signal<GitCommit[]>;
  commitsLoading: Signal<boolean>;
  commitSearch: Signal<string>;
  commitPath: Signal<string | null>;
  selectedCommit: Signal<string | null>;
  commitDetail: Signal<GitCommitDetail | null>;
  commitFileDiff: Signal<FileDiff | null>;
}

/**
 * Hands out increasing tokens per key so that, of several overlapping
 * requests, only the newest one applies its result.
 */
class RequestTokens {
  private readonly tokens = new Map<string, number>();

  next(key: string): number {
    const token = (this.tokens.get(key) ?? 0) + 1;
    this.tokens.set(key, token);
    return token;
  }

  isLatest(key: string, token: number): boolean {
    return this.tokens.get(key) === token;
  }
}

/**
 * Owns all git state and operations for the workspace. Every method takes an
 * explicit `projectId`; all transient view/history state is keyed by project so
 * switching projects cannot show another project's commits or diffs.
 */
@Injectable({ providedIn: 'root' })
export class GitService {
  private readonly infoState = signal<Record<string, GitInfo>>({});
  private readonly statusState = signal<Record<string, GitStatus>>({});
  private readonly refsState = signal<Record<string, GitRefs>>({});
  private readonly commitsState = signal<Record<string, GitCommit[]>>({});
  private readonly commitsLoadingState = signal<Record<string, boolean>>({});
  private readonly commitsHasMoreState = signal<Record<string, boolean>>({});
  private readonly commitSearchState = signal<Record<string, string>>({});
  private readonly commitPathState = signal<Record<string, string | null>>({});
  private readonly commitDetailState = signal<Record<string, GitCommitDetail | null>>({});
  private readonly commitFileDiffState = signal<Record<string, FileDiff | null>>({});
  private readonly selectedCommitState = signal<Record<string, string | null>>({});
  private readonly viewState = signal<Record<string, GitViewMode>>({});
  private readonly selectedBranchState = signal<Record<string, string | null>>({});
  private readonly diffState = signal<Record<string, GitChangeDiff | null>>({});
  private readonly busyState = signal<Record<string, boolean>>({});
  private readonly messageState = signal<Record<string, string | null>>({});
  private readonly errorState = signal<Record<string, string | null>>({});
  private readonly tokens = new RequestTokens();
  private readonly statusRequests = new Map<string, Promise<void>>();

  readonly infoByProject = this.infoState.asReadonly();

  constructor(private readonly transloco: TranslocoService) {}

  /** Signals for the project `projectId` currently names (none: empty state). */
  scope(projectId: () => string | null): GitScope {
    const of = <T>(read: (id: string) => T, fallback: T): Signal<T> =>
      computed(() => {
        const id = projectId();
        return id ? read(id) : fallback;
      });
    return {
      status: of((id) => this.statusFor(id), null),
      refs: of((id) => this.refsFor(id), EMPTY_REFS),
      busy: of((id) => this.busyFor(id), false),
      message: of((id) => this.messageFor(id), null),
      error: of((id) => this.errorFor(id), null),
      diff: of((id) => this.diffFor(id), null),
      view: of((id) => this.viewFor(id), 'changes'),
      selectedBranch: of((id) => this.selectedBranchFor(id), null),
      commits: of((id) => this.commitsFor(id), []),
      commitsLoading: of((id) => this.commitsLoadingFor(id), false),
      commitSearch: of((id) => this.commitSearchFor(id), ''),
      commitPath: of((id) => this.commitPathFor(id), null),
      selectedCommit: of((id) => this.selectedCommitFor(id), null),
      commitDetail: of((id) => this.commitDetailFor(id), null),
      commitFileDiff: of((id) => this.commitFileDiffFor(id), null),
    };
  }

  viewFor(projectId: string): GitViewMode {
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

  commitPathFor(projectId: string): string | null {
    return this.commitPathState()[projectId] ?? null;
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

  diffFor(projectId: string): GitChangeDiff | null {
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

  refsFor(projectId: string): GitRefs {
    return this.refsState()[projectId] ?? EMPTY_REFS;
  }

  infoFor(projectId: string): GitInfo | null {
    return this.infoState()[projectId] ?? null;
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
    this.set(this.commitPathState, projectId, null);
    this.set(this.messageState, projectId, null);
    this.set(this.errorState, projectId, null);
  }

  async loadInfo(projectId: string): Promise<void> {
    return this.loadLatest('info', this.infoState, projectId, () => api.getGitInfo(projectId));
  }

  /**
   * Loads the working-tree status. A caller that just changed the repository
   * passes `fresh`, so the result reflects that change; others (views that
   * mount together) share a request that is already running. Only the newest
   * request applies its result, so an older one never overwrites it.
   */
  loadStatus(projectId: string, fresh = false): Promise<void> {
    const running = this.statusRequests.get(projectId);
    if (running && !fresh) {
      return running;
    }
    const request = this.loadLatest('status', this.statusState, projectId, () =>
      api.getGitStatus(projectId),
    ).finally(() => {
      if (this.statusRequests.get(projectId) === request) {
        this.statusRequests.delete(projectId);
      }
    });
    this.statusRequests.set(projectId, request);
    return request;
  }

  /** Branches, tags, stashes, submodules and remotes; they change only on ref operations. */
  async loadRefs(projectId: string): Promise<void> {
    return this.loadLatest('refs', this.refsState, projectId, () => api.getGitRefs(projectId));
  }

  async refresh(projectId: string): Promise<void> {
    this.clearError(projectId);
    await Promise.all([
      this.loadStatus(projectId, true),
      this.loadInfo(projectId),
      this.loadRefs(projectId),
    ]);
  }

  async loadCommits(projectId: string, reset = true): Promise<void> {
    const key = `commits:${projectId}`;
    const token = this.tokens.next(key);
    this.set(this.commitsLoadingState, projectId, true);
    try {
      const query = this.commitSearchFor(projectId).trim() || null;
      const path = this.commitPathFor(projectId);
      const skip = reset ? 0 : this.commitsFor(projectId).length;
      const commits = await api.getGitCommits(projectId, query, skip, GIT_COMMIT_PAGE_SIZE, path);
      if (!this.tokens.isLatest(key, token)) {
        return;
      }
      this.set(
        this.commitsState,
        projectId,
        reset ? commits : [...this.commitsFor(projectId), ...commits],
      );
      this.set(this.commitsHasMoreState, projectId, commits.length === GIT_COMMIT_PAGE_SIZE);
    } catch (error) {
      if (this.tokens.isLatest(key, token)) {
        if (reset) {
          this.set(this.commitsState, projectId, []);
        }
        this.set(this.commitsHasMoreState, projectId, false);
        this.setError(projectId, error);
      }
    } finally {
      if (this.tokens.isLatest(key, token)) {
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
    const navigation = this.startNavigation(projectId);
    this.clearError(projectId);
    this.set(this.commitSearchState, projectId, query);
    this.clearCommitSelection(projectId);
    await this.loadCommits(projectId, true);
    const first = this.commitsFor(projectId)[0];
    if (first && navigation()) {
      await this.selectCommit(projectId, first.hash);
    }
  }

  /**
   * Shows the history and selects `reveal` (a commit hash), the tip of
   * `branch`, or else the newest commit. The commit is paged into the list
   * when it is older than the first page.
   */
  async openHistory(
    projectId: string,
    branch: string | null,
    reveal: string | null = null,
  ): Promise<void> {
    const navigation = this.startNavigation(projectId);
    this.clearError(projectId);
    this.set(this.viewState, projectId, 'commits');
    this.set(this.selectedBranchState, projectId, branch);
    this.set(this.commitSearchState, projectId, '');
    this.set(this.commitPathState, projectId, null);
    this.set(this.commitsState, projectId, []);
    this.set(this.commitsHasMoreState, projectId, false);
    this.clearCommitSelection(projectId);
    if (branch && !this.refsState()[projectId]) {
      await this.loadRefs(projectId);
    }
    await this.loadCommits(projectId, true);
    const tip = branch
      ? (this.refsFor(projectId).branches.find((entry) => entry.name === branch)?.hash ?? null)
      : null;
    const target = reveal ?? tip;
    if (target) {
      await this.revealCommit(projectId, target, navigation);
      return;
    }
    const first = this.commitsFor(projectId)[0];
    if (first && navigation()) {
      await this.selectCommit(projectId, first.hash);
    }
  }

  /** Opens the commit history filtered to a single path. */
  async openFileHistory(projectId: string, path: string): Promise<void> {
    const navigation = this.startNavigation(projectId);
    this.clearError(projectId);
    this.set(this.viewState, projectId, 'commits');
    this.set(this.selectedBranchState, projectId, null);
    this.set(this.commitPathState, projectId, path);
    this.set(this.commitsState, projectId, []);
    this.set(this.commitsHasMoreState, projectId, false);
    this.set(this.commitSearchState, projectId, '');
    this.clearCommitSelection(projectId);
    await this.loadCommits(projectId, true);
    const first = this.commitsFor(projectId)[0];
    if (first && navigation()) {
      await this.selectCommit(projectId, first.hash);
    }
  }

  /** Tag hashes are peeled to full commit hashes by the backend. */
  async openTag(projectId: string, tag: GitTag): Promise<void> {
    await this.openHistory(projectId, null, tag.hash);
  }

  async selectCommit(projectId: string, hash: string): Promise<void> {
    const key = `detail:${projectId}`;
    const token = this.tokens.next(key);
    this.tokens.next(`commit-file:${projectId}`);
    this.set(this.selectedCommitState, projectId, hash);
    this.set(this.commitFileDiffState, projectId, null);
    try {
      const detail = await api.getGitCommit(projectId, hash);
      if (this.tokens.isLatest(key, token)) {
        this.set(this.commitDetailState, projectId, detail);
      }
    } catch (error) {
      if (this.tokens.isLatest(key, token)) {
        this.set(this.commitDetailState, projectId, null);
        this.setError(projectId, error);
      }
    }
  }

  async selectCommitFile(projectId: string, path: string): Promise<void> {
    const hash = this.selectedCommitFor(projectId);
    if (!hash) {
      return;
    }
    const key = `commit-file:${projectId}`;
    const token = this.tokens.next(key);
    try {
      const diff = await api.getGitCommitFileDiff(projectId, hash, path);
      if (this.tokens.isLatest(key, token)) {
        this.set(this.commitFileDiffState, projectId, diff);
      }
    } catch (error) {
      if (this.tokens.isLatest(key, token)) {
        this.set(this.commitFileDiffState, projectId, null);
        this.setError(projectId, error);
      }
    }
  }

  showChanges(projectId: string): void {
    this.startNavigation(projectId);
    this.set(this.viewState, projectId, 'changes');
    this.set(this.selectedBranchState, projectId, null);
    this.set(this.commitsState, projectId, []);
    this.set(this.commitsHasMoreState, projectId, false);
    this.set(this.commitSearchState, projectId, '');
    this.set(this.commitPathState, projectId, null);
    this.clearCommitSelection(projectId);
  }

  async selectChange(projectId: string, path: string, staged: boolean): Promise<void> {
    const key = `change:${projectId}`;
    const token = this.tokens.next(key);
    try {
      const diff = await api.getGitFileDiff(projectId, path, staged);
      if (this.tokens.isLatest(key, token)) {
        this.set(this.diffState, projectId, { path, staged, diff });
      }
    } catch (error) {
      if (this.tokens.isLatest(key, token)) {
        this.set(this.diffState, projectId, null);
        this.setError(projectId, error);
      }
    }
  }

  async stagePath(projectId: string, path: string | null): Promise<void> {
    await this.mutatePaths(projectId, path ? [path] : null, true, () =>
      api.gitStage(projectId, path),
    );
  }

  async unstagePath(projectId: string, path: string | null): Promise<void> {
    await this.mutatePaths(projectId, path ? [path] : null, false, () =>
      api.gitUnstage(projectId, path),
    );
  }

  async stagePaths(projectId: string, paths: string[]): Promise<void> {
    if (paths.length > 0) {
      await this.mutatePaths(projectId, paths, true, () => api.gitStagePaths(projectId, paths));
    }
  }

  async unstagePaths(projectId: string, paths: string[]): Promise<void> {
    if (paths.length > 0) {
      await this.mutatePaths(projectId, paths, false, () => api.gitUnstagePaths(projectId, paths));
    }
  }

  /** Discards unstaged changes; single files and selections take the same path. */
  async discardPaths(projectId: string, paths: string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }
    this.clearError(projectId);
    try {
      await api.gitDiscardPaths(projectId, paths);
    } catch (error) {
      this.setError(projectId, error);
    }
    const selected = this.diffFor(projectId);
    if (selected && paths.includes(selected.path)) {
      this.set(this.diffState, projectId, null);
    }
    await this.loadStatus(projectId, true);
  }

  async blame(projectId: string, path: string): Promise<GitBlameLine[]> {
    return api.getGitBlame(projectId, path);
  }

  async ignorePath(projectId: string, path: string): Promise<void> {
    this.clearError(projectId);
    try {
      await api.gitIgnore(projectId, path);
      this.set(this.messageState, projectId, this.transloco.translate('git.ignored', { path }));
    } catch (error) {
      this.setError(projectId, error);
    }
    await this.loadStatus(projectId, true);
  }

  async revealPath(projectId: string, path: string): Promise<void> {
    try {
      await api.revealPath(projectId, path);
    } catch (error) {
      this.setError(projectId, error);
    }
  }

  /** Commits through `runAction`, so the commit buttons stay disabled until it is done. */
  async commit(projectId: string, message: string, amend: boolean): Promise<string> {
    return this.runAction(projectId, async () => {
      const output = await api.gitCommit(projectId, message, amend);
      this.set(this.diffState, projectId, null);
      return output;
    });
  }

  /** Loads the current HEAD commit so the amend form can prefill it. */
  async headMessage(projectId: string): Promise<{ subject: string; body: string } | null> {
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
    return this.runAction(projectId, async () => {
      const output = await api.gitCheckout(projectId, branch, track, localBranch);
      this.set(this.diffState, projectId, null);
      return output;
    });
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

  /** Fast-forwards `branch` to its configured upstream. */
  async fastForward(projectId: string, branch: string): Promise<string> {
    return this.runAction(projectId, () => api.gitFastForward(projectId, branch));
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

  /** The commits an interactive rebase onto `onto` works on; errors reach the caller. */
  async getRebaseCommits(projectId: string, onto: string): Promise<GitCommit[]> {
    return api.getGitRebaseCommits(projectId, onto);
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

  /**
   * Deletes a branch. Without `force`, git refuses to delete a local branch
   * with unmerged commits; see {@link isUnmergedBranchError}.
   */
  async branchDelete(
    projectId: string,
    branch: string,
    remote: boolean,
    force = false,
  ): Promise<string> {
    return this.runAction(projectId, () => api.gitBranchDelete(projectId, branch, remote, force));
  }

  /** Whether a failed delete was refused because the branch has unmerged work. */
  isUnmergedBranchError(error: unknown): boolean {
    return String(error).toLowerCase().includes('not fully merged');
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

  async abortOperation(projectId: string, operation: GitOperation): Promise<string> {
    return this.runAction(projectId, () => api.gitOperationAbort(projectId, operation));
  }

  async continueOperation(projectId: string, operation: GitOperation): Promise<string> {
    return this.runAction(projectId, () => api.gitOperationContinue(projectId, operation));
  }

  async stashPush(
    projectId: string,
    message: string | null,
    includeUntracked: boolean,
  ): Promise<string> {
    return this.runAction(projectId, () => api.gitStashPush(projectId, message, includeUntracked));
  }

  async stashApply(projectId: string, stash: GitStash): Promise<string> {
    return this.runAction(projectId, () => api.gitStashApply(projectId, stash));
  }

  async stashPop(projectId: string, stash: GitStash): Promise<string> {
    return this.runAction(projectId, () => api.gitStashPop(projectId, stash));
  }

  async stashDrop(projectId: string, stash: GitStash): Promise<string> {
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

  async openExternalUrl(url: string, projectId: string | null = null): Promise<void> {
    try {
      await api.openExternalUrl(url);
    } catch (error) {
      if (projectId) {
        this.setError(projectId, error);
      } else {
        console.error(error);
      }
    }
  }

  private async runAction(projectId: string, operation: () => Promise<string>): Promise<string> {
    this.set(this.busyState, projectId, true);
    this.set(this.messageState, projectId, null);
    this.clearError(projectId);
    try {
      const output = await operation();
      this.set(this.messageState, projectId, output || null);
      await this.reloadState(projectId);
      return output;
    } catch (error) {
      this.setError(projectId, error);
      // A failed operation (conflicts, a rejected push) can still have
      // changed the work tree or started a merge or rebase.
      await this.reloadState(projectId);
      throw error;
    } finally {
      this.set(this.busyState, projectId, false);
    }
  }

  private async reloadState(projectId: string): Promise<void> {
    await Promise.all([
      this.loadStatus(projectId, true),
      this.loadInfo(projectId),
      this.loadRefs(projectId),
    ]);
    if (this.viewFor(projectId) === 'commits') {
      await this.loadCommits(projectId, true);
    }
  }

  /**
   * Runs a stage or unstage, then shows fresh status. When the change being
   * viewed was affected, its diff follows it to the other side.
   */
  private async mutatePaths(
    projectId: string,
    paths: string[] | null,
    staged: boolean,
    operation: () => Promise<void>,
  ): Promise<void> {
    this.clearError(projectId);
    try {
      await operation();
    } catch (error) {
      this.setError(projectId, error);
    }
    await this.loadStatus(projectId, true);
    const selected = this.diffFor(projectId);
    if (selected && (paths === null || paths.includes(selected.path))) {
      await this.selectChange(projectId, selected.path, staged);
    }
  }

  /**
   * Starts a history navigation and returns a check that is false once a
   * newer navigation started, so a slow one cannot select its commit late.
   */
  private startNavigation(projectId: string): () => boolean {
    const key = `navigation:${projectId}`;
    const token = this.tokens.next(key);
    return () => this.tokens.isLatest(key, token);
  }

  /** Pages through the history until `hash` is listed, then selects it. */
  private async revealCommit(
    projectId: string,
    hash: string,
    navigation: () => boolean,
  ): Promise<void> {
    const listed = () => this.commitsFor(projectId).some((commit) => commit.hash === hash);
    for (
      let page = 0;
      page < GIT_REVEAL_MAX_PAGES && !listed() && this.commitsHasMoreFor(projectId) && navigation();
      page += 1
    ) {
      await this.loadCommits(projectId, false);
    }
    if (navigation()) {
      await this.selectCommit(projectId, hash);
    }
  }

  private clearCommitSelection(projectId: string): void {
    this.tokens.next(`detail:${projectId}`);
    this.tokens.next(`commit-file:${projectId}`);
    this.set(this.selectedCommitState, projectId, null);
    this.set(this.commitDetailState, projectId, null);
    this.set(this.commitFileDiffState, projectId, null);
  }

  private async loadLatest<T>(
    kind: string,
    state: WritableSignal<Record<string, T>>,
    projectId: string,
    load: () => Promise<T>,
  ): Promise<void> {
    const key = `${kind}:${projectId}`;
    const token = this.tokens.next(key);
    try {
      const value = await load();
      if (this.tokens.isLatest(key, token)) {
        this.set(state, projectId, value);
      }
    } catch (error) {
      if (this.tokens.isLatest(key, token)) {
        this.setError(projectId, error);
      }
    }
  }

  private set<T>(state: WritableSignal<Record<string, T>>, projectId: string, value: T): void {
    state.update((current) => ({ ...current, [projectId]: value }));
  }

  private clearError(projectId: string): void {
    this.set(this.errorState, projectId, null);
  }

  private setError(projectId: string, error: unknown): void {
    this.set(this.errorState, projectId, this.describeError(error));
  }

  /**
   * Maps common failures to a translated hint. The backend runs git with
   * English messages, so matching them here is reliable.
   */
  private describeError(error: unknown): string {
    const text = String(error);
    const lower = text.toLowerCase();
    const auth = [
      'authentication failed',
      'could not read username',
      'could not read password',
      'terminal prompts disabled',
      'invalid username or password',
      'permission denied (publickey',
      'returned error: 401',
      'returned error: 403',
    ].some((pattern) => lower.includes(pattern));
    if (auth) {
      return this.transloco.translate('git.errors.auth');
    }
    const network = [
      'could not resolve host',
      'network is unreachable',
      'connection timed out',
      'connection refused',
      'operation timed out',
    ].some((pattern) => lower.includes(pattern));
    if (network) {
      return this.transloco.translate('git.errors.network');
    }
    return text;
  }
}
