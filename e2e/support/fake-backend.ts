import type {
  EndpointInfo,
  FileChange,
  FileDiff,
  GitCommit,
  GitDiffLine,
  GitHunkDiff,
  GitRefs,
  GitStatus,
  McpToolGrant,
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
  SandboxSupport,
  WindowControl,
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
  /**
   * Asks to run `command` and waits for `resolve_permission`. With an
   * `mcpTool` in `request` it is the call of an MCP tool, which runs without
   * asking once the user chose not to be asked again for that tool.
   */
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
  /**
   * An MCP server the turn starts before it calls the model. Starting takes
   * until the test calls `window.__pumrFakeResume`, or until Stop; `issues` is
   * what the chat is then told the turn has to do without.
   */
  mcp?: { server: string; issues?: string[] };
}

/** The parts of a repository the fake does not derive from the project folder. */
export interface FakeGit {
  /** Branches, tags and stashes; what is left out is empty. */
  refs?: Partial<GitRefs>;
  /** What is committed, where that is not the project folder as seeded. */
  committed?: Record<string, string>;
  /** The history, newest first. */
  commits?: GitCommit[];
  /** Local branches that git only deletes when forced. */
  unmerged?: string[];
  /** What merging a branch, or rebasing onto it, brings in; nothing by default. */
  incoming?: Record<string, FakeIncoming>;
}

/** The outcome of a merge or rebase, as file contents by path. */
export interface FakeIncoming {
  /** Applied cleanly. */
  changes?: Record<string, string>;
  /** Left as conflicts, which stop the operation until they are resolved. */
  conflicts?: Record<string, string>;
}

export interface FakeSeed {
  settings: Settings;
  /** Providers with a stored API key (`openrouter`, `anthropic`, ...). */
  apiKeys: string[];
  projects: Project[];
  sessions: Session[];
  messages: Message[];
  models: ModelInfo[];
  /** The providers OpenRouter serves every model through, for the routing pickers. */
  endpoints: EndpointInfo[];
  /** Content of the files in the project folder, by path relative to it. */
  files: Record<string, string>;
  /** Whether the project folder is a git repository with `files` committed. */
  repo: boolean;
  /** What the git views list besides the work tree. */
  git?: FakeGit;
  /** Commands that are rejected, with the error the Rust side returns. */
  failures?: Record<string, string>;
  /** What the native folder picker returns; `null` means cancelled. */
  pickFolder: string | null;
  /** What native confirm/ask dialogs return. */
  confirm: boolean;
  /**
   * How the desktop summons the window (`get_window_control`). Its
   * `shortcutError` is why registering the shortcut fails on this desktop; it
   * is only reported while the saved settings have the shortcut switched on.
   */
  windowControl: WindowControl;
  /** What the sandbox can do on this machine (`get_sandbox_support`). */
  sandboxSupport: SandboxSupport;
  /** Whether the webview paints without GPU compositing (`is_software_rendered`). */
  softwareRendering: boolean;
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
  /** Answers to the next confirm dialogs, in order; `confirm` applies after them. */
  answers: boolean[];
  /** Debug logs written through the save dialog of `save_debug_log`. */
  savedLogs: { fileName: string; content: string }[];
  /** Ids of terminals in which a program runs (`terminal_busy`). */
  busyTerminals: string[];
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
    answers: restored?.answers ?? [],
    savedLogs: restored?.savedLogs ?? [],
    busyTerminals: restored?.busyTerminals ?? [],
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

  /** What differs between two versions of the folder; a changed file counts whole. */
  function changesBetween(base: Map<string, string>, next: Map<string, string>): FileChange[] {
    return [...new Set([...base.keys(), ...next.keys()])]
      .sort()
      .filter((path) => base.get(path) !== next.get(path))
      .map((path) => ({
        path,
        additions: lineCount(next.get(path)),
        deletions: lineCount(base.get(path)),
        status: !base.has(path) ? 'A' : !next.has(path) ? 'D' : 'M',
      }));
  }

