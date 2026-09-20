import { Channel, invoke } from '@tauri-apps/api/core';
import {
  CreateSessionArgs,
  DefaultSystemPrompts,
  EndpointInfo,
  FileChange,
  FileDiff,
  GitInfo,
  McpCandidate,
  Message,
  Mode,
  ModelInfo,
  ProcessInfo,
  Project,
  ProjectRule,
  ProviderInfo,
  QuestionAnswer,
  RevertResult,
  RoutedEvent,
  SendMessageArgs,
  Session,
  Settings,
  SkillCandidate,
  SpendStats,
  SpendSummary,
  UpdateSessionArgs,
  WorkspaceEntry,
  WorkspaceFile,
} from './models';

export const OPENROUTER_PROVIDER = 'openrouter';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const api = {
  getSettings: () => invoke<Settings>('get_settings'),
  getDefaultSystemPrompts: () => invoke<DefaultSystemPrompts>('get_default_system_prompts'),
  getDefaultModes: () => invoke<Mode[]>('get_default_modes'),
  saveSettings: (settings: Settings) => invoke<Settings>('save_settings', { settings }),
  setApiKey: (provider: string, key: string) => invoke<void>('set_api_key', { provider, key }),
  deleteApiKey: (provider: string) => invoke<void>('delete_api_key', { provider }),
  hasApiKey: (provider: string) => invoke<boolean>('has_api_key', { provider }),
  listModels: (refresh = false) => invoke<ModelInfo[]>('list_models', { refresh }),
  listEndpoints: (modelId: string, refresh = false) =>
    invoke<EndpointInfo[]>('list_endpoints', { modelId, refresh }),
  listProviders: (refresh = false) => invoke<ProviderInfo[]>('list_providers', { refresh }),
  listProjects: () => invoke<Project[]>('list_projects'),
  addProject: (path: string) => invoke<Project>('add_project', { path }),
  removeProject: (projectId: string) => invoke<void>('remove_project', { projectId }),
  updateProject: (args: {
    projectId: string;
    color: string | null;
    icon: string | null;
    iconImage: string | null;
  }) => invoke<Project>('update_project', { ...args }),
  listSessions: (projectId: string, includeArchived = false) =>
    invoke<Session[]>('list_sessions', { projectId, includeArchived }),
  listSubSessions: (sessionId: string) => invoke<Session[]>('list_sub_sessions', { sessionId }),
  createSession: (args: CreateSessionArgs) => invoke<Session>('create_session', { ...args }),
  updateSession: (args: UpdateSessionArgs) => invoke<Session>('update_session', { ...args }),
  archiveSession: (sessionId: string, archived: boolean) =>
    invoke<Session>('archive_session', { sessionId, archived }),
  deleteSession: (sessionId: string) => invoke<void>('delete_session', { sessionId }),
  listMessages: (sessionId: string) => invoke<Message[]>('list_messages', { sessionId }),
  getSpend: (sessionId: string | null = null) => invoke<SpendSummary>('get_spend', { sessionId }),
  getSpendStats: (fromMs: number, toMs: number, bucket: 'day' | 'hour' = 'day') =>
    invoke<SpendStats>('get_spend_stats', { fromMs, toMs, bucket }),
  stopGeneration: (sessionId: string) => invoke<void>('stop_generation', { sessionId }),
  resolvePermission: (
    requestId: string,
    decision: 'allow_once' | 'allow_always' | 'deny' | 'deny_always',
    rule: string | null = null,
    folder: string | null = null,
    promptKind: string | null = null,
  ) => invoke<void>('resolve_permission', { requestId, decision, rule, folder, promptKind }),
  resolveQuestion: (requestId: string, answers: QuestionAnswer[] | null) =>
    invoke<void>('resolve_question', { requestId, answers }),
  addCommandRule: (rule: string) => invoke<Settings>('add_command_rule', { rule }),
  deleteCommandRule: (rule: string) => invoke<Settings>('delete_command_rule', { rule }),
  addWebsiteRule: (rule: string, allow: boolean) =>
    invoke<Settings>('add_website_rule', { rule, allow }),
  deleteWebsiteRule: (rule: string, allow: boolean) =>
    invoke<Settings>('delete_website_rule', { rule, allow }),
  listProcesses: () => invoke<ProcessInfo[]>('list_processes'),
  stopProcess: (processId: string) => invoke<void>('stop_process', { processId }),
  getGitInfo: (projectId: string) => invoke<GitInfo>('get_git_info', { projectId }),
  getSessionChanges: (sessionId: string) =>
    invoke<FileChange[]>('get_session_changes', { sessionId }),
  getFileDiff: (sessionId: string, path: string) =>
    invoke<FileDiff>('get_file_diff', { sessionId, path }),
  getProjectRules: (projectId: string, sessionId: string | null = null) =>
    invoke<ProjectRule[]>('get_project_rules', { projectId, sessionId }),
  discoverMcpSources: (folders: string[], disabled: string[], autoDiscovery: boolean) =>
    invoke<McpCandidate[]>('discover_mcp_sources', { folders, disabled, autoDiscovery }),
  discoverSkills: (folders: string[], disabled: string[], autoDiscovery: boolean) =>
    invoke<SkillCandidate[]>('discover_skills', { folders, disabled, autoDiscovery }),
  listWorkspaceEntries: (projectId: string) =>
    invoke<WorkspaceEntry[]>('list_workspace_entries', { projectId }),
  readWorkspaceFile: (projectId: string, path: string) =>
    invoke<WorkspaceFile>('read_workspace_file', { projectId, path }),
  writeWorkspaceFile: (projectId: string, path: string, content: string) =>
    invoke<void>('write_workspace_file', { projectId, path, content }),
  revertToMessage: (messageId: string, restoreFiles: boolean) =>
    invoke<RevertResult>('revert_to_message', { messageId, restoreFiles }),
  summarizeSession: (sessionId: string) => invoke<string>('summarize_session', { sessionId }),
  sendMessage: (args: SendMessageArgs, channel: Channel<RoutedEvent>) =>
    invoke<Message>('send_message', { ...args, channel }),
};
