import { Channel, invoke } from '@tauri-apps/api/core';
import {
  CreateSessionArgs,
  DefaultSystemPrompts,
  EndpointInfo,
  FileChange,
  FileDiff,
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitInfo,
  GitRebaseEntry,
  GitStatus,
  IgnoreCatalogEntry,
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
  getFileIgnoreCatalog: () => invoke<IgnoreCatalogEntry[]>('get_file_ignore_catalog'),
  listProcesses: () => invoke<ProcessInfo[]>('list_processes'),
  stopProcess: (processId: string) => invoke<void>('stop_process', { processId }),
  getGitInfo: (projectId: string) => invoke<GitInfo>('get_git_info', { projectId }),
  getGitStatus: (projectId: string) => invoke<GitStatus>('get_git_status', { projectId }),
  getGitBranches: (projectId: string) => invoke<GitBranch[]>('get_git_branches', { projectId }),
  getGitCommits: (projectId: string, query: string | null = null, skip = 0, limit = 50) =>
    invoke<GitCommit[]>('get_git_commits', { projectId, query, skip, limit }),
  getGitCommit: (projectId: string, hash: string) =>
    invoke<GitCommitDetail>('get_git_commit', { projectId, hash }),
  getGitCommitFileDiff: (projectId: string, hash: string, path: string) =>
    invoke<FileDiff>('get_git_commit_file_diff', { projectId, hash, path }),
  getGitFileDiff: (projectId: string, path: string, staged: boolean) =>
    invoke<FileDiff>('get_git_file_diff', { projectId, path, staged }),
  gitStage: (projectId: string, path: string | null = null) =>
    invoke<void>('git_stage', { projectId, path }),
  gitUnstage: (projectId: string, path: string | null = null) =>
    invoke<void>('git_unstage', { projectId, path }),
  gitDiscard: (projectId: string, path: string) => invoke<void>('git_discard', { projectId, path }),
  gitCommit: (projectId: string, message: string, amend: boolean) =>
    invoke<string>('git_commit', { projectId, message, amend }),
  gitCheckout: (projectId: string, branch: string, track = false, localBranch?: string) =>
    invoke<string>('git_checkout', { projectId, branch, track, localBranch }),
  gitFetch: (projectId: string) => invoke<string>('git_fetch', { projectId }),
  gitPull: (projectId: string) => invoke<string>('git_pull', { projectId }),
  gitPush: (projectId: string) => invoke<string>('git_push', { projectId }),
  getGitRemotes: (projectId: string) => invoke<string[]>('get_git_remotes', { projectId }),
  gitFastForward: (projectId: string, branch: string, upstream: string) =>
    invoke<string>('git_fast_forward', { projectId, branch, upstream }),
  gitMerge: (projectId: string, branch: string) =>
    invoke<string>('git_merge', { projectId, branch }),
  gitRebase: (projectId: string, onto: string) => invoke<string>('git_rebase', { projectId, onto }),
  gitRebaseInteractive: (projectId: string, onto: string, todo: GitRebaseEntry[]) =>
    invoke<string>('git_rebase_interactive', { projectId, onto, todo }),
  getGitRebaseCommits: (projectId: string, onto: string) =>
    invoke<GitCommit[]>('get_git_rebase_commits', { projectId, onto }),
  gitBranchCreate: (
    projectId: string,
    name: string,
    startPoint: string | null,
    checkout: boolean,
  ) => invoke<string>('git_branch_create', { projectId, name, startPoint, checkout }),
  gitTagCreate: (projectId: string, name: string, target: string | null, message: string | null) =>
    invoke<string>('git_tag_create', { projectId, name, target, message }),
  gitBranchRename: (projectId: string, from: string, to: string) =>
    invoke<string>('git_branch_rename', { projectId, from, to }),
  gitBranchDelete: (projectId: string, branch: string, remote: boolean) =>
    invoke<string>('git_branch_delete', { projectId, branch, remote }),
  gitSetUpstream: (projectId: string, branch: string, upstream: string) =>
    invoke<string>('git_set_upstream', { projectId, branch, upstream }),
  gitPushBranch: (projectId: string, branch: string, remote: string, setUpstream: boolean) =>
    invoke<string>('git_push_branch', { projectId, branch, remote, setUpstream }),
  gitPullRequestUrl: (projectId: string, remote: string, branch: string) =>
    invoke<string>('git_pull_request_url', { projectId, remote, branch }),
  openExternalUrl: (url: string) => invoke<void>('open_external_url', { url }),
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