  /** What differs between `base` and the folder. */
  const changesSince = (base: Map<string, string>) => changesBetween(base, files);

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

  // --- git ------------------------------------------------------------------

  // The repository of the project folder: `committed` is HEAD, `index` what
  // is staged on top of it, and `files` the work tree.
  let isRepo = seed.repo;
  const committed = new Map(Object.entries(seed.git?.committed ?? seed.files));
  const index = new Map(committed);
  const commits: GitCommit[] = clone(seed.git?.commits ?? []);
  const refs: GitRefs = {
    branches: [],
    tags: [],
    stashes: [],
    submodules: [],
    remotes: [],
    ...clone(seed.git?.refs ?? {}),
  };
  let currentBranch = refs.branches.find((branch) => branch.current)?.name ?? 'main';
  /** What each stash made here put away, by its hash: the content of every path it took. */
  const stashed = new Map<string, Map<string, string | undefined>>();
  /** A merge or rebase that stopped at conflicts. */
  let operation: {
    name: 'merge' | 'rebase';
    branch: string;
    /** The incoming content of the paths that are still unresolved. */
    conflicts: Map<string, string>;
    /** The folder and the index as they were before, for an abort. */
    before: { files: [string, string][]; index: [string, string][] };
  } | null = null;

  function gitStatus(): GitStatus {
    // Like git, a conflicted path is listed on both sides until it is resolved.
    const conflicted = operation ? [...operation.conflicts.keys()].sort() : [];
    const unmerged = (changes: FileChange[]) => [
      ...changes.filter((change) => !conflicted.includes(change.path)),
      ...conflicted.map((path) => ({ path, additions: 0, deletions: 0, status: 'U' })),
    ];
    return {
      isRepo,
      branch: isRepo ? currentBranch : null,
      head: isRepo ? 'a1b2c3d' : null,
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: isRepo ? unmerged(changesBetween(committed, index)) : [],
      unstaged: isRepo ? unmerged(changesBetween(index, files)) : [],
      operation: operation?.name ?? null,
      conflicted,
    };
  }

  /** Makes `paths` (every path when `null`) in `to` what they are in `from`. */
  function copyPaths(
    from: Map<string, string>,
    to: Map<string, string>,
    paths: string[] | null,
  ): void {
    for (const path of paths ?? [...new Set([...from.keys(), ...to.keys()])]) {
      const content = from.get(path);
      if (content === undefined) {
        to.delete(path);
      } else {
        to.set(path, content);
      }
    }
  }

  const pathsOf = (args: Args): string[] | null =>
    (args['paths'] as string[] | undefined) ?? (args['path'] ? [String(args['path'])] : null);

