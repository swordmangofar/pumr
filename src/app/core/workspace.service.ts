import { Injectable, WritableSignal, computed, inject, signal } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { TranslocoService } from '@jsverse/transloco';
import { api } from './api';
import {
  CommandRule,
  ContextUsageInfo,
  FileChange,
  FileDiff,
  GitInfo,
  GitPullStrategy,
  LiveToolCall,
  Mention,
  Message,
  MessageAttachment,
  PendingModelChoice,
  PendingPermission,
  PendingQuestion,
  Project,
  ProjectRule,
  QuestionAnswer,
  RevertResult,
  RoutedEvent,
  RunningTurns,
  SendMessageArgs,
  Session,
  SpendSummary,
  UpdateSessionArgs,
} from './models';
import { planToggleTarget, resolveMode } from './modes';
import { SettingsService } from './settings.service';
import { SoundService } from './sound.service';
import { ProcessService } from './process.service';
import { DEFAULT_PROJECT_SORT, ProjectSort, isProjectSort, sortProjects } from './project-sort';
import { MessageQueueService } from './message-queue.service';
import { GitService } from './git.service';
import { WorkspaceEditorService } from './workspace-editor.service';

const TABS_KEY = 'pumr.tabs';
const ACTIVE_KEY = 'pumr.activeTab';
const LEFT_TAB_KEY = 'pumr.leftTab';
const BROWSE_PROJECT_KEY = 'pumr.browseProject';
const RIGHT_TAB_KEY = 'pumr.rightTab';
const SESSION_VIEW_KEY = 'pumr.sessionView';
const PROJECT_SORT_KEY = 'pumr.projectSort';
const LAYOUT_KEY = 'pumr.layout';
const GIT_PULL_STRATEGY_KEY = 'pumr.gitPullStrategy';
const COMPOSER_DRAFTS_KEY = 'pumr.composerDrafts';
/** Longest handover title derived from the source session title. */
const HANDOVER_TITLE_MAX_CHARS = 60;
/** How long a tool call has to keep printing before the chat opens its output. */
const LIVE_OUTPUT_AFTER_MS = 600;
/** How much of a running call's output is kept: a test run can print megabytes. */
const LIVE_OUTPUT_MAX_CHARS = 64_000;
/** One list for every session without MCP issues, so readers see no change. */
const NO_MCP_ISSUES: string[] = [];

