export interface Project {
  id: string;
  path: string;
  name: string;
  createdAt: number;
  lastOpenedAt: number;
  sessionCount: number;
  totalCost: number;
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
  sessionCost: number;
  budgetUsd: number;
  remainingUsd: number | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface Settings {
  defaultSystemPrompt: string;
  budgetUsd: number;
  language: string;
  extraFolders: string[];
  openrouterBaseUrl: string;
  defaultModel: string | null;
  defaultReasoningEffort: string | null;
  favoriteModels: string[];
  contextMessageLimit: number;
  commandRules: string[];
  allowedWebsites: string[];
  deniedWebsites: string[];
  mcpAutoDiscovery: boolean;
  mcpFolders: string[];
  mcpDisabled: string[];
  skillsAutoDiscovery: boolean;
  skillFolders: string[];
  skillsDisabled: string[];
  keepAwake: boolean;
}

export interface McpCandidate {
  path: string;
  label: string;
  source: string;
  format: string;
  servers: string[];
  enabled: boolean;
}

export interface SkillCandidate {
  path: string;
  label: string;
  source: string;
  skills: string[];
  enabled: boolean;
}

export interface GitInfo {
  isRepo: boolean;
  branch: string | null;
  head: string | null;
}

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

export interface LiveToolCall {
  callId: string;
  name: string;
  summary: string;
  arguments: string;
  output: string;
  status: 'running' | 'ok' | 'error' | 'denied';
  changes: FileChange[];
  anchor: string | null;
}

export type PermissionRequestEvent = Extract<StreamEvent, { kind: 'permissionRequest' }>;

export type StreamEvent =
  | { kind: 'started'; message: Message }
  | { kind: 'delta'; text: string }
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'usage';
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
      cost: number;
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
    }
  | { kind: 'permissionResolved'; requestId: string; allowed: boolean }
  | { kind: 'changes'; changes: FileChange[] }
  | { kind: 'done'; message: Message; session: Session }
  | { kind: 'stopped'; message: Message }
  | { kind: 'subAgentStarted'; session: Session }
  | { kind: 'subAgentStatus'; status: string }
  | { kind: 'error'; message: string };

export interface RoutedEvent {
  sessionId: string;
  event: StreamEvent;
}

export interface PendingPermission extends PermissionRequestEvent {
  sessionId: string;
}

export interface CreateSessionArgs {
  projectId: string;
  title?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  provider?: string | null;
  systemPrompt?: string | null;
}

export interface UpdateSessionArgs {
  sessionId: string;
  title?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  provider?: string | null;
  systemPrompt?: string | null;
}

export interface SendMessageArgs {
  sessionId: string;
  content: string;
  model: string;
  reasoningEffort?: string | null;
  provider?: string | null;
}