  /**
   * The diff of one path as a single hunk: the lines both versions start and
   * end with are context, what is between them is removed and added.
   */
  function hunkDiff(path: string, staged: boolean): GitHunkDiff {
    const [from, to] = staged ? [committed, index] : [index, files];
    if (operation?.conflicts.has(path)) {
      return {
        path,
        staged,
        status: 'M',
        language: languageOf(path),
        hunks: [],
        additions: 0,
        deletions: 0,
        binary: false,
        tooLarge: false,
        blocked: 'conflict',
        fingerprint: '',
      };
    }
    const linesOf = (content: string | undefined) =>
      content ? content.replace(/\n$/, '').split('\n') : [];
    const [old, next] = [linesOf(from.get(path)), linesOf(to.get(path))];
    let start = 0;
    while (start < old.length && start < next.length && old[start] === next[start]) {
      start += 1;
    }
    let end = 0;
    while (
      end < old.length - start &&
      end < next.length - start &&
      old[old.length - 1 - end] === next[next.length - 1 - end]
    ) {
      end += 1;
    }
    const lines: GitDiffLine[] = [];
    const push = (kind: GitDiffLine['kind'], text: string, oldLine: number, newLine: number) =>
      lines.push({
        id: lines.length,
        kind,
        text,
        oldLine: kind === 'add' ? null : oldLine,
        newLine: kind === 'del' ? null : newLine,
        noNewline: false,
      });
    old.slice(0, start).forEach((text, at) => push('context', text, at + 1, at + 1));
    old.slice(start, old.length - end).forEach((text, at) => push('del', text, start + at + 1, 0));
    next
      .slice(start, next.length - end)
      .forEach((text, at) => push('add', text, 0, start + at + 1));
    old
      .slice(old.length - end)
      .forEach((text, at) =>
        push('context', text, old.length - end + at + 1, next.length - end + at + 1),
      );
    return {
      path,
      staged,
      status: !from.has(path) ? 'A' : !to.has(path) ? 'D' : 'M',
      language: languageOf(path),
      hunks: lines.some((line) => line.kind !== 'context')
        ? [
            {
              oldStart: 1,
              oldLines: old.length,
              newStart: 1,
              newLines: next.length,
              section: '',
              lines,
            },
          ]
        : [],
      additions: next.length - start - end,
      deletions: old.length - start - end,
      binary: false,
      tooLarge: false,
      blocked: null,
      fingerprint: JSON.stringify([staged, from.get(path) ?? null, to.get(path) ?? null]),
    };
  }

  /** Stages, unstages or discards the chosen lines of the diff `hunkDiff` gave out. */
  function applyLines(args: Args): null {
    const [path, staged, action] = [
      String(args['path']),
      Boolean(args['staged']),
      String(args['action']),
    ];
    const diff = hunkDiff(path, staged);
    if (diff.fingerprint !== args['fingerprint']) {
      throw `stale diff: ${path} changed since its diff was loaded`;
    }
    const chosen = new Set(args['lines'] as number[]);
    // Staging takes the chosen changes over; the other two take them back out.
    const forward = action === 'stage';
    const kept = diff.hunks
      .flatMap((hunk) => hunk.lines)
      .filter(
        (line) =>
          line.kind === 'context' ||
          (line.kind === 'del' ? chosen.has(line.id) !== forward : chosen.has(line.id) === forward),
      );
    const target = action === 'discard' ? files : index;
    if (kept.length === 0) {
      target.delete(path);
    } else {
      target.set(path, kept.map((line) => `${line.text}\n`).join(''));
    }
    return null;
  }

  function commitStaged(args: Args): string {
    if (operation && operation.conflicts.size > 0) {
      throw 'error: Committing is not possible because you have unmerged files.';
    }
    if (changesBetween(committed, index).length === 0 && !args['amend'] && !operation) {
      throw 'nothing to commit';
    }
    operation = null;
    copyPaths(index, committed, null);
    const [subject] = String(args['message']).split('\n');
    const hash = `${commits.length + 1}`.padStart(40, 'c');
    if (args['amend']) {
      commits.shift();
    }
    commits.unshift({
      hash,
      shortHash: hash.slice(0, 7),
      author: 'e2e',
      timestamp: 0,
      subject,
      refs: ['main'],
      parents: commits[0] ? [commits[0].hash] : [],
    });
    return `[main ${hash.slice(0, 7)}] ${subject}`;
  }

  /** Staging a conflicted file is how it is marked as resolved. */
  function stagePaths(args: Args): void {
    const paths = pathsOf(args);
    copyPaths(files, index, paths);
    for (const path of paths ?? [...(operation?.conflicts.keys() ?? [])]) {
      operation?.conflicts.delete(path);
    }
  }

  /**
   * Unstaging leaves unmerged paths as they are: a conflict is resolved, not
   * unstaged. Among other paths they are skipped without a word; asked for
   * nothing but them, the command fails as it does in Rust.
   */
  function unstagePaths(args: Args): void {
    const requested = pathsOf(args) ?? [...new Set([...committed.keys(), ...index.keys()])];
    const paths = requested.filter((path) => !operation?.conflicts.has(path));
    if (requested.length > 0 && paths.length === 0) {
      throw `conflicts are resolved, not unstaged: ${[...requested].sort().slice(0, 5).join(', ')}`;
    }
    copyPaths(committed, index, paths);
  }

