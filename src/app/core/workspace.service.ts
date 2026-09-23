import { Injectable, computed, inject, signal } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { TranslocoService } from '@jsverse/transloco';
import { api } from './api';
import {
  FileChange,
  FileDiff,
  GitInfo,
  GitPullStrategy,
  LiveToolCall,
  Message,
  MessageAttachment,
  PendingPermission,
  PendingQuestion,
  Project,
  ProjectRule,
  QuestionAnswer,
  RevertResult,
  RoutedEvent,
  SendMessageArgs,
  Session,
  SpendSummary,
  UpdateSessionArgs,
} from './models';
import { SettingsService } from './settings.service';
import { SoundService } from './sound.service';
import { ProcessService } from './process.service';
import { MessageQueueService } from './message-queue.service';
import { GitService } from './git.service';
import { WorkspaceEditorService } from './workspace-editor.service';

const TABS_KEY = 'pumr.tabs';
const ACTIVE_KEY = 'pumr.activeTab';
const LEFT_TAB_KEY = 'pumr.leftTab';
const RIGHT_TAB_KEY = 'pumr.rightTab';
const SESSION_VIEW_KEY = 'pumr.sessionView';
const LAYOUT_KEY = 'pumr.layout';
const GIT_PULL_STRATEGY_KEY = 'pumr.gitPullStrategy';
const COMPOSER_DRAFTS_KEY = 'pumr.composerDrafts';
/** Longest handover title derived from the source session title. */
const HANDOVER_TITLE_MAX_CHARS = 60;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

type LeftTab = 'projects' | 'workspace' | 'git';
type RightTab = 'changes' | 'session' | 'prompts' | 'modes';
type SessionView = 'projects' | 'history';
type PanelId = 'left' | 'center' | 'right';

interface PersistedLayout {
  leftPanelOpen?: boolean;
  rightPanelOpen?: boolean;
  leftPanelWidth?: number;
  rightPanelWidth?: number;
}

@Injectable({ providedIn: 'root' })
export class WorkspaceService {
  private readonly settings = inject(SettingsService);
  private readonly sound = inject(SoundService);
  private readonly transloco = inject(TranslocoService);
  private readonly processesService = inject(ProcessService);
  private readonly queueService = inject(MessageQueueService);
  private readonly gitService = inject(GitService);
  private readonly editorService = inject(WorkspaceEditorService);

  private readonly projectsState = signal<Project[]>([]);
  private readonly sessionsState = signal<Record<string, Session>>({});
  private readonly projectSessionsState = signal<Record<string, string[]>>({});
  private readonly tabsState = signal<string[]>([]);
  private readonly activeState = signal<string | null>(null);
  private readonly messagesState = signal<Record<string, Message[]>>({});
  private readonly messageLoadTokens = new Map<string, number>();
  private readonly streamingState = signal<Record<string, boolean>>({});
  private readonly errorsState = signal<Record<string, string | null>>({});
  private readonly composerDraftsState = signal<Record<string, string>>({});
  private readonly composerAttachmentsState = signal<Record<string, MessageAttachment[]>>({});
  private readonly spendState = signal<SpendSummary | null>(null);
  private readonly liveToolsState = signal<Record<string, LiveToolCall[]>>({});
  private readonly changesState = signal<Record<string, FileChange[]>>({});
  private readonly selectedPathState = signal<Record<string, string | null>>({});
  private readonly diffState = signal<FileDiff | null>(null);
  private readonly leftTabState = signal<LeftTab>('projects');
  private readonly rightTabState = signal<RightTab>('changes');
  private readonly sessionViewState = signal<SessionView>('projects');
  private readonly leftPanelOpenState = signal(true);
  private readonly rightPanelOpenState = signal(true);
  private readonly leftPanelWidthState = signal(340);
  private readonly rightPanelWidthState = signal(512);
  private readonly focusedPanelState = signal<PanelId | null>(null);
  private readonly composerFocusState = signal(0);
  private readonly rulesState = signal<ProjectRule[]>([]);
  private readonly permissionState = signal<PendingPermission[]>([]);
  private readonly questionState = signal<PendingQuestion[]>([]);
  private readonly draftState = signal<string | null>(null);
  private readonly handoverState = signal<Record<string, boolean>>({});
  private readonly debugSessionState = signal<string | null>(null);
  private readonly scrollTargetState = signal<{ id: string; nonce: number } | null>(null);
  private readonly subAgentsState = signal<Record<string, string[]>>({});
  private readonly viewingState = signal<Record<string, string>>({});
  private readonly showArchivedState = signal(false);
  private readonly projectEditorState = signal<string | null>(null);
  private scrollNonce = 0;

  // Streamed text tokens arrive many times per second. Rather than rebuilding
  // the message array and re-running every dependent computed on each token, we
  // accumulate deltas and apply them once per animation frame.
  private readonly pendingMessageText = new Map<
    string,
    { sessionId: string; messageId: string; field: 'content' | 'reasoning'; text: string }
  >();
  private readonly pendingToolOutput = new Map<
    string,
    { sessionId: string; callId: string; text: string }
  >();
  private streamFlushScheduled = false;

