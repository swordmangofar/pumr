import { CustomTheme } from './themes';

export type WindowToggleAction = 'hide' | 'minimize';

/** How the window can be summoned on this desktop. */
export interface WindowControl {
  /** Command line that toggles the window, to bind to a key in the desktop's keyboard settings. */
  toggleCommand: string;
  /** `false` on Wayland, where apps cannot register system-wide shortcuts. */
  globalShortcut: boolean;
  /**
   * Why the system-wide shortcut could not be registered the last time it was
   * applied, such as a key another app holds; `null` when it works.
   */
  shortcutError: string | null;
}

export interface Project {
  id: string;
  path: string;
  name: string;
  createdAt: number;
  lastOpenedAt: number;
  sessionCount: number;
  totalCost: number;
  color: string | null;
  icon: string | null;
  iconImage: string | null;
}

export interface Session {
  id: string;
  projectId: string;
  title: string;
  model: string | null;
  reasoningEffort: string | null;
  provider: string | null;
  systemPrompt: string | null;
  createdAt: number;
  updatedAt: number;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  messageCount: number;
  parentSessionId: string | null;
  agentStatus: string | null;
  archived: boolean;
  modeId: string | null;
  limitReached: boolean;
  autoContinue: boolean;
  /**
   * The last turn was cut off before the agent finished (the app closed, or
   * the machine slept mid-reply) and waits for the user to continue.
   */
  interrupted: boolean;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: string;
}

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  status: string;
}

export type AttachmentKind = 'image' | 'text' | 'pdf';

export type MentionKind = 'file' | 'directory' | 'website' | 'skill' | 'mcp';

export interface Mention {
  kind: MentionKind;
  value: string;
  label: string;
}

export interface WorkspaceEntry {
  path: string;
  kind: 'file' | 'directory';
}

export interface WorkspaceFile {
  path: string;
  /** Empty for a `binary` file. */
  content: string;
  language: string;
  /** The file exists but is not UTF-8 text, so it can neither be shown nor saved. */
  binary: boolean;
}

export interface McpToolInfo {
  server: string;
  name: string;
  exposedName: string;
  description: string;
  inputSchema: unknown;
}

export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  lines: number | null;
  data: string;
}

export interface TextBlock {
  id: string;
  text: string;
}

export interface Message {
  id: string;
  sessionId: string;
  seq: number;
  /**
   * `compaction` records a checkpoint: its content is the summary that stands
   * in for the earlier messages in what the model is sent.
   */
  /** `note` is something pumr itself told the agent, e.g. to check a change before finishing. */
  role: 'user' | 'assistant' | 'system' | 'tool' | 'compaction' | 'note';
  content: string;
  reasoning: string;
  model: string | null;
  provider: string | null;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  createdAt: number;
  toolCalls: ToolCallRecord[];
  toolCallId: string | null;
  toolName: string | null;
  status: string | null;
  changes: FileChange[];
  baseCommit: string | null;
  attachments: MessageAttachment[];
  mentions: Mention[];
  context: string;
  durationMs: number;
}

/**
 * Id of the provider that serves a model: `openrouter`, or a provider used
 * directly with its own key (`anthropic`, `openai`, `ollama`, ...).
 */
export type ModelSource = string;

/** A model provider and whether it is set up. */
export interface ProviderStatus {
  id: string;
  name: string;
  /** A server on this machine that needs no key. */
  local: boolean;
  /** Offered before the long tail of providers when adding one. */
  popular: boolean;
  hasKey: boolean;
  enabled: boolean;
  /** Enabled and, unless local, with a key: its models are listed. */
  connected: boolean;
  baseUrl: string;
  defaultBaseUrl: string;
  keyPlaceholder: string;
  keysUrl: string;
  /** Why its models could not be listed the last time. */
  error: string | null;
}