  function createBranch(args: Args): string {
    const name = String(args['name']);
    if (/\s|\.\./.test(name)) {
      throw `fatal: '${name}' is not a valid branch name`;
    }
    if (refs.branches.some((branch) => !branch.remote && branch.name === name)) {
      throw `fatal: a branch named '${name}' already exists`;
    }
    const tip = refs.branches.find((branch) => branch.name === currentBranch);
    refs.branches = [
      ...refs.branches,
      {
        name,
        current: false,
        remote: false,
        upstream: null,
        remoteName: null,
        remoteBranch: null,
        hash: tip?.hash ?? commits[0]?.hash ?? null,
        subject: tip?.subject ?? null,
        timestamp: tip?.timestamp ?? null,
      },
    ];
    return args['checkout'] ? checkoutBranch({ branch: name }) : '';
  }

  /** Switches branches; local changes come along, as they do when nothing collides. */
  function checkoutBranch(args: Args): string {
    const name = String(args['localBranch'] ?? args['branch']);
    if (!refs.branches.some((branch) => branch.name === name)) {
      throw `error: pathspec '${name}' did not match any file(s) known to git`;
    }
    currentBranch = name;
    refs.branches = refs.branches.map((branch) => ({
      ...branch,
      current: !branch.remote && branch.name === name,
    }));
    return `Switched to branch '${name}'`;
  }

  const renumbered = (stashes: GitRefs['stashes']) =>
    stashes.map((stash, at) => ({ ...stash, name: `stash@{${at}}` }));

  /** Puts the local changes away; new files only when untracked ones are asked for. */
  function stashPush(args: Args): string {
    const changed = [...changesBetween(committed, index), ...changesBetween(index, files)]
      .map((change) => change.path)
      .filter((path) => args['includeUntracked'] || committed.has(path) || index.has(path));
    if (changed.length === 0) {
      return 'No local changes to save';
    }
    const hash = `${stashed.size + 1}`.padStart(40, 'e');
    stashed.set(hash, new Map(changed.map((path) => [path, files.get(path)])));
    copyPaths(committed, index, changed);
    copyPaths(committed, files, changed);
    const message = args['message']
      ? `On ${currentBranch}: ${String(args['message'])}`
      : `WIP on ${currentBranch}: a1b2c3d`;
    refs.stashes = renumbered([{ name: '', hash, message }, ...refs.stashes]);
    return `Saved working directory and index state ${message}`;
  }

  /** Brings back what a stash put away; `drop` is the difference between pop and apply. */
  function stashRestore(args: Args, drop: boolean): string {
    const hash = String(args['hash']);
    if (!refs.stashes.some((stash) => stash.hash === hash && stash.name === args['stash'])) {
      throw `${String(args['stash'])} changed since the stash list was loaded; refresh and try again`;
    }
    for (const [path, content] of stashed.get(hash) ?? []) {
      if (content === undefined) {
        files.delete(path);
      } else {
        files.set(path, content);
      }
    }
    if (drop) {
      stashed.delete(hash);
      refs.stashes = renumbered(refs.stashes.filter((stash) => stash.hash !== hash));
    }
    return '';
  }