  readonly projects = this.projectsState.asReadonly();
  readonly spend = this.spendState.asReadonly();
  readonly activeSessionId = this.activeState.asReadonly();
  private readonly activeContextIds = computed(() => {
    const rootId = this.activeState();
    if (!rootId) {
      return new Set<string>();
    }
    const viewing = this.viewingState()[rootId];
    if (viewing && this.sessionsState()[viewing]) {
      return new Set([viewing]);
    }
    const ids = new Set<string>([rootId]);
    for (const agentId of this.subAgentsState()[rootId] ?? []) {
      ids.add(agentId);
    }
    return ids;
  });
  readonly permission = computed<PendingPermission | null>(() => {
    const ids = this.activeContextIds();
    return this.permissionState().find((entry) => ids.has(entry.sessionId)) ?? null;
  });
  readonly question = computed<PendingQuestion | null>(() => {
    const ids = this.activeContextIds();
    return this.questionState().find((entry) => ids.has(entry.sessionId)) ?? null;
  });
  readonly processes = this.processesService.processes;
  readonly rules = this.rulesState.asReadonly();
  readonly activeDiff = this.diffState.asReadonly();
  readonly leftTab = this.leftTabState.asReadonly();
  readonly rightTab = this.rightTabState.asReadonly();
  readonly sessionView = this.sessionViewState.asReadonly();
  readonly leftPanelOpen = this.leftPanelOpenState.asReadonly();
  readonly rightPanelOpen = this.rightPanelOpenState.asReadonly();
  readonly leftPanelWidth = this.leftPanelWidthState.asReadonly();
  readonly rightPanelWidth = this.rightPanelWidthState.asReadonly();
  readonly focusedPanel = this.focusedPanelState.asReadonly();
  readonly composerFocusNonce = this.composerFocusState.asReadonly();
  readonly pendingDraft = this.draftState.asReadonly();
  readonly debugSessionId = this.debugSessionState.asReadonly();
  readonly debugOpen = computed(() => this.debugSessionState() !== null);
  readonly scrollTarget = this.scrollTargetState.asReadonly();
  readonly showArchived = this.showArchivedState.asReadonly();
  readonly projectEditorId = this.projectEditorState.asReadonly();
  readonly tabs = computed(() =>
    this.tabsState()
      .map((id) => this.sessionsState()[id])
      .filter((session): session is Session => !!session),
  );
  readonly activeSession = computed(() => {
    const id = this.activeState();
    return id ? (this.sessionsState()[id] ?? null) : null;
  });
  readonly activeAgentId = computed(() => {
    const rootId = this.activeState();
    if (!rootId) {
      return null;
    }
    const viewing = this.viewingState()[rootId];
    return viewing && this.sessionsState()[viewing] ? viewing : rootId;
  });
  readonly activeAgent = computed(() => {
    const id = this.activeAgentId();
    return id ? (this.sessionsState()[id] ?? null) : null;
  });
  readonly activeSubAgents = computed(() => {
    const rootId = this.activeState();
    return rootId ? this.subAgentsFor(rootId) : [];
  });
  readonly activeProject = computed(() => {
    const session = this.activeSession();
    if (!session) {
      return null;
    }
    return this.projectsState().find((project) => project.id === session.projectId) ?? null;
  });
  readonly activeGitInfo = computed(() => {
    const project = this.activeProject();
    return project ? (this.gitService.infoByProject()[project.id] ?? null) : null;
  });
  readonly gitDiff = computed(() => {
    const project = this.activeProject();
    return project ? this.gitService.diffFor(project.id) : null;
  });
  readonly gitBusy = computed(() => {
    const project = this.activeProject();
    return project ? this.gitService.busyFor(project.id) : false;
  });
  readonly gitMessage = computed(() => {
    const project = this.activeProject();
    return project ? this.gitService.messageFor(project.id) : null;
  });
  readonly gitError = computed(() => {
    const project = this.activeProject();
    return project ? this.gitService.errorFor(project.id) : null;
  });
  readonly gitView = computed(() => {
    const project = this.activeProject();
    return project ? this.gitService.viewFor(project.id) : 'changes';
  });
  readonly selectedGitBranch = computed(() => {
    const project = this.activeProject();
    return project ? this.gitService.selectedBranchFor(project.id) : null;
  });
  readonly gitCommits = computed(() => {
    const project = this.activeProject();
    return project ? this.gitService.commitsFor(project.id) : [];
  });
  readonly gitCommitsLoading = computed(() => {
    const project = this.activeProject();
    return project ? this.gitService.commitsLoadingFor(project.id) : false;
  });
  readonly gitCommitsHasMore = computed(() => {
    const project = this.activeProject();
    return project ? this.gitService.commitsHasMoreFor(project.id) : false;
  });
  readonly gitCommitSearch = computed(() => {
    const project = this.activeProject();
    return project ? this.gitService.commitSearchFor(project.id) : '';
  });
  readonly gitCommitDetail = computed(() => {
    const project = this.activeProject();
    return project ? this.gitService.commitDetailFor(project.id) : null;
  });
  readonly gitCommitFileDiff = computed(() => {
    const project = this.activeProject();
    return project ? this.gitService.commitFileDiffFor(project.id) : null;
  });
  readonly selectedGitCommit = computed(() => {
    const project = this.activeProject();
    return project ? this.gitService.selectedCommitFor(project.id) : null;
  });
  readonly activeGitBranches = computed(() => {
    const project = this.activeProject();
    if (!project) {
      return [];
    }
    return (
      this.gitService.branchesByProject()[project.id] ??
      this.gitService.statusByProject()[project.id]?.branches ??
      []
    );
  });
  readonly activeGitStatus = computed(() => {
    const project = this.activeProject();
    return project ? (this.gitService.statusByProject()[project.id] ?? null) : null;
  });
  readonly activeGitRemotes = computed(() => {
    const project = this.activeProject();
    return project ? (this.gitService.remotesByProject()[project.id] ?? []) : [];
  });
  private readonly gitPullStrategyState = signal<GitPullStrategy>('ff-only');
  readonly gitPullStrategy = this.gitPullStrategyState.asReadonly();

  setGitPullStrategy(strategy: GitPullStrategy): void {
    this.gitPullStrategyState.set(strategy);
    localStorage.setItem(GIT_PULL_STRATEGY_KEY, strategy);
  }

  constructor() {
    const leftTab = localStorage.getItem(LEFT_TAB_KEY);
    if (leftTab === 'projects' || leftTab === 'workspace' || leftTab === 'git') {
      this.leftTabState.set(leftTab);
    }
    const rightTab = localStorage.getItem(RIGHT_TAB_KEY);
    if (
      rightTab === 'changes' ||
      rightTab === 'session' ||
      rightTab === 'prompts' ||
      rightTab === 'modes'
    ) {
      this.rightTabState.set(rightTab);
    }
    const sessionView = localStorage.getItem(SESSION_VIEW_KEY);
    if (sessionView === 'projects' || sessionView === 'history') {
      this.sessionViewState.set(sessionView);
    }
    const pullStrategy = localStorage.getItem(GIT_PULL_STRATEGY_KEY);
    if (pullStrategy === 'ff-only' || pullStrategy === 'merge' || pullStrategy === 'rebase') {
      this.gitPullStrategyState.set(pullStrategy);
    }
    const layout = this.readJson<PersistedLayout>(LAYOUT_KEY, {}, isPlainObject);
    if (typeof layout.leftPanelOpen === 'boolean') {
      this.leftPanelOpenState.set(layout.leftPanelOpen);
    }
    if (typeof layout.rightPanelOpen === 'boolean') {
      this.rightPanelOpenState.set(layout.rightPanelOpen);
    }
    if (typeof layout.leftPanelWidth === 'number' && Number.isFinite(layout.leftPanelWidth)) {
      this.leftPanelWidthState.set(layout.leftPanelWidth);
    }
    if (typeof layout.rightPanelWidth === 'number' && Number.isFinite(layout.rightPanelWidth)) {
      this.rightPanelWidthState.set(layout.rightPanelWidth);
    }
    this.composerDraftsState.set(
      this.readJson<Record<string, string>>(COMPOSER_DRAFTS_KEY, {}, isStringRecord),
    );
  }