export interface ProviderSettings {
  /** Overrides the provider's base URL; empty uses its default. */
  baseUrl: string;
  /** Whether its models are listed; null is the default (on unless local). */
  enabled: boolean | null;
  /** Whether pumr stored a key for it (the key stays in the keychain). */
  keyStored?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  contextLength: number;
  promptPricePerM: number;
  completionPricePerM: number;
  cacheReadPricePerM: number;
  supportsReasoning: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  inputModalities: string[];
  supportedParameters: string[];
  created: number;
  source: ModelSource;
}

export interface EndpointInfo {
  name: string;
  slug: string;
  providerName: string;
  providerSlug: string;
  contextLength: number;
  promptPricePerM: number;
  completionPricePerM: number;
  cacheReadPricePerM: number;
  uptimeLast5m: number | null;
  uptimeLast30m: number | null;
  uptimeLast1d: number | null;
  throughputLast30m: number | null;
  latencyLast30m: number | null;
  maxCompletionTokens: number | null;
  quantization: string | null;
  supportsImplicitCaching: boolean;
  training: boolean | null;
  retainsPrompts: boolean | null;
}

export interface ProviderInfo {
  slug: string;
  name: string;
  iconUrl: string | null;
  headquarters: string | null;
}

export interface SpendSummary {
  totalCost: number;
  todayCost: number;
  sessionCost: number;
  budgetUsd: number;
  remainingUsd: number | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface DailySpend {
  date: string;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface ModelSpend {
  model: string;
  provider: string | null;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  messages: number;
}

export interface SessionSpend {
  sessionId: string;
  title: string;
  projectId: string;
  parentSessionId: string | null;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  messages: number;
  updatedAt: number;
}

export interface SpendStats {
  totalCost: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  messages: number;
  sessions: number;
  daily: DailySpend[];
  byModel: ModelSpend[];
  bySession: SessionSpend[];
}

/**
 * One of "Your prompts": called from the chat box with a slash and its name
 * (`/code-review`) for a single message, or named by a mode.
 */
export interface UserSystemPrompt {
  id: string;
  name: string;
  prompt: string;
}

export interface Mode {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  userPromptIds: string[];
  mcpServers: string[];
  skills: string[];
  includeGlobalPrompts: boolean;
  includeProjectRules: boolean;
  planOnly: boolean;
  builtin: boolean;
}

export interface Settings {
  settingsVersion: number;
  defaultSystemPrompt: string;
  securitySystemPromptEnabled: boolean;
  securitySystemPrompt: string;
  testingSystemPromptEnabled: boolean;
  testingSystemPrompt: string;
  architectureSystemPromptEnabled: boolean;
  architectureSystemPrompt: string;
  userSystemPrompts: UserSystemPrompt[];
  modes: Mode[];
  defaultModeId: string;
  language: string;
  replyLanguage: string | null;
  theme: string;
  customTheme: CustomTheme;
  highContrast: boolean;
  extraFolders: string[];
  openrouterBaseUrl: string;
  providers: Record<string, ProviderSettings>;
  defaultModel: string | null;
  handoverModel: string | null;
  defaultReasoningEffort: string | null;
  favoriteModels: string[];
  providerByModel: Record<string, string>;
  /** Percent of the context window's input room at which a chat is compacted; 0 is off. */
  autoCompactThreshold: number;
  /** A chat is compacted at this many input tokens at the latest; 0 sets no bound. */
  autoCompactMaxTokens: number;
  maxToolIterations: number;
  autoContinueAllSessions: boolean;
  subagentModel: string | null;
  compactionModel: string | null;
  titleModel: string | null;
  commitMessageModel: string | null;
  promptCaching: boolean;
  /** Ask the agent once to run a project check before it finishes with unchecked code changes. */
  verifyBeforeFinish: boolean;
  commandRules: CommandRule[];
  deniedCommandRules: CommandRule[];
  allowedWebsites: string[];
  deniedWebsites: string[];
  /** MCP tools that run without a prompt, saved with "always allow". */
  mcpToolGrants: McpToolGrant[];
  /** Folders whose sensitive files commands may use without a prompt. */
  secretFolders: string[];
  permissionDefaults: PermissionDefaults;
  autoApproveReadOnly: boolean;
  autoApprovePackageScripts: boolean;
  autoApproveProjectExecutables: boolean;
  autoApproveProjectCommands: boolean;
  ignoreGitignored: boolean;
  scanGeneratedFiles: boolean;
  ignoreLocalDatabases: boolean;
  ignoreEnvFiles: boolean;
  fileIgnoreExemptions: string[];
  fileIgnoreDisabled: string[];
  fileIgnoreEnabled: string[];
  fileIgnoreAdvanced: boolean;
  mcpAutoDiscovery: boolean;
  mcpFolders: string[];
  mcpDisabled: string[];
  mcpDisabledServers: McpServerRef[];
  mcpProgressiveDisclosure: boolean;
  skillsAutoDiscovery: boolean;
  skillFolders: string[];
  skillsDisabled: string[];
  skillsDisabledItems: SkillRef[];
  marketplaceVerifiedOnly: boolean;
  keepAwake: boolean;
  tabsMultiline: boolean;
  pasteWordLimit: number;
  openTabHotkey: string;
  closeTabHotkey: string;
  newSessionHotkey: string;
  deleteSessionHotkey: string;
  terminalHotkey: string;
  /** Overrides for configurable hotkeys, keyed by `HotkeyAction`. */
  hotkeys: Record<string, string>;
  windowToggleEnabled: boolean;
  windowToggleHotkey: string;
  windowToggleAction: WindowToggleAction;
  windowToggleMaximize: boolean;
  zoom: number;
  waitingChatsBanner: boolean;
  soundsEnabled: boolean;
  soundVolume: number;
  doneSound: string;
  permissionSound: string;
  errorSound: string;
  doneSoundPath: string;
  permissionSoundPath: string;
  errorSoundPath: string;
  background: string;
  backgroundImage: string;
  backgroundOpacity: number;
  backgroundBlur: number;
  glassOpacity: number;
  /** Id of the logo in the app header, see `LOGOS`. */
  logo: string;
  /** How far the operating system confines the agent's commands. */
  sandbox: SandboxMode;
  /** Folders outside the project a confined command may still write to. */
  sandboxWritableFolders: string[];
  /** Folders and files a confined command may not read. */
  sandboxUnreadableFolders: string[];
  /** Commands that run outside the sandbox. */
  sandboxExcludedCommands: string[];
  /** Commands of the user's that run at fixed moments of the agent's work. */
  hooks: Hook[];
}

export type SandboxMode = 'off' | 'files' | 'filesAndNetwork';

/** What the sandbox can do on this machine (`get_sandbox_support`). */
export interface SandboxSupport {
  files: boolean;
  network: boolean;
}

export type HookEvent = 'beforeTool' | 'afterTool' | 'turnEnd';

export interface Hook {
  id: string;
  enabled: boolean;
  event: HookEvent;
  /** Tool names or patterns separated by `|`; empty runs it for every tool. */
  tools: string;
  /** Patterns for the file a call names; empty runs it for every call. */
  files: string;
  command: string;
  timeoutSeconds: number;
  /** Path of the one project it runs in; empty runs it in every project. */
  project: string;
}

export type PermissionDefaultAction = 'once' | 'session';

export interface PermissionDefaults {
  website: PermissionDefaultAction;
  command: PermissionDefaultAction;
  folder: PermissionDefaultAction;
}

export interface DefaultSystemPrompts {
  defaultSystemPrompt: string;
  securitySystemPrompt: string;
  testingSystemPrompt: string;
  architectureSystemPrompt: string;
  userSystemPrompts: UserSystemPrompt[];
}

export interface McpCandidate {
  path: string;
  label: string;
  source: string;
  format: string;
  servers: McpServerState[];
  enabled: boolean;
}

export interface McpServerState {
  name: string;
  enabled: boolean;
  /** Launch command line or URL. */
  detail: string | null;
}

export interface McpServerRef {
  path: string;
  name: string;
}

export interface SkillCandidate {
  path: string;
  label: string;
  source: string;
  skills: SkillState[];
  enabled: boolean;
}

export interface SkillState {
  name: string;
  enabled: boolean;
  description: string | null;
}

export interface SkillRef {
  path: string;
  name: string;
}

export interface MarketplaceEnv {
  name: string;
  required: boolean;
  secret: boolean;
}

export interface MarketplaceServer {
  name: string;
  title: string | null;
  description: string | null;
  version: string | null;
  kind: string;
  transport: string | null;
  url: string | null;
  command: string | null;
  args: string[];
  env: MarketplaceEnv[];
  repository: string | null;
  verified: boolean;
  publishedAt: string | null;
  updatedAt: string | null;
}

export interface MarketplacePlugin {
  name: string;
  description: string | null;
  version: string | null;
  repository: string | null;
  homepage: string | null;
  category: string | null;
  keywords: string[];
  skills: string[];
}

export interface DirectoryInstall {
  command: string | null;
  args: string[];
  url: string | null;
  transport: string | null;
  cli: string | null;
  requirements: string[];
}

export interface DirectoryServer {
  name: string;
  displayName: string;
  description: string | null;
  version: string | null;
  category: string;
  serverType: string | null;
  logoUrl: string | null;
  sourceRegistry: string;
  githubUrl: string | null;
  dockerUrl: string | null;
  npmUrl: string | null;
  documentationUrl: string | null;
  githubStars: number;
  dockerPulls: number;
  npmDownloads: number;
  verificationStatus: string;
  env: MarketplaceEnv[];
  install: DirectoryInstall;
}

export interface DirectoryPage {
  servers: DirectoryServer[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface SkillMarketplace {
  name: string;
  description: string | null;
  owner: string | null;
  url: string | null;
  path: string | null;
  source: string;
  verified: boolean;
  trusted: boolean;
  commit: string | null;
  spoofedName: boolean;
  plugins: MarketplacePlugin[];
}

export interface InstalledSkill {
  name: string;
  marketplace: string;
  plugin: string;
  description: string | null;
  path: string;
}

/** A reviewed server to add to pumr's own MCP config. */
export interface McpInstallRequest {
  name: string;
  command: string | null;
  args: string[];
  url: string | null;
  transport: string | null;
  env: Record<string, string>;
}

export interface IgnoreCatalogEntry {
  id: string;
  group: string;
  pattern: string;
}

export interface GitInfo {
  isRepo: boolean;
  branch: string | null;
  head: string | null;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
  /** Remote of a remote branch, or of a local branch's upstream. */
  remoteName: string | null;
  /** Branch name on that remote, without the remote prefix. */
  remoteBranch: string | null;
  hash: string | null;
  subject: string | null;
  timestamp: number | null;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  timestamp: number;
  subject: string;
  refs: string[];
  parents: string[];
}

export interface GitCommitDetail {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  timestamp: number;
  subject: string;
  body: string;
  parents: string[];
  refs: string[];
  changes: FileChange[];
}

export interface GitBlameLine {
  hash: string;
  shortHash: string;
  author: string;
  timestamp: number;
  line: number;
  content: string;
}

export interface GitTag {
  name: string;
  hash: string;
}

export interface GitStash {
  /** `stash@{N}`; shifts when stashes are added or dropped. */
  name: string;
  /** The stash commit; the backend checks `name` still points at it. */
  hash: string;
  message: string;
}

export const GIT_REBASE_ACTIONS = ['pick', 'squash', 'fixup', 'drop'] as const;
export type GitRebaseAction = (typeof GIT_REBASE_ACTIONS)[number];

export interface GitRebaseEntry {
  action: GitRebaseAction;
  hash: string;
}

/** Working-tree status; refs are loaded separately as {@link GitRefs}. */
export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: FileChange[];
  unstaged: FileChange[];
  operation: GitOperation | null;
  conflicted: string[];
}

export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export interface GitRefs {
  branches: GitBranch[];
  tags: GitTag[];
  stashes: GitStash[];
  submodules: string[];
  remotes: string[];
}

export type GitPullStrategy = 'ff-only' | 'merge' | 'rebase';

export interface ProjectRule {
  path: string;
  scope: string;
  content: string;
}

export interface FileDiff {
  path: string;
  oldContent: string;
  newContent: string;
  language: string;
  additions: number;
  deletions: number;
  status: string;
  /** Binary files come without content. */
  binary?: boolean;
  /** Files too large to preview come without content. */
  tooLarge?: boolean;
}

export type GitDiffLineKind = 'context' | 'add' | 'del';

/** One line of a hunk as `git diff` printed it. */
export interface GitDiffLine {
  /** Position in the whole diff; line actions refer to it. */
  id: number;
  kind: GitDiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
  /** The last line of its side, without a newline at the end of the file. */
  noNewline: boolean;
}

export interface GitDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The function or section git names after the `@@` header. */
  section: string;
  lines: GitDiffLine[];
}

/** Why single lines and hunks of a diff cannot be staged, unstaged or discarded. */
export type GitLineBlock =
  | 'binary'
  | 'tooLarge'
  | 'conflict'
  | 'symlink'
  | 'submodule'
  | 'whitespace';

/** A working-tree or staged diff split into hunks. */
export interface GitHunkDiff {
  path: string;
  staged: boolean;
  status: string;
  language: string;
  hunks: GitDiffHunk[];
  additions: number;
  deletions: number;
  binary: boolean;
  tooLarge: boolean;
  blocked: GitLineBlock | null;
  /** Identifies this exact diff, so line actions refuse to run on a stale view. */
  fingerprint: string;
}

export type GitLineAction = 'stage' | 'unstage' | 'discard';

export type GitResetMode = 'soft' | 'mixed' | 'hard';

export type GitConflictSide = 'ours' | 'theirs';

/** How the Changes view shows a diff; kept across projects and restarts. */
export interface GitDiffOptions {
  /** Unchanged lines around each change; `GIT_WHOLE_FILE_CONTEXT` shows the whole file. */
  context: number;
  ignoreWhitespace: boolean;
  layout: 'unified' | 'split';
  wrap: boolean;
}

/** Context lines that make a diff show the whole file as one hunk. */
export const GIT_WHOLE_FILE_CONTEXT = 10_000_000;

export interface ProcessInfo {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  startedAt: number;
  running: boolean;
  output: string;
}

/** Streamed from an interactive terminal opened with `terminal_open`. */
export type TerminalEvent =
  | { kind: 'output'; data: string }
  | { kind: 'exit'; code: number | null };

export interface RevertResult {
  prompt: string;
  restoredFiles: string[];
}

export interface QuestionOption {
  label: string;
  description: string | null;
  /** The option the assistant would pick; shown with a "Recommended" badge. */
  recommended: boolean;
}

export interface QuestionItem {
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface QuestionAnswer {
  header: string;
  question: string;
  selected: string[];
  custom: string | null;
}

export interface LiveToolCall {
  callId: string;
  name: string;
  summary: string;
  arguments: string;
  /** While the call runs: the latest of what it has printed so far. */
  output: string;
  /**
   * The call has been printing for longer than a moment, so the chat opens
   * its output and follows it. A command that is over at once never is.
   */
  live: boolean;
  status: 'running' | 'ok' | 'error' | 'denied' | 'canceled';
  changes: FileChange[];
  /** Pictures the call shows in the chat (the `screenshot` tool). */
  attachments: MessageAttachment[];
  anchor: string | null;
}

export interface CommandSegment {
  text: string;
  allowed: boolean;
  suggestedRule?: string | null;
  scopeOptions?: CommandScopeOption[];
  /** Why this segment needs approval; absent for auto-allowed segments. */
  reason?: string | null;
  /**
   * Outside-project folders this segment touches. With no `scopeOptions`, a
   * folder grant is the only way to stop the segment from asking.
   */
  folders?: string[];
  /**
   * Websites this segment contacts that are not allowed yet. Like `folders`,
   * only a website grant can stop such a segment from asking.
   */
  hosts?: string[];
}

export type CommandRiskLevel = 'low' | 'medium' | 'network' | 'high' | 'danger';

export interface CommandRisk {
  level: CommandRiskLevel;
  detail: string;
}

export type CommandScopeKind = 'program' | 'subcommand' | 'programFlags' | 'exact';

export type CommandRule = { kind: 'exact'; value: string } | { kind: 'glob'; value: string };

export interface CommandScopeOption {
  kind: CommandScopeKind;
  rule: CommandRule;
}

/** A remembered approval for one tool of one MCP server, with any arguments. */
export interface McpToolGrant {
  server: string;
  tool: string;
  /** The config file that defines the server. */
  source: string;
  /** Digest of the server's configuration; a changed server asks again. */
  fingerprint: string;
}

export type PermissionRequestEvent = Extract<StreamEvent, { kind: 'permissionRequest' }>;

/** One recorded permission decision, for the debug view's permission log. */
export interface PermissionAuditEntry {
  id: number;
  createdAt: number;
  /** The session that asked (may be a subagent). */
  sessionId: string;
  /** The chat (root session) the decision belongs to. */
  conversationId: string;
  kind: string;
  /** The command line, URL or path. */
  subject: string;
  allowed: boolean;
  /**
   * `auto` (allowed without asking), `rule` (a deny rule), or who resolved a
   * prompt: `user`, `grant`, `cascade`, `stopped`, `timeout`, `cancelled`.
   */
  decidedBy: string;
  decision: string | null;
  reason: string;
  rule: string | null;
}

/** The machine a chat's debug log is exported on. */
export interface SystemInfo {
  /** `macOS`, `Windows`, `Linux`, or the OS's own name elsewhere. */
  osName: string;
  /** e.g. `15.6 (24G84)`, `11 23H2 (10.0.22631.4037)`, `Ubuntu 24.04.1 LTS`. */
  osVersion: string | null;
  /** e.g. `Darwin 25.6.0`; `null` on Windows. */
  kernel: string | null;
  arch: string;
  appVersion: string;
  webviewVersion: string | null;
  /** Linux: the session type and desktop, e.g. `wayland (GNOME)`. */
  desktop: string | null;
  /** Linux: whether pumr runs from an AppImage. */
  appImage: boolean;
}

/** A personal or secret value a model found in a debug log excerpt. */
export interface SensitiveFinding {
  /** Copied verbatim from the excerpt. */
  text: string;
  /** `name`, `username`, `email`, `phone`, `address`, `secret`, `ip`, `url`, `path`, `org` or `other`. */
  kind: string;
}

export type QuestionRequestEvent = Extract<StreamEvent, { kind: 'questionRequest' }>;
export type ModelChoiceRequestEvent = Extract<StreamEvent, { kind: 'modelChoiceRequest' }>;

export interface ContextUsageInfo {
  usedTokens: number;
  budgetTokens: number;
  systemTokens: number;
  historyTokens: number;
  toolSchemaTokens: number;
  toolOutputTokens: number;
}

export type StreamEvent =
  | { kind: 'started'; message: Message }
  | { kind: 'delta'; text: string }
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'usage';
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
      cacheWriteTokens: number;
      cost: number;
    }
  | {
      kind: 'contextUsage';
      usedTokens: number;
      budgetTokens: number;
      systemTokens: number;
      historyTokens: number;
      toolSchemaTokens: number;
      toolOutputTokens: number;
    }
  | { kind: 'assistant'; message: Message }
  /** The history is being summarised before the next request. */
  | { kind: 'compacting' }
  /** The history was compacted; `message` records the checkpoint. */
  | { kind: 'compacted'; message: Message }
  /** pumr told the agent something; `message` records it. */
  | { kind: 'note'; message: Message }
  /** An MCP server the turn uses is being started or connected to. */
  | { kind: 'mcpStarting'; server: string }
  /** The turn's MCP servers are settled; `issues` names those it has to do without, and why. */
  | { kind: 'mcpReady'; issues: string[] }
  | { kind: 'toolStart'; callId: string; name: string; summary: string; arguments: string }
  | { kind: 'toolDelta'; callId: string; text: string }
  | {
      kind: 'toolEnd';
      callId: string;
      name: string;
      status: string;
      result: string;
      changes: FileChange[];
      /** Pictures the call shows in the chat (the `screenshot` tool). */
      attachments?: MessageAttachment[];
    }
  | {
      kind: 'permissionRequest';
      requestId: string;
      promptKind: string;
      title: string;
      detail: string;
      command: string | null;
      path: string | null;
      folder: string | null;
      url: string | null;
      suggestedRule: string | null;
      segments: CommandSegment[];
      risk: CommandRisk | null;
      scopeOptions: CommandScopeOption[];
      folders: string[];
      /** Websites a command contacts that the user can allow. */
      hosts: string[];
      /** The MCP tool a "don't ask again" choice would remember. */
      mcpTool?: McpToolGrant | null;
      /** Folders whose sensitive files the user can release for commands. */
      secretFolders?: string[];
      /** The assistant's one-sentence explanation of why it asks. */
      justification: string | null;
    }
  | { kind: 'permissionResolved'; requestId: string; allowed: boolean }
  | { kind: 'questionRequest'; requestId: string; questions: QuestionItem[] }
  | { kind: 'questionResolved'; requestId: string; answers: QuestionAnswer[] | null }
  /**
   * The model the agent named for a subagent (`query`) fits several models;
   * `candidates` holds their ids, the closest first.
   */
  | { kind: 'modelChoiceRequest'; requestId: string; query: string; candidates: string[] }
  | { kind: 'modelChoiceResolved'; requestId: string; model: string | null }
  | { kind: 'changes'; changes: FileChange[] }
  | { kind: 'done'; message: Message; session: Session }
  | { kind: 'stopped'; message: Message }
  | { kind: 'interrupted'; message: Message }
  | { kind: 'subAgentStarted'; session: Session }
  | { kind: 'subAgentStatus'; status: string }
  | { kind: 'limitReached'; iterations: number; autoContinued: boolean }
  | { kind: 'error'; message: string };

export interface RoutedEvent {
  sessionId: string;
  event: StreamEvent;
}

/** What compacting a chat on request left behind. */
export interface CompactResult {
  /** The checkpoint's record in the chat. */
  message: Message;
  /** Estimated tokens of the messages the model is sent from now on. */
  usedTokens: number;
}

/** Streamed while a side question (`/btw`) is being answered. */
export type SideAnswerEvent = { kind: 'delta'; text: string };

export interface SideAnswer {
  answer: string;
  /** Stopped before the model finished; `answer` is what had arrived. */
  cancelled: boolean;
}

export interface PendingPermission extends PermissionRequestEvent {
  sessionId: string;
}

export interface PendingQuestion extends QuestionRequestEvent {
  sessionId: string;
}

export interface PendingModelChoice extends ModelChoiceRequestEvent {
  sessionId: string;
}

/**
 * Turns still running in the backend and the prompts they wait on, so a
 * webview that reloaded mid-turn can pick them up again.
 */
export interface RunningTurns {
  sessionIds: string[];
  permissions: { sessionId: string; event: PermissionRequestEvent }[];
  questions: { sessionId: string; event: QuestionRequestEvent }[];
  modelChoices: { sessionId: string; event: ModelChoiceRequestEvent }[];
}

export interface CreateSessionArgs {
  projectId: string;
  title?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  provider?: string | null;
  systemPrompt?: string | null;
  modeId?: string | null;
}

export interface UpdateSessionArgs {
  sessionId: string;
  title?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  provider?: string | null;
  systemPrompt?: string | null;
  modeId?: string | null;
  projectId?: string | null;
}

export interface SendMessageArgs {
  sessionId: string;
  content: string;
  model: string;
  reasoningEffort?: string | null;
  provider?: string | null;
  attachments?: MessageAttachment[];
  mentions?: Mention[];
  /** Id of the prompt of "Your prompts" that the message calls with a slash command. */
  promptId?: string | null;
  resume?: boolean;
}