  /** Merges `branch` or rebases onto it, with the outcome the seed gives that branch. */
  function integrate(name: 'merge' | 'rebase', branch: string): string {
    const incoming = seed.git?.incoming?.[branch];
    const clean = Object.keys(incoming?.changes ?? {});
    const conflicts = new Map(Object.entries(incoming?.conflicts ?? {}));
    const before = { files: [...files], index: [...index] };
    for (const path of clean) {
      const content = incoming?.changes?.[path] ?? '';
      index.set(path, content);
      files.set(path, content);
    }
    if (conflicts.size === 0) {
      copyPaths(index, committed, clean);
      if (!incoming) {
        return name === 'merge'
          ? 'Already up to date.'
          : `Current branch ${currentBranch} is up to date.`;
      }
      return name === 'merge'
        ? "Merge made by the 'ort' strategy."
        : `Successfully rebased and updated refs/heads/${currentBranch}.`;
    }
    for (const [path, theirs] of conflicts) {
      const ours = committed.get(path) ?? '';
      files.set(path, `<<<<<<< HEAD\n${ours}=======\n${theirs}>>>>>>> ${branch}\n`);
    }
    operation = { name, branch, conflicts, before };
    throw [
      ...[...conflicts.keys()].map((path) => `CONFLICT (content): Merge conflict in ${path}`),
      'Automatic merge failed; fix conflicts and then commit the result.',
    ].join('\n');
  }

  function resolveConflict(args: Args): null {
    const path = String(args['path']);
    const theirs = operation?.conflicts.get(path);
    if (!operation || theirs === undefined) {
      throw `${path} has no conflict`;
    }
    const content = args['side'] === 'ours' ? (committed.get(path) ?? '') : theirs;
    files.set(path, content);
    index.set(path, content);
    operation.conflicts.delete(path);
    return null;
  }

  /** Ends the operation in progress: `abort` goes back to how things were before it. */
  function endOperation(args: Args, abort: boolean): string {
    if (!operation || operation.name !== args['operation']) {
      throw `error: no ${String(args['operation'])} in progress`;
    }
    if (abort) {
      files.clear();
      index.clear();
      operation.before.files.forEach(([path, content]) => files.set(path, content));
      operation.before.index.forEach(([path, content]) => index.set(path, content));
    } else {
      if (operation.conflicts.size > 0) {
        throw 'error: Committing is not possible because you have unmerged files.';
      }
      copyPaths(index, committed, null);
    }
    operation = null;
    return '';
  }

  /** The commits a rebase onto `onto` replays, oldest first. */
  function rebaseCommits(args: Args): GitCommit[] {
    const base = refs.branches.find((branch) => branch.name === args['onto'])?.hash;
    const ahead = commits.findIndex((commit) => commit.hash === base);
    return clone(ahead < 0 ? commits : commits.slice(0, ahead)).reverse();
  }

  function deleteBranch(args: Args): string {
    const branch = String(args['branch']);
    if (seed.git?.unmerged?.includes(branch) && !args['force']) {
      throw `error: the branch '${branch}' is not fully merged`;
    }
    refs.branches = refs.branches.filter((entry) => entry.name !== branch);
    return `Deleted branch ${branch}`;
  }

  // --- turns ----------------------------------------------------------------

  interface Waiter {
    sessionId: string;
    resolve: (value: unknown) => void;
  }
  const permissionWaiters = new Map<string, Waiter>();
  // The MCP tool each open prompt asks about, and the tools allowed per chat;
  // tools allowed for good are in the settings, as in the app.
  const promptMcpTools = new Map<string, McpToolGrant>();
  const chatMcpTools = new Map<string, McpToolGrant[]>();
  // The same for folders whose sensitive files a command prompt offers to
  // release: per open prompt, and released per chat.
  const promptSecretFolders = new Map<string, string[]>();
  const chatSecretFolders = new Map<string, string[]>();
  const sameMcpTool = (a: McpToolGrant, b: McpToolGrant) =>
    a.server === b.server &&
    a.tool === b.tool &&
    a.source === b.source &&
    a.fingerprint === b.fingerprint;
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

