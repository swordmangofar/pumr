import { Channel, invoke } from '@tauri-apps/api/core';
import {
  CommandRule,
  CreateSessionArgs,
  DefaultSystemPrompts,
  DirectoryPage,
  EndpointInfo,
  FileChange,
  FileDiff,
  GitBlameLine,
  GitCommit,
  GitCommitDetail,
  GitConflictSide,
  GitHunkDiff,
  GitInfo,
  GitLineAction,
  GitOperation,
  GitPullStrategy,
  GitRebaseEntry,
  GitRefs,
  GitResetMode,
  GitStash,
  GitStatus,
  IgnoreCatalogEntry,
  InstalledSkill,
  MarketplaceServer,
  McpCandidate,
  McpServerRef,
  Message,
  Mode,
  ModelInfo,
  PermissionAuditEntry,
  ProcessInfo,
  Project,
  ProjectRule,
  ProviderInfo,
  QuestionAnswer,
  RevertResult,
  RoutedEvent,
  RunningTurns,
  SendMessageArgs,
  Session,
  Settings,
  SkillCandidate,
  SkillMarketplace,
  SkillRef,
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

/**
 * Identifies one `send_message` or `attach_session` call. Tauri re-delivers an
 * invoke whose IPC request failed (a webview reload mid-turn does that) with
 * the same payload, and the backend uses this id to ignore the repeat instead
 * of starting a second turn that would cancel the running one, or of routing a
 * turn back to the reloaded page.
 */
function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `send-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const api = {
  getSettings: () => invoke<Settings>('get_settings'),
  getDefaultSystemPrompts: () => invoke<DefaultSystemPrompts>('get_default_system_prompts'),
  getDefaultModes: () => invoke<Mode[]>('get_default_modes'),
  saveSettings: (settings: Settings) => invoke<Settings>('save_settings', { settings }),
  suspendWindowShortcut: (suspended: boolean) =>
    invoke<void>('suspend_window_shortcut', { suspended }),
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
  listSubSessionsForProject: (projectId: string) =>
    invoke<Session[]>('list_sub_sessions_for_project', { projectId }),
  createSession: (args: CreateSessionArgs) => invoke<Session>('create_session', { ...args }),
  updateSession: (args: UpdateSessionArgs) => invoke<Session>('update_session', { ...args }),
  setSessionAutoContinue: (sessionId: string, autoContinue: boolean) =>
    invoke<Session>('set_session_auto_continue', { sessionId, autoContinue }),
  archiveSession: (sessionId: string, archived: boolean) =>
    invoke<Session>('archive_session', { sessionId, archived }),
  deleteSession: (sessionId: string) => invoke<void>('delete_session', { sessionId }),
  listMessages: (sessionId: string) => invoke<Message[]>('list_messages', { sessionId }),
  getSpend: (sessionId: string | null = null) => invoke<SpendSummary>('get_spend', { sessionId }),
  getSpendStats: (fromMs: number, toMs: number, bucket: 'day' | 'hour' = 'day') =>
    invoke<SpendStats>('get_spend_stats', { fromMs, toMs, bucket }),
  stopGeneration: (sessionId: string) => invoke<void>('stop_generation', { sessionId }),
  listRunningTurns: () => invoke<RunningTurns>('list_running_turns'),
  /** Resolves once the turn has finished; `false` when none was running. */
  attachSession: (sessionId: string, channel: Channel<RoutedEvent>) =>
    invoke<boolean>('attach_session', { sessionId, requestId: newRequestId(), channel }),
  resolvePermission: (
    requestId: string,
    decision: 'allow_once' | 'allow_session' | 'allow_always' | 'deny' | 'deny_always',
    rules: string[] | null = null,
    folder: string | null = null,
    promptKind: string | null = null,
    commandRules: CommandRule[] | null = null,
    folders: string[] | null = null,
    hosts: string[] | null = null,
  ) =>
    invoke<void>('resolve_permission', {
      requestId,
      decision,
      rules,
      folder,
      promptKind,
      commandRules,
      folders,
      hosts,
    }),
  listPermissionAudit: (conversationId: string | null, limit: number | null = null) =>
    invoke<PermissionAuditEntry[]>('list_permission_audit', { conversationId, limit }),
  clearPermissionAudit: (conversationId: string | null) =>
    invoke<void>('clear_permission_audit', { conversationId }),
  resolveQuestion: (requestId: string, answers: QuestionAnswer[] | null) =>
    invoke<void>('resolve_question', { requestId, answers }),
  addCommandRule: (rule: CommandRule, allow: boolean) =>
    invoke<Settings>('add_command_rule', { rule, allow }),
  deleteCommandRule: (rule: CommandRule, allow: boolean) =>
    invoke<Settings>('delete_command_rule', { rule, allow }),
  addWebsiteRule: (rule: string, allow: boolean) =>
    invoke<Settings>('add_website_rule', { rule, allow }),
  deleteWebsiteRule: (rule: string, allow: boolean) =>
    invoke<Settings>('delete_website_rule', { rule, allow }),
  getFileIgnoreCatalog: () => invoke<IgnoreCatalogEntry[]>('get_file_ignore_catalog'),
  listProcesses: () => invoke<ProcessInfo[]>('list_processes'),
  stopProcess: (processId: string) => invoke<void>('stop_process', { processId }),
  getGitInfo: (projectId: string) => invoke<GitInfo>('get_git_info', { projectId }),
  getGitStatus: (projectId: string) => invoke<GitStatus>('get_git_status', { projectId }),
  getGitRefs: (projectId: string) => invoke<GitRefs>('get_git_refs', { projectId }),
  getGitCommits: (
    projectId: string,
    query: string | null,
    skip: number,
    limit: number,
    path: string | null = null,
  ) => invoke<GitCommit[]>('get_git_commits', { projectId, query, path, skip, limit }),
  getGitCommit: (projectId: string, hash: string) =>
    invoke<GitCommitDetail>('get_git_commit', { projectId, hash }),
  getGitCommitFileDiff: (projectId: string, hash: string, path: string) =>
    invoke<FileDiff>('get_git_commit_file_diff', { projectId, hash, path }),
  getGitFileDiff: (projectId: string, path: string, staged: boolean) =>
    invoke<FileDiff>('get_git_file_diff', { projectId, path, staged }),
  getGitFileHunks: (
    projectId: string,
    path: string,
    staged: boolean,
    context: number,
    ignoreWhitespace: boolean,
  ) =>
    invoke<GitHunkDiff>('get_git_file_hunks', {
      projectId,
      path,
      staged,
      context,
      ignoreWhitespace,
    }),
  gitApplyLines: (
    projectId: string,
    path: string,
    staged: boolean,
    action: GitLineAction,
    context: number,
    fingerprint: string,
    lines: number[],
  ) =>
    invoke<void>('git_apply_lines', {
      projectId,
      path,
      staged,
      action,
      context,
      fingerprint,
      lines,
    }),
  gitResolveConflict: (projectId: string, path: string, side: GitConflictSide) =>
    invoke<void>('git_resolve_conflict', { projectId, path, side }),
  gitCherryPick: (projectId: string, hash: string) =>
    invoke<string>('git_cherry_pick', { projectId, hash }),
  gitRevert: (projectId: string, hash: string) => invoke<string>('git_revert', { projectId, hash }),
  gitReset: (projectId: string, hash: string, mode: GitResetMode) =>
    invoke<string>('git_reset', { projectId, hash, mode }),
  gitCheckoutCommit: (projectId: string, hash: string) =>
    invoke<string>('git_checkout_commit', { projectId, hash }),
  gitGenerateCommitMessage: (projectId: string) =>
    invoke<string>('git_generate_commit_message', { projectId }),
  gitStage: (projectId: string, path: string | null = null) =>
    invoke<void>('git_stage', { projectId, path }),
  gitStagePaths: (projectId: string, paths: string[]) =>
    invoke<void>('git_stage_paths', { projectId, paths }),
  gitUnstage: (projectId: string, path: string | null = null) =>
    invoke<void>('git_unstage', { projectId, path }),
  gitUnstagePaths: (projectId: string, paths: string[]) =>
    invoke<void>('git_unstage_paths', { projectId, paths }),
  gitDiscardPaths: (projectId: string, paths: string[]) =>
    invoke<void>('git_discard_paths', { projectId, paths }),
  getGitBlame: (projectId: string, path: string) =>
    invoke<GitBlameLine[]>('get_git_blame', { projectId, path }),
  gitIgnore: (projectId: string, path: string) => invoke<void>('git_ignore', { projectId, path }),
  revealPath: (projectId: string, path: string) => invoke<void>('reveal_path', { projectId, path }),
  gitCommit: (projectId: string, message: string, amend: boolean) =>
    invoke<string>('git_commit', { projectId, message, amend }),
  gitCheckout: (projectId: string, branch: string, track = false, localBranch?: string) =>
    invoke<string>('git_checkout', { projectId, branch, track, localBranch }),
  gitFetch: (projectId: string) => invoke<string>('git_fetch', { projectId }),
  gitPull: (projectId: string, strategy: GitPullStrategy) =>
    invoke<string>('git_pull', { projectId, strategy }),
  gitPush: (projectId: string) => invoke<string>('git_push', { projectId }),
  gitFastForward: (projectId: string, branch: string) =>
    invoke<string>('git_fast_forward', { projectId, branch }),
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
  gitBranchDelete: (projectId: string, branch: string, remote: boolean, force = false) =>
    invoke<string>('git_branch_delete', { projectId, branch, remote, force }),
  gitSetUpstream: (projectId: string, branch: string, upstream: string) =>
    invoke<string>('git_set_upstream', { projectId, branch, upstream }),
  gitPushBranch: (projectId: string, branch: string, remote: string, setUpstream: boolean) =>
    invoke<string>('git_push_branch', { projectId, branch, remote, setUpstream }),
  gitPullRequestUrl: (projectId: string, remote: string, branch: string) =>
    invoke<string>('git_pull_request_url', { projectId, remote, branch }),
  openExternalUrl: (url: string) => invoke<void>('open_external_url', { url }),
  pickAssetFile: (kind: 'image' | 'sound') =>
    invoke<string | null>('pick_asset_file', { kind }),
  gitOperationAbort: (projectId: string, operation: GitOperation) =>
    invoke<string>('git_operation_abort', { projectId, operation }),
  gitOperationContinue: (projectId: string, operation: GitOperation) =>
    invoke<string>('git_operation_continue', { projectId, operation }),
  gitStashPush: (projectId: string, message: string | null, includeUntracked: boolean) =>
    invoke<string>('git_stash_push', { projectId, message, includeUntracked }),
  gitStashApply: (projectId: string, stash: GitStash) =>
    invoke<string>('git_stash_apply', { projectId, stash: stash.name, hash: stash.hash }),
  gitStashPop: (projectId: string, stash: GitStash) =>
    invoke<string>('git_stash_pop', { projectId, stash: stash.name, hash: stash.hash }),
  gitStashDrop: (projectId: string, stash: GitStash) =>
    invoke<string>('git_stash_drop', { projectId, stash: stash.name, hash: stash.hash }),
  gitInit: (projectId: string) => invoke<string>('git_init', { projectId }),
  gitClone: (url: string, path: string) => invoke<Project>('git_clone', { url, path }),
  gitTagDelete: (projectId: string, name: string) =>
    invoke<string>('git_tag_delete', { projectId, name }),
  gitTagPush: (projectId: string, remote: string, name: string) =>
    invoke<string>('git_tag_push', { projectId, remote, name }),
  gitSubmoduleUpdate: (projectId: string, path: string | null) =>
    invoke<string>('git_submodule_update', { projectId, path }),
  getSessionChanges: (sessionId: string) =>
    invoke<FileChange[]>('get_session_changes', { sessionId }),
  getFileDiff: (sessionId: string, path: string) =>
    invoke<FileDiff>('get_file_diff', { sessionId, path }),
  getProjectRules: (projectId: string, sessionId: string | null = null) =>
    invoke<ProjectRule[]>('get_project_rules', { projectId, sessionId }),
  discoverMcpSources: (
    folders: string[],
    disabled: string[],
    disabledServers: McpServerRef[],
    autoDiscovery: boolean,
  ) =>
    invoke<McpCandidate[]>('discover_mcp_sources', {
      folders,
      disabled,
      disabledServers,
      autoDiscovery,
    }),
  discoverSkills: (
    folders: string[],
    disabled: string[],
    disabledItems: SkillRef[],
    autoDiscovery: boolean,
  ) =>
    invoke<SkillCandidate[]>('discover_skills', {
      folders,
      disabled,
      disabledItems,
      autoDiscovery,
    }),
  searchMcpMarketplace: (query: string | null = null, limit: number | null = null, includeUnverified = false) =>
    invoke<MarketplaceServer[]>('search_mcp_marketplace', { query, limit, includeUnverified }),
  browseMcpDirectory: (
    query: string | null,
    category: string | null,
    source: string,
    sort: string,
    limit: number,
    offset: number,
  ) =>
    invoke<DirectoryPage>('browse_mcp_directory', { query, category, source, sort, limit, offset }),
  listSkillMarketplaces: () => invoke<SkillMarketplace[]>('list_skill_marketplaces'),
  addSkillMarketplace: (url: string) =>
    invoke<SkillMarketplace>('add_skill_marketplace', { url }),
  removeSkillMarketplace: (url: string) =>
    invoke<void>('remove_skill_marketplace', { url }),
  installMarketplaceSkills: (url: string, plugin: string, includeUnverified = false) =>
    invoke<InstalledSkill[]>('install_marketplace_skills', { url, plugin, includeUnverified }),
  listInstalledMarketplaceSkills: () =>
    invoke<InstalledSkill[]>('list_installed_marketplace_skills'),
  uninstallMarketplaceSkills: (marketplace: string, skill: string) =>
    invoke<void>('uninstall_marketplace_skills', { marketplace, skill }),
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
    invoke<Message>('send_message', { ...args, requestId: newRequestId(), channel }),
};
