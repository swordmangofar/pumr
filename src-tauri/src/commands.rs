use crate::agent::{self, TurnDeps, TurnRequest};
use crate::config::{self, Settings};
use crate::db::NewMessage;
use crate::error::{AppError, Result};
use crate::git::{
    git_branch_create as branch_create_worktree, git_branch_delete as branch_delete_worktree,
    git_branch_rename as branch_rename_worktree, git_checkout as checkout_worktree,
    git_clone as clone_repository, git_commit as commit_worktree, git_discard as discard_worktree,
    git_fast_forward as fast_forward_worktree, git_fetch as fetch_worktree,
    git_init as init_worktree, git_merge as merge_worktree,
    git_operation_abort as abort_operation_worktree,
    git_operation_continue as continue_operation_worktree, git_pull as pull_worktree,
    git_pull_request_url as pull_request_url_worktree, git_push as push_worktree,
    git_push_branch as push_branch_worktree, git_rebase as rebase_worktree,
    git_rebase_interactive as rebase_interactive_worktree, git_set_upstream as set_upstream_worktree,
    git_stage as stage_worktree, git_stash_apply as stash_apply_worktree,
    git_stash_drop as stash_drop_worktree, git_stash_pop as stash_pop_worktree,
    git_stash_push as stash_push_worktree, git_submodule_update as submodule_update_worktree,
    git_tag_create as tag_create_worktree, git_tag_delete as tag_delete_worktree,
    git_tag_push as tag_push_worktree, git_unstage as unstage_worktree, project_branches,
    project_commit_detail, project_commit_file_diff, project_commits, project_file_diff,
    project_git_info, project_git_status, project_rebase_commits, project_remotes, ShadowRepo,
};
use crate::mcp::McpManager;
use crate::mentions;
use crate::permissions::FileIgnoreConfig;
use crate::models::{
    Attachment, EndpointInfo, EventSink, FileChange, FileDiff, GitBranch, GitCommit,
    GitCommitDetail, GitInfo, GitStatus, Mention, Message, ModelInfo, PermissionDecision,
    ProcessInfo, Project, ProjectRule, ProviderInfo, QuestionAnswer, RoutedEvent, Session,
    SpendStats, SpendSummary, StreamEvent, WorkspaceEntry, WorkspaceFile,
};
use crate::providers::openrouter::{ChatChunk, ChatMessage};
use crate::state::AppState;
use crate::tools::ToolRuntime;
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

const DEFAULT_SESSION_TITLE: &str = "New session";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertResult {
    pub prompt: String,
    pub restored_files: Vec<String>,
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings()
}

#[tauri::command]
pub fn get_default_system_prompts() -> config::DefaultSystemPrompts {
    config::default_system_prompts()
}

