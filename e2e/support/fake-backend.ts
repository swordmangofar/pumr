import type {
  FileChange,
  FileDiff,
  GitStatus,
  Message,
  MessageAttachment,
  ModelInfo,
  PermissionRequestEvent,
  Project,
  ProviderStatus,
  QuestionAnswer,
  QuestionItem,
  RoutedEvent,
  Session,
  Settings,
  StreamEvent,
  WorkspaceEntry,
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
      /**
       * What the tool prints while it runs, one `toolDelta` per entry, as a
       * `bash` command does. With `hold` the call then stays running until the
       * test calls `window.__pumrFakeResume`, or for Stop.
       */
      output?: string[];
      hold?: boolean;
      result: string;
      status?: string;
      changes?: FileChange[];
      /** Pictures the tool shows in the chat, as the `screenshot` tool does. */
      attachments?: MessageAttachment[];
      /**
       * Files the tool writes into the project folder; `null` deletes one. The
       * session's change list follows, as after a mutating tool in the agent loop.
       */
      writes?: Record<string, string | null>;
    }
  /** Asks to run `command` and waits for `resolve_permission`. */
  | {
      kind: 'permission';
      command: string;
      title?: string;
      justification?: string;
      /** Overrides for the emitted request, such as `risk` or `scopeOptions`. */
      request?: Partial<PermissionRequestEvent>;
    }
  /** Asks one question and waits for `resolve_question`. */
  | { kind: 'question'; question: QuestionItem }
  /**
   * Asks which of `candidates` (model ids) the subagent model `query` means,
   * waits for `resolve_model_choice` and reports the pick as a `task` call.
   */
  | { kind: 'modelChoice'; query: string; candidates: string[] }
  /** Compacts the history as a turn does past its limit: `summary` becomes the checkpoint. */
  | { kind: 'compact'; summary: string }
  /** Waits until the test calls `window.__pumrFakeResume`, or for Stop. */
  | { kind: 'pause' }
  /** Waits until the user presses Stop (`stop_generation`). */
  | { kind: 'hang' }
  /** Cuts the turn off as when the machine slept while the reply was on its way. */
  | { kind: 'interrupt' }
  | { kind: 'error'; message: string };

export interface FakeReply {
  steps: FakeStep[];
}

export interface FakeSeed {
  settings: Settings;
  /** Providers with a stored API key (`openrouter`, `anthropic`, ...). */
  apiKeys: string[];
  projects: Project[];
  sessions: Session[];
  messages: Message[];
  models: ModelInfo[];
  /** Content of the files in the project folder, by path relative to it. */
  files: Record<string, string>;
  /** Whether the project folder is a git repository with `files` committed. */
  repo: boolean;
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
    apiKeys: string[];
    projects: Project[];
    sessions: Session[];
    messages: Message[];
  };
  replies: FakeReply[];
  pickFolder: string | null;
  confirm: boolean;
  /** Debug logs written through the save dialog of `save_debug_log`. */
  savedLogs: { fileName: string; content: string }[];
}

/**
 * What tests call in the page as `window.__pumrFakeEmit` to deliver a backend
 * event to the app's `listen` handlers, like Rust's `Emitter::emit` does.
 */
export type FakeEmit = (event: string, payload?: unknown) => void;

