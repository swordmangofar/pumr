import type {
  FileChange,
  Message,
  ModelInfo,
  Project,
  QuestionAnswer,
  QuestionItem,
  RoutedEvent,
  Session,
  Settings,
  StreamEvent,
} from '../../src/app/core/models';

/**
 * One step of a scripted agent turn. `send_message` plays the next queued
 * reply's steps in order; without a queued reply it echoes the prompt.
 */
export type FakeStep =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'tool';
      name: string;
      summary: string;
      arguments?: Record<string, unknown>;
      result: string;
      status?: string;
      changes?: FileChange[];
    }
  /** Asks to run `command` and waits for `resolve_permission`. */
  | { kind: 'permission'; command: string; title?: string; justification?: string }
  /** Asks one question and waits for `resolve_question`. */
  | { kind: 'question'; question: QuestionItem }
  /** Waits until the user presses Stop (`stop_generation`). */
  | { kind: 'hang' }
  | { kind: 'error'; message: string };

export interface FakeReply {
  steps: FakeStep[];
}

export interface FakeSeed {
  settings: Settings;
  hasApiKey: boolean;
  projects: Project[];
  sessions: Session[];
  messages: Message[];
  models: ModelInfo[];
  /** What the native folder picker returns; `null` means cancelled. */
  pickFolder: string | null;
  /** What native confirm/ask dialogs return. */
  confirm: boolean;
  replies: FakeReply[];
  /** Milliseconds between streamed chunks. */
  chunkDelayMs: number;
}

export interface FakeCall {
  cmd: string;
  args: Record<string, unknown>;
}

/** What tests can read back from the page as `window.__pumrFake`. */
export interface FakeHandle {
  calls: FakeCall[];
  unhandled: string[];
  state: {
    settings: Settings;
    hasApiKey: boolean;
    projects: Project[];
    sessions: Session[];
    messages: Message[];
  };
  replies: FakeReply[];
  pickFolder: string | null;
  confirm: boolean;
}

/**
 * Stands in for the Rust backend: installs `window.__TAURI_INTERNALS__` so the
 * real `@tauri-apps/api` code paths run unchanged against in-memory state.
 *
 * Runs in the page via `page.addInitScript`, so it must be self-contained:
 * Playwright serialises the function source, and nothing from module scope
 * (other than erased types) is available at runtime.
 */
