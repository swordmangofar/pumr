import { CustomTheme } from './themes';

export type WindowToggleAction = 'hide' | 'minimize';

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
  content: string;
  language: string;
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
  role: 'user' | 'assistant' | 'system' | 'tool';
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

export interface UserSystemPrompt {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
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
  defaultModel: string | null;
  handoverModel: string | null;
  defaultReasoningEffort: string | null;
  favoriteModels: string[];
  providerByModel: Record<string, string>;
  contextMessageLimit: number;
  maxToolIterations: number;
  autoContinueAllSessions: boolean;
  subagentModel: string | null;
  compactionModel: string | null;
  titleModel: string | null;
  promptCaching: boolean;
  commandRules: CommandRule[];
  deniedCommandRules: CommandRule[];
  allowedWebsites: string[];
  deniedWebsites: string[];
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
  windowToggleEnabled: boolean;
  windowToggleHotkey: string;
  windowToggleAction: WindowToggleAction;
  windowToggleMaximize: boolean;
  zoom: number;
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
  description: string | null;
  path: string;
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

export interface ProcessInfo {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  startedAt: number;
  running: boolean;
  output: string;
}

export interface RevertResult {
  prompt: string;
  restoredFiles: string[];
}

export interface QuestionOption {
  label: string;
  description: string | null;
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
  output: string;
  status: 'running' | 'ok' | 'error' | 'denied' | 'canceled';
  changes: FileChange[];
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

export type QuestionRequestEvent = Extract<StreamEvent, { kind: 'questionRequest' }>;

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
  | { kind: 'toolStart'; callId: string; name: string; summary: string; arguments: string }
  | { kind: 'toolDelta'; callId: string; text: string }
  | {
      kind: 'toolEnd';
      callId: string;
      name: string;
      status: string;
      result: string;
      changes: FileChange[];
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
    }
  | { kind: 'permissionResolved'; requestId: string; allowed: boolean }
  | { kind: 'questionRequest'; requestId: string; questions: QuestionItem[] }
  | { kind: 'questionResolved'; requestId: string; answers: QuestionAnswer[] | null }
  | { kind: 'changes'; changes: FileChange[] }
  | { kind: 'done'; message: Message; session: Session }
  | { kind: 'stopped'; message: Message }
  | { kind: 'subAgentStarted'; session: Session }
  | { kind: 'subAgentStatus'; status: string }
  | { kind: 'limitReached'; iterations: number; autoContinued: boolean }
  | { kind: 'error'; message: string };

export interface RoutedEvent {
  sessionId: string;
  event: StreamEvent;
}

export interface PendingPermission extends PermissionRequestEvent {
  sessionId: string;
}

export interface PendingQuestion extends QuestionRequestEvent {
  sessionId: string;
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
  resume?: boolean;
}
