import { Injectable, computed, inject, signal } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { api } from './api';
import {
  FileChange,
  FileDiff,
  GitInfo,
  LiveToolCall,
  Message,
  PendingPermission,
  PendingQuestion,
  ProcessInfo,
  Project,
  ProjectRule,
  QuestionAnswer,
  RevertResult,
  RoutedEvent,
  SendMessageArgs,
  Session,
  SpendSummary,
  UpdateSessionArgs,
  WorkspaceEntry,
  WorkspaceFile,
} from './models';
import { SettingsService } from './settings.service';
import { SoundService } from './sound.service';

const TABS_KEY = 'pumr.tabs';
const ACTIVE_KEY = 'pumr.activeTab';
const OPEN_FILES_KEY = 'pumr.workspace.openFiles';

interface PersistedOpenFiles {
  files?: string[];
  active?: string | null;
}

@Injectable({ providedIn: 'root' })
export class WorkspaceService {
  private readonly settings = inject(SettingsService);
  private readonly sound = inject(SoundService);

  private readonly projectsState = signal<Project[]>([]);
  private readonly sessionsState = signal<Record<string, Session>>({});
  private readonly projectSessionsState = signal<Record<string, string[]>>({});
  private readonly tabsState = signal<string[]>([]);
  private readonly activeState = signal<string | null>(null);
  private readonly messagesState = signal<Record<string, Message[]>>({});
  private readonly streamingState = signal<Record<string, boolean>>({});
  private readonly errorsState = signal<Record<string, string | null>>({});
  private readonly spendState = signal<SpendSummary | null>(null);
  private readonly liveToolsState = signal<Record<string, LiveToolCall[]>>({});
  private readonly changesState = signal<Record<string, FileChange[]>>({});
  private readonly selectedPathState = signal<Record<string, string | null>>({});
  private readonly diffState = signal<FileDiff | null>(null);
  private readonly workspaceEntriesState = signal<Record<string, WorkspaceEntry[]>>({});
  private readonly openFilesState = signal<Record<string, string[]>>({});
  private readonly activeOpenFileState = signal<Record<string, string | null>>({});
  private readonly editorContentState = signal<Record<string, WorkspaceFile>>({});
  private readonly editorDiffState = signal<Record<string, FileDiff>>({});
  private readonly editorDirtyState = signal<Record<string, boolean>>({});
  private readonly leftTabState = signal<'projects' | 'workspace'>('projects');
  private readonly sessionViewState = signal<'projects' | 'history'>('projects');
  private readonly rulesState = signal<ProjectRule[]>([]);
  private readonly gitState = signal<Record<string, GitInfo>>({});
  private readonly processesState = signal<ProcessInfo[]>([]);
  private readonly permissionState = signal<PendingPermission[]>([]);
  private readonly questionState = signal<PendingQuestion[]>([]);
  private readonly draftState = signal<string | null>(null);
  private readonly handoverState = signal<Record<string, boolean>>({});
  private readonly scrollTargetState = signal<{ id: string; nonce: number } | null>(null);
  private readonly subAgentsState = signal<Record<string, string[]>>({});
  private readonly viewingState = signal<Record<string, string>>({});
  private readonly showArchivedState = signal(false);
  private readonly projectEditorState = signal<string | null>(null);
  private scrollNonce = 0;
  private processTimer: ReturnType<typeof setInterval> | null = null;
  private readonly autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  readonly projects = this.projectsState.asReadonly();
  readonly spend = this.spendState.asReadonly();
  readonly activeSessionId = this.activeState.asReadonly();
  readonly permission = computed<PendingPermission | null>(() => this.permissionState()[0] ?? null);
  readonly question = computed<PendingQuestion | null>(() => this.questionState()[0] ?? null);
  readonly processes = this.processesState.asReadonly();
  readonly rules = this.rulesState.asReadonly();
  readonly activeDiff = this.diffState.asReadonly();
  readonly editorContent = this.editorContentState.asReadonly();
  readonly editorDiff = this.editorDiffState.asReadonly();
  readonly leftTab = this.leftTabState.asReadonly();
  readonly sessionView = this.sessionViewState.asReadonly();
  readonly pendingDraft = this.draftState.asReadonly();
  readonly handovers = this.handoverState.asReadonly();
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
    return project ? (this.gitState()[project.id] ?? null) : null;
  });

  constructor() {
    const stored = this.readJson<Record<string, PersistedOpenFiles>>(OPEN_FILES_KEY, {});
    const files: Record<string, string[]> = {};
    const active: Record<string, string | null> = {};
    for (const [projectId, entry] of Object.entries(stored)) {
      files[projectId] = Array.isArray(entry?.files) ? entry.files : [];
      active[projectId] = entry?.active ?? null;
    }
    this.openFilesState.set(files);
    this.activeOpenFileState.set(active);
  }

  async init(): Promise<void> {
    await this.reloadProjects();
    await this.refreshSpend();
    await this.refreshProcesses();
    this.startProcessPolling();
    const storedTabs = this.readJson<string[]>(TABS_KEY, []);
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
    return this.gitState()[projectId] ?? null;
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

  async reloadProjects(): Promise<void> {
    const projects = await api.listProjects();
    this.projectsState.set(projects);
    for (const project of projects) {
      await this.reloadSessions(project.id);
    }
  }

  async reloadSessions(projectId: string): Promise<void> {
    const sessions = await api.listSessions(projectId, this.showArchivedState());
    this.sessionsState.update((state) => {
      const next = { ...state };
      for (const session of sessions) {
        next[session.id] = session;
      }
      return next;
    });
    this.projectSessionsState.update((state) => ({
      ...state,
      [projectId]: sessions.map((session) => session.id),
    }));
  }

  async toggleShowArchived(): Promise<void> {
    this.showArchivedState.update((value) => !value);
    await Promise.all(this.projectsState().map((project) => this.reloadSessions(project.id)));
  }

  async addProject(): Promise<void> {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Select project folder',
    });
    if (!selected || Array.isArray(selected)) {
      return;
    }
    await api.addProject(selected);
    await this.reloadProjects();
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
        title: `Handover: ${session.title}`.slice(0, 60),
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
    this.persistTabs();
    void this.activateSession(sessionId);
  }

  closeTab(sessionId: string): void {
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
  }

  async loadMessages(sessionId: string, force = false): Promise<void> {
    if (!force && this.messagesState()[sessionId]) {
      return;
    }
    const messages = await api.listMessages(sessionId);
    this.messagesState.update((state) => ({ ...state, [sessionId]: messages }));
  }

  async send(args: SendMessageArgs): Promise<void> {
    const session = this.sessionsState()[args.sessionId];
    if (!session || this.isStreaming(args.sessionId)) {
      return;
    }
    const now = Date.now();
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
    });
    this.setError(args.sessionId, null);
    this.setStreaming(args.sessionId, true);
    this.setLiveTools(args.sessionId, []);

    const assistantIds: Record<string, string | null> = {};
    const channel = new Channel<RoutedEvent>();
    channel.onmessage = ({ sessionId, event }) => {
      switch (event.kind) {
        case 'started':
          assistantIds[sessionId] = event.message.id;
          this.appendMessage(sessionId, event.message);
          break;
        case 'delta':
          this.patchMessage(sessionId, assistantIds[sessionId] ?? null, (message) => ({
            ...message,
            content: message.content + event.text,
          }));
          break;
        case 'reasoning':
          this.patchMessage(sessionId, assistantIds[sessionId] ?? null, (message) => ({
            ...message,
            reasoning: message.reasoning + event.text,
          }));
          break;
        case 'usage':
          this.patchMessage(sessionId, assistantIds[sessionId] ?? null, (message) => ({
            ...message,
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            cachedTokens: event.cachedTokens,
            cost: event.cost,
          }));
          break;
        case 'assistant':
          this.replaceMessage(sessionId, event.message);
          assistantIds[sessionId] = null;
          break;
        case 'toolStart':
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
          this.patchLiveTool(sessionId, event.callId, (tool) => ({
            ...tool,
            output: tool.output + event.text,
          }));
          break;
        case 'toolEnd':
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
          this.changesState.update((state) => ({ ...state, [sessionId]: event.changes }));
          void this.reloadSessions(session.projectId);
          break;
        case 'done':
          this.replaceMessage(sessionId, event.message);
          this.upsertSession(event.session);
          void this.refreshSpend();
          this.sound.play('done');
          break;
        case 'stopped':
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
      this.setStreaming(args.sessionId, false);
      await this.loadMessages(args.sessionId, true);
      this.setLiveTools(args.sessionId, []);
      await this.reloadSessions(session.projectId);
      await this.reloadProjects();
      await this.refreshSpend();
      await this.loadChanges(args.sessionId);
      await this.loadRules(session.projectId, args.sessionId);
      await this.loadSubAgents(args.sessionId);
      await this.loadWorkspaceEntries(session.projectId, true);
      const active = this.activeOpenFileState()[session.projectId];
      if (active) {
        void this.loadEditorFile(session.projectId, active);
      }
    }
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessionsState()[sessionId];
    const target = session?.parentSessionId ?? sessionId;
    await api.stopGeneration(target);
  }

  async resolvePermission(
    decision: 'allow_once' | 'allow_always' | 'deny' | 'deny_always',
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

  workspaceEntriesFor(projectId: string): WorkspaceEntry[] {
    return this.workspaceEntriesState()[projectId] ?? [];
  }

  async loadWorkspaceEntries(projectId: string, force = false): Promise<void> {
    if (!force && this.workspaceEntriesState()[projectId]) {
      return;
    }
    try {
      const entries = await api.listWorkspaceEntries(projectId);
      this.workspaceEntriesState.update((state) => ({ ...state, [projectId]: entries }));
    } catch {
      // best effort
    }
  }

  setLeftTab(tab: 'projects' | 'workspace'): void {
    this.leftTabState.set(tab);
  }

  setSessionView(view: 'projects' | 'history'): void {
    this.sessionViewState.set(view);
  }

  openFilesFor(projectId: string): string[] {
    return this.openFilesState()[projectId] ?? [];
  }

  activeFileFor(projectId: string): string | null {
    return this.activeOpenFileState()[projectId] ?? null;
  }

  editorKey(projectId: string, path: string): string {
    return `${projectId}\n${path}`;
  }

  openWorkspaceFile(path: string): void {
    const project = this.activeProject();
    if (!project) {
      return;
    }
    const files = this.openFilesState()[project.id] ?? [];
    if (!files.includes(path)) {
      this.openFilesState.update((state) => ({ ...state, [project.id]: [...files, path] }));
    }
    this.setActiveWorkspaceFile(project.id, path);
  }

  setActiveWorkspaceFile(projectId: string, path: string): void {
    this.activeOpenFileState.update((state) => ({ ...state, [projectId]: path }));
    this.persistOpenFiles();
  }

  closeWorkspaceFile(path: string): void {
    const project = this.activeProject();
    if (!project) {
      return;
    }
    const files = (this.openFilesState()[project.id] ?? []).filter((entry) => entry !== path);
    this.openFilesState.update((state) => ({ ...state, [project.id]: files }));
    const key = this.editorKey(project.id, path);
    const pending = this.editorContentState()[key];
    if (pending && this.editorDirtyState()[key]) {
      void api.writeWorkspaceFile(project.id, path, pending.content).catch(() => undefined);
    }
    this.clearAutoSave(project.id, path);
    this.editorContentState.update((state) => {
      const next = { ...state };
      delete next[key];
      return next;
    });
    this.clearEditorDiff(key);
    this.editorDirtyState.update((state) => {
      const next = { ...state };
      delete next[key];
      return next;
    });
    if (this.activeOpenFileState()[project.id] === path) {
      const next = files[files.length - 1] ?? null;
      this.activeOpenFileState.update((state) => ({ ...state, [project.id]: next }));
    }
    this.persistOpenFiles();
  }

  async loadEditorFile(projectId: string, path: string, force = false): Promise<void> {
    const key = this.editorKey(projectId, path);
    if (!force && this.editorDirtyState()[key]) {
      return;
    }
    const session = this.activeSession();
    const changed = session
      ? this.changesFor(session.id).some((change) => change.path === path)
      : false;
    const [file, diff] = await Promise.all([
      api.readWorkspaceFile(projectId, path).catch(() => null),
      changed && session
        ? api.getFileDiff(session.id, path).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (file) {
      this.editorContentState.update((state) => ({ ...state, [key]: file }));
      this.editorDirtyState.update((state) => {
        const next = { ...state };
        delete next[key];
        return next;
      });
    }
    if (diff) {
      this.editorDiffState.update((state) => ({ ...state, [key]: diff }));
    } else {
      this.clearEditorDiff(key);
    }
  }

  updateEditorContent(projectId: string, path: string, content: string): void {
    const key = this.editorKey(projectId, path);
    const file = this.editorContentState()[key];
    if (!file || file.content === content) {
      return;
    }
    this.editorContentState.update((state) => ({ ...state, [key]: { ...file, content } }));
    this.editorDirtyState.update((state) => ({ ...state, [key]: true }));
    this.scheduleAutoSave(projectId, path);
  }

  isEditorDirty(projectId: string, path: string): boolean {
    return this.editorDirtyState()[this.editorKey(projectId, path)] ?? false;
  }

  async saveEditorFile(projectId: string, path: string): Promise<void> {
    const key = this.editorKey(projectId, path);
    const file = this.editorContentState()[key];
    if (!file) {
      return;
    }
    const saved = file.content;
    try {
      await api.writeWorkspaceFile(projectId, path, saved);
    } catch {
      return;
    }
    const current = this.editorContentState()[key];
    if (current && current.content !== saved) {
      this.scheduleAutoSave(projectId, path);
      return;
    }
    this.editorDirtyState.update((state) => {
      const next = { ...state };
      delete next[key];
      return next;
    });
  }

  async discardEditorFile(projectId: string, path: string): Promise<void> {
    this.clearAutoSave(projectId, path);
    await this.loadEditorFile(projectId, path, true);
  }

  private scheduleAutoSave(projectId: string, path: string): void {
    const key = this.editorKey(projectId, path);
    this.clearAutoSave(projectId, path);
    const timer = setTimeout(() => {
      this.autoSaveTimers.delete(key);
      void this.saveEditorFile(projectId, path);
    }, 500);
    this.autoSaveTimers.set(key, timer);
  }

  private clearAutoSave(projectId: string, path: string): void {
    const key = this.editorKey(projectId, path);
    const timer = this.autoSaveTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.autoSaveTimers.delete(key);
    }
  }

  private clearEditorDiff(key: string): void {
    this.editorDiffState.update((state) => {
      const next = { ...state };
      delete next[key];
      return next;
    });
  }

  private persistOpenFiles(): void {
    const data: Record<string, PersistedOpenFiles> = {};
    for (const [projectId, files] of Object.entries(this.openFilesState())) {
      data[projectId] = { files, active: this.activeOpenFileState()[projectId] ?? null };
    }
    localStorage.setItem(OPEN_FILES_KEY, JSON.stringify(data));
  }

  async loadRules(projectId: string, sessionId: string | null): Promise<void> {
    try {
      this.rulesState.set(await api.getProjectRules(projectId, sessionId));
    } catch {
      this.rulesState.set([]);
    }
  }

  async loadGitInfo(projectId: string): Promise<void> {
    try {
      const info = await api.getGitInfo(projectId);
      this.gitState.update((state) => ({ ...state, [projectId]: info }));
    } catch {
      // best effort
    }
  }

  async revertToMessage(messageId: string, restoreFiles: boolean): Promise<RevertResult> {
    const result = await api.revertToMessage(messageId, restoreFiles);
    const session = this.activeAgent();
    if (session) {
      await this.loadMessages(session.id, true);
      await this.loadChanges(session.id);
      this.diffState.set(null);
      this.draftState.set(result.prompt);
    }
    return result;
  }

  consumeDraft(): void {
    this.draftState.set(null);
  }

  scrollToMessage(messageId: string): void {
    this.scrollNonce += 1;
    this.scrollTargetState.set({ id: messageId, nonce: this.scrollNonce });
  }

  async refreshProcesses(): Promise<void> {
    try {
      this.processesState.set(await api.listProcesses());
    } catch {
      // best effort
    }
  }

  async stopProcess(processId: string): Promise<void> {
    await api.stopProcess(processId);
    await this.refreshProcesses();
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
    this.scrollTargetState.set(null);
    await this.loadMessages(sessionId);
    if (session) {
      await Promise.all([
        this.loadChanges(sessionId),
        this.loadRules(session.projectId, sessionId),
        this.loadGitInfo(session.projectId),
        this.loadSubAgents(sessionId),
        this.loadWorkspaceEntries(session.projectId),
      ]);
      const active = this.activeOpenFileState()[session.projectId];
      if (active) {
        void this.loadEditorFile(session.projectId, active);
      }
    }
    void this.refreshSpend();
  }

  private startProcessPolling(): void {
    if (this.processTimer) {
      return;
    }
    this.processTimer = setInterval(() => void this.refreshProcesses(), 3000);
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
    this.messagesState.update((state) => ({
      ...state,
      [sessionId]: (state[sessionId] ?? []).map((entry) =>
        entry.id === message.id ? message : entry,
      ),
    }));
  }

  private patchMessage(
    sessionId: string,
    messageId: string | null,
    patch: (message: Message) => Message,
  ): void {
    if (!messageId) {
      return;
    }
    this.messagesState.update((state) => ({
      ...state,
      [sessionId]: (state[sessionId] ?? []).map((entry) =>
        entry.id === messageId ? patch(entry) : entry,
      ),
    }));
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

  private readJson<T>(key: string, fallback: T): T {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '') as T;
    } catch {
      return fallback;
    }
  }
}