  async init(): Promise<void> {
    await this.reloadProjects();
    await this.refreshSpend();
    await this.processesService.refresh();
    this.processesService.startPolling();
    const storedTabs = this.readJson<string[]>(TABS_KEY, [], isStringArray);
    const known = new Set(Object.keys(this.sessionsState()));
    const tabs = storedTabs.filter((id) => known.has(id));
    this.tabsState.set(tabs);
    const active = localStorage.getItem(ACTIVE_KEY);
    const nextActive = active && known.has(active) ? active : (tabs[tabs.length - 1] ?? null);
    this.activeState.set(nextActive);
    if (nextActive) {
      await this.activateSession(nextActive);
    }
  }

  sessionsFor(projectId: string): Session[] {
    const ids = this.projectSessionsState()[projectId] ?? [];
    return ids
      .map((id) => this.sessionsState()[id])
      .filter((session): session is Session => !!session);
  }

  allSessions(): Session[] {
    return this.projectsState()
      .flatMap((project) => this.sessionsFor(project.id))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  session(id: string): Session | null {
    return this.sessionsState()[id] ?? null;
  }

  subAgentsFor(sessionId: string): Session[] {
    const ids = this.subAgentsState()[sessionId] ?? [];
    return ids
      .map((id) => this.sessionsState()[id])
      .filter((session): session is Session => !!session);
  }

  async loadSubAgents(sessionId: string): Promise<void> {
    try {
      const sessions = await api.listSubSessions(sessionId);
      this.sessionsState.update((state) => {
        const next = { ...state };
        for (const session of sessions) {
          next[session.id] = session;
        }
        return next;
      });
      this.subAgentsState.update((state) => ({
        ...state,
        [sessionId]: sessions.map((session) => session.id),
      }));
    } catch {
      // best effort
    }
  }

  hasLoadedMessages(sessionId: string): boolean {
    return this.messagesState()[sessionId] !== undefined;
  }

  hasLoadedSubAgents(sessionId: string): boolean {
    return this.subAgentsState()[sessionId] !== undefined;
  }

  /**
   * Loads a session and all of its descendants (subagents of subagents included)
   * so the debugger can render the full branch tree.
   */
  async loadAgentTree(sessionId: string): Promise<void> {
    await this.loadMessages(sessionId);
    await this.loadSubAgents(sessionId);
    for (const child of this.subAgentsState()[sessionId] ?? []) {
      await this.loadAgentTree(child);
    }
  }

  viewAgent(rootSessionId: string, agentSessionId: string | null): void {
    this.viewingState.update((state) => {
      const next = { ...state };
      if (agentSessionId && agentSessionId !== rootSessionId) {
        next[rootSessionId] = agentSessionId;
      } else {
        delete next[rootSessionId];
      }
      return next;
    });
    if (agentSessionId && agentSessionId !== rootSessionId) {
      void this.loadMessages(agentSessionId);
      void this.loadChanges(agentSessionId);
    }
  }

  viewingAgentId(rootSessionId: string): string | null {
    return this.viewingState()[rootSessionId] ?? null;
  }

  messagesFor(sessionId: string): Message[] {
    return this.messagesState()[sessionId] ?? [];
  }

  liveToolsFor(sessionId: string): LiveToolCall[] {
    return this.liveToolsState()[sessionId] ?? [];
  }

  changesFor(sessionId: string): FileChange[] {
    return this.changesState()[sessionId] ?? [];
  }

  selectedPathFor(sessionId: string): string | null {
    return this.selectedPathState()[sessionId] ?? null;
  }

  gitInfoFor(projectId: string): GitInfo | null {
    return this.gitService.infoByProject()[projectId] ?? null;
  }

  isStreaming(sessionId: string): boolean {
    return this.streamingState()[sessionId] ?? false;
  }

  /**
   * Status of the agent(s) tied to a session. A root session reports `running`
   * while it streams or while any of its sub-agents is still working, otherwise
   * it falls back to its own persisted agent status.
   */
  agentActivity(sessionId: string): string | null {
    if (this.isStreaming(sessionId)) {
      return 'running';
    }
    const agents = this.subAgentsFor(sessionId);
    if (agents.some((agent) => agent.agentStatus === 'running' || this.isStreaming(agent.id))) {
      return 'running';
    }
    return this.sessionsState()[sessionId]?.agentStatus ?? null;
  }

  /**
   * Whether a session is waiting on the user: a pending permission request or
   * an open question. Root sessions also surface requests from their sub-agents.
   */
  sessionAttention(sessionId: string): 'permission' | 'question' | null {
    const permission = this.permissionState();
    const question = this.questionState();
    if (permission.some((entry) => entry.sessionId === sessionId)) {
      return 'permission';
    }
    if (question.some((entry) => entry.sessionId === sessionId)) {
      return 'question';
    }
    const agents = this.subAgentsState()[sessionId];
    if (agents?.length) {
      if (agents.some((id) => permission.some((entry) => entry.sessionId === id))) {
        return 'permission';
      }
      if (agents.some((id) => question.some((entry) => entry.sessionId === id))) {
        return 'question';
      }
    }
    return null;
  }

  errorFor(sessionId: string): string | null {
    return this.errorsState()[sessionId] ?? null;
  }

  /**
   * Whether the last turn of a session paused at the tool-iteration limit and
   * is waiting for the user to continue.
   */
  limitReachedFor(sessionId: string): boolean {
    return this.sessionsState()[sessionId]?.limitReached ?? false;
  }

  /**
   * Resumes a session that paused at the tool-iteration limit. With
   * `autoContinue`, the session keeps going past future limits too.
   */
  async continueSession(
    sessionId: string,
    options: { autoContinue?: boolean } = {},
  ): Promise<void> {
    const session = this.sessionsState()[sessionId];
    if (!session || this.isStreaming(sessionId)) {
      return;
    }
    if (options.autoContinue) {
      this.upsertSession(await api.setSessionAutoContinue(sessionId, true));
    }
    const model = session.model ?? this.settings.settings()?.defaultModel ?? '';
    if (!model) {
      return;
    }
    await this.send({
      sessionId,
      content: '',
      model,
      reasoningEffort: session.reasoningEffort,
      provider: session.provider,
      resume: true,
    });
  }

  async reloadProjects(): Promise<void> {
    const projects = await api.listProjects();
    this.projectsState.set(projects);
    for (const project of projects) {
      await this.reloadSessions(project.id);
    }
  }

  async reloadSessions(projectId: string): Promise<void> {
    const [sessions, subSessions] = await Promise.all([
      api.listSessions(projectId, this.showArchivedState()),
      api.listSubSessionsForProject(projectId),
    ]);
    this.sessionsState.update((state) => {
      const next = { ...state };
      for (const session of sessions) {
        next[session.id] = session;
      }
      for (const session of subSessions) {
        next[session.id] = session;
      }
      return next;
    });
    this.projectSessionsState.update((state) => ({
      ...state,
      [projectId]: sessions.map((session) => session.id),
    }));
    const grouped = new Map<string, string[]>();
    for (const session of subSessions) {
      const parent = session.parentSessionId;
      if (!parent) {
        continue;
      }
      const ids = grouped.get(parent);
      if (ids) {
        ids.push(session.id);
      } else {
        grouped.set(parent, [session.id]);
      }
    }
    this.subAgentsState.update((state) => {
      const next = { ...state };
      for (const session of sessions) {
        const ids = grouped.get(session.id);
        if (ids) {
          next[session.id] = ids;
        } else {
          delete next[session.id];
        }
      }
      return next;
    });
  }

  async toggleShowArchived(): Promise<void> {
    this.showArchivedState.update((value) => !value);
    await Promise.all(this.projectsState().map((project) => this.reloadSessions(project.id)));
  }

  async addProject(): Promise<void> {
    const selected = await open({
      directory: true,
      multiple: false,
      title: this.transloco.translate('workspace.selectProjectFolder'),
    });
    if (!selected || Array.isArray(selected)) {
      return;
    }
    await api.addProject(selected);
    await this.reloadProjects();
  }

  async cloneProject(url: string, path: string): Promise<Project> {
    const project = await api.gitClone(url, path);
    await this.reloadProjects();
    return project;
  }

  async removeProject(projectId: string): Promise<void> {
    const sessionIds = this.projectSessionsState()[projectId] ?? [];
    await api.removeProject(projectId);
    for (const id of sessionIds) {
      this.closeTab(id);
    }
    await this.reloadProjects();
  }

  projectFor(projectId: string): Project | null {
    return this.projectsState().find((project) => project.id === projectId) ?? null;
  }

  openProjectEditor(projectId: string): void {
    this.projectEditorState.set(projectId);
  }

  closeProjectEditor(): void {
    this.projectEditorState.set(null);
  }

  async updateProjectAppearance(
    projectId: string,
    appearance: { color: string | null; icon: string | null; iconImage: string | null },
  ): Promise<void> {
    const updated = await api.updateProject({ projectId, ...appearance });
    this.projectsState.update((state) =>
      state.map((project) => (project.id === updated.id ? updated : project)),
    );
  }

  async newSession(projectId: string): Promise<Session> {
    const settings = this.settings.settings();
    const session = await api.createSession({
      projectId,
      model: settings?.defaultModel ?? null,
      reasoningEffort: settings?.defaultReasoningEffort ?? 'medium',
      provider: null,
      modeId: settings?.defaultModeId ?? 'coding',
    });
    this.sessionsState.update((state) => ({ ...state, [session.id]: session }));
    await this.reloadSessions(projectId);
    this.messagesState.update((state) => ({ ...state, [session.id]: [] }));
    this.openTab(session.id);
    return session;
  }

  isHandover(sessionId: string): boolean {
    return this.handoverState()[sessionId] ?? false;
  }

  /**
   * Summarizes the active session and opens a fresh session with the summary
   * prefilled in the composer so the work can continue seamlessly.
   */
  async handoverActiveSession(): Promise<Session | null> {
    const session = this.activeSession();
    if (!session || this.isStreaming(session.id) || this.isHandover(session.id)) {
      return null;
    }
    this.handoverState.update((state) => ({ ...state, [session.id]: true }));
    this.setError(session.id, null);
    try {
      const summary = await api.summarizeSession(session.id);
      const settings = this.settings.settings();
      const created = await api.createSession({
        projectId: session.projectId,
        title: this.transloco
          .translate('chat.handoverTitle', { title: session.title })
          .slice(0, HANDOVER_TITLE_MAX_CHARS),
        model: session.model ?? settings?.defaultModel ?? null,
        reasoningEffort: session.reasoningEffort ?? settings?.defaultReasoningEffort ?? 'medium',
        provider: session.provider,
        modeId: session.modeId ?? settings?.defaultModeId ?? 'coding',
      });
      this.sessionsState.update((state) => ({ ...state, [created.id]: created }));
      await this.reloadSessions(session.projectId);
      this.messagesState.update((state) => ({ ...state, [created.id]: [] }));
      this.openTab(created.id);
      this.draftState.set(summary);
      return created;
    } catch (error) {
      this.setError(session.id, String(error));
      return null;
    } finally {
      this.handoverState.update((state) => {
        const next = { ...state };
        delete next[session.id];
        return next;
      });
    }
  }

  openTab(sessionId: string): void {
    if (!this.tabsState().includes(sessionId)) {
      this.tabsState.update((tabs) => [...tabs, sessionId]);
    }
    this.activeState.set(sessionId);
    if (this.viewingState()[sessionId]) {
      this.viewAgent(sessionId, null);
    }
    this.persistTabs();
    void this.activateSession(sessionId);
  }

  openDebug(): void {
    const sessionId = this.activeState();
    if (!sessionId) {
      return;
    }
    this.debugSessionState.set(sessionId);
    void this.loadAgentTree(sessionId);
  }

  closeDebug(): void {
    this.debugSessionState.set(null);
  }

  closeTab(sessionId: string, deleteIfEmpty = false): void {
    const tabs = this.tabsState().filter((id) => id !== sessionId);
    this.tabsState.set(tabs);
    if (this.activeState() === sessionId) {
      const next = tabs[tabs.length - 1] ?? null;
      this.activeState.set(next);
      if (next) {
        void this.activateSession(next);
      }
    }
    this.persistTabs();
    void this.refreshSpend();

    if (deleteIfEmpty && this.isEmptySession(sessionId)) {
      void this.deleteSession(sessionId);
    }
  }

  private isEmptySession(sessionId: string): boolean {
    if ((this.subAgentsState()[sessionId] ?? []).length > 0) {
      return false;
    }
    const messages = this.messagesState()[sessionId];
    if (messages) {
      return messages.length === 0;
    }
    return (this.sessionsState()[sessionId]?.messageCount ?? 1) === 0;
  }

  async loadMessages(sessionId: string, force = false): Promise<void> {
    if (!force && this.messagesState()[sessionId]) {
      return;
    }
    const token = (this.messageLoadTokens.get(sessionId) ?? 0) + 1;
    this.messageLoadTokens.set(sessionId, token);
    const messages = await api.listMessages(sessionId);
    // A revert or a newer turn can issue a reload while this one is in flight.
    // Dropping the stale response prevents the deleted prompt from reappearing.
    if (this.messageLoadTokens.get(sessionId) !== token) {
      return;
    }
    this.messagesState.update((state) => ({ ...state, [sessionId]: messages }));
  }

  private drainQueue(sessionId: string): void {
    if (this.isStreaming(sessionId) || !this.sessionsState()[sessionId]) {
      return;
    }
    const next = this.queueService.first(sessionId);
    if (!next) {
      return;
    }
    void this.dispatchQueued(sessionId, next);
  }

  /// Sends the head of a session's queue and removes it only once the send has
  /// actually started, so a racing stream or a removed session cannot make a
  /// queued prompt vanish silently.
  private async dispatchQueued(sessionId: string, args: SendMessageArgs): Promise<void> {
    const dispatched = await this.send(args);
    if (!dispatched) {
      return;
    }
    this.queueService.removeFirst(sessionId, args);
  }

  async send(args: SendMessageArgs): Promise<boolean> {
    const session = this.sessionsState()[args.sessionId];
    if (!session || this.isStreaming(args.sessionId)) {
      return false;
    }
    const now = Date.now();
    if (!args.resume) {
      this.appendMessage(args.sessionId, {
        id: `local-${now}`,
        sessionId: args.sessionId,
        seq: now,
        role: 'user',
        content: args.content,
        reasoning: '',
        model: null,
        provider: null,
        cost: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        createdAt: now,
        toolCalls: [],
        toolCallId: null,
        toolName: null,
        status: null,
        changes: [],
        baseCommit: null,
        attachments: args.attachments ?? [],
        mentions: args.mentions ?? [],
        context: '',
        durationMs: 0,
      });
    }
    this.setError(args.sessionId, null);
    this.patchSession(args.sessionId, { limitReached: false });
    this.setStreaming(args.sessionId, true);
    this.setLiveTools(args.sessionId, []);

    const assistantIds: Record<string, string | null> = {};
    const channel = new Channel<RoutedEvent>();
    channel.onmessage = ({ sessionId, event }) => {
      switch (event.kind) {
        case 'started':
          this.flushStreamBuffers();
          assistantIds[sessionId] = event.message.id;
          this.appendMessage(sessionId, event.message);
          break;
        case 'delta':
          this.bufferMessageText(sessionId, assistantIds[sessionId] ?? null, 'content', event.text);
          break;
        case 'reasoning':
          this.bufferMessageText(
            sessionId,
            assistantIds[sessionId] ?? null,
            'reasoning',
            event.text,
          );
          break;
        case 'usage':
          this.flushStreamBuffers();
          this.patchMessage(sessionId, assistantIds[sessionId] ?? null, (message) => ({
            ...message,
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            cachedTokens: event.cachedTokens,
            cost: event.cost,
          }));
          break;
        case 'assistant':
          this.flushStreamBuffers();
          this.replaceMessage(sessionId, event.message);
          assistantIds[sessionId] = null;
          break;
        case 'toolStart':
          this.flushStreamBuffers();
          this.upsertLiveTool(sessionId, {
            callId: event.callId,
            name: event.name,
            summary: event.summary,
            arguments: event.arguments,
            output: '',
            status: 'running',
            changes: [],
            anchor: this.lastMessageId(sessionId),
          });
          break;
        case 'toolDelta':
          this.bufferToolOutput(sessionId, event.callId, event.text);
          break;
        case 'toolEnd':
          this.flushStreamBuffers();
          this.patchLiveTool(sessionId, event.callId, (tool) => ({
            ...tool,
            status: this.mapToolStatus(event.status),
            output: event.result,
            changes: event.changes,
          }));
          break;
        case 'permissionRequest':
          this.permissionState.update((state) => [...state, { ...event, sessionId }]);
          this.sound.play('permission');
          break;
        case 'permissionResolved':
          this.permissionState.update((state) =>
            state.filter((entry) => entry.requestId !== event.requestId),
          );
          break;
        case 'questionRequest':
          this.questionState.update((state) => [...state, { ...event, sessionId }]);
          this.sound.play('permission');
          break;
        case 'questionResolved':
          this.questionState.update((state) =>
            state.filter((entry) => entry.requestId !== event.requestId),
          );
          break;
        case 'changes':
          this.flushStreamBuffers();
          this.changesState.update((state) => ({ ...state, [sessionId]: event.changes }));
          void this.reloadSessions(session.projectId);
          break;
        case 'done':
          this.flushStreamBuffers();
          this.replaceMessage(sessionId, event.message);
          this.upsertSession(event.session);
          void this.refreshSpend();
          this.sound.play('done');
          break;
        case 'stopped':
          this.flushStreamBuffers();
          this.replaceMessage(sessionId, event.message);
          break;
        case 'subAgentStarted': {
          this.upsertSession(event.session);
          const parentId = event.session.parentSessionId;
          if (parentId) {
            this.subAgentsState.update((state) => {
              const existing = state[parentId] ?? [];
              if (existing.includes(event.session.id)) {
                return state;
              }
              return { ...state, [parentId]: [...existing, event.session.id] };
            });
          }
          this.messagesState.update((state) => ({
            ...state,
            [event.session.id]: state[event.session.id] ?? [],
          }));
          this.setStreaming(event.session.id, true);
          this.setLiveTools(event.session.id, []);
          break;
        }
        case 'subAgentStatus':
          this.patchSession(sessionId, { agentStatus: event.status });
          this.setStreaming(sessionId, false);
          this.setLiveTools(sessionId, []);
          void this.reloadSessions(session.projectId);
          void this.refreshSpend();
          break;
        case 'limitReached':
          // Subagents report back to the parent instead of pausing for input.
          if (sessionId === session.id && !event.autoContinued) {
            this.patchSession(sessionId, { limitReached: true });
          }
          break;
        case 'error':
          this.setError(sessionId, event.message);
          this.sound.play('error');
          break;
      }
    };

    try {
      await api.sendMessage(args, channel);
    } catch (error) {
      if (!this.errorFor(args.sessionId)) {
        this.setError(args.sessionId, String(error));
        this.sound.play('error');
      }
    } finally {
      this.flushStreamBuffers();
      this.setLiveTools(args.sessionId, []);
      // Keep the session marked as streaming until the post-turn refresh has
      // finished, otherwise a new send could start and be clobbered by this
      // still-running `loadMessages`. Refresh failures must not skip the queue
      // drain below (and must not reject `send`).
      try {
        await this.loadMessages(args.sessionId, true);
        await this.reloadSessions(session.projectId);
        await this.reloadProjects();
        await this.refreshSpend();
        await this.loadChanges(args.sessionId);
        await this.loadRules(session.projectId, args.sessionId);
        await this.loadSubAgents(args.sessionId);
        await this.editorService.loadWorkspaceEntries(session.projectId, true);
        const active = this.editorService.activeFileFor(session.projectId);
        if (active) {
          await this.loadEditorFile(session.projectId, active);
        }
      } catch (error) {
        console.error('post-send refresh failed', error);
      } finally {
        this.setStreaming(args.sessionId, false);
      }
      this.drainQueue(args.sessionId);
    }
    return true;
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessionsState()[sessionId];
    const target = session?.parentSessionId ?? sessionId;
    await api.stopGeneration(target);
  }

  async resolvePermission(
    decision: 'allow_once' | 'allow_session' | 'allow_always' | 'deny' | 'deny_always',
    ruleOverride?: string,
  ): Promise<void> {
    const request = this.permission();
    if (!request) {
      return;
    }
    await api.resolvePermission(
      request.requestId,
      decision,
      ruleOverride ?? request.suggestedRule,
      request.folder,
      request.promptKind,
    );
    this.permissionState.update((state) =>
      state.filter((entry) => entry.requestId !== request.requestId),
    );
  }

  async resolveQuestion(requestId: string, answers: QuestionAnswer[] | null): Promise<void> {
    await api.resolveQuestion(requestId, answers);
    this.questionState.update((state) => state.filter((entry) => entry.requestId !== requestId));
  }

  async updateSession(args: UpdateSessionArgs): Promise<void> {
    const session = await api.updateSession(args);
    this.upsertSession(session);
  }

  async changeSessionProject(sessionId: string, projectId: string): Promise<void> {
    const current = this.sessionsState()[sessionId];
    if (!current || current.projectId === projectId) {
      return;
    }
    const session = await api.updateSession({ sessionId, projectId });
    this.upsertSession(session);
    await this.reloadSessions(current.projectId);
    await this.reloadSessions(projectId);
    await this.activateSession(sessionId);
  }

  async archiveSession(sessionId: string, archived: boolean): Promise<void> {
    const session = await api.archiveSession(sessionId, archived);
    this.upsertSession(session);
    if (archived) {
      this.closeTab(sessionId);
    }
    await this.reloadSessions(session.projectId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessionsState()[sessionId];
    await api.deleteSession(sessionId);
    this.clearComposerDraft(sessionId);
    this.clearComposerAttachments(sessionId);
    this.messagesState.update((state) => {
      const next = { ...state };
      delete next[sessionId];
      return next;
    });
    this.subAgentsState.update((state) => {
      const next = { ...state };
      delete next[sessionId];
      return next;
    });
    this.viewingState.update((state) => {
      const next = { ...state };
      delete next[sessionId];
      for (const [root, agent] of Object.entries(next)) {
        if (agent === sessionId) {
          delete next[root];
        }
      }
      return next;
    });
    this.closeTab(sessionId);
    if (session) {
      await this.reloadSessions(session.projectId);
    }
  }

  async loadChanges(sessionId: string): Promise<void> {
    try {
      const changes = await api.getSessionChanges(sessionId);
      this.changesState.update((state) => ({ ...state, [sessionId]: changes }));
    } catch {
      // best effort
    }
  }

  async selectChange(sessionId: string, path: string): Promise<void> {
    this.selectedPathState.update((state) => ({ ...state, [sessionId]: path }));
    try {
      this.diffState.set(await api.getFileDiff(sessionId, path));
    } catch {
      this.diffState.set(null);
    }
  }

  clearDiff(): void {
    this.diffState.set(null);
  }

  async loadEditorFile(projectId: string, path: string, force = false): Promise<void> {
    const session = this.activeSession();
    const changed = session ? this.changesFor(session.id).some((c) => c.path === path) : false;
    return this.editorService.loadFile(
      projectId,
      path,
      force,
      changed && session ? session.id : null,
    );
  }

  setLeftTab(tab: LeftTab): void {
    this.leftTabState.set(tab);
    localStorage.setItem(LEFT_TAB_KEY, tab);
  }

  setRightTab(tab: RightTab): void {
    this.rightTabState.set(tab);
    localStorage.setItem(RIGHT_TAB_KEY, tab);
  }

  setSessionView(view: SessionView): void {
    this.sessionViewState.set(view);
    localStorage.setItem(SESSION_VIEW_KEY, view);
  }

  toggleLeftPanel(): void {
    this.setLeftPanelOpen(!this.leftPanelOpenState());
  }

  setLeftPanelOpen(open: boolean): void {
    this.leftPanelOpenState.set(open);
    if (!open && this.focusedPanelState() === 'left') {
      this.focusedPanelState.set('center');
    }
    this.persistLayout();
  }

  toggleRightPanel(): void {
    this.setRightPanelOpen(!this.rightPanelOpenState());
  }

  setRightPanelOpen(open: boolean): void {
    this.rightPanelOpenState.set(open);
    if (!open && this.focusedPanelState() === 'right') {
      this.focusedPanelState.set('center');
    }
    this.persistLayout();
  }

  setLeftPanelWidth(width: number): void {
    this.leftPanelWidthState.set(width);
    this.persistLayout();
  }

  setRightPanelWidth(width: number): void {
    this.rightPanelWidthState.set(width);
    this.persistLayout();
  }

  setFocusedPanel(panel: PanelId | null): void {
    this.focusedPanelState.set(panel);
  }

  /** Moves focus to the next (`1`) or previous (`-1`) visible panel. */
  focusAdjacentPanel(direction: 1 | -1): void {
    const panels = this.visiblePanels();
    if (panels.length === 0) {
      return;
    }
    const current = this.focusedPanelState();
    const index = current ? panels.indexOf(current) : -1;
    const next =
      index === -1
        ? direction === 1
          ? panels[0]
          : panels[panels.length - 1]
        : panels[(index + direction + panels.length) % panels.length];
    this.focusedPanelState.set(next);
  }

  private visiblePanels(): PanelId[] {
    const panels: PanelId[] = [];
    if (this.leftPanelOpenState()) {
      panels.push('left');
    }
    panels.push('center');
    if (this.rightPanelOpenState() && this.leftTabState() !== 'git') {
      panels.push('right');
    }
    return panels;
  }

  /** Cycles the tab strip of whichever sidebar currently has focus. */
  cycleFocusedPanelTab(direction: 1 | -1): void {
    const panel = this.focusedPanelState();
    if (panel === 'left') {
      const tabs: LeftTab[] = ['projects', 'workspace', 'git'];
      const index = tabs.indexOf(this.leftTabState());
      this.setLeftTab(tabs[(index + direction + tabs.length) % tabs.length]);
    } else if (panel === 'right') {
      const tabs: RightTab[] = ['changes', 'session', 'prompts', 'modes'];
      const index = tabs.indexOf(this.rightTabState());
      this.setRightTab(tabs[(index + direction + tabs.length) % tabs.length]);
    }
  }

  /** Asks the composer to put keyboard focus in its editor. */
  requestComposerFocus(): void {
    this.composerFocusState.update((nonce) => nonce + 1);
  }

  private persistLayout(): void {
    const data: PersistedLayout = {
      leftPanelOpen: this.leftPanelOpenState(),
      rightPanelOpen: this.rightPanelOpenState(),
      leftPanelWidth: this.leftPanelWidthState(),
      rightPanelWidth: this.rightPanelWidthState(),
    };
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(data));
  }

  async loadRules(projectId: string, sessionId: string | null): Promise<void> {
    try {
      this.rulesState.set(await api.getProjectRules(projectId, sessionId));
    } catch {
      this.rulesState.set([]);
    }
  }

  async loadGitInfo(projectId: string): Promise<void> {
    return this.gitService.loadInfo(projectId);
  }

  async revertToMessage(messageId: string, restoreFiles: boolean): Promise<RevertResult> {
    const sessionId = this.sessionIdForMessage(messageId) ?? this.activeAgent()?.id ?? null;
    const result = await api.revertToMessage(messageId, restoreFiles);
    if (sessionId) {
      this.pruneMessagesFrom(sessionId, messageId);
      this.setLiveTools(sessionId, []);
      await this.loadMessages(sessionId, true);
      await this.loadChanges(sessionId);
      this.diffState.set(null);
      this.draftState.set(result.prompt);
    }
    return result;
  }

  /** Finds which session holds a message so a revert refreshes the right transcript. */
  private sessionIdForMessage(messageId: string): string | null {
    for (const [sessionId, messages] of Object.entries(this.messagesState())) {
      if (messages.some((message) => message.id === messageId)) {
        return sessionId;
      }
    }
    return null;
  }

  /**
   * Removes `messageId` and every message that follows it. The backend deletes
   * by seq, so mirror that here to keep the transcript correct even before the
   * reload completes (or if it fails).
   */
  private pruneMessagesFrom(sessionId: string, messageId: string): void {
    const messages = this.messagesState()[sessionId];
    if (!messages) {
      return;
    }
    const index = messages.findIndex((message) => message.id === messageId);
    if (index === -1) {
      return;
    }
    this.messagesState.update((state) => ({ ...state, [sessionId]: messages.slice(0, index) }));
  }

  consumeDraft(): void {
    this.draftState.set(null);
  }

  composerDraftFor(sessionId: string): string {
    return this.composerDraftsState()[sessionId] ?? '';
  }

  setComposerDraft(sessionId: string, text: string): void {
    const current = this.composerDraftsState();
    if ((current[sessionId] ?? '') === text) {
      return;
    }
    if (text.length === 0) {
      this.clearComposerDraft(sessionId);
      return;
    }
    this.composerDraftsState.set({ ...current, [sessionId]: text });
    this.persistComposerDrafts();
  }

  clearComposerDraft(sessionId: string): void {
    const current = this.composerDraftsState();
    if (!(sessionId in current)) {
      return;
    }
    const next = { ...current };
    delete next[sessionId];
    this.composerDraftsState.set(next);
    this.persistComposerDrafts();
  }

  private persistComposerDrafts(): void {
    localStorage.setItem(COMPOSER_DRAFTS_KEY, JSON.stringify(this.composerDraftsState()));
  }

  composerAttachmentsFor(sessionId: string): MessageAttachment[] {
    return this.composerAttachmentsState()[sessionId] ?? [];
  }

  setComposerAttachments(sessionId: string, attachments: MessageAttachment[]): void {
    const current = this.composerAttachmentsState();
    if (attachments.length === 0) {
      if (!(sessionId in current)) {
        return;
      }
      const next = { ...current };
      delete next[sessionId];
      this.composerAttachmentsState.set(next);
      return;
    }
    this.composerAttachmentsState.set({ ...current, [sessionId]: attachments });
  }

  clearComposerAttachments(sessionId: string): void {
    this.setComposerAttachments(sessionId, []);
  }

  scrollToMessage(messageId: string): void {
    this.scrollNonce += 1;
    this.scrollTargetState.set({ id: messageId, nonce: this.scrollNonce });
  }

  async refreshSpend(): Promise<void> {
    try {
      this.spendState.set(await api.getSpend(this.activeState()));
    } catch {
      // spend display is best effort
    }
  }

  private async activateSession(sessionId: string): Promise<void> {
    const session = this.sessionsState()[sessionId];
    this.diffState.set(null);
    this.gitService.resetView(session.projectId);
    this.scrollTargetState.set(null);
    await this.loadMessages(sessionId);
    if (session) {
      await Promise.all([
        this.loadChanges(sessionId),
        this.loadRules(session.projectId, sessionId),
        this.gitService.loadInfo(session.projectId),
        this.loadSubAgents(sessionId),
        this.editorService.loadWorkspaceEntries(session.projectId),
      ]);
      const active = this.editorService.activeFileFor(session.projectId);
      if (active) {
        void this.loadEditorFile(session.projectId, active);
      }
    }
    void this.refreshSpend();
  }

  private appendMessage(sessionId: string, message: Message): void {
    this.messagesState.update((state) => ({
      ...state,
      [sessionId]: [...(state[sessionId] ?? []), message],
    }));
  }

  private lastMessageId(sessionId: string): string | null {
    const messages = this.messagesState()[sessionId] ?? [];
    return messages.length > 0 ? messages[messages.length - 1].id : null;
  }

  private replaceMessage(sessionId: string, message: Message): void {
    this.messagesState.update((state) => {
      const messages = state[sessionId];
      if (!messages || messages.length === 0) {
        return state;
      }
      const last = messages.length - 1;
      const index =
        messages[last].id === message.id
          ? last
          : messages.findIndex((entry) => entry.id === message.id);
      if (index === -1) {
        return state;
      }
      const next = messages.slice();
      next[index] = message;
      return { ...state, [sessionId]: next };
    });
  }

  private patchMessage(
    sessionId: string,
    messageId: string | null,
    patch: (message: Message) => Message,
  ): void {
    if (!messageId) {
      return;
    }
    this.messagesState.update((state) => {
      const messages = state[sessionId];
      if (!messages || messages.length === 0) {
        return state;
      }
      const last = messages.length - 1;
      const index =
        messages[last].id === messageId
          ? last
          : messages.findIndex((entry) => entry.id === messageId);
      if (index === -1) {
        return state;
      }
      const next = messages.slice();
      next[index] = patch(messages[index]);
      return { ...state, [sessionId]: next };
    });
  }

  private bufferMessageText(
    sessionId: string,
    messageId: string | null,
    field: 'content' | 'reasoning',
    text: string,
  ): void {
    if (!messageId || !text) {
      return;
    }
    const key = `${sessionId}:${messageId}:${field}`;
    const existing = this.pendingMessageText.get(key);
    if (existing) {
      existing.text += text;
    } else {
      this.pendingMessageText.set(key, { sessionId, messageId, field, text });
    }
    this.scheduleStreamFlush();
  }

  private bufferToolOutput(sessionId: string, callId: string, text: string): void {
    if (!text) {
      return;
    }
    const key = `${sessionId}:${callId}`;
    const existing = this.pendingToolOutput.get(key);
    if (existing) {
      existing.text += text;
    } else {
      this.pendingToolOutput.set(key, { sessionId, callId, text });
    }
    this.scheduleStreamFlush();
  }

  private scheduleStreamFlush(): void {
    if (this.streamFlushScheduled) {
      return;
    }
    this.streamFlushScheduled = true;
    const run = (): void => this.flushStreamBuffers();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 16);
    }
  }

  private flushStreamBuffers(): void {
    this.streamFlushScheduled = false;

    if (this.pendingMessageText.size > 0) {
      const grouped = new Map<
        string,
        { sessionId: string; messageId: string; content: string; reasoning: string }
      >();
      for (const entry of this.pendingMessageText.values()) {
        const key = `${entry.sessionId}:${entry.messageId}`;
        const group = grouped.get(key) ?? {
          sessionId: entry.sessionId,
          messageId: entry.messageId,
          content: '',
          reasoning: '',
        };
        if (entry.field === 'content') {
          group.content += entry.text;
        } else {
          group.reasoning += entry.text;
        }
        grouped.set(key, group);
      }
      this.pendingMessageText.clear();
      for (const group of grouped.values()) {
        this.patchMessage(group.sessionId, group.messageId, (message) => ({
          ...message,
          content: group.content ? message.content + group.content : message.content,
          reasoning: group.reasoning ? message.reasoning + group.reasoning : message.reasoning,
        }));
      }
    }

    if (this.pendingToolOutput.size > 0) {
      const pending = [...this.pendingToolOutput.values()];
      this.pendingToolOutput.clear();
      for (const entry of pending) {
        this.patchLiveTool(entry.sessionId, entry.callId, (tool) => ({
          ...tool,
          output: tool.output + entry.text,
        }));
      }
    }
  }

  private mapToolStatus(status: string): LiveToolCall['status'] {
    switch (status) {
      case 'ok':
      case 'denied':
      case 'canceled':
        return status;
      default:
        return 'error';
    }
  }

  private setLiveTools(sessionId: string, tools: LiveToolCall[]): void {
    this.liveToolsState.update((state) => ({ ...state, [sessionId]: tools }));
  }

  private upsertLiveTool(sessionId: string, tool: LiveToolCall): void {
    this.liveToolsState.update((state) => {
      const existing = state[sessionId] ?? [];
      const found = existing.some((entry) => entry.callId === tool.callId);
      return {
        ...state,
        [sessionId]: found
          ? existing.map((entry) => (entry.callId === tool.callId ? tool : entry))
          : [...existing, tool],
      };
    });
  }

  private patchLiveTool(
    sessionId: string,
    callId: string,
    patch: (tool: LiveToolCall) => LiveToolCall,
  ): void {
    this.liveToolsState.update((state) => ({
      ...state,
      [sessionId]: (state[sessionId] ?? []).map((entry) =>
        entry.callId === callId ? patch(entry) : entry,
      ),
    }));
  }

  private upsertSession(session: Session): void {
    this.sessionsState.update((state) => ({ ...state, [session.id]: session }));
  }

  private patchSession(sessionId: string, patch: Partial<Session>): void {
    this.sessionsState.update((state) => {
      const session = state[sessionId];
      if (!session) {
        return state;
      }
      return { ...state, [sessionId]: { ...session, ...patch } };
    });
  }

  private setStreaming(sessionId: string, value: boolean): void {
    this.streamingState.update((state) => ({ ...state, [sessionId]: value }));
  }

  private setError(sessionId: string, message: string | null): void {
    this.errorsState.update((state) => ({ ...state, [sessionId]: message }));
  }

  private persistTabs(): void {
    localStorage.setItem(TABS_KEY, JSON.stringify(this.tabsState()));
    const active = this.activeState();
    if (active) {
      localStorage.setItem(ACTIVE_KEY, active);
    }
  }

  private readJson<T>(key: string, fallback: T, validate: (value: unknown) => boolean): T {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '');
      return validate(parsed) ? (parsed as T) : fallback;
    } catch {
      return fallback;
    }
  }
}