/** What tests call in the page as `window.__pumrFakeResume` to end every `pause` step. */
export type FakeResume = () => void;

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
    apiKeys: [...seed.apiKeys],
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
    savedLogs: restored?.savedLogs ?? [],
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

  /** Callback ids of the app's event listeners, by event name. */
  const listeners = new Map<string, Set<number>>();
  const emit: FakeEmit = (event, payload = null) => {
    for (const id of listeners.get(event) ?? []) {
      runCallback(id, { event, id, payload });
    }
  };
  (window as unknown as { __pumrFakeEmit: FakeEmit }).__pumrFakeEmit = emit;

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

  // --- workspace ------------------------------------------------------------

  /** The project folder; the fake keeps one for every project. */
  const files = new Map(Object.entries(seed.files));
  /** The folder as a session's first prompt found it, like its shadow snapshot. */
  const baselines = new Map<string, Map<string, string>>();

  const lineCount = (content: string | undefined) =>
    content ? content.replace(/\n$/, '').split('\n').length : 0;
  const languageOf = (path: string) => (path.endsWith('.ts') ? 'typescript' : 'plaintext');

  /** What differs between `base` and the folder; a changed file counts whole. */
  function changesSince(base: Map<string, string>): FileChange[] {
    return [...new Set([...base.keys(), ...files.keys()])]
      .sort()
      .filter((path) => base.get(path) !== files.get(path))
      .map((path) => ({
        path,
        additions: lineCount(files.get(path)),
        deletions: lineCount(base.get(path)),
        status: !base.has(path) ? 'A' : !files.has(path) ? 'D' : 'M',
      }));
  }

  function sessionChanges(sessionId: unknown): FileChange[] {
    const base = baselines.get(String(sessionId));
    return base ? changesSince(base) : [];
  }

  function workspaceEntries(): WorkspaceEntry[] {
    const entries = new Map<string, WorkspaceEntry>();
    for (const path of files.keys()) {
      const segments = path.split('/');
      for (let depth = 1; depth < segments.length; depth += 1) {
        const directory = segments.slice(0, depth).join('/');
        entries.set(directory, { path: directory, kind: 'directory' });
      }
      entries.set(path, { path, kind: 'file' });
    }
    return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  function gitStatus(): GitStatus {
    return {
      isRepo: seed.repo,
      branch: seed.repo ? 'main' : null,
      head: seed.repo ? 'a1b2c3d' : null,
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: seed.repo ? changesSince(new Map(Object.entries(seed.files))) : [],
      operation: null,
      conflicted: [],
    };
  }

  // --- turns ----------------------------------------------------------------

  interface Waiter {
    sessionId: string;
    resolve: (value: unknown) => void;
  }
  const permissionWaiters = new Map<string, Waiter>();
  const questionWaiters = new Map<string, Waiter>();
  const modelChoiceWaiters = new Map<string, Waiter>();
  const stopWaiters = new Map<string, () => void>();
  const pauseWaiters = new Set<() => void>();
  const resume: FakeResume = () => {
    for (const waiter of [...pauseWaiters]) {
      waiter();
    }
  };
  (window as unknown as { __pumrFakeResume: FakeResume }).__pumrFakeResume = resume;

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
    // A new turn, a continued one included, settles one that was cut off.
    session.interrupted = false;
    if (session.title === 'New session' && prompt) {
      session.title = prompt.slice(0, 40);
    }
    if (args['model']) {
      session.model = String(args['model']);
    }
    if (!baselines.has(sessionId)) {
      baselines.set(sessionId, new Map(files));
    }

    const reply = handle.replies.shift() ?? {
      steps: [{ kind: 'text', text: `Echo: ${prompt}` } satisfies FakeStep],
    };
    const assistant = message(sessionId, 'assistant', '');
    const started = now();
    emit({ kind: 'started', message: clone(assistant) });

    let stopped = false;
    let interrupted = false;
    const stopped$ = new Promise<void>((done) =>
      stopWaiters.set(sessionId, () => {
        stopped = true;
        done();
      }),
    );

    /** Waits for `window.__pumrFakeResume`, or for Stop. */
    const paused = async () => {
      let resumed = () => {};
      const resumed$ = new Promise<void>((done) => (resumed = done));
      pauseWaiters.add(resumed);
      await Promise.race([resumed$, stopped$]);
      pauseWaiters.delete(resumed);
    };

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
        if (stopped || interrupted) {
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
            for (const text of step.output ?? []) {
              emit({ kind: 'toolDelta', callId, text });
              await sleep(seed.chunkDelayMs);
            }
            if (step.hold) {
              await paused();
            }
            assistant.toolCalls.push({ id: callId, name: step.name, arguments: argumentsJson });
            const tool = message(sessionId, 'tool', step.result);
            tool.toolCallId = callId;
            tool.toolName = step.name;
            tool.status = step.status ?? 'ok';
            const before = new Map(files);
            for (const [path, content] of Object.entries(step.writes ?? {})) {
              if (content === null) {
                files.delete(path);
              } else {
                files.set(path, content);
              }
            }
            tool.changes = step.changes ?? changesSince(before);
            tool.attachments = step.attachments ?? [];
            emit({
              kind: 'toolEnd',
              callId,
              name: step.name,
              status: tool.status,
              result: step.result,
              changes: tool.changes,
              attachments: tool.attachments,
            });
            state.messages.push(tool);
            if (step.writes) {
              emit({ kind: 'changes', changes: sessionChanges(sessionId) });
            }
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
              ...step.request,
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
          case 'modelChoice': {
            const callId = newId('call');
            emit({
              kind: 'toolStart',
              callId,
              name: 'task',
              summary: 'Subtask',
              arguments: JSON.stringify({ description: 'Subtask', model: step.query }),
            });
            const requestId = newId('model-choice');
            emit({
              kind: 'modelChoiceRequest',
              requestId,
              query: step.query,
              candidates: step.candidates,
            });
            const model = (await Promise.race([
              new Promise((resolve) => modelChoiceWaiters.set(requestId, { sessionId, resolve })),
              stopped$.then(() => null),
            ])) as string | null;
            modelChoiceWaiters.delete(requestId);
            emit({ kind: 'modelChoiceResolved', requestId, model });
            emit({
              kind: 'toolEnd',
              callId,
              name: 'task',
              status: model ? 'ok' : 'error',
              result: model ? `Subagent ran on ${model}.` : 'The user did not pick a model.',
              changes: [],
            });
            break;
          }
          case 'compact': {
            emit({ kind: 'compacting' });
            await sleep(seed.chunkDelayMs);
            const marker = message(sessionId, 'compaction', step.summary);
            state.messages.push(marker);
            emit({ kind: 'compacted', message: clone(marker) });
            break;
          }
          case 'pause': {
            await paused();
            break;
          }
          case 'hang':
            await stopped$;
            break;
          case 'interrupt':
            interrupted = true;
            break;
          case 'error':
            emit({ kind: 'error', message: step.message });
            throw step.message;
        }
      }

      assistant.durationMs = now() - started;
      if (interrupted) {
        state.messages.push(assistant);
        session.interrupted = true;
        emit({ kind: 'interrupted', message: clone(assistant) });
      } else if (stopped) {
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

  // Mirrors `providers::catalog` in the Rust backend.
  const PROVIDERS = [
    {
      id: 'openrouter',
      name: 'OpenRouter',
      local: false,
      url: 'https://openrouter.ai/api/v1',
      key: 'sk-or-v1-...',
      popular: true,
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      local: false,
      url: 'https://api.anthropic.com',
      key: 'sk-ant-...',
      popular: true,
    },
    {
      id: 'openai',
      name: 'OpenAI',
      local: false,
      url: 'https://api.openai.com/v1',
      key: 'sk-...',
      popular: true,
    },
    {
      id: 'google',
      name: 'Google Gemini',
      local: false,
      url: 'https://generativelanguage.googleapis.com/v1beta/openai',
      key: 'AIza...',
      popular: true,
    },
    {
      id: 'xai',
      name: 'xAI',
      local: false,
      url: 'https://api.x.ai/v1',
      key: 'xai-...',
      popular: true,
    },
    {
      id: 'mistral',
      name: 'Mistral',
      local: false,
      url: 'https://api.mistral.ai/v1',
      key: '',
      popular: true,
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      local: false,
      url: 'https://api.deepseek.com/v1',
      key: 'sk-...',
      popular: true,
    },
    {
      id: 'groq',
      name: 'Groq',
      local: false,
      url: 'https://api.groq.com/openai/v1',
      key: 'gsk_...',
      popular: true,
    },
    {
      id: 'ollama',
      name: 'Ollama',
      local: true,
      url: 'http://localhost:11434/v1',
      key: '',
      popular: true,
    },
    {
      id: 'lmstudio',
      name: 'LM Studio',
      local: true,
      url: 'http://localhost:1234/v1',
      key: '',
      popular: true,
    },
    // A few of the providers the backend loads from models.dev.
    {
      id: 'togetherai',
      name: 'Together AI',
      local: false,
      url: 'https://api.together.xyz/v1',
      key: '',
      popular: true,
    },
    {
      id: 'minimax',
      name: 'MiniMax (minimax.io)',
      local: false,
      url: 'https://api.minimax.io/anthropic/v1',
      key: '',
      popular: true,
    },
    {
      id: 'wandb',
      name: 'CoreWeave',
      local: false,
      url: 'https://api.inference.wandb.ai/v1',
      key: '',
      popular: false,
    },
  ];
  type ProviderDef = (typeof PROVIDERS)[number];
  const providerDef = (id: string): ProviderDef =>
    PROVIDERS.find((def) => def.id === id) ?? { ...PROVIDERS[0], id, name: id };
  const providerStatus = (def: ProviderDef): ProviderStatus => {
    const config = state.settings.providers?.[def.id];
    const hasKey = !def.local && state.apiKeys.includes(def.id);
    const enabled = config?.enabled ?? !def.local;
    const custom = def.id === 'openrouter' ? state.settings.openrouterBaseUrl : config?.baseUrl;
    return {
      id: def.id,
      name: def.name,
      local: def.local,
      popular: def.popular,
      hasKey,
      enabled,
      connected: enabled && (hasKey || def.local),
      baseUrl: custom || def.url,
      defaultBaseUrl: def.url,
      keyPlaceholder: def.key,
      keysUrl: `https://example.com/${def.id}/keys`,
      error: null,
    };
  };

  let terminalCount = 0;

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
    set_interface_zoom: () => null,
    has_api_key: (args) => state.apiKeys.includes(String(args['provider'])),
    set_api_key: (args) => {
      const provider = String(args['provider']);
      if (!state.apiKeys.includes(provider)) {
        state.apiKeys.push(provider);
      }
      return null;
    },
    delete_api_key: (args) => {
      state.apiKeys = state.apiKeys.filter((provider) => provider !== String(args['provider']));
      return null;
    },
    list_llm_providers: () => PROVIDERS.map(providerStatus),
    update_provider: (args) => {
      const id = String(args['provider']);
      const entry = { baseUrl: '', enabled: null as boolean | null };
      const current = state.settings.providers?.[id] ?? entry;
      const next = { ...current };
      if (typeof args['baseUrl'] === 'string') {
        next.baseUrl = args['baseUrl'];
      }
      if (typeof args['enabled'] === 'boolean') {
        next.enabled = args['enabled'];
      }
      state.settings = {
        ...state.settings,
        providers: { ...state.settings.providers, [id]: next },
      };
      return clone(state.settings);
    },
    // Like the backend, only connected providers' models are listed.
    list_models: () =>
      clone(seed.models.filter((entry) => providerStatus(providerDef(entry.source)).connected)),
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
        interrupted: false,
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
    list_running_turns: () => ({
      sessionIds: [],
      permissions: [],
      questions: [],
      modelChoices: [],
    }),
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
    resolve_model_choice: (args) => {
      modelChoiceWaiters.get(String(args['requestId']))?.resolve(args['model']);
      return null;
    },
    summarize_session: () => 'Summary of the previous session.',
    compact_session: (args) => {
      const sessionId = String(args['sessionId']);
      if (!state.messages.some((entry) => entry.sessionId === sessionId)) {
        throw 'There is too little to compact yet.';
      }
      const marker = message(sessionId, 'compaction', 'Summary of the conversation so far.');
      state.messages.push(marker);
      return { message: clone(marker), usedTokens: 300 };
    },
    get_system_info: () => ({
      osName: 'macOS',
      osVersion: '15.6 (24G84)',
      kernel: 'Darwin 25.6.0',
      arch: 'aarch64',
      appVersion: '0.0.0-e2e',
      webviewVersion: '20621.3.11',
      desktop: null,
      appImage: false,
    }),
    // Stands in for the model: finds email addresses and `sk-` keys.
    find_sensitive_data: (args) => {
      const text = String(args['text']);
      const emails = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
      const keys = text.match(/\bsk-[\w-]+/g) ?? [];
      return [
        ...emails.map((value) => ({ text: value, kind: 'email' })),
        ...keys.map((value) => ({ text: value, kind: 'secret' })),
      ];
    },
    save_debug_log: (args) => {
      const fileName = String(args['fileName']);
      handle.savedLogs.push({ fileName, content: String(args['content']) });
      return `/Users/e2e/Downloads/${fileName}`;
    },

    list_processes: () => [],
    get_session_changes: (args) => sessionChanges(args['sessionId']),
    get_file_diff: (args): FileDiff => {
      const path = String(args['path']);
      const base = baselines.get(String(args['sessionId']));
      const change = sessionChanges(args['sessionId']).find((entry) => entry.path === path);
      return {
        path,
        oldContent: base?.get(path) ?? '',
        newContent: files.get(path) ?? '',
        language: languageOf(path),
        additions: change?.additions ?? 0,
        deletions: change?.deletions ?? 0,
        status: change?.status ?? 'M',
      };
    },
    get_project_rules: () => [],
    list_workspace_entries: () => workspaceEntries(),
    read_workspace_file: (args) => {
      const path = String(args['path']);
      return { path, content: files.get(path) ?? '', language: languageOf(path) };
    },
    list_permission_audit: () => [],
    get_git_info: () => {
      const { isRepo, branch, head } = gitStatus();
      return { isRepo, branch, head };
    },
    get_git_status: () => gitStatus(),
    get_git_refs: () => ({ branches: [], tags: [], stashes: [], submodules: [], remotes: [] }),
    get_file_ignore_catalog: () => [],
    discover_mcp_sources: () => [],
    discover_skills: () => [],
    list_skill_marketplaces: () => [],
    list_installed_mcp_servers: () => [],
    list_installed_marketplace_skills: () => [],
    search_mcp_marketplace: () => [],
    // Shells that start and stay silent: enough for the dock and its tabs.
    terminal_open: () => `terminal-${++terminalCount}`,
    terminal_write: () => null,
    terminal_resize: () => null,
    terminal_close: () => null,
    terminal_close_all: () => null,

    'plugin:dialog|open': () => handle.pickFolder,
    'plugin:dialog|confirm': () => handle.confirm,
    'plugin:dialog|ask': () => handle.confirm,
    'plugin:dialog|message': () => null,
    'plugin:app|version': () => '0.0.0-e2e',
    'plugin:app|name': () => 'pumr',
    'plugin:updater|check': () => null,
    'plugin:event|listen': (args) => {
      const event = String(args['event']);
      const id = args['handler'] as number;
      listeners.set(event, (listeners.get(event) ?? new Set()).add(id));
      return id;
    },
    'plugin:event|unlisten': (args) => {
      listeners.get(String(args['event']))?.delete(args['eventId'] as number);
      return null;
    },
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