export function installFakeBackend(seed: FakeSeed): void {
  type Args = Record<string, unknown>;
  type Callback = (payload: unknown) => void;
  interface ChannelLike {
    id: number;
  }

  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

  // A reload re-runs this script; the snapshot makes it behave like the app
  // restarting against the same database instead of a fresh install.
  const STORAGE_KEY = '__pumrFake';
  let restored: FakeHandle | null = null;
  try {
    restored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as FakeHandle | null;
  } catch {
    restored = null;
  }

  let state: FakeHandle['state'] = restored?.state ?? {
    settings: clone(seed.settings),
    hasApiKey: seed.hasApiKey,
    projects: clone(seed.projects),
    sessions: clone(seed.sessions),
    messages: clone(seed.messages),
  };
  const handle: FakeHandle = {
    calls: restored?.calls ?? [],
    unhandled: restored?.unhandled ?? [],
    get state() {
      return state;
    },
    set state(next) {
      state = next;
    },
    replies: restored?.replies ?? clone(seed.replies),
    pickFolder: restored ? restored.pickFolder : seed.pickFolder,
    confirm: restored?.confirm ?? seed.confirm,
  };
  (window as unknown as { __pumrFake: FakeHandle }).__pumrFake = handle;
  const persist = () => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(handle));
    } catch {
      // Best effort: only reload tests depend on it.
    }
  };
  window.addEventListener('pagehide', persist);

  // --- Tauri IPC primitives -------------------------------------------------

  const callbacks = new Map<number, Callback>();
  let nextCallbackId = 1;
  const transformCallback = (callback?: Callback, once = false): number => {
    const id = nextCallbackId++;
    callbacks.set(id, (payload) => {
      if (once) {
        callbacks.delete(id);
      }
      callback?.(payload);
    });
    return id;
  };
  const runCallback = (id: number, payload: unknown) => callbacks.get(id)?.(payload);

  /** Sends ordered messages to a frontend `Channel`, like Tauri's IPC does. */
  function channelSender(channel: ChannelLike) {
    let index = 0;
    return {
      send(message: unknown) {
        runCallback(channel.id, { index: index++, message });
      },
      end() {
        runCallback(channel.id, { index: index++, end: true });
      },
    };
  }

  // --- helpers --------------------------------------------------------------

  let idCounter = 0;
  const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++idCounter}`;
  const now = () => Date.now();

  function message(sessionId: string, role: Message['role'], content: string): Message {
    const created = now();
    return {
      id: newId('msg'),
      sessionId,
      seq: created + idCounter,
      role,
      content,
      reasoning: '',
      model: role === 'assistant' ? (findSession(sessionId)?.model ?? null) : null,
      provider: null,
      cost: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      createdAt: created,
      toolCalls: [],
      toolCallId: null,
      toolName: null,
      status: null,
      changes: [],
      baseCommit: null,
      attachments: [],
      mentions: [],
      context: '',
      durationMs: 0,
    };
  }

  function findSession(id: unknown): Session | undefined {
    return state.sessions.find((session) => session.id === id);
  }

  function requireSession(id: unknown): Session {
    const session = findSession(id);
    if (!session) {
      throw `Session ${String(id)} not found`;
    }
    return session;
  }

  function projectView(project: Project): Project {
    const sessions = state.sessions.filter(
      (session) => session.projectId === project.id && !session.parentSessionId,
    );
    return {
      ...project,
      sessionCount: sessions.length,
      totalCost: sessions.reduce((sum, session) => sum + session.cost, 0),
    };
  }

  function spend(sessionId: unknown) {
    const total = state.sessions.reduce((sum, session) => sum + session.cost, 0);
    return {
      totalCost: total,
      todayCost: total,
      sessionCost: findSession(sessionId)?.cost ?? 0,
      budgetUsd: 0,
      remainingUsd: null,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
    };
  }

  // --- turns ----------------------------------------------------------------

  interface Waiter {
    sessionId: string;
    resolve: (value: unknown) => void;
  }
  const permissionWaiters = new Map<string, Waiter>();
  const questionWaiters = new Map<string, Waiter>();
  const stopWaiters = new Map<string, () => void>();

  async function runTurn(args: Args): Promise<Message> {
    const sessionId = String(args['sessionId']);
    const session = requireSession(sessionId);
    const channel = channelSender(args['channel'] as ChannelLike);
    const emit = (event: StreamEvent) => channel.send({ sessionId, event } satisfies RoutedEvent);

    const prompt = String(args['content'] ?? '');
    if (!args['resume']) {
      const user = message(sessionId, 'user', prompt);
      user.mentions = (args['mentions'] as Message['mentions']) ?? [];
      user.attachments = (args['attachments'] as Message['attachments']) ?? [];
      state.messages.push(user);
    }
    if (session.title === 'New session' && prompt) {
      session.title = prompt.slice(0, 40);
    }
    if (args['model']) {
      session.model = String(args['model']);
    }

    const reply = handle.replies.shift() ?? {
      steps: [{ kind: 'text', text: `Echo: ${prompt}` } satisfies FakeStep],
    };
    const assistant = message(sessionId, 'assistant', '');
    const started = now();
    emit({ kind: 'started', message: clone(assistant) });

    let stopped = false;
    const stopped$ = new Promise<void>((done) =>
      stopWaiters.set(sessionId, () => {
        stopped = true;
        done();
      }),
    );

    const stream = async (field: 'content' | 'reasoning', text: string) => {
      const kind = field === 'content' ? 'delta' : 'reasoning';
      for (const chunk of text.match(/.{1,12}/gs) ?? []) {
        if (stopped) {
          return;
        }
        assistant[field] += chunk;
        emit({ kind, text: chunk });
        await sleep(seed.chunkDelayMs);
      }
    };

    try {
      for (const step of reply.steps) {
        if (stopped) {
          break;
        }
        switch (step.kind) {
          case 'text':
            await stream('content', step.text);
            break;
          case 'reasoning':
            await stream('reasoning', step.text);
            break;
          case 'tool': {
            const callId = newId('call');
            const argumentsJson = JSON.stringify(step.arguments ?? {});
            emit({
              kind: 'toolStart',
              callId,
              name: step.name,
              summary: step.summary,
              arguments: argumentsJson,
            });
            await sleep(seed.chunkDelayMs);
            assistant.toolCalls.push({ id: callId, name: step.name, arguments: argumentsJson });
            const tool = message(sessionId, 'tool', step.result);
            tool.toolCallId = callId;
            tool.toolName = step.name;
            tool.status = step.status ?? 'ok';
            tool.changes = step.changes ?? [];
            emit({
              kind: 'toolEnd',
              callId,
              name: step.name,
              status: tool.status,
              result: step.result,
              changes: tool.changes,
            });
            state.messages.push(tool);
            break;
          }
          case 'permission': {
            const requestId = newId('perm');
            emit({
              kind: 'permissionRequest',
              requestId,
              promptKind: 'command',
              title: step.title ?? 'Run command?',
              detail: 'The agent wants to run a command.',
              command: step.command,
              path: null,
              folder: null,
              url: null,
              suggestedRule: `${step.command.split(' ')[0]} *`,
              segments: [],
              risk: null,
              scopeOptions: [],
              folders: [],
              hosts: [],
              justification: step.justification ?? null,
            });
            const decision = await Promise.race([
              new Promise((resolve) => permissionWaiters.set(requestId, { sessionId, resolve })),
              stopped$.then(() => 'deny'),
            ]);
            permissionWaiters.delete(requestId);
            const allowed = String(decision).startsWith('allow');
            emit({ kind: 'permissionResolved', requestId, allowed });
            const callId = newId('call');
            emit({
              kind: 'toolStart',
              callId,
              name: 'bash',
              summary: step.command,
              arguments: JSON.stringify({ command: step.command }),
            });
            emit({
              kind: 'toolEnd',
              callId,
              name: 'bash',
              status: allowed ? 'ok' : 'denied',
              result: allowed ? 'ok' : 'The user denied this command.',
              changes: [],
            });
            break;
          }
          case 'question': {
            const requestId = newId('question');
            emit({ kind: 'questionRequest', requestId, questions: [step.question] });
            const answers = (await Promise.race([
              new Promise((resolve) => questionWaiters.set(requestId, { sessionId, resolve })),
              stopped$.then(() => null),
            ])) as QuestionAnswer[] | null;
            questionWaiters.delete(requestId);
            emit({ kind: 'questionResolved', requestId, answers });
            break;
          }
          case 'hang':
            await stopped$;
            break;
          case 'error':
            emit({ kind: 'error', message: step.message });
            throw step.message;
        }
      }

      assistant.durationMs = now() - started;
      if (stopped) {
        assistant.status = 'stopped';
        state.messages.push(assistant);
        emit({ kind: 'stopped', message: clone(assistant) });
      } else {
        assistant.completionTokens = assistant.content.length;
        assistant.cost = 0.0012;
        session.cost += assistant.cost;
        emit({
          kind: 'usage',
          promptTokens: 1200,
          completionTokens: assistant.completionTokens,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          cost: assistant.cost,
        });
        state.messages.push(assistant);
        session.updatedAt = now();
        session.messageCount = state.messages.filter((m) => m.sessionId === sessionId).length;
        emit({ kind: 'done', message: clone(assistant), session: clone(session) });
      }
      return clone(assistant);
    } finally {
      stopWaiters.delete(sessionId);
      channel.end();
    }
  }

  // --- command table --------------------------------------------------------

  const handlers: Record<string, (args: Args) => unknown> = {
    get_settings: () => clone(state.settings),
    save_settings: (args) => {
      state.settings = clone(args['settings'] as Settings);
      return clone(state.settings);
    },
    get_default_system_prompts: () => ({
      defaultSystemPrompt: state.settings.defaultSystemPrompt,
      securitySystemPrompt: state.settings.securitySystemPrompt,
      testingSystemPrompt: state.settings.testingSystemPrompt,
      architectureSystemPrompt: state.settings.architectureSystemPrompt,
      userSystemPrompts: [],
    }),
    get_default_modes: () => clone(state.settings.modes),
    suspend_window_shortcut: () => null,
    has_api_key: () => state.hasApiKey,
    set_api_key: () => {
      state.hasApiKey = true;
      return null;
    },
    delete_api_key: () => {
      state.hasApiKey = false;
      return null;
    },
    list_models: () => clone(seed.models),
    list_endpoints: () => [],
    list_providers: () => [],

    list_projects: () => state.projects.map(projectView),
    add_project: (args) => {
      const path = String(args['path']);
      const existing = state.projects.find((project) => project.path === path);
      if (existing) {
        return projectView(existing);
      }
      const project: Project = {
        id: newId('project'),
        path,
        name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
        createdAt: now(),
        lastOpenedAt: now(),
        sessionCount: 0,
        totalCost: 0,
        color: null,
        icon: null,
        iconImage: null,
      };
      state.projects.push(project);
      return projectView(project);
    },
    remove_project: (args) => {
      state.projects = state.projects.filter((project) => project.id !== args['projectId']);
      state.sessions = state.sessions.filter((session) => session.projectId !== args['projectId']);
      return null;
    },
    update_project: (args) => {
      const project = state.projects.find((entry) => entry.id === args['projectId']);
      if (!project) {
        throw 'Project not found';
      }
      Object.assign(project, {
        color: args['color'] ?? null,
        icon: args['icon'] ?? null,
        iconImage: args['iconImage'] ?? null,
      });
      return projectView(project);
    },

    list_sessions: (args) =>
      clone(
        state.sessions
          .filter(
            (session) =>
              session.projectId === args['projectId'] &&
              !session.parentSessionId &&
              (args['includeArchived'] || !session.archived),
          )
          .sort((a, b) => b.updatedAt - a.updatedAt),
      ),
    list_sub_sessions: (args) =>
      clone(state.sessions.filter((session) => session.parentSessionId === args['sessionId'])),
    list_sub_sessions_for_project: (args) =>
      clone(
        state.sessions.filter(
          (session) => session.projectId === args['projectId'] && !!session.parentSessionId,
        ),
      ),
    create_session: (args) => {
      const created = now();
      const session: Session = {
        id: newId('session'),
        projectId: String(args['projectId']),
        title: (args['title'] as string | null) ?? 'New session',
        model: (args['model'] as string | null) ?? null,
        reasoningEffort: (args['reasoningEffort'] as string | null) ?? null,
        provider: (args['provider'] as string | null) ?? null,
        systemPrompt: (args['systemPrompt'] as string | null) ?? null,
        createdAt: created,
        updatedAt: created,
        cost: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        messageCount: 0,
        parentSessionId: null,
        agentStatus: null,
        archived: false,
        modeId: (args['modeId'] as string | null) ?? null,
        limitReached: false,
        autoContinue: false,
      };
      state.sessions.push(session);
      return clone(session);
    },
    update_session: (args) => {
      const session = requireSession(args['sessionId']);
      for (const key of [
        'title',
        'model',
        'reasoningEffort',
        'provider',
        'systemPrompt',
        'modeId',
        'projectId',
      ] as const) {
        if (args[key] !== undefined && args[key] !== null) {
          (session as unknown as Args)[key] = args[key];
        }
      }
      session.updatedAt = now();
      return clone(session);
    },
    set_session_auto_continue: (args) => {
      const session = requireSession(args['sessionId']);
      session.autoContinue = Boolean(args['autoContinue']);
      return clone(session);
    },
    archive_session: (args) => {
      const session = requireSession(args['sessionId']);
      session.archived = Boolean(args['archived']);
      return clone(session);
    },
    delete_session: (args) => {
      state.sessions = state.sessions.filter((session) => session.id !== args['sessionId']);
      state.messages = state.messages.filter((entry) => entry.sessionId !== args['sessionId']);
      return null;
    },
    list_messages: (args) =>
      clone(state.messages.filter((entry) => entry.sessionId === args['sessionId'])),
    get_spend: (args) => spend(args['sessionId']),
    get_spend_stats: () => ({
      totalCost: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      messages: 0,
      sessions: 0,
      daily: [],
      byModel: [],
      bySession: [],
    }),

    send_message: (args) => runTurn(args),
    attach_session: () => false,
    list_running_turns: () => ({ sessionIds: [], permissions: [], questions: [] }),
    stop_generation: (args) => {
      stopWaiters.get(String(args['sessionId']))?.();
      return null;
    },
    resolve_permission: (args) => {
      permissionWaiters.get(String(args['requestId']))?.resolve(args['decision']);
      return null;
    },
    resolve_question: (args) => {
      questionWaiters.get(String(args['requestId']))?.resolve(args['answers']);
      return null;
    },
    summarize_session: () => 'Summary of the previous session.',

    list_processes: () => [],
    get_session_changes: () => [],
    get_project_rules: () => [],
    list_workspace_entries: () => [],
    list_permission_audit: () => [],
    get_git_info: () => ({ isRepo: false, branch: null, head: null }),
    get_file_ignore_catalog: () => [],
    discover_mcp_sources: () => [],
    discover_skills: () => [],
    list_skill_marketplaces: () => [],
    list_installed_mcp_servers: () => [],
    list_installed_marketplace_skills: () => [],
    search_mcp_marketplace: () => [],
    terminal_close_all: () => null,

    'plugin:dialog|open': () => handle.pickFolder,
    'plugin:dialog|confirm': () => handle.confirm,
    'plugin:dialog|ask': () => handle.confirm,
    'plugin:dialog|message': () => null,
    'plugin:app|version': () => '0.0.0-e2e',
    'plugin:app|name': () => 'pumr',
    'plugin:updater|check': () => null,
    'plugin:event|listen': (args) => args['handler'],
    'plugin:event|unlisten': () => null,
    'plugin:event|emit': () => null,
    'plugin:webview|set_webview_zoom': () => null,
    'plugin:path|resolve_directory': () => '/Users/e2e',
  };

  const invoke = async (cmd: string, args: Args = {}): Promise<unknown> => {
    // Channels serialise to `__CHANNEL__:<id>` like they do over real IPC.
    handle.calls.push({ cmd, args: clone(args) });
    const handler = handlers[cmd];
    if (!handler) {
      handle.unhandled.push(cmd);
      persist();
      return null;
    }
    try {
      return await handler(args);
    } finally {
      persist();
    }
  };

  const internals = {
    invoke,
    transformCallback,
    unregisterCallback: (id: number) => callbacks.delete(id),
    runCallback,
    callbacks,
    convertFileSrc: (path: string, protocol = 'asset') =>
      `${protocol}://localhost/${encodeURIComponent(path)}`,
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
    plugins: {},
  };
  Object.assign(window, {
    __TAURI_INTERNALS__: internals,
    __TAURI_EVENT_PLUGIN_INTERNALS__: {
      unregisterListener: (_event: string, id: number) => callbacks.delete(id),
    },
  });
}