/** The end of `output` that fits `LIVE_OUTPUT_MAX_CHARS`, from the start of a line. */
function latestOutput(output: string): string {
  if (output.length <= LIVE_OUTPUT_MAX_CHARS) {
    return output;
  }
  const cut = output.length - LIVE_OUTPUT_MAX_CHARS;
  const line = output.indexOf('\n', cut);
  return output.slice(line === -1 ? cut : line + 1);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

type LeftTab = 'sessions' | 'workspace' | 'git';

/** A file mention and a text block to add to the composer. */
export interface ComposerInsert {
  mention: Mention | null;
  text: string;
}

/** A chat that waits on the user, and for what. */
export interface WaitingChat {
  session: Session;
  kind: 'permission' | 'question';
}
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
  /** The mode each session left when the plan hotkey took it to planning. */
  private readonly modeBeforePlan = new Map<string, string>();
  private readonly streamingState = signal<Record<string, boolean>>({});
  private readonly errorsState = signal<Record<string, string | null>>({});
  private readonly composerDraftsState = signal<Record<string, string>>({});
  private readonly composerAttachmentsState = signal<Record<string, MessageAttachment[]>>({});
  private readonly spendState = signal<SpendSummary | null>(null);
  private readonly liveToolsState = signal<Record<string, LiveToolCall[]>>({});
  private readonly changesState = signal<Record<string, FileChange[]>>({});
  /** Running `refreshFiles` passes by project, and whether files changed since one began. */
  private readonly fileRefreshes = new Map<string, { stale: boolean; done: Promise<void> }>();
  private readonly contextUsageState = signal<Record<string, ContextUsageInfo>>({});
  private readonly selectedPathState = signal<Record<string, string | null>>({});
  private readonly diffState = signal<FileDiff | null>(null);
  /** Whose change `diffState` shows or is loading; `null` once it was cleared. */
  private diffSource: { sessionId: string; path: string } | null = null;
  private readonly leftTabState = signal<LeftTab>('sessions');
  private readonly browseProjectState = signal<string | null>(null);
  private readonly rightTabState = signal<RightTab>('changes');
  private readonly sessionViewState = signal<SessionView>('projects');
  private readonly projectSortState = signal<ProjectSort>(DEFAULT_PROJECT_SORT);
  private readonly leftPanelOpenState = signal(true);
  private readonly rightPanelOpenState = signal(true);
  private readonly leftPanelWidthState = signal(340);
  private readonly rightPanelWidthState = signal(512);
  private readonly focusedPanelState = signal<PanelId | null>(null);
  private readonly composerFocusState = signal(0);
  private readonly composerInsertState = signal<ComposerInsert | null>(null);
  private readonly rulesState = signal<ProjectRule[]>([]);
  private readonly permissionState = signal<PendingPermission[]>([]);
  private readonly questionState = signal<PendingQuestion[]>([]);
  private readonly modelChoiceState = signal<PendingModelChoice[]>([]);
  /** Ids of prompts already answered or withdrawn, never to be shown again. */
  private readonly settledRequests = new Set<string>();
  /** Ids of prompts whose `waitingElsewhere` entry the user closed. */
  private readonly dismissedPromptState = signal<ReadonlySet<string>>(new Set());
  private readonly draftState = signal<string | null>(null);
  private readonly handoverState = signal<Record<string, boolean>>({});
  /** Sessions whose history is being summarised right now. */
  private readonly compactingState = signal<Record<string, boolean>>({});
  /** The MCP server a session's turn is starting right now. */
  private readonly mcpStartingState = signal<Record<string, string>>({});
  /** The MCP servers a session's latest turn has to do without, and why. */
  private readonly mcpIssuesState = signal<Record<string, string[]>>({});
  private readonly debugSessionState = signal<string | null>(null);
  private readonly debugExportState = signal(false);
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

  /** Projects in the order the user picked for the sidebar. */
  readonly projects = computed(() =>
    sortProjects(this.projectsState(), this.projectSortState(), (project) =>
      this.lastActivity(project),
    ),
  );
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
  /** The open prompt to pick the model a subagent was asked to run on. */
  readonly modelChoice = computed<PendingModelChoice | null>(() => {
    const ids = this.activeContextIds();
    return this.modelChoiceState().find((entry) => ids.has(entry.sessionId)) ?? null;
  });
  /**
   * Chats that wait on the user with a prompt the chat on screen does not
   * show, each listed once under its root session; permissions come first.
   * Prompts the user dismissed no longer count.
   */
  readonly waitingElsewhere = computed<WaitingChat[]>(() => {
    const shown = this.activeContextIds();
    const onScreen = this.activeAgentId();
    const dismissed = this.dismissedPromptState();
    const waiting = new Map<string, WaitingChat>();
    const collect = (
      prompts: (PendingPermission | PendingQuestion | PendingModelChoice)[],
      kind: WaitingChat['kind'],
    ): void => {
      for (const prompt of prompts) {
        const hidden = shown.has(prompt.sessionId) || dismissed.has(prompt.requestId);
        const root = hidden ? null : this.rootSession(prompt.sessionId);
        // Nothing to switch to when the main view of that chat is on screen.
        if (root && root.id !== onScreen && !waiting.has(root.id)) {
          waiting.set(root.id, { session: root, kind });
        }
      }
    };
    collect(this.permissionState(), 'permission');
    collect(this.questionState(), 'question');
    collect(this.modelChoiceState(), 'question');
    return [...waiting.values()];
  });
  readonly processes = this.processesService.processes;
  readonly rules = this.rulesState.asReadonly();
  readonly activeDiff = this.diffState.asReadonly();
  readonly contextUsage = this.contextUsageState.asReadonly();
  readonly leftTab = this.leftTabState.asReadonly();
  readonly rightTab = this.rightTabState.asReadonly();
  readonly sessionView = this.sessionViewState.asReadonly();
  readonly projectSort = this.projectSortState.asReadonly();
  readonly leftPanelOpen = this.leftPanelOpenState.asReadonly();
  readonly rightPanelOpen = this.rightPanelOpenState.asReadonly();
  readonly leftPanelWidth = this.leftPanelWidthState.asReadonly();
  readonly rightPanelWidth = this.rightPanelWidthState.asReadonly();
  readonly focusedPanel = this.focusedPanelState.asReadonly();
  readonly composerFocusNonce = this.composerFocusState.asReadonly();
  /** Content waiting to be added to the composer, see `askInChat`. */
  readonly pendingComposerInsert = this.composerInsertState.asReadonly();
  readonly pendingDraft = this.draftState.asReadonly();
  readonly debugSessionId = this.debugSessionState.asReadonly();
  readonly debugOpen = computed(() => this.debugSessionState() !== null);
  /** Whether the debugger shows its log export dialog. */
  readonly debugExportOpen = this.debugExportState.asReadonly();
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
  /**
   * The project the Workspace and Git tabs show. The user picks it there, so
   * it stays put when another session becomes active.
   */
  readonly browseProject = computed(() => {
    const id = this.browseProjectState();
    return this.projectsState().find((project) => project.id === id) ?? null;
  });
  private readonly gitPullStrategyState = signal<GitPullStrategy>('ff-only');
  readonly gitPullStrategy = this.gitPullStrategyState.asReadonly();

  setGitPullStrategy(strategy: GitPullStrategy): void {
    this.gitPullStrategyState.set(strategy);
    localStorage.setItem(GIT_PULL_STRATEGY_KEY, strategy);
  }

  constructor() {
    const leftTab = localStorage.getItem(LEFT_TAB_KEY);
    if (leftTab === 'sessions' || leftTab === 'workspace' || leftTab === 'git') {
      this.leftTabState.set(leftTab);
    }
    this.browseProjectState.set(localStorage.getItem(BROWSE_PROJECT_KEY));
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
    const projectSort = localStorage.getItem(PROJECT_SORT_KEY);
    if (isProjectSort(projectSort)) {
      this.projectSortState.set(projectSort);
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
    this.ensureBrowseProject();
    // A webview reload leaves turns running in the backend with nobody
    // listening; pick them up before the active session renders.
    await this.resumeRunningTurns();
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

  /** When a project was last used: its newest listed session, or when it was opened. */
  private lastActivity(project: Project): number {
    return this.sessionsFor(project.id).reduce(
      (latest, session) => Math.max(latest, session.updatedAt),
      project.lastOpenedAt,
    );
  }

  allSessions(): Session[] {
    return this.projectsState()
      .flatMap((project) => this.sessionsFor(project.id))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  session(id: string): Session | null {
    return this.sessionsState()[id] ?? null;
  }

  /** The top-level chat a session belongs to, itself unless it is a sub-agent. */
  private rootSession(sessionId: string): Session | null {
    const sessions = this.sessionsState();
    const seen = new Set<string>();
    let session = sessions[sessionId];
    while (session?.parentSessionId && !seen.has(session.id)) {
      seen.add(session.id);
      session = sessions[session.parentSessionId];
    }
    return session ?? null;
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

  /** Brings a chat from `waitingElsewhere` on screen, on its main view. */
  showWaitingChat(sessionId: string): void {
    if (this.activeState() === sessionId) {
      this.viewAgent(sessionId, null);
    } else {
      this.openTab(sessionId);
    }
  }

  /** Hides a chat from `waitingElsewhere` until it raises a new prompt. */
  dismissWaitingChat(sessionId: string): void {
    const ids = [...this.permissionState(), ...this.questionState(), ...this.modelChoiceState()]
      .filter((prompt) => this.rootSession(prompt.sessionId)?.id === sessionId)
      .map((prompt) => prompt.requestId);
    this.dismissedPromptState.update((state) => new Set([...state, ...ids]));
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
    // Picking a subagent's model waits on the user like a question does.
    const question = [...this.questionState(), ...this.modelChoiceState()];
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
   * Whether the last turn of a session was cut off before the agent finished
   * (the app closed, or the machine slept mid-reply) and can be continued.
   */
  interruptedFor(sessionId: string): boolean {
    return this.sessionsState()[sessionId]?.interrupted ?? false;
  }

  /**
   * Resumes a session whose last turn paused at the tool-iteration limit or
   * was cut off. With `autoContinue`, the session keeps going past future
   * limits too.
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
    await Promise.all(projects.map((project) => this.reloadSessions(project.id)));
  }

  /** Refreshes the project list and its counts without reloading every project's sessions. */
  private async refreshProjectList(): Promise<void> {
    this.projectsState.set(await api.listProjects());
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
    this.ensureBrowseProject();
  }

  async cloneProject(url: string, path: string): Promise<Project> {
    const project = await api.gitClone(url, path);
    await this.reloadProjects();
    this.ensureBrowseProject();
    return project;
  }

  async removeProject(projectId: string): Promise<void> {
    const sessionIds = Object.values(this.sessionsState())
      .filter((session) => session.projectId === projectId)
      .map((session) => session.id);
    await api.removeProject(projectId);
    this.forgetSessions(sessionIds);
    this.projectSessionsState.update((state) => {
      const next = { ...state };
      delete next[projectId];
      return next;
    });
    await this.reloadProjects();
    this.ensureBrowseProject();
  }

  projectFor(projectId: string): Project | null {
    return this.projectsState().find((project) => project.id === projectId) ?? null;
  }

  /** Shows `projectId` in the Workspace and Git tabs, with a fresh git view. */
  setBrowseProject(projectId: string): void {
    if (projectId === this.browseProjectState()) {
      return;
    }
    this.gitService.resetView(projectId);
    this.storeBrowseProject(projectId);
  }

  /**
   * Picks a project for the Workspace and Git tabs while none is chosen, or
   * the chosen one is gone: the one of the session on screen, else the first.
   */
  private ensureBrowseProject(): void {
    if (this.browseProject()) {
      return;
    }
    this.storeBrowseProject((this.activeProject() ?? this.projects()[0])?.id ?? null);
  }

  private storeBrowseProject(projectId: string | null): void {
    this.browseProjectState.set(projectId);
    if (projectId) {
      localStorage.setItem(BROWSE_PROJECT_KEY, projectId);
    } else {
      localStorage.removeItem(BROWSE_PROJECT_KEY);
    }
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

  isCompacting(sessionId: string): boolean {
    return this.compactingState()[sessionId] ?? false;
  }

  /**
   * Replaces the active session's history by a summary for the model, which
   * frees its context without leaving the chat. The messages stay visible.
   */
  async compactActiveSession(): Promise<void> {
    const session = this.activeSession();
    if (
      !session ||
      this.isStreaming(session.id) ||
      this.isCompacting(session.id) ||
      this.isHandover(session.id)
    ) {
      return;
    }
    this.setCompacting(session.id, true);
    this.setError(session.id, null);
    try {
      const result = await api.compactSession(session.id);
      this.appendMessage(session.id, result.message);
      // The last request's numbers describe the history before it was compacted.
      this.contextUsageState.update((state) => {
        const usage = state[session.id];
        if (!usage) {
          return state;
        }
        const fixed = usage.systemTokens + usage.toolSchemaTokens;
        return {
          ...state,
          [session.id]: {
            ...usage,
            usedTokens: fixed + result.usedTokens,
            historyTokens: result.usedTokens,
            toolOutputTokens: 0,
          },
        };
      });
      void this.refreshSpend();
    } catch (error) {
      this.setError(session.id, String(error));
    } finally {
      this.setCompacting(session.id, false);
    }
  }

  private setCompacting(sessionId: string, value: boolean): void {
    if (this.isCompacting(sessionId) === value) {
      return;
    }
    this.compactingState.update((state) => {
      const next = { ...state };
      if (value) {
        next[sessionId] = true;
      } else {
        delete next[sessionId];
      }
      return next;
    });
  }

  /** The MCP server the session's turn is waiting for, while it starts one. */
  mcpStartingFor(sessionId: string): string | null {
    return this.mcpStartingState()[sessionId] ?? null;
  }

  /** What the session's latest turn could not use of its MCP servers. */
  mcpIssuesFor(sessionId: string): string[] {
    return this.mcpIssuesState()[sessionId] ?? NO_MCP_ISSUES;
  }

  private setMcpStarting(sessionId: string, server: string | null): void {
    if (this.mcpStartingFor(sessionId) === server) {
      return;
    }
    this.mcpStartingState.update((state) => {
      const next = { ...state };
      if (server) {
        next[sessionId] = server;
      } else {
        delete next[sessionId];
      }
      return next;
    });
  }

  private setMcpIssues(sessionId: string, issues: string[]): void {
    if (issues.length === 0 && this.mcpIssuesFor(sessionId).length === 0) {
      return;
    }
    this.mcpIssuesState.update((state) => {
      const next = { ...state };
      if (issues.length > 0) {
        next[sessionId] = issues;
      } else {
        delete next[sessionId];
      }
      return next;
    });
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

  /** Opens the debugger for the active session, with `exportLog` on its export dialog. */
  openDebug(exportLog = false): void {
    const sessionId = this.activeState();
    if (!sessionId) {
      return;
    }
    this.debugSessionState.set(sessionId);
    this.debugExportState.set(exportLog);
    void this.loadAgentTree(sessionId);
  }

  setDebugExport(open: boolean): void {
    this.debugExportState.set(open);
  }

  closeDebug(): void {
    this.debugSessionState.set(null);
    this.debugExportState.set(false);
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
    void this.send(next);
  }

  /**
   * Sends a prompt and follows its turn to the end. Resolves to whether the
   * backend took the prompt. It did not when nothing was sent, or when it
   * turned the prompt down before storing it: for a model without an API key,
   * say, or a project folder that is gone. Such a prompt is not in the chat,
   * so the caller still has to keep it; one from the queue is queued again.
   */
  async send(args: SendMessageArgs): Promise<boolean> {
    const session = this.sessionsState()[args.sessionId];
    if (!session || this.isStreaming(args.sessionId)) {
      return false;
    }
    // Consume the head of the queue as soon as the send actually starts, so a
    // dispatched prompt leaves the queue immediately instead of lingering until
    // the whole turn (and its refreshes) finishes.
    const queued = this.queueService.first(args.sessionId) === args;
    this.queueService.removeFirst(args.sessionId, args);
    const now = Date.now();
    const localId = `local-${now}`;
    if (!args.resume) {
      this.appendMessage(args.sessionId, {
        id: localId,
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
    this.patchSession(args.sessionId, { limitReached: false, interrupted: false });
    let taken = true;
    await this.followTurn(
      session,
      (channel) => api.sendMessage(args, channel),
      () => {
        taken = false;
        // Reloading the chat took the optimistic message away, unless that failed too.
        this.messagesState.update((state) => {
          const messages = state[args.sessionId] ?? [];
          return messages.some((message) => message.id === localId)
            ? { ...state, [args.sessionId]: messages.filter((message) => message.id !== localId) }
            : state;
        });
        if (queued) {
          // Back to the head of the queue, in front of what waits behind it.
          const waiting = this.queueService.forSession(args.sessionId);
          this.queueService.clear(args.sessionId);
          for (const item of [args, ...waiting]) {
            this.queueService.enqueue(item);
          }
        }
      },
    );
    return taken;
  }

  /**
   * Picks up turns that are still running in the backend without a channel in
   * this page, e.g. after a webview reload: marks them as streaming so Stop
   * works, restores the prompts they wait on and attaches a fresh channel.
   */
  async resumeRunningTurns(): Promise<void> {
    let running: RunningTurns;
    try {
      running = await api.listRunningTurns();
    } catch {
      return;
    }
    for (const { sessionId, event } of running.permissions) {
      this.addPrompt(this.permissionState, { ...event, sessionId });
    }
    for (const { sessionId, event } of running.questions) {
      this.addPrompt(this.questionState, { ...event, sessionId });
    }
    for (const { sessionId, event } of running.modelChoices) {
      this.addPrompt(this.modelChoiceState, { ...event, sessionId });
    }
    for (const sessionId of running.sessionIds) {
      const session = this.sessionsState()[sessionId];
      if (!session || this.isStreaming(sessionId)) {
        continue;
      }
      for (const agent of this.subAgentsFor(sessionId)) {
        if (agent.agentStatus === 'running') {
          this.setStreaming(agent.id, true);
        }
      }
      void this.followTurn(session, (channel) => api.attachSession(sessionId, channel));
    }
  }

  /**
   * Streams a turn's events into the UI until `run` settles, then refreshes
   * what the turn changed. `run` hands the channel to the backend, either to
   * start a turn or to attach to one that is already running. `refused` is
   * called when `run` failed before a turn began, instead of going on with
   * the queue: the next prompt would be turned down for the same reason.
   */
  private async followTurn(
    session: Session,
    run: (channel: Channel<RoutedEvent>) => Promise<unknown>,
    refused?: () => void,
  ): Promise<void> {
    const sessionId = session.id;
    this.setStreaming(sessionId, true);
    this.setLiveTools(sessionId, []);
    // What the turn before could not use says nothing about this one.
    this.setMcpIssues(sessionId, []);
    const turn = { begun: false };
    let failed = false;
    try {
      await run(this.turnChannel(session, turn));
    } catch (error) {
      failed = true;
      if (!this.errorFor(sessionId)) {
        this.setError(sessionId, String(error));
        this.sound.play('error');
      }
    } finally {
      this.flushStreamBuffers();
      this.setLiveTools(sessionId, []);
      // Keep the session marked as streaming until the post-turn refresh has
      // finished, otherwise a new send could start and be clobbered by this
      // still-running `loadMessages`. Refresh failures must not skip the queue
      // drain below (and must not reject `send`).
      try {
        await this.loadMessages(sessionId, true);
        await this.reloadSessions(session.projectId);
        await this.refreshProjectList();
        await this.refreshSpend();
        await this.loadChanges(sessionId);
        await this.loadRules(session.projectId, sessionId);
        await this.loadSubAgents(sessionId);
        await this.refreshFiles(session.projectId);
      } catch (error) {
        console.error('post-send refresh failed', error);
      } finally {
        this.endTurn(sessionId);
      }
      if (failed && !turn.begun && refused) {
        refused();
      } else {
        this.drainQueue(sessionId);
      }
    }
  }

  /**
   * Once a turn is over, none of its subagents run and none of its prompts are
   * open. Their own closing events may have gone to a channel lost in a reload.
   */
  private endTurn(sessionId: string): void {
    const ids = new Set([sessionId, ...(this.subAgentsState()[sessionId] ?? [])]);
    for (const id of ids) {
      this.setStreaming(id, false);
      this.setCompacting(id, false);
      this.setMcpStarting(id, null);
    }
    this.dropPrompts((entry) => ids.has(entry.sessionId));
  }

  /**
   * A channel that applies a turn's streamed events, routed by session id.
   * `turn.begun` is set once the session's turn runs: the backend stores the
   * prompt before a reply starts and before it reports an error as an event,
   * so a failure without either means the prompt was never taken.
   */
  private turnChannel(session: Session, turn: { begun: boolean }): Channel<RoutedEvent> {
    const assistantIds: Record<string, string | null> = {};
    const channel = new Channel<RoutedEvent>();
    channel.onmessage = ({ sessionId, event }) => {
      if (sessionId === session.id && (event.kind === 'started' || event.kind === 'error')) {
        turn.begun = true;
      }
      switch (event.kind) {
        case 'started':
          this.flushStreamBuffers();
          // A compaction that was under way is over, whether or not it worked.
          this.setCompacting(sessionId, false);
          assistantIds[sessionId] = event.message.id;
          this.appendMessage(sessionId, event.message);
          break;
        case 'compacting':
          this.flushStreamBuffers();
          this.setCompacting(sessionId, true);
          break;
        case 'compacted':
          this.flushStreamBuffers();
          this.setCompacting(sessionId, false);
          this.appendMessage(sessionId, event.message);
          break;
        case 'note':
          this.flushStreamBuffers();
          this.appendMessage(sessionId, event.message);
          break;
        case 'mcpStarting':
          this.setMcpStarting(sessionId, event.server);
          break;
        case 'mcpReady':
          this.setMcpStarting(sessionId, null);
          this.setMcpIssues(sessionId, event.issues);
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
        case 'contextUsage':
          this.contextUsageState.update((state) => ({
            ...state,
            [sessionId]: {
              usedTokens: event.usedTokens,
              budgetTokens: event.budgetTokens,
              systemTokens: event.systemTokens,
              historyTokens: event.historyTokens,
              toolSchemaTokens: event.toolSchemaTokens,
              toolOutputTokens: event.toolOutputTokens,
            },
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
            live: false,
            status: 'running',
            changes: [],
            attachments: [],
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
            attachments: event.attachments ?? [],
          }));
          break;
        case 'permissionRequest':
          if (this.addPrompt(this.permissionState, { ...event, sessionId })) {
            this.sound.play('permission');
          }
          break;
        case 'permissionResolved':
          this.settleRequest(event.requestId);
          break;
        case 'questionRequest':
          if (this.addPrompt(this.questionState, { ...event, sessionId })) {
            this.sound.play('permission');
          }
          break;
        case 'questionResolved':
          this.settleRequest(event.requestId);
          break;
        case 'modelChoiceRequest':
          if (this.addPrompt(this.modelChoiceState, { ...event, sessionId })) {
            this.sound.play('permission');
          }
          break;
        case 'modelChoiceResolved':
          this.settleRequest(event.requestId);
          break;
        case 'changes':
          this.flushStreamBuffers();
          this.changesState.update((state) => ({ ...state, [sessionId]: event.changes }));
          void this.reloadSessions(session.projectId);
          void this.refreshFiles(session.projectId);
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
        case 'interrupted':
          this.flushStreamBuffers();
          this.replaceMessage(sessionId, event.message);
          this.patchSession(sessionId, { interrupted: true });
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
    return channel;
  }

  /** Shows a prompt unless it is already shown or was settled; `true` if added. */
  private addPrompt<T extends { requestId: string }>(
    prompts: WritableSignal<T[]>,
    prompt: T,
  ): boolean {
    if (
      this.settledRequests.has(prompt.requestId) ||
      prompts().some((entry) => entry.requestId === prompt.requestId)
    ) {
      return false;
    }
    prompts.update((state) => [...state, prompt]);
    return true;
  }

  /**
   * Removes an answered or withdrawn prompt. The id is remembered because a
   * re-attached turn can replay a prompt after it was resolved.
   */
  private settleRequest(requestId: string): void {
    this.settledRequests.add(requestId);
    this.dropPrompts((entry) => entry.requestId === requestId);
  }

  /** Removes matching permission prompts, questions and model choices. */
  private dropPrompts(
    drop: (entry: PendingPermission | PendingQuestion | PendingModelChoice) => boolean,
  ): void {
    const keep = <T extends PendingPermission | PendingQuestion | PendingModelChoice>(
      state: T[],
    ): T[] => (state.some(drop) ? state.filter((entry) => !drop(entry)) : state);
    this.permissionState.update(keep);
    this.questionState.update(keep);
    this.modelChoiceState.update(keep);
  }

  /**
   * Stops the turn behind a session. The backend stops the session's own
   * turn (a message sent from a subagent's tab) and otherwise the running
   * ancestor turn that drives the subagent.
   */
  async stop(sessionId: string): Promise<void> {
    await api.stopGeneration(sessionId);
  }

  async resolvePermission(
    decision: 'allow_once' | 'allow_session' | 'allow_always' | 'deny' | 'deny_always',
    rulesOverride?: CommandRule[],
    foldersOverride?: string[],
    hostsOverride?: string[],
    websiteRule?: string,
    secretFolders?: string[],
  ): Promise<void> {
    const request = this.permission();
    if (!request) {
      return;
    }
    const isCommand = request.promptKind === 'command';
    // A website prompt may send the rule the user edited; the backend saves
    // it only while it still covers the requested host.
    const siteRule = websiteRule?.trim() || request.suggestedRule;
    const rules = !isCommand && siteRule ? [siteRule] : null;
    const commandRules = isCommand ? rulesOverride ?? null : null;
    const hosts = isCommand ? hostsOverride ?? null : null;
    if (isCommand && secretFolders?.length) {
      // Folders whose sensitive files the user released; the backend keeps
      // only the ones the prompt proposed.
      await api.resolvePermission(
        request.requestId,
        decision,
        rules,
        request.folder,
        request.promptKind,
        commandRules,
        foldersOverride ?? null,
        hosts,
        secretFolders,
      );
    } else {
      await api.resolvePermission(
        request.requestId,
        decision,
        rules,
        request.folder,
        request.promptKind,
        commandRules,
        foldersOverride ?? null,
        hosts,
      );
    }
    // Allow-always/deny-always persist a rule in settings; refresh so the
    // settings lists reflect it immediately.
    if (decision === 'allow_always' || decision === 'deny_always') {
      await this.settings.reload();
    }
    this.settleRequest(request.requestId);
  }

  async resolveQuestion(requestId: string, answers: QuestionAnswer[] | null): Promise<void> {
    await api.resolveQuestion(requestId, answers);
    this.settleRequest(requestId);
  }

  /** Answers a model choice with the picked model id; `null` skips it. */
  async resolveModelChoice(requestId: string, model: string | null): Promise<void> {
    await api.resolveModelChoice(requestId, model);
    this.settleRequest(requestId);
  }

  async updateSession(args: UpdateSessionArgs): Promise<void> {
    const session = await api.updateSession(args);
    this.upsertSession(session);
  }

  /**
   * Switches the session shown between planning and the mode it was in before
   * (coding unless it left another one for planning).
   */
  async togglePlanMode(): Promise<void> {
    const session = this.activeAgent();
    if (!session) {
      return;
    }
    const modes = this.settings.modes();
    const current = resolveMode(modes, session.modeId ?? this.settings.settings()?.defaultModeId);
    const target = planToggleTarget(modes, current, this.modeBeforePlan.get(session.id));
    if (!target || target.id === current?.id) {
      return;
    }
    if (current && !current.planOnly) {
      this.modeBeforePlan.set(session.id, current.id);
    }
    await this.updateSession({ sessionId: session.id, modeId: target.id });
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
    // The backend deletes the chat together with its subagent sessions.
    const deleted = this.sessionTree(sessionId);
    await api.deleteSession(sessionId);
    this.forgetSessions(deleted);
    if (session) {
      await this.reloadSessions(session.projectId);
    }
  }

  /** A session plus every subagent session below it. */
  private sessionTree(sessionId: string): string[] {
    const sessions = Object.values(this.sessionsState());
    const tree = [sessionId];
    for (let index = 0; index < tree.length; index++) {
      for (const session of sessions) {
        if (session.parentSessionId === tree[index] && !tree.includes(session.id)) {
          tree.push(session.id);
        }
      }
    }
    return tree;
  }

  /**
   * Drops deleted sessions from every per-session store and closes their
   * tabs: `reloadSessions` only adds and updates entries, so it never removes
   * a deleted session (or its subagents) on its own.
   */
  private forgetSessions(sessionIds: string[]): void {
    if (sessionIds.length === 0) {
      return;
    }
    const gone = new Set(sessionIds);
    const without = <T>(state: Record<string, T>): Record<string, T> => {
      const next = { ...state };
      for (const id of gone) {
        delete next[id];
      }
      return next;
    };
    for (const id of sessionIds) {
      this.clearComposerDraft(id);
      this.clearComposerAttachments(id);
    }
    this.sessionsState.update(without);
    this.messagesState.update(without);
    this.changesState.update(without);
    this.streamingState.update(without);
    this.errorsState.update(without);
    this.subAgentsState.update((state) => {
      const next = without(state);
      for (const [parent, ids] of Object.entries(next)) {
        if (ids.some((id) => gone.has(id))) {
          next[parent] = ids.filter((id) => !gone.has(id));
        }
      }
      return next;
    });
    this.viewingState.update((state) => {
      const next = without(state);
      for (const [root, agent] of Object.entries(next)) {
        if (gone.has(agent)) {
          delete next[root];
        }
      }
      return next;
    });
    for (const id of sessionIds) {
      this.closeTab(id);
    }
  }

  /**
   * Re-reads what shows the files of `projectId` after a turn changed them:
   * the tree, the file and the diff that are open, and the git views. Changes
   * reported while this runs are picked up by one more pass.
   */
  private refreshFiles(projectId: string): Promise<void> {
    const running = this.fileRefreshes.get(projectId);
    if (running) {
      running.stale = true;
      return running.done;
    }
    const refresh = { stale: false, done: Promise.resolve() };
    refresh.done = (async () => {
      try {
        do {
          refresh.stale = false;
          await this.loadFiles(projectId);
        } while (refresh.stale);
      } catch (error) {
        console.error('file refresh failed', error);
      } finally {
        this.fileRefreshes.delete(projectId);
      }
    })();
    this.fileRefreshes.set(projectId, refresh);
    return refresh.done;
  }

  private async loadFiles(projectId: string): Promise<void> {
    const loads: Promise<void>[] = [
      this.editorService.loadWorkspaceEntries(projectId, true),
      this.gitService.followWorkingTree(projectId),
    ];
    // The editor shows the browsed project, the diff beside the chat the active session's.
    const open = this.editorService.activeFileFor(projectId);
    if (open && this.browseProjectState() === projectId) {
      loads.push(this.loadEditorFile(projectId, open));
    }
    const shown = this.diffSource;
    if (shown && this.activeSession()?.projectId === projectId) {
      loads.push(this.selectChange(shown.sessionId, shown.path));
    }
    await Promise.all(loads);
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
    const source = { sessionId, path };
    this.diffSource = source;
    const diff = await api.getFileDiff(sessionId, path).catch(() => null);
    // A newer selection, or clearing the diff, wins over a slow load.
    if (this.diffSource === source) {
      this.diffState.set(diff);
    }
  }

  clearDiff(): void {
    this.diffSource = null;
    this.diffState.set(null);
  }

  /** The active session when it works in `projectId`: its changes apply to that project's files. */
  sessionIn(projectId: string): Session | null {
    const session = this.activeSession();
    return session?.projectId === projectId ? session : null;
  }

  async loadEditorFile(projectId: string, path: string, force = false): Promise<void> {
    const session = this.sessionIn(projectId);
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

  setProjectSort(sort: ProjectSort): void {
    this.projectSortState.set(sort);
    localStorage.setItem(PROJECT_SORT_KEY, sort);
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
      const tabs: LeftTab[] = ['sessions', 'workspace', 'git'];
      const index = tabs.indexOf(this.leftTabState());
      this.setLeftTab(tabs[(index + direction + tabs.length) % tabs.length]);
    } else if (panel === 'right') {
      const tabs: RightTab[] = ['changes', 'session', 'prompts', 'modes'];
      const index = tabs.indexOf(this.rightTabState());
      this.setRightTab(tabs[(index + direction + tabs.length) % tabs.length]);
    }
  }

  /**
   * Opens a chat of `projectId` with `insert` added to its composer, e.g. diff
   * lines from the git view the user wants to ask about: the active session
   * when it works in that project, else the newest open one, else a new one.
   */
  async askInChat(projectId: string, insert: ComposerInsert): Promise<void> {
    const session =
      this.sessionIn(projectId) ??
      this.tabs()
        .filter((tab) => tab.projectId === projectId)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    this.setLeftTab('sessions');
    if (session) {
      this.openTab(session.id);
    } else {
      await this.newSession(projectId);
    }
    this.composerInsertState.set(insert);
  }

  consumeComposerInsert(): void {
    this.composerInsertState.set(null);
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
    const rules = await api.getProjectRules(projectId, sessionId).catch(() => []);
    // There is one list, for the chat on screen. A turn that ends in another
    // chat, or the slow answer for one that was left, must not replace it.
    if (
      sessionId === null ||
      sessionId === this.activeState() ||
      sessionId === this.activeAgentId()
    ) {
      this.rulesState.set(rules);
    }
  }

  async loadGitInfo(projectId: string): Promise<void> {
    return this.gitService.loadInfo(projectId);
  }

  /** Reverts a session to one of its prompts; a failure shows as the session's error. */
  async revertToMessage(messageId: string, restoreFiles: boolean): Promise<RevertResult | null> {
    const sessionId = this.sessionIdForMessage(messageId) ?? this.activeAgent()?.id ?? null;
    let result: RevertResult;
    try {
      result = await api.revertToMessage(messageId, restoreFiles);
    } catch (error) {
      if (sessionId) {
        this.setError(sessionId, String(error));
      }
      return null;
    }
    if (sessionId) {
      this.pruneMessagesFrom(sessionId, messageId);
      // The turn that was cut off, or that stopped at the tool limit, is among
      // the messages taken back, and the backend resets both marks with them.
      this.patchSession(sessionId, { interrupted: false, limitReached: false });
      this.setLiveTools(sessionId, []);
      await this.loadMessages(sessionId, true);
      await this.loadChanges(sessionId);
      this.clearDiff();
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
    // Cheap safety net for a turn that started after the last resume.
    void this.resumeRunningTurns();
    this.clearDiff();
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
        const { sessionId, callId } = entry;
        const first = this.liveToolsFor(sessionId).some(
          (tool) => tool.callId === callId && !tool.output,
        );
        this.patchLiveTool(sessionId, callId, (tool) => ({
          ...tool,
          output: latestOutput(tool.output + entry.text),
        }));
        if (first) {
          // Most commands are over at once: only one that is still running a
          // moment after it began to print has its output opened in the chat.
          setTimeout(() => {
            this.patchLiveTool(sessionId, callId, (tool) =>
              tool.status === 'running' ? { ...tool, live: true } : tool,
            );
          }, LIVE_OUTPUT_AFTER_MS);
        }
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