#[tauri::command]
pub fn get_default_modes() -> Vec<config::Mode> {
    config::default_modes()
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<Settings> {
    config::save_settings(&state.settings_path, &settings)?;
    state.power.set_enabled(settings.interface.keep_awake);
    state.set_settings(settings.clone());
    Ok(settings)
}

#[tauri::command]
pub fn set_api_key(provider: String, key: String) -> Result<()> {
    config::set_api_key(&provider, &key)
}

#[tauri::command]
pub fn delete_api_key(provider: String) -> Result<()> {
    config::delete_api_key(&provider)
}

#[tauri::command]
pub fn has_api_key(provider: String) -> Result<bool> {
    config::has_api_key(&provider)
}

#[tauri::command]
pub async fn list_models(
    state: State<'_, AppState>,
    refresh: Option<bool>,
) -> Result<Vec<ModelInfo>> {
    if !refresh.unwrap_or(false) {
        if let Some(models) = state.cached_models() {
            return Ok(models);
        }
    }
    let api_key = config::get_api_key(config::OPENROUTER_PROVIDER)?.unwrap_or_default();
    let models = state.provider().list_models(&api_key).await?;
    state.cache_models(models.clone());
    Ok(models)
}

#[tauri::command]
pub async fn list_endpoints(
    state: State<'_, AppState>,
    model_id: String,
    refresh: Option<bool>,
) -> Result<Vec<EndpointInfo>> {
    if !refresh.unwrap_or(false) {
        if let Some(endpoints) = state.cached_endpoints(&model_id) {
            return Ok(endpoints);
        }
    }
    let api_key = config::get_api_key(config::OPENROUTER_PROVIDER)?.unwrap_or_default();
    let endpoints = state.provider().list_endpoints(&api_key, &model_id).await?;
    state.cache_endpoints(&model_id, endpoints.clone());
    Ok(endpoints)
}

#[tauri::command]
pub async fn list_providers(
    state: State<'_, AppState>,
    refresh: Option<bool>,
) -> Result<Vec<ProviderInfo>> {
    if !refresh.unwrap_or(false) {
        if let Some(providers) = state.cached_providers() {
            return Ok(providers);
        }
    }
    let api_key = config::get_api_key(config::OPENROUTER_PROVIDER)?.unwrap_or_default();
    let providers = state.provider().list_providers(&api_key).await?;
    state.cache_providers(providers.clone());
    Ok(providers)
}

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> Result<Vec<Project>> {
    state.db.list_projects()
}

#[tauri::command]
pub fn add_project(state: State<'_, AppState>, path: String) -> Result<Project> {
    let path_buf = std::path::PathBuf::from(&path);
    if !path_buf.is_dir() {
        return Err(AppError::msg(format!("Not a directory: {path}")));
    }
    let canonical = path_buf.canonicalize().unwrap_or(path_buf);
    state.db.upsert_project(&canonical.to_string_lossy())
}

#[tauri::command]
pub fn remove_project(state: State<'_, AppState>, project_id: String) -> Result<()> {
    state.db.remove_project(&project_id)
}

#[tauri::command]
pub fn update_project(
    state: State<'_, AppState>,
    project_id: String,
    color: Option<String>,
    icon: Option<String>,
    icon_image: Option<String>,
) -> Result<Project> {
    state.db.update_project_appearance(
        &project_id,
        color.as_deref(),
        icon.as_deref(),
        icon_image.as_deref(),
    )
}

#[tauri::command]
pub fn list_sessions(
    state: State<'_, AppState>,
    project_id: String,
    include_archived: Option<bool>,
) -> Result<Vec<Session>> {
    state
        .db
        .list_sessions(&project_id, include_archived.unwrap_or(false))
}

#[tauri::command]
pub fn list_sub_sessions(state: State<'_, AppState>, session_id: String) -> Result<Vec<Session>> {
    state.db.list_sub_sessions(&session_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_session(
    state: State<'_, AppState>,
    project_id: String,
    title: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    provider: Option<String>,
    system_prompt: Option<String>,
    mode_id: Option<String>,
) -> Result<Session> {
    state.db.touch_project(&project_id)?;
    state.db.create_session(
        &project_id,
        title.as_deref().unwrap_or(DEFAULT_SESSION_TITLE),
        model.as_deref(),
        reasoning_effort.as_deref(),
        provider.as_deref(),
        system_prompt.as_deref(),
        mode_id.as_deref(),
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_session(
    state: State<'_, AppState>,
    session_id: String,
    title: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    provider: Option<String>,
    system_prompt: Option<String>,
    mode_id: Option<String>,
    project_id: Option<String>,
) -> Result<Session> {
    if let Some(project_id) = project_id.as_deref() {
        state.db.touch_project(project_id)?;
    }
    state.db.update_session(
        &session_id,
        title.as_deref(),
        model.as_deref(),
        reasoning_effort.as_deref(),
        provider.as_deref(),
        system_prompt.as_deref(),
        mode_id.as_deref(),
        project_id.as_deref(),
    )
}

#[tauri::command]
pub fn set_session_auto_continue(
    state: State<'_, AppState>,
    session_id: String,
    auto_continue: bool,
) -> Result<Session> {
    state
        .db
        .set_session_auto_continue(&session_id, auto_continue)
}

#[tauri::command]
pub fn archive_session(
    state: State<'_, AppState>,
    session_id: String,
    archived: bool,
) -> Result<Session> {
    if archived {
        state.processes.stop_for_session(&session_id);
        state.cancel(&session_id);
    }
    state.db.set_session_archived(&session_id, archived)
}

#[tauri::command]
pub fn delete_session(state: State<'_, AppState>, session_id: String) -> Result<()> {
    state.processes.stop_for_session(&session_id);
    state.db.delete_session(&session_id)
}

#[tauri::command]
pub fn list_messages(state: State<'_, AppState>, session_id: String) -> Result<Vec<Message>> {
    state.db.list_messages(&session_id)
}

#[tauri::command]
pub fn get_spend(state: State<'_, AppState>, session_id: Option<String>) -> Result<SpendSummary> {
    let settings = state.settings();
    state.db.spend(session_id.as_deref(), settings.model.budget_usd)
}

#[tauri::command]
pub fn get_spend_stats(
    state: State<'_, AppState>,
    from_ms: i64,
    to_ms: i64,
    bucket: Option<String>,
) -> Result<SpendStats> {
    let bucket = bucket.as_deref().unwrap_or("day");
    state.db.spend_stats(from_ms, to_ms, bucket)
}

#[tauri::command]
pub fn stop_generation(state: State<'_, AppState>, session_id: String) {
    state.cancel(&session_id);
}

#[tauri::command]
pub fn discover_mcp_sources(
    folders: Vec<String>,
    disabled: Vec<String>,
    disabled_servers: Vec<crate::models::McpServerRef>,
    auto_discovery: bool,
) -> Vec<crate::models::McpCandidate> {
    crate::discovery::discover_mcp(&folders, &disabled, &disabled_servers, auto_discovery)
}

#[tauri::command]
pub fn discover_skills(
    state: State<'_, AppState>,
    folders: Vec<String>,
    disabled: Vec<String>,
    disabled_items: Vec<crate::models::SkillRef>,
    auto_discovery: bool,
) -> Vec<crate::models::SkillCandidate> {
    crate::discovery::discover_skills(
        &folders,
        &disabled,
        &disabled_items,
        auto_discovery,
        &state.marketplace.installed_skill_dirs(),
    )
}

// ---------------------------------------------------------------------------
// MCP + skill marketplaces
// ---------------------------------------------------------------------------

/// Searches the official MCP registry for installable servers. The persisted
/// `marketplace_verified_only` setting is authoritative: when it is on, the
/// caller cannot lift the verified filter.
#[tauri::command]
pub async fn search_mcp_marketplace(
    state: State<'_, AppState>,
    query: Option<String>,
    limit: Option<u32>,
    include_unverified: Option<bool>,
) -> Result<Vec<crate::marketplace::MarketplaceServer>> {
    let include_unverified = resolve_include_unverified(state.inner(), include_unverified);
    state
        .marketplace
        .search_mcp(query.as_deref(), limit, include_unverified)
        .await
}

/// The webview may only widen the marketplace filter when the user has turned
/// the persisted "verified only" policy off. The setting wins otherwise.
fn resolve_include_unverified(state: &AppState, requested: Option<bool>) -> bool {
    requested.unwrap_or(false) && !state.settings().integrations.marketplace_verified_only
}

/// Browses the Build with Claude MCP directory (categories, stars, install
/// commands). Read-only: it never installs anything, it only returns metadata.
#[tauri::command]
pub async fn browse_mcp_directory(
    state: State<'_, AppState>,
    query: Option<String>,
    category: Option<String>,
    source: Option<String>,
    sort: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<crate::marketplace::DirectoryPage> {
    state
        .marketplace
        .browse_directory(
            query.as_deref(),
            category.as_deref(),
            source.as_deref(),
            sort.as_deref(),
            limit.unwrap_or(24),
            offset.unwrap_or(0),
        )
        .await
}

/// Lists curated and user-added skill marketplaces.
#[tauri::command]
pub fn list_skill_marketplaces(
    state: State<'_, AppState>,
) -> Result<Vec<crate::marketplace::SkillMarketplace>> {
    state.marketplace.list_marketplaces()
}

/// Adds a marketplace by URL, cloning it on first use.
#[tauri::command]
pub async fn add_skill_marketplace(
    state: State<'_, AppState>,
    url: String,
) -> Result<crate::marketplace::SkillMarketplace> {
    state.marketplace.add_marketplace(&url).await
}

#[tauri::command]
pub fn remove_skill_marketplace(state: State<'_, AppState>, url: String) -> Result<()> {
    state.marketplace.remove_marketplace(&url)
}

/// Installs a plugin's skills into the local skills directory. The persisted
/// `marketplace_verified_only` setting is authoritative: when it is on, the
/// caller cannot install from an unverified marketplace.
#[tauri::command]
pub async fn install_marketplace_skills(
    state: State<'_, AppState>,
    url: String,
    plugin: String,
    include_unverified: Option<bool>,
) -> Result<Vec<crate::marketplace::InstalledSkill>> {
    let include_unverified = resolve_include_unverified(state.inner(), include_unverified);
    state
        .marketplace
        .install_skills(&url, &plugin, include_unverified)
        .await
}

#[tauri::command]
pub fn list_installed_marketplace_skills(
    state: State<'_, AppState>,
) -> Result<Vec<crate::marketplace::InstalledSkill>> {
    state.marketplace.list_installed()
}

#[tauri::command]
pub fn uninstall_marketplace_skills(
    state: State<'_, AppState>,
    marketplace: String,
    skill: String,
) -> Result<()> {
    state.marketplace.uninstall_skills(&marketplace, &skill)
}

const MAX_WORKSPACE_ENTRIES: usize = 4000;

/// Lists files and directories in the project so the composer can offer
/// `@file` and `@directory` completions. Git-ignored paths are skipped.
#[tauri::command]
pub fn list_workspace_entries(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<WorkspaceEntry>> {
    let project = state.db.get_project(&project_id)?;
    let root = PathBuf::from(&project.path);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<WorkspaceEntry> = Vec::new();
    let walker = WalkBuilder::new(&root).hidden(false).build();
    for entry in walker.flatten() {
        let path = entry.path();
        if path == root {
            continue;
        }
        if path
            .components()
            .any(|component| component.as_os_str() == ".git")
        {
            continue;
        }
        let Ok(relative) = path.strip_prefix(&root) else {
            continue;
        };
        let kind = if path.is_dir() { "directory" } else { "file" };
        entries.push(WorkspaceEntry {
            path: relative.to_string_lossy().replace('\\', "/"),
            kind: kind.to_string(),
        });
        if entries.len() >= MAX_WORKSPACE_ENTRIES {
            break;
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

/// Reads a project file for the workspace viewer. The path must resolve inside
/// the project root; binary or unreadable files open as an empty viewer.
#[tauri::command]
pub fn read_workspace_file(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> Result<WorkspaceFile> {
    let project = state.db.get_project(&project_id)?;
    let root = PathBuf::from(&project.path);
    let root = root.canonicalize().unwrap_or(root);
    let absolute = crate::permissions::resolve_path(&root, &path);
    if !crate::permissions::path_is_inside(&absolute, &root, &[]) {
        return Err(AppError::msg("path is outside the project"));
    }
    let content = std::fs::read_to_string(&absolute).unwrap_or_default();
    Ok(WorkspaceFile {
        path: path.replace('\\', "/"),
        content,
        language: language_for(&path).to_string(),
    })
}

/// Writes a file edited in the workspace viewer. The path must resolve inside
/// the project root; missing parent directories are created.
#[tauri::command]
pub fn write_workspace_file(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    content: String,
) -> Result<()> {
    let project = state.db.get_project(&project_id)?;
    let root = PathBuf::from(&project.path);
    let root = root.canonicalize().unwrap_or(root);
    let absolute = crate::permissions::resolve_path(&root, &path);
    if !crate::permissions::path_is_inside(&absolute, &root, &[]) {
        return Err(AppError::msg("path is outside the project"));
    }
    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&absolute, content)?;
    Ok(())
}

#[tauri::command]
pub fn resolve_permission(
    state: State<'_, AppState>,
    request_id: String,
    decision: String,
    rule: Option<String>,
    folder: Option<String>,
    prompt_kind: Option<String>,
) -> Result<()> {
    let allowed = decision != "deny" && decision != "deny_always";
    let rule = rule
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let folder = folder
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let is_web = prompt_kind
        .as_deref()
        .is_some_and(|kind| kind.starts_with("web"));
    if is_web {
        let mut settings = state.settings();
        let mut changed = false;
        if allowed && decision == "allow_always" {
            if let Some(rule) = &rule {
                if !settings.permissions.allowed_websites.iter().any(|entry| entry == rule) {
                    settings.permissions.allowed_websites.push(rule.clone());
                    changed = true;
                }
            }
        }
        if !allowed && decision == "deny_always" {
            if let Some(rule) = &rule {
                if !settings.permissions.denied_websites.iter().any(|entry| entry == rule) {
                    settings.permissions.denied_websites.push(rule.clone());
                    changed = true;
                }
            }
        }
        if changed {
            config::save_settings(&state.settings_path, &settings)?;
            state.set_settings(settings);
        }
    } else if allowed && decision == "allow_always" {
        let mut settings = state.settings();
        let mut changed = false;
        if let Some(rule) = &rule {
            if !settings.permissions.command_rules.iter().any(|entry| entry == rule) {
                settings.permissions.command_rules.push(rule.clone());
                changed = true;
            }
        }
        if let Some(folder) = &folder {
            if !settings.permissions.extra_folders.iter().any(|entry| entry == folder) {
                settings.permissions.extra_folders.push(folder.clone());
                changed = true;
            }
        }
        if changed {
            config::save_settings(&state.settings_path, &settings)?;
            state.set_settings(settings);
        }
    } else if allowed && decision == "allow_once" {
        // A folder granted once stays available for the rest of the app
        // session (including every file and subfolder below it), but is not
        // written to settings.
        if let Some(folder) = &folder {
            state.permissions.add_session_folder(folder);
        }
    }
    state.broker.resolve(
        &request_id,
        PermissionDecision {
            allowed,
            rule,
            folder,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn resolve_question(
    state: State<'_, AppState>,
    request_id: String,
    answers: Option<Vec<QuestionAnswer>>,
) -> Result<()> {
    state.questions.resolve(&request_id, answers);
    Ok(())
}

#[tauri::command]
pub fn add_website_rule(state: State<'_, AppState>, rule: String, allow: bool) -> Result<Settings> {
    let mut settings = state.settings();
    let rule = rule.trim().to_string();
    if !rule.is_empty() {
        let exists = if allow {
            settings.permissions.allowed_websites.iter().any(|entry| entry == &rule)
        } else {
            settings.permissions.denied_websites.iter().any(|entry| entry == &rule)
        };
        if !exists {
            if allow {
                settings.permissions.allowed_websites.push(rule);
            } else {
                settings.permissions.denied_websites.push(rule);
            }
            config::save_settings(&state.settings_path, &settings)?;
            state.set_settings(settings.clone());
        }
    }
    Ok(settings)
}

#[tauri::command]
pub fn delete_website_rule(
    state: State<'_, AppState>,
    rule: String,
    allow: bool,
) -> Result<Settings> {
    let mut settings = state.settings();
    if allow {
        settings.permissions.allowed_websites.retain(|entry| entry != &rule);
    } else {
        settings.permissions.denied_websites.retain(|entry| entry != &rule);
    }
    config::save_settings(&state.settings_path, &settings)?;
    state.set_settings(settings.clone());
    Ok(settings)
}

#[tauri::command]
pub fn add_command_rule(state: State<'_, AppState>, rule: String) -> Result<Settings> {
    let mut settings = state.settings();
    let rule = rule.trim().to_string();
    if !rule.is_empty() && !settings.permissions.command_rules.iter().any(|entry| entry == &rule) {
        settings.permissions.command_rules.push(rule);
        config::save_settings(&state.settings_path, &settings)?;
        state.set_settings(settings.clone());
    }
    Ok(settings)
}

#[tauri::command]
pub fn delete_command_rule(state: State<'_, AppState>, rule: String) -> Result<Settings> {
    let mut settings = state.settings();
    settings.permissions.command_rules.retain(|entry| entry != &rule);
    config::save_settings(&state.settings_path, &settings)?;
    state.set_settings(settings.clone());
    Ok(settings)
}

#[tauri::command]
pub fn get_file_ignore_catalog() -> Vec<crate::permissions::IgnoreCatalogEntry> {
    crate::permissions::ignore_catalog()
}

#[tauri::command]
pub fn list_processes(state: State<'_, AppState>) -> Vec<ProcessInfo> {
    state.processes.list()
}

#[tauri::command]
pub fn stop_process(state: State<'_, AppState>, process_id: String) -> Result<()> {
    state.processes.stop(&process_id)
}

#[tauri::command]
pub fn get_git_info(state: State<'_, AppState>, project_id: String) -> Result<GitInfo> {
    let project = state.db.get_project(&project_id)?;
    Ok(project_git_info(Path::new(&project.path)))
}

fn project_root(state: &AppState, project_id: &str) -> Result<PathBuf> {
    let project = state.db.get_project(project_id)?;
    Ok(PathBuf::from(project.path))
}

/// Runs a potentially long, network-bound git operation off the main thread.
async fn blocking<T, F>(operation: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| AppError::msg(error.to_string()))?
}

#[tauri::command]
pub fn get_git_status(state: State<'_, AppState>, project_id: String) -> Result<GitStatus> {
    let root = project_root(&state, &project_id)?;
    project_git_status(&root)
}

#[tauri::command]
pub fn get_git_branches(state: State<'_, AppState>, project_id: String) -> Result<Vec<GitBranch>> {
    let root = project_root(&state, &project_id)?;
    Ok(project_branches(&root))
}

#[tauri::command]
pub fn get_git_commits(
    state: State<'_, AppState>,
    project_id: String,
    query: Option<String>,
    skip: Option<usize>,
    limit: Option<usize>,
) -> Result<Vec<GitCommit>> {
    let root = project_root(&state, &project_id)?;
    project_commits(
        &root,
        query.as_deref(),
        skip.unwrap_or(0),
        limit.unwrap_or(50),
    )
}

#[tauri::command]
pub fn get_git_commit(
    state: State<'_, AppState>,
    project_id: String,
    hash: String,
) -> Result<GitCommitDetail> {
    let root = project_root(&state, &project_id)?;
    project_commit_detail(&root, &hash)
}

#[tauri::command]
pub fn get_git_commit_file_diff(
    state: State<'_, AppState>,
    project_id: String,
    hash: String,
    path: String,
) -> Result<FileDiff> {
    let root = project_root(&state, &project_id)?;
    project_commit_file_diff(&root, &hash, &path)
}

#[tauri::command]
pub fn get_git_file_diff(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    staged: bool,
) -> Result<FileDiff> {
    let root = project_root(&state, &project_id)?;
    project_file_diff(&root, &path, staged)
}

#[tauri::command]
pub fn git_stage(
    state: State<'_, AppState>,
    project_id: String,
    path: Option<String>,
) -> Result<()> {
    let root = project_root(&state, &project_id)?;
    stage_worktree(&root, path.as_deref())
}

#[tauri::command]
pub fn git_unstage(
    state: State<'_, AppState>,
    project_id: String,
    path: Option<String>,
) -> Result<()> {
    let root = project_root(&state, &project_id)?;
    unstage_worktree(&root, path.as_deref())
}

#[tauri::command]
pub fn git_discard(state: State<'_, AppState>, project_id: String, path: String) -> Result<()> {
    let root = project_root(&state, &project_id)?;
    discard_worktree(&root, &path)
}

#[tauri::command]
pub fn git_commit(
    state: State<'_, AppState>,
    project_id: String,
    message: String,
    amend: bool,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    commit_worktree(&root, &message, amend)
}

#[tauri::command]
pub fn git_checkout(
    state: State<'_, AppState>,
    project_id: String,
    branch: String,
    track: Option<bool>,
    local_branch: Option<String>,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    checkout_worktree(&root, &branch, track.unwrap_or(false), local_branch.as_deref())
}

#[tauri::command]
pub async fn git_fetch(state: State<'_, AppState>, project_id: String) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    blocking(move || fetch_worktree(&root)).await
}

#[tauri::command]
pub async fn git_pull(
    state: State<'_, AppState>,
    project_id: String,
    strategy: Option<String>,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    blocking(move || pull_worktree(&root, strategy.as_deref())).await
}

#[tauri::command]
pub async fn git_push(state: State<'_, AppState>, project_id: String) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    blocking(move || push_worktree(&root)).await
}

#[tauri::command]
pub fn get_git_remotes(state: State<'_, AppState>, project_id: String) -> Result<Vec<String>> {
    let root = project_root(&state, &project_id)?;
    Ok(project_remotes(&root))
}

#[tauri::command]
pub async fn git_fast_forward(
    state: State<'_, AppState>,
    project_id: String,
    branch: String,
    upstream: String,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    blocking(move || fast_forward_worktree(&root, &branch, &upstream)).await
}

#[tauri::command]
pub fn git_merge(
    state: State<'_, AppState>,
    project_id: String,
    branch: String,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    merge_worktree(&root, &branch)
}

#[tauri::command]
pub fn git_rebase(state: State<'_, AppState>, project_id: String, onto: String) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    rebase_worktree(&root, &onto)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseTodoEntry {
    pub action: String,
    pub hash: String,
}

#[tauri::command]
pub fn git_rebase_interactive(
    state: State<'_, AppState>,
    project_id: String,
    onto: String,
    todo: Vec<RebaseTodoEntry>,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    let entries: Vec<(String, String)> = todo
        .into_iter()
        .map(|entry| (entry.action, entry.hash))
        .collect();
    rebase_interactive_worktree(&root, &onto, &entries)
}

#[tauri::command]
pub fn get_git_rebase_commits(
    state: State<'_, AppState>,
    project_id: String,
    onto: String,
) -> Result<Vec<GitCommit>> {
    let root = project_root(&state, &project_id)?;
    project_rebase_commits(&root, &onto)
}

#[tauri::command]
pub fn git_branch_create(
    state: State<'_, AppState>,
    project_id: String,
    name: String,
    start_point: Option<String>,
    checkout: bool,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    branch_create_worktree(&root, &name, start_point.as_deref(), checkout)
}

#[tauri::command]
pub fn git_tag_create(
    state: State<'_, AppState>,
    project_id: String,
    name: String,
    target: Option<String>,
    message: Option<String>,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    tag_create_worktree(&root, &name, target.as_deref(), message.as_deref())
}

#[tauri::command]
pub fn git_branch_rename(
    state: State<'_, AppState>,
    project_id: String,
    from: String,
    to: String,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    branch_rename_worktree(&root, &from, &to)
}

#[tauri::command]
pub fn git_branch_delete(
    state: State<'_, AppState>,
    project_id: String,
    branch: String,
    remote: bool,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    branch_delete_worktree(&root, &branch, remote)
}

#[tauri::command]
pub fn git_set_upstream(
    state: State<'_, AppState>,
    project_id: String,
    branch: String,
    upstream: String,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    set_upstream_worktree(&root, &branch, &upstream)
}

#[tauri::command]
pub async fn git_push_branch(
    state: State<'_, AppState>,
    project_id: String,
    branch: String,
    remote: String,
    set_upstream: bool,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    blocking(move || push_branch_worktree(&root, &branch, &remote, set_upstream)).await
}

#[tauri::command]
pub async fn git_operation_abort(
    state: State<'_, AppState>,
    project_id: String,
    operation: String,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    blocking(move || abort_operation_worktree(&root, &operation)).await
}

#[tauri::command]
pub fn git_operation_continue(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    continue_operation_worktree(&root)
}

#[tauri::command]
pub async fn git_stash_push(
    state: State<'_, AppState>,
    project_id: String,
    message: Option<String>,
    include_untracked: bool,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    blocking(move || stash_push_worktree(&root, message.as_deref(), include_untracked)).await
}

#[tauri::command]
pub fn git_stash_apply(
    state: State<'_, AppState>,
    project_id: String,
    stash: String,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    stash_apply_worktree(&root, &stash)
}

#[tauri::command]
pub fn git_stash_pop(state: State<'_, AppState>, project_id: String, stash: String) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    stash_pop_worktree(&root, &stash)
}

#[tauri::command]
pub fn git_stash_drop(
    state: State<'_, AppState>,
    project_id: String,
    stash: String,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    stash_drop_worktree(&root, &stash)
}

#[tauri::command]
pub fn git_init(state: State<'_, AppState>, project_id: String) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    init_worktree(&root)
}

#[tauri::command]
pub async fn git_clone(
    state: State<'_, AppState>,
    url: String,
    path: String,
) -> Result<Project> {
    let destination = PathBuf::from(&path);
    let result = blocking({
        let url = url.clone();
        let destination = destination.clone();
        move || clone_repository(&url, &destination)
    })
    .await?;
    let canonical = destination.canonicalize().unwrap_or(destination);
    let _ = result;
    state.db.upsert_project(&canonical.to_string_lossy())
}

#[tauri::command]
pub async fn git_tag_delete(
    state: State<'_, AppState>,
    project_id: String,
    name: String,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    blocking(move || tag_delete_worktree(&root, &name)).await
}

#[tauri::command]
pub async fn git_tag_push(
    state: State<'_, AppState>,
    project_id: String,
    remote: String,
    name: String,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    blocking(move || tag_push_worktree(&root, &remote, &name)).await
}

#[tauri::command]
pub async fn git_submodule_update(
    state: State<'_, AppState>,
    project_id: String,
    path: Option<String>,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    blocking(move || submodule_update_worktree(&root, path.as_deref())).await
}

#[tauri::command]
pub fn git_pull_request_url(
    state: State<'_, AppState>,
    project_id: String,
    remote: String,
    branch: String,
) -> Result<String> {
    let root = project_root(&state, &project_id)?;
    pull_request_url_worktree(&root, &remote, &branch)
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<()> {
    let status = {
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg(&url).status()
        }
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("cmd")
                .args(["/C", "start", "", &url])
                .status()
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            std::process::Command::new("xdg-open").arg(&url).status()
        }
    };
    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(_) => Err(AppError::msg(format!("could not open {url}"))),
        Err(error) => Err(AppError::msg(error.to_string())),
    }
}

fn open_shadow(state: &AppState, project_id: &str) -> Result<Arc<ShadowRepo>> {
    let project = state.db.get_project(project_id)?;
    Ok(Arc::new(ShadowRepo::open(
        &state.data_dir,
        project_id,
        Path::new(&project.path),
    )?))
}

#[tauri::command]
pub fn get_session_changes(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<FileChange>> {
    session_changes_resolved(&state, &session_id)
}

#[tauri::command]
pub fn get_file_diff(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<FileDiff> {
    let session = state.db.get_session(&session_id)?;
    let project = state.db.get_project(&session.project_id)?;
    let base = state.db.session_base_commit(&session_id)?;
    let change = session_changes_resolved(&state, &session_id)?
        .into_iter()
        .find(|change| change.path == path);
    let (old_content, additions, deletions, status) = match base {
        Some(base) => {
            let shadow = open_shadow(&state, &session.project_id)?;
            (
                shadow.file_at(&base, &path).unwrap_or_default(),
                change.as_ref().map(|change| change.additions).unwrap_or(0),
                change.as_ref().map(|change| change.deletions).unwrap_or(0),
                change
                    .map(|change| change.status)
                    .unwrap_or_else(|| "M".to_string()),
            )
        }
        None => (String::new(), 0, 0, "M".to_string()),
    };
    let absolute = Path::new(&project.path).join(&path);
    let new_content = std::fs::read_to_string(&absolute).unwrap_or_default();
    Ok(FileDiff {
        path: path.clone(),
        old_content,
        new_content,
        language: language_for(&path).to_string(),
        additions,
        deletions,
        status,
    })
}

#[tauri::command]
pub fn get_project_rules(
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
) -> Result<Vec<ProjectRule>> {
    collect_project_rules(&state, &project_id, session_id.as_deref())
}

fn collect_project_rules(
    state: &AppState,
    project_id: &str,
    session_id: Option<&str>,
) -> Result<Vec<ProjectRule>> {
    let project = state.db.get_project(&project_id)?;
    let project_root = Path::new(&project.path);
    let mut rules: Vec<ProjectRule> = Vec::new();

    let mut global_candidates = vec![state.data_dir.join("AGENTS.md")];
    if let Ok(home) = std::env::var("HOME") {
        global_candidates.push(PathBuf::from(&home).join(".config/pumr/AGENTS.md"));
        global_candidates.push(PathBuf::from(&home).join(".pumr/AGENTS.md"));
    }
    for global in global_candidates {
        if let Ok(content) = std::fs::read_to_string(&global) {
            if !content.trim().is_empty() {
                rules.push(ProjectRule {
                    path: global.display().to_string(),
                    scope: "global".to_string(),
                    content,
                });
                break;
            }
        }
    }

    let root_rule = project_root.join("AGENTS.md");
    if let Ok(content) = std::fs::read_to_string(&root_rule) {
        if !content.trim().is_empty() {
            rules.push(ProjectRule {
                path: root_rule.display().to_string(),
                scope: "project".to_string(),
                content,
            });
        }
    }

    if let Some(session_id) = session_id {
        let mut directories: Vec<PathBuf> = Vec::new();
        if let Ok(changes) = session_changes_resolved(state, session_id) {
            for change in changes {
                let mut current = project_root.join(&change.path);
                current.pop();
                while current.starts_with(project_root) && current != *project_root {
                    if !directories.contains(&current) {
                        directories.push(current.clone());
                    }
                    if !current.pop() {
                        break;
                    }
                }
            }
        }
        for directory in directories {
            let candidate = directory.join("AGENTS.md");
            if rules.iter().any(|rule| Path::new(&rule.path) == candidate) {
                continue;
            }
            if let Ok(content) = std::fs::read_to_string(&candidate) {
                if !content.trim().is_empty() {
                    rules.push(ProjectRule {
                        path: candidate.display().to_string(),
                        scope: "nested".to_string(),
                        content,
                    });
                }
            }
        }
    }

    Ok(rules)
}

fn resolve_provider_preset(state: &AppState, model: &str, provider: String) -> String {
    if provider != "auto:value" {
        return provider;
    }
    best_value_provider(state, model).unwrap_or(provider)
}

fn best_value_provider(state: &AppState, model: &str) -> Option<String> {
    let endpoints = state.cached_endpoints(model)?;
    endpoints
        .iter()
        .filter_map(|endpoint| {
            let throughput = endpoint.throughput_last_30m?;
            let price = (endpoint.prompt_price_per_m + endpoint.completion_price_per_m) / 2.0;
            (throughput > 0.0 && price > 0.0)
                .then_some((endpoint.provider_slug.clone(), price / throughput))
        })
        .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(slug, _)| slug)
}

/// Returns the session's frozen change set. Sessions that predate per-session
/// tracking have no record yet; derive one once and pin it to a snapshot so it
/// can never drift into another session's working-tree edits.
fn session_changes_resolved(state: &AppState, session_id: &str) -> Result<Vec<FileChange>> {
    if let Some((changes, _)) = state.db.session_changes_record(session_id)? {
        return Ok(changes);
    }
    let session = state.db.get_session(session_id)?;
    let Some(base) = state.db.session_base_commit(session_id)? else {
        return Ok(Vec::new());
    };
    let shadow = open_shadow(state, &session.project_id)?;
    let changes = shadow.changes_since(&base)?;
    let boundary = shadow.snapshot("baseline").ok();
    state
        .db
        .set_session_changes_record(session_id, &changes, boundary.as_deref())?;
    Ok(changes)
}

#[tauri::command]
pub fn revert_to_message(
    state: State<'_, AppState>,
    message_id: String,
    restore_files: bool,
) -> Result<RevertResult> {
    let message = state.db.get_message(&message_id)?;
    if message.role != "user" {
        return Err(AppError::msg("Only user prompts can be reverted to."));
    }
    let session = state.db.get_session(&message.session_id)?;
    let mut restored = Vec::new();
    if restore_files {
        if let Some(base) = message.base_commit.as_deref() {
            let shadow = open_shadow(&state, &session.project_id)?;
            restored = shadow.restore_to(base)?;
        }
    }
    state
        .db
        .delete_messages_from(&message.session_id, message.seq)?;
    state.db.clear_session_changes(&message.session_id)?;
    Ok(RevertResult {
        prompt: message.content,
        restored_files: restored,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn send_message(
    state: State<'_, AppState>,
    session_id: String,
    content: String,
    model: String,
    reasoning_effort: Option<String>,
    provider: Option<String>,
    attachments: Option<Vec<Attachment>>,
    mentions: Option<Vec<Mention>>,
    resume: Option<bool>,
    channel: Channel<RoutedEvent>,
) -> Result<Message> {
    let setup = prepare_turn(
        &state,
        &session_id,
        content,
        &model,
        reasoning_effort,
        provider,
        attachments,
        mentions,
        resume,
    )?;

    let sink: EventSink = {
        let channel = channel.clone();
        Arc::new(move |event: RoutedEvent| {
            let _ = channel.send(event);
        })
    };

    let mode = config::resolve_mode(&setup.settings, setup.session.mode_id.as_deref());
    let cancel = state.register_cancel(&session_id);
    let file_ignore = Arc::new(FileIgnoreConfig::from_settings(&setup.settings));

    let (context, mcp_manager) = assemble_turn_context(
        &state,
        &setup.settings,
        &session_id,
        &setup.project_root,
        setup.shadow.clone(),
        &mode,
        &setup.mentions,
        cancel.clone(),
        &sink,
        file_ignore.clone(),
    )
    .await;

    if !setup.resume {
        append_user_message(&state, &session_id, &setup, &context)?;
    }

    // A new turn (message or resume) cancels any pending limit notice.
    if setup.session.limit_reached {
        state.db.set_session_limit_reached(&session_id, false)?;
    }

    let rules = if mode.include_project_rules {
        collect_project_rules(&state, &setup.project.id, Some(&session_id)).unwrap_or_default()
    } else {
        Vec::new()
    };
    let system_prompt =
        build_system_prompt(&setup.settings, &setup.session, &mode, &mcp_manager, &rules);

    let fallback_pricing = state
        .cached_models()
        .and_then(|models| models.into_iter().find(|entry| entry.id == model))
        .map(|entry| {
            (
                entry.prompt_price_per_m / 1_000_000.0,
                entry.completion_price_per_m / 1_000_000.0,
            )
        });

    let request = TurnRequest {
        api_key: setup.api_key,
        model: model.clone(),
        reasoning_effort: setup.reasoning,
        provider: setup.selected_provider,
        system_prompt,
        session_id: session_id.clone(),
        project_id: setup.project.id.clone(),
        depth: 0,
        project_root: setup.project_root,
        extra_folders: setup
            .settings
            .permissions
            .extra_folders
            .iter()
            .map(PathBuf::from)
            .collect(),
        command_rules: setup.settings.permissions.command_rules.clone(),
        file_ignore,
        context_message_limit: setup.settings.model.context_message_limit,
        max_tool_iterations: setup.settings.model.max_tool_iterations,
        auto_continue: setup.session.auto_continue
            || setup.settings.model.auto_continue_all_sessions,
        fallback_pricing,
        base_commit: setup.base_commit,
        resume: setup.resume,
        plan_only: mode.plan_only,
        cancel,
    };
    let deps = TurnDeps {
        db: state.db.clone(),
        shadow: setup.shadow,
        processes: state.processes.clone(),
        broker: state.broker.clone(),
        questions: state.questions.clone(),
        permissions: state.permissions.clone(),
        client: state.provider(),
        http: state.http.clone(),
        mcp: mcp_manager,
    };

    let result = {
        let _keep_awake = state.power.acquire();
        agent::run_turn(&deps, request, sink).await
    };

    state.clear_cancel(&session_id);

    let send = |event: StreamEvent| {
        let _ = channel.send(RoutedEvent {
            session_id: session_id.clone(),
            event,
        });
    };

    match result {
        Ok(turn) => {
            state.db.add_session_usage(
                &session_id,
                turn.usage.cost,
                turn.usage.prompt_tokens,
                turn.usage.completion_tokens,
                turn.usage.cached_tokens,
            )?;
            if let Some(error) = turn.error {
                send(StreamEvent::Error {
                    message: error.clone(),
                });
                return Err(AppError::msg(error));
            }
            if turn.limit_reached {
                state.db.set_session_limit_reached(&session_id, true)?;
                return Ok(turn.message);
            }
            let session = state.db.get_session(&session_id)?;
            if turn.cancelled {
                send(StreamEvent::Stopped {
                    message: turn.message.clone(),
                });
                return Ok(turn.message);
            }
            send(StreamEvent::Done {
                message: turn.message.clone(),
                session,
            });
            Ok(turn.message)
        }
        Err(error) => {
            send(StreamEvent::Error {
                message: error.to_string(),
            });
            Err(error)
        }
    }
}

/// Everything `send_message` resolves before it starts assembling the turn.
struct TurnSetup {
    settings: Settings,
    api_key: String,
    session: Session,
    project: Project,
    project_root: PathBuf,
    content: String,
    attachments: Vec<Attachment>,
    mentions: Vec<Mention>,
    resume: bool,
    reasoning: Option<String>,
    selected_provider: Option<String>,
    shadow: Arc<ShadowRepo>,
    base_commit: String,
}

#[allow(clippy::too_many_arguments)]
fn prepare_turn(
    state: &AppState,
    session_id: &str,
    content: String,
    model: &str,
    reasoning_effort: Option<String>,
    provider: Option<String>,
    attachments: Option<Vec<Attachment>>,
    mentions: Option<Vec<Mention>>,
    resume: Option<bool>,
) -> Result<TurnSetup> {
    let attachments = attachments.unwrap_or_default();
    let mentions = mentions.unwrap_or_default();
    let resume = resume.unwrap_or(false);
    let settings = state.settings();
    let api_key = config::get_api_key(config::OPENROUTER_PROVIDER)?
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| AppError::msg("No OpenRouter API key configured. Add one in Settings."))?;

    let session = state.db.get_session(session_id)?;
    let project = state.db.get_project(&session.project_id)?;
    let project_root = PathBuf::from(&project.path);
    if !project_root.is_dir() {
        return Err(AppError::msg(format!(
            "Project folder no longer exists: {}",
            project.path
        )));
    }

    let reasoning = reasoning_effort
        .filter(|value| !value.trim().is_empty())
        .or_else(|| session.reasoning_effort.clone())
        .or_else(|| settings.model.default_reasoning_effort.clone());
    let selected_provider = provider
        .filter(|value| !value.trim().is_empty())
        .or_else(|| session.provider.clone())
        .map(|value| resolve_provider_preset(state, model, value));

    let shadow = Arc::new(ShadowRepo::open(
        &state.data_dir,
        &project.id,
        &project_root,
    )?);
    let base_commit = if resume {
        // Reuse the snapshot of the prompt this turn is continuing so the
        // change summary still covers everything since that prompt.
        state
            .db
            .list_messages(session_id)?
            .into_iter()
            .rev()
            .find(|message| message.role == "user")
            .and_then(|message| message.base_commit)
            .unwrap_or_default()
    } else {
        shadow.snapshot(&format!("before: {}", truncate_title(&content)))?
    };

    Ok(TurnSetup {
        settings,
        api_key,
        session,
        project,
        project_root,
        content,
        attachments,
        mentions,
        resume,
        reasoning,
        selected_provider,
        shadow,
        base_commit,
    })
}

/// Resolves @mentions and mode-bundled skills/MCP servers into the per-message
/// context, connecting any MCP servers they reference.
#[allow(clippy::too_many_arguments)]
async fn assemble_turn_context(
    state: &AppState,
    settings: &Settings,
    session_id: &str,
    project_root: &Path,
    shadow: Arc<ShadowRepo>,
    mode: &config::Mode,
    mentions: &[Mention],
    cancel: tokio_util::sync::CancellationToken,
    sink: &EventSink,
    file_ignore: Arc<FileIgnoreConfig>,
) -> (String, Arc<McpManager>) {
    let mut context = String::new();
    let mut mcp_servers: Vec<String> = Vec::new();
    if !mentions.is_empty() {
        let mut mention_runtime = ToolRuntime {
            call_id: "mention".to_string(),
            project_root: project_root.to_path_buf(),
            permissions: state.permissions.clone(),
            file_ignore,
            session_id: session_id.to_string(),
            shadow,
            processes: state.processes.clone(),
            broker: state.broker.clone(),
            questions: state.questions.clone(),
            http: state.http.clone(),
            mcp: None,
            cancel,
            emit: sink.clone(),
        };
        let resolution = mentions::resolve(
            &mut mention_runtime,
            settings,
            mentions,
            &state.marketplace.installed_skill_dirs(),
        )
        .await;
        context = resolution.context;
        mcp_servers = resolution.mcp_servers;
    }

    // Modes bundle skills and MCP servers that apply automatically.
    let installed_skill_dirs = state.marketplace.installed_skill_dirs();
    for server in &mode.mcp_servers {
        let name = server.trim();
        if !name.is_empty() && !mcp_servers.iter().any(|entry| entry == name) {
            mcp_servers.push(name.to_string());
        }
    }
    for skill in &mode.skills {
        if skill.trim().is_empty() {
            continue;
        }
        if !context.is_empty() {
            context.push_str("\n\n");
        }
        context.push_str(&mentions::resolve_skill(settings, skill, &installed_skill_dirs));
    }

    let mut mcp_manager = Arc::new(McpManager::empty());
    let mut mcp_errors: Vec<String> = Vec::new();
    if !mcp_servers.is_empty() {
        let available = crate::discovery::discover_mcp_servers(
            &settings.integrations.mcp_folders,
            &settings.integrations.mcp_disabled,
            &settings.integrations.mcp_disabled_servers,
            settings.integrations.mcp_auto_discovery,
        );
        let mut configs = Vec::new();
        for name in &mcp_servers {
            match available.iter().find(|config| &config.name == name) {
                Some(config) => configs.push(config.clone()),
                None => mcp_errors.push(format!(
                    "No MCP server named '{name}' was found in the configured sources."
                )),
            }
        }
        mcp_manager = Arc::new(McpManager::connect(configs).await);
    }
    mcp_errors.extend(mcp_manager.errors.iter().cloned());
    if !mcp_errors.is_empty() {
        context.push_str("\n\n## MCP connection issues\n");
        for error in &mcp_errors {
            context.push_str(&format!("- {error}\n"));
        }
    }

    (context, mcp_manager)
}

/// Persists the user message for a turn and derives a session title from it on
/// the first message.
fn append_user_message(
    state: &AppState,
    session_id: &str,
    setup: &TurnSetup,
    context: &str,
) -> Result<()> {
    let user_message = state.db.append_message(
        session_id,
        NewMessage::user(
            &setup.content,
            context,
            Some(&setup.base_commit),
            &setup.attachments,
            &setup.mentions,
        ),
    )?;

    if setup.session.title == DEFAULT_SESSION_TITLE {
        let title = truncate_title(&user_message.content);
        if !title.trim().is_empty() {
            state.db.update_session(
                session_id,
                Some(&title),
                None,
                None,
                None,
                None,
                None,
                None,
            )?;
        }
    }
    Ok(())
}

/// Assembles the system prompt for a turn from the session prompt, global
/// prompts, the selected mode, reply language, project rules and MCP tools.
fn build_system_prompt(
    settings: &Settings,
    session: &Session,
    mode: &config::Mode,
    mcp_manager: &McpManager,
    rules: &[ProjectRule],
) -> String {
    let mut system_prompt = session
        .system_prompt
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| settings.prompts.default_system_prompt.clone());

    let mut added_user_prompts: Vec<String> = Vec::new();
    if mode.include_global_prompts {
        for (enabled, prompt) in [
            (
                settings.prompts.security_system_prompt_enabled,
                &settings.prompts.security_system_prompt,
            ),
            (
                settings.prompts.testing_system_prompt_enabled,
                &settings.prompts.testing_system_prompt,
            ),
            (
                settings.prompts.architecture_system_prompt_enabled,
                &settings.prompts.architecture_system_prompt,
            ),
        ] {
            if enabled && !prompt.trim().is_empty() {
                system_prompt.push_str("\n\n");
                system_prompt.push_str(prompt);
            }
        }

        for prompt in &settings.prompts.user_system_prompts {
            if prompt.enabled && !prompt.prompt.trim().is_empty() {
                system_prompt.push_str("\n\n");
                system_prompt.push_str(&prompt.prompt);
                added_user_prompts.push(prompt.id.clone());
            }
        }
    }

    for id in &mode.user_prompt_ids {
        if added_user_prompts.iter().any(|added| added == id) {
            continue;
        }
        if let Some(prompt) = settings
            .prompts
            .user_system_prompts
            .iter()
            .find(|entry| &entry.id == id)
        {
            if !prompt.prompt.trim().is_empty() {
                system_prompt.push_str("\n\n");
                system_prompt.push_str(&prompt.prompt);
                added_user_prompts.push(id.clone());
            }
        }
    }

    if !mode.system_prompt.trim().is_empty() {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(&mode.system_prompt);
    }

    if let Some(language) = settings
        .appearance
        .reply_language
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        system_prompt.push_str(&format!("\n\nAlways respond in {}.", language));
    }

    if !rules.is_empty() {
        system_prompt.push_str("\n\n# Project rules\n");
        system_prompt.push_str(
            "The following rule files apply to this project. The most specific file is listed last and wins on conflict.\n",
        );
        for rule in rules {
            system_prompt.push_str(&format!(
                "\n## {} ({})\n{}\n",
                rule.scope, rule.path, rule.content
            ));
        }
    }

    if !mcp_manager.tools().is_empty() {
        system_prompt.push_str("\n\n# MCP tools\n");
        system_prompt.push_str(
            "These MCP servers are active for this message (from @mentions or the selected mode). Their tools are available; call them when they help complete the task.\n",
        );
        for tool in mcp_manager.tools() {
            system_prompt.push_str(&format!(
                "\n- {} (server: {}): {}",
                tool.exposed_name, tool.server, tool.description
            ));
        }
    }

    system_prompt
}

const HANDOVER_SYSTEM_PROMPT: &str = "You are pumr, a coding assistant. The current working session is being handed off to a fresh session. Write a self-contained handover briefing that lets the next assistant continue seamlessly. Cover, when relevant:\n- The user's overall goal and any constraints or decisions already made.\n- What has been completed so far, with concrete file paths and key changes.\n- The current state of the work: what works, what is untested, what is still in progress.\n- Important commands, findings, errors or gotchas discovered.\n- Open questions or decisions that still need the user.\n- Clear next steps.\nWrite it as a message from the user to the new assistant and begin by stating the goal. Use concise bullet points. Output only the briefing and do not call any tools.";

#[tauri::command]
pub async fn summarize_session(state: State<'_, AppState>, session_id: String) -> Result<String> {
    let settings = state.settings();
    let api_key = config::get_api_key(config::OPENROUTER_PROVIDER)?
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| AppError::msg("No OpenRouter API key configured. Add one in Settings."))?;

    let session = state.db.get_session(&session_id)?;
    let messages = state.db.list_messages(&session_id)?;
    let transcript = build_transcript(&messages);
    if transcript.trim().is_empty() {
        return Err(AppError::msg("There is nothing to hand over yet."));
    }

    let model = settings
        .model
        .handover_model
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            session
                .model
                .clone()
                .filter(|value| !value.trim().is_empty())
        })
        .or_else(|| settings.model.default_model.clone())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::msg("No model configured. Pick a model before handing over."))?;

    let fallback_pricing = state
        .cached_models()
        .and_then(|models| models.into_iter().find(|entry| entry.id == model))
        .map(|entry| {
            (
                entry.prompt_price_per_m / 1_000_000.0,
                entry.completion_price_per_m / 1_000_000.0,
            )
        });

    let client = state.provider();
    let cancel = state.register_cancel(&format!("handover:{session_id}"));
    let mut summary = String::new();
    let result = client
        .stream_chat(
            &api_key,
            &model,
            vec![
                ChatMessage::text("system", HANDOVER_SYSTEM_PROMPT),
                ChatMessage::text("user", format!("# Session transcript\n\n{transcript}")),
            ],
            None,
            None,
            fallback_pricing,
            &[],
            cancel,
            &mut |chunk| {
                if let ChatChunk::Delta(text) = chunk {
                    summary.push_str(&text);
                }
            },
        )
        .await;
    state.clear_cancel(&format!("handover:{session_id}"));
    result?;

    let summary = summary.trim().to_string();
    if summary.is_empty() {
        return Err(AppError::msg(
            "The model returned an empty handover summary.",
        ));
    }
    Ok(summary)
}

fn build_transcript(messages: &[Message]) -> String {
    const MAX_CONTENT: usize = 4000;
    const MAX_TOOL_OUTPUT: usize = 1500;
    const MAX_ARGUMENTS: usize = 300;

    let mut out = String::new();
    for message in messages {
        match message.role.as_str() {
            "user" => {
                out.push_str("\n## User\n");
                push_truncated(&mut out, &message.content, MAX_CONTENT);
                if !message.mentions.is_empty() {
                    let refs = message
                        .mentions
                        .iter()
                        .map(|mention| format!("{}:{}", mention.kind, mention.value))
                        .collect::<Vec<_>>()
                        .join(", ");
                    out.push_str(&format!("\n(references: {refs})"));
                }
            }
            "assistant" => {
                out.push_str("\n## Assistant\n");
                push_truncated(&mut out, &message.content, MAX_CONTENT);
                for call in &message.tool_calls {
                    out.push_str(&format!(
                        "\n- tool call {}({})\n",
                        call.name,
                        truncate(&call.arguments, MAX_ARGUMENTS)
                    ));
                }
            }
            "tool" => {
                out.push_str(&format!(
                    "\n### Tool result: {}\n",
                    message.tool_name.as_deref().unwrap_or("tool")
                ));
                push_truncated(&mut out, &message.content, MAX_TOOL_OUTPUT);
            }
            _ => {}
        }
    }
    out.trim().to_string()
}

fn push_truncated(out: &mut String, text: &str, max: usize) {
    if text.trim().is_empty() {
        return;
    }
    out.push_str(&truncate(text, max));
    out.push('\n');
}

fn truncate(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(max).collect();
    format!("{head}… [truncated]")
}

fn truncate_title(content: &str) -> String {
    content
        .lines()
        .next()
        .unwrap_or(DEFAULT_SESSION_TITLE)
        .chars()
        .take(60)
        .collect()
}

fn language_for(path: &str) -> &'static str {
    let extension = Path::new(path)
        .extension()
        .map(|extension| extension.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "ts" => "typescript",
        "tsx" => "typescript",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascript",
        "json" | "jsonc" => "json",
        "rs" => "rust",
        "py" => "python",
        "rb" => "ruby",
        "go" => "go",
        "java" => "java",
        "kt" => "kotlin",
        "swift" => "swift",
        "c" | "h" => "c",
        "cpp" | "cc" | "hpp" | "hh" => "cpp",
        "cs" => "csharp",
        "php" => "php",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "md" | "markdown" => "markdown",
        "toml" => "ini",
        "yaml" | "yml" => "yaml",
        "sh" | "bash" | "zsh" => "shell",
        "sql" => "sql",
        "xml" => "xml",
        "dockerfile" => "dockerfile",
        _ => "plaintext",
    }
}