    // MCP servers are connected before the reply begins.
    if (reply.mcp) {
      emit({ kind: 'mcpStarting', server: reply.mcp.server });
      await paused();
      emit({ kind: 'mcpReady', issues: stopped ? [] : (reply.mcp.issues ?? []) });
    }
    emit({ kind: 'started', message: clone(assistant) });

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
            const mcpTool = step.request?.mcpTool ?? null;
            const secretFolders = step.request?.secretFolders ?? [];
            const released = [
              ...(chatSecretFolders.get(sessionId) ?? []),
              ...(state.settings.secretFolders ?? []),
            ];
            const remembered =
              (mcpTool !== null &&
                [
                  ...(chatMcpTools.get(sessionId) ?? []),
                  ...(state.settings.mcpToolGrants ?? []),
                ].some((grant) => sameMcpTool(grant, mcpTool))) ||
              (secretFolders.length > 0 &&
                secretFolders.every((folder) => released.includes(folder)));
            let allowed = true;
            if (!remembered) {
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
                suggestedRule: mcpTool ? null : `${step.command.split(' ')[0]} *`,
                segments: [],
                risk: null,
                scopeOptions: [],
                folders: [],
                hosts: [],
                justification: step.justification ?? null,
                ...step.request,
              });
              if (mcpTool) {
                promptMcpTools.set(requestId, mcpTool);
              }
              promptSecretFolders.set(requestId, secretFolders);
              const decision = await Promise.race([
                new Promise((resolve) => permissionWaiters.set(requestId, { sessionId, resolve })),
                stopped$.then(() => 'deny'),
              ]);
              permissionWaiters.delete(requestId);
              promptMcpTools.delete(requestId);
              promptSecretFolders.delete(requestId);
              allowed = String(decision).startsWith('allow');
              emit({ kind: 'permissionResolved', requestId, allowed });
            }
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
    // As in Rust, nothing was tried and so nothing failed while the shortcut is off.
    get_window_control: () => ({
      ...clone(seed.windowControl),
      shortcutError: state.settings.windowToggleEnabled ? seed.windowControl.shortcutError : null,
    }),
    get_sandbox_support: () => clone(seed.sandboxSupport),
    is_software_rendered: () => seed.softwareRendering,
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
    list_endpoints: () => clone(seed.endpoints),
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
      const requestId = String(args['requestId']);
      const waiter = permissionWaiters.get(requestId);
      const mcpTool = promptMcpTools.get(requestId);
      if (waiter && mcpTool) {
        if (args['decision'] === 'allow_session') {
          chatMcpTools.set(waiter.sessionId, [
            ...(chatMcpTools.get(waiter.sessionId) ?? []),
            mcpTool,
          ]);
        } else if (args['decision'] === 'allow_always') {
          state.settings.mcpToolGrants = [...(state.settings.mcpToolGrants ?? []), mcpTool];
        }
      }
      // Only folders the prompt offered are released, as in the app.
      const offered = promptSecretFolders.get(requestId) ?? [];
      const folders = ((args['secretFolders'] as string[] | undefined) ?? []).filter((folder) =>
        offered.includes(folder),
      );
      if (waiter && folders.length > 0) {
        if (args['decision'] === 'allow_session') {
          chatSecretFolders.set(waiter.sessionId, [
            ...(chatSecretFolders.get(waiter.sessionId) ?? []),
            ...folders,
          ]);
        } else if (args['decision'] === 'allow_always') {
          state.settings.secretFolders = [...(state.settings.secretFolders ?? []), ...folders];
        }
      }
      waiter?.resolve(args['decision']);
      return null;
    },
    delete_secret_folder: (args) => {
      state.settings.secretFolders = (state.settings.secretFolders ?? []).filter(
        (folder) => folder !== args['folder'],
      );
      return clone(state.settings);
    },
    delete_mcp_tool_grant: (args) => {
      const grant = args['grant'] as McpToolGrant;
      state.settings.mcpToolGrants = (state.settings.mcpToolGrants ?? []).filter(
        (entry) => !sameMcpTool(entry, grant),
      );
      return clone(state.settings);
    },
    resolve_question: (args) => {
      questionWaiters.get(String(args['requestId']))?.resolve(args['answers']);
      return null;
    },
    resolve_model_choice: (args) => {
      modelChoiceWaiters.get(String(args['requestId']))?.resolve(args['model']);
      return null;
    },
    // Takes a session back to one of its prompts like the Rust command: the
    // prompt and what followed it go, and its text returns for the chat box.
    revert_to_message: (args) => {
      const target = state.messages.find((entry) => entry.id === args['messageId']);
      if (!target || target.role !== 'user') {
        throw 'Only user prompts can be reverted to.';
      }
      const sessionId = target.sessionId;
      if (stopWaiters.has(sessionId)) {
        throw 'Stop the running turn before reverting.';
      }
      const restored: string[] = [];
      const base = baselines.get(sessionId);
      if (args['restoreFiles'] && base) {
        for (const path of new Set([...files.keys(), ...base.keys()])) {
          const before = base.get(path);
          if (before === files.get(path)) {
            continue;
          }
          if (before === undefined) {
            files.delete(path);
          } else {
            files.set(path, before);
          }
          restored.push(path);
        }
      }
      baselines.delete(sessionId);
      state.messages = state.messages.filter(
        (entry) => entry.sessionId !== sessionId || entry.seq < target.seq,
      );
      requireSession(sessionId).interrupted = false;
      return { prompt: target.content, restoredFiles: restored };
    },
    summarize_session: () => 'Summary of the previous session.',
    // Stands in for the model: the answer repeats the question and is not
    // added to the session's messages.
    ask_side_question: async (args) => {
      const sessionId = String(args['sessionId']);
      requireSession(sessionId);
      const channel = channelSender(args['channel'] as ChannelLike);
      const key = `side-question:${sessionId}`;
      let stopped = false;
      stopWaiters.set(key, () => {
        stopped = true;
      });
      let answer = '';
      for (const chunk of `Side answer: ${String(args['question'])}`.match(/.{1,12}/gs) ?? []) {
        if (stopped) {
          break;
        }
        answer += chunk;
        channel.send({ kind: 'delta', text: chunk });
        await sleep(seed.chunkDelayMs);
      }
      stopWaiters.delete(key);
      return { answer, cancelled: stopped };
    },
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
      // Every file of the fake folder is text.
      return { path, content: files.get(path) ?? '', language: languageOf(path), binary: false };
    },
    list_permission_audit: () => [],
    get_git_info: () => {
      const { isRepo, branch, head } = gitStatus();
      return { isRepo, branch, head };
    },
    get_git_status: () => gitStatus(),
    // Fresh copies, as over real IPC: the app tells a change by identity.
    get_git_refs: () => clone(refs),
    get_git_commits: (args) => (Number(args['skip']) > 0 ? [] : clone(commits)),
    get_git_commit: (args) => {
      const commit =
        args['hash'] === 'HEAD' ? commits[0] : commits.find((entry) => entry.hash === args['hash']);
      if (!commit) {
        throw `unknown revision ${String(args['hash'])}`;
      }
      return { ...commit, authorEmail: 'e2e@example.com', body: '', changes: [] };
    },
    get_git_rebase_commits: rebaseCommits,
    get_git_blame: () => [],
    get_git_file_hunks: (args) => hunkDiff(String(args['path']), Boolean(args['staged'])),
    // A conflicted file is shown whole: "ours" against what is in the folder.
    get_git_file_diff: (args): FileDiff => {
      const path = String(args['path']);
      const [from, to] = args['staged'] ? [committed, index] : [index, files];
      return {
        path,
        oldContent: from.get(path) ?? '',
        newContent: to.get(path) ?? '',
        language: languageOf(path),
        additions: lineCount(to.get(path)),
        deletions: lineCount(from.get(path)),
        status: 'M',
        binary: false,
        tooLarge: false,
      };
    },
    git_apply_lines: applyLines,
    git_stage: stagePaths,
    git_stage_paths: stagePaths,
    git_unstage: unstagePaths,
    git_unstage_paths: unstagePaths,
    git_discard_paths: (args) => copyPaths(index, files, pathsOf(args)),
    git_commit: commitStaged,
    git_init: () => {
      isRepo = true;
      return 'Initialized empty Git repository';
    },
    git_fetch: () => '',
    git_pull: () => 'Already up to date.',
    git_push: () => 'Everything up-to-date',
    git_push_branch: (args) =>
      `branch '${String(args['branch'])}' set up to track '${String(args['remote'])}/${String(args['branch'])}'.`,
    git_merge: (args) => integrate('merge', String(args['branch'])),
    git_rebase: (args) => integrate('rebase', String(args['onto'])),
    git_rebase_interactive: () => `Successfully rebased and updated refs/heads/${currentBranch}.`,
    git_resolve_conflict: resolveConflict,
    git_operation_continue: (args) => endOperation(args, false),
    git_operation_abort: (args) => endOperation(args, true),
    git_branch_create: createBranch,
    git_checkout: checkoutBranch,
    git_stash_push: stashPush,
    git_reset: () => '',
    git_revert: () => '',
    git_cherry_pick: () => '',
    git_checkout_commit: () => '',
    git_branch_delete: deleteBranch,
    git_tag_delete: (args) => {
      refs.tags = refs.tags.filter((tag) => tag.name !== args['name']);
      return `Deleted tag ${String(args['name'])}`;
    },
    git_stash_apply: (args) => stashRestore(args, false),
    git_stash_pop: (args) => stashRestore(args, true),
    git_stash_drop: (args) => {
      stashed.delete(String(args['hash']));
      refs.stashes = renumbered(refs.stashes.filter((stash) => stash.hash !== args['hash']));
      return `Dropped ${String(args['stash'])}`;
    },
    get_file_ignore_catalog: () => [],
    discover_mcp_sources: () => [],
    discover_skills: () => [],
    list_skill_marketplaces: () => [],
    list_installed_mcp_servers: () => [],
    list_installed_marketplace_skills: () => [],
    search_mcp_marketplace: () => [],
    // Shells that show a prompt and then stay silent: enough for the dock,
    // its tabs and a command sent from the chat.
    terminal_open: (args) => {
      const channel = channelSender(args['channel'] as ChannelLike);
      setTimeout(() => channel.send({ kind: 'output', data: '$ ' }), 0);
      return `terminal-${++terminalCount}`;
    },
    terminal_write: () => null,
    terminal_resize: () => null,
    terminal_busy: (args) => handle.busyTerminals.includes(String(args['terminalId'])),
    terminal_close: () => null,
    terminal_close_all: () => null,

    'plugin:dialog|open': () => handle.pickFolder,
    'plugin:dialog|confirm': () => handle.confirm,
    'plugin:dialog|ask': () => handle.confirm,
    'plugin:dialog|message': (args) => dialogAnswer(args['buttons']),
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

  /**
   * The label of the button a native message dialog is closed with. `confirm`
   * and `ask` are message dialogs with two buttons and compare the answer with
   * the label of the first.
   */
  function dialogAnswer(buttons: unknown): string {
    const custom = (buttons ?? {}) as { OkCancelCustom?: string[]; YesNoCancelCustom?: string[] };
    const [accept, decline] =
      custom.OkCancelCustom ??
      custom.YesNoCancelCustom ??
      (buttons === 'YesNo' || buttons === 'YesNoCancel'
        ? ['Yes', 'No']
        : ['Ok', buttons === 'OkCancel' ? 'Cancel' : 'Ok']);
    return (handle.answers.shift() ?? handle.confirm) ? accept : decline;
  }

  const invoke = async (cmd: string, args: Args = {}): Promise<unknown> => {
    // Channels serialise to `__CHANNEL__:<id>` like they do over real IPC.
    handle.calls.push({ cmd, args: clone(args) });
    const failure = seed.failures?.[cmd];
    if (failure !== undefined) {
      persist();
      throw failure;
    }
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
