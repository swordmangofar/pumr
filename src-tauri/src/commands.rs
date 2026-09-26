use crate::agent::{self, TurnDeps, TurnRequest};
use crate::config::{self, Settings};
use crate::db::NewMessage;
use crate::error::{AppError, Result};
use crate::git::{self, language_for, ShadowRepo};
use crate::mcp::McpManager;
use crate::mentions;
use crate::models::{
    Attachment, CommandRule, EndpointInfo, EventSink, FileChange, FileDiff, GitBlameLine,
    GitCommit, GitCommitDetail, GitHunkDiff, GitInfo, GitRefs, GitStatus, Mention, Message,
    ModelInfo,
    PermissionDecision, ProcessInfo, Project, ProjectRule, ProviderInfo, QuestionAnswer,
    RoutedEvent, RunningTurns, Session, SpendStats, SpendSummary, StreamEvent, WorkspaceEntry,
    WorkspaceFile,
};
use crate::permissions::{CommandScopeKind, CommandScopeOption, FileIgnoreConfig};
use crate::providers::openrouter::{ChatChunk, ChatMessage};
use crate::state::{AppState, SendClaim, SwappableSink};
use crate::tools::ToolRuntime;
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

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
pub fn save_settings(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<Settings> {
    validate_base_url(&settings.model.openrouter_base_url).map_err(AppError::msg)?;
    config::save_settings(&state.settings_path, &settings)?;
    state.power.set_enabled(settings.interface.keep_awake);
    crate::window::apply(&app, &settings.window);
    state.set_settings(settings.clone());
    Ok(settings)
}

/// The provider key is sent to whatever host this URL points at, so require
/// https except for local gateways.
fn validate_base_url(url: &str) -> std::result::Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let parsed =
        reqwest::Url::parse(trimmed).map_err(|_| "The base URL is not a valid URL.".to_string())?;
    match parsed.scheme() {
        "https" => Ok(()),
        "http" => {
            // IPv6 hosts come back in brackets ("[::1]").
            let host = parsed.host_str().unwrap_or("");
            let loopback = host == "localhost"
                || host
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback());
            if loopback {
                Ok(())
            } else {
                Err("The base URL must use https (http is only allowed for localhost).".to_string())
            }
        }
        _ => Err("The base URL must use https.".to_string()),
    }
}

/// Temporarily releases (or re-applies) the global window-toggle shortcut while
/// the settings recorder listens for a new combination.
#[tauri::command]
pub fn suspend_window_shortcut(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    suspended: bool,
) -> Result<()> {
    if suspended {
        crate::window::suspend(&app);
    } else {
        crate::window::apply(&app, &state.settings().window);
    }
    Ok(())
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

/// How long deleting waits for stopped turns to unwind, so they do not write
/// into sessions that are already gone.
const STOP_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// Stops the turns, processes, prompts and MCP servers of sessions that are
/// about to be deleted, forgets their chat grants, and waits (briefly) until
/// the stopped turns have finished.
async fn stop_for_deletion(state: &AppState, session_ids: &[String]) {
    let finished = state.stop_sessions(session_ids);
    for id in session_ids {
        state.permissions.clear_session(id);
    }
    let all_finished = async {
        for token in finished {
            token.cancelled().await;
        }
    };
    if tokio::time::timeout(STOP_GRACE, all_finished).await.is_err() {
        log::warn!("a stopped turn was still running when its session was deleted");
    }
}

#[tauri::command]
pub async fn remove_project(state: State<'_, AppState>, project_id: String) -> Result<()> {
    let session_ids = state.db.project_session_ids(&project_id)?;
    stop_for_deletion(&state, &session_ids).await;
    state.db.remove_project(&project_id)?;
    // The shadow repository keeps a copy of every snapshot; nothing refers to
    // it once the project is gone.
    if let Err(error) = git::remove_shadow(&state.data_dir, &project_id) {
        log::warn!("could not remove shadow repository of {project_id}: {error}");
    }
    Ok(())
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
pub fn list_sub_sessions_for_project(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<Session>> {
    state.db.list_sub_sessions_for_project(&project_id)
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
        // Subagent sessions below the chat can run turns of their own.
        state.stop_sessions(&state.db.session_tree(&session_id)?);
    }
    state.db.set_session_archived(&session_id, archived)
}

/// Deletes a chat with its subagent sessions, after stopping everything that
/// still runs for any of them: otherwise the model call, tool batch and
/// subagents of a running turn would carry on (and keep costing money) with
/// no chat left to show them.
#[tauri::command]
pub async fn delete_session(state: State<'_, AppState>, session_id: String) -> Result<()> {
    let session_ids = state.db.session_tree(&session_id)?;
    stop_for_deletion(&state, &session_ids).await;
    state.db.delete_session(&session_id)
}

#[tauri::command]
pub fn list_messages(state: State<'_, AppState>, session_id: String) -> Result<Vec<Message>> {
    state.db.list_messages(&session_id)
}

#[tauri::command]
pub async fn get_spend(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<SpendSummary> {
    let mut summary = state.db.spend(session_id.as_deref())?;
    if let Some(info) = state.key_info().await {
        if let Some(limit) = info.limit {
            summary.budget_usd = limit;
            summary.remaining_usd = info.limit_remaining.map(|remaining| remaining.max(0.0));
        }
    }
    Ok(summary)
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
    state.stop_session(&session_id);
}

/// Chat turns that are still running and the prompts they wait on, for a
/// webview that reloaded mid-turn and lost the channels streaming them.
#[tauri::command]
pub fn list_running_turns(state: State<'_, AppState>) -> RunningTurns {
    RunningTurns {
        session_ids: state.running_turns(),
        permissions: state.broker.pending_requests(),
        questions: state.questions.pending_requests(),
    }
}

/// Streams a running turn's events, and the prompts it still waits on, to
/// `channel` instead of the channel `send_message` was given. Like
/// `send_message`, it resolves once the turn has finished: `true` then, or
/// `false` right away when the session has no running turn. A repeated
/// delivery of `request_id` (see `send_message`) leaves the turn's route alone.
#[tauri::command]
pub async fn attach_session(
    state: State<'_, AppState>,
    session_id: String,
    request_id: Option<String>,
    channel: Channel<RoutedEvent>,
) -> Result<bool> {
    let Some(turn) = state.attach_turn(
        &session_id,
        request_id.as_deref(),
        channel_sink(channel),
    ) else {
        return Ok(false);
    };
    turn.finished().await;
    Ok(true)
}

/// Adapts a webview channel to an [`EventSink`]. Send errors are ignored: a
/// channel whose page reloaded just drops the event.
fn channel_sink(channel: Channel<RoutedEvent>) -> EventSink {
    Arc::new(move |event: RoutedEvent| {
        let _ = channel.send(event);
    })
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
    let absolute = crate::permissions::resolve_inside_project(&root, &path)
        .ok_or_else(|| AppError::msg("path is outside the project"))?;
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
    let absolute = crate::permissions::resolve_inside_project(&root, &path)
        .ok_or_else(|| AppError::msg("path is outside the project"))?;
    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&absolute, content)?;
    Ok(())
}

fn select_command_rules(
    options: &[CommandScopeOption],
    submitted: Vec<CommandRule>,
) -> Vec<CommandRule> {
    let mut chosen = Vec::new();
    for rule in submitted {
        let rule = rule.trimmed();
        if !rule.value().is_empty()
            && options.iter().any(|option| option.rule == rule)
            && !chosen.contains(&rule)
        {
            chosen.push(rule);
        }
    }
    // Missing segment selections use only backend-owned exact options, never
    // the display suggestion. An unscoped command offers its whole line as an
    // exact option, so allow and deny can both remember it without widening.
    for option in options {
        if option.kind == CommandScopeKind::Exact {
            if let CommandRule::Exact(command) = &option.rule {
                if !command.trim().is_empty()
                    && !crate::permissions::matches_rules(command, &chosen)
                {
                    chosen.push(option.rule.clone());
                }
            }
        }
    }
    chosen
}

fn command_rules_for_decision(
    pending: &crate::broker::PendingPrompt,
    decision: &str,
    submitted: Vec<CommandRule>,
) -> Vec<CommandRule> {
    if pending.kind != "command" {
        return Vec::new();
    }
    // Shell prompts carry a suggestion; MCP prompts do not. An unscoped shell
    // denial may remember the original command, but never a suggested glob.
    if decision == "deny_always"
        && pending.scope_options.is_empty()
        && pending.suggested_rule.is_some()
    {
        return pending
            .command
            .as_deref()
            .map(str::trim)
            .filter(|command| !command.is_empty())
            .map(|command| CommandRule::Exact(command.to_string()))
            .into_iter()
            .collect();
    }
    select_command_rules(&pending.scope_options, submitted)
}

#[cfg(test)]
mod permission_rule_tests {
    use super::*;
    use crate::permissions::{evaluate_command, CommandDecision};

    fn options(command: &str) -> Vec<CommandScopeOption> {
        let CommandDecision::Ask { scope_options, .. } =
            evaluate_command(command, Path::new("/project"), Path::new("/project"), &[], &[], &[])
        else {
            panic!("expected command scopes");
        };
        scope_options
    }

    #[test]
    fn missing_selections_default_to_each_backend_exact_option() {
        let scopes = options("pnpm test '*' && node build.js");
        assert_eq!(
            select_command_rules(&scopes, vec![]),
            vec![
                CommandRule::Exact("pnpm test '*'".into()),
                CommandRule::Exact("node build.js".into()),
            ],
        );
        assert_eq!(
            select_command_rules(&scopes, vec![CommandRule::Glob("pnpm *".into())]),
            vec![
                CommandRule::Glob("pnpm *".into()),
                CommandRule::Exact("node build.js".into()),
            ],
        );
    }

    #[test]
    fn submitted_rule_must_match_backend_kind_and_value() {
        let scopes = options("pnpm test '*'");
        assert_eq!(
            select_command_rules(
                &scopes,
                vec![
                    CommandRule::Glob("pnpm test '*'".into()),
                    CommandRule::Glob("*".into()),
                    CommandRule::Exact("pnpm *".into()),
                ],
            ),
            vec![CommandRule::Exact("pnpm test '*'".into())],
        );
    }

    #[test]
    fn selections_deduplicate_by_typed_identity() {
        let scopes = options("pnpm *");
        let exact = CommandRule::Exact("pnpm *".into());
        let glob = CommandRule::Glob("pnpm *".into());
        assert_eq!(
            select_command_rules(&scopes, vec![exact.clone()]),
            vec![exact.clone()],
        );
        assert_eq!(
            select_command_rules(&scopes, vec![glob.clone()]),
            vec![glob.clone()],
        );
        assert_eq!(
            select_command_rules(&scopes, vec![exact.clone(), glob.clone(), exact.clone()]),
            vec![exact, glob],
        );
    }

    #[test]
    fn empty_scope_options_cannot_select_renderer_rules() {
        let scopes: Vec<CommandScopeOption> = Vec::new();
        assert!(select_command_rules(&scopes, vec![]).is_empty());
        assert!(select_command_rules(&scopes, vec![CommandRule::Glob("echo *".into())]).is_empty());
    }

    #[test]
    fn unscoped_shell_command_offers_only_its_exact_line() {
        let command = r#"echo "$(whoami)""#;
        let pending = crate::broker::PendingPrompt {
            kind: "command".into(),
            command: Some(format!("  {command}  ")),
            folder: None,
            suggested_rule: Some("echo *".into()),
            scope_options: options(command),
            folders: Vec::new(),
            hosts: Vec::new(),
            url: None,
            session_id: "chat".into(),
            grant_session_id: "chat".into(),
        };
        // The only offered scope is the byte-identical whole line.
        assert_eq!(
            pending.scope_options,
            vec![CommandScopeOption {
                kind: CommandScopeKind::Exact,
                rule: CommandRule::Exact(command.into()),
            }],
        );
        // A submitted rule the backend did not offer is dropped; the exact
        // whole-line fallback is remembered for deny and allow alike.
        for decision in ["deny_always", "allow_always", "allow_session"] {
            assert_eq!(
                command_rules_for_decision(
                    &pending,
                    decision,
                    vec![CommandRule::Glob("echo *".into())],
                ),
                vec![CommandRule::Exact(command.into())],
            );
        }
        let denied = command_rules_for_decision(
            &pending,
            "deny_always",
            vec![CommandRule::Glob("*".into())],
        );
        assert!(matches!(
            evaluate_command(
                command,
                Path::new("/project"),
                Path::new("/project"),
                &[],
                &[],
                &denied,
            ),
            CommandDecision::Deny { .. },
        ));
        assert!(evaluate_command(
            r#"echo "$(id)""#,
            Path::new("/project"),
            Path::new("/project"),
            &[],
            &[],
            &denied,
        )
        .is_ask());

        // An MCP prompt carries no command and no scopes, so nothing is
        // remembered for it.
        let mcp = crate::broker::PendingPrompt {
            kind: "command".into(),
            command: None,
            folder: None,
            suggested_rule: None,
            scope_options: Vec::new(),
            folders: Vec::new(),
            hosts: Vec::new(),
            url: None,
            session_id: "chat".into(),
            grant_session_id: "chat".into(),
        };
        for decision in ["deny_always", "allow_always", "allow_session"] {
            assert!(command_rules_for_decision(&mcp, decision, vec![]).is_empty());
        }
        let mut other_kind = pending;
        other_kind.kind = "web".into();
        assert!(command_rules_for_decision(&other_kind, "deny_always", vec![]).is_empty());
    }
}

#[tauri::command]
pub fn resolve_permission(
    state: State<'_, AppState>,
    request_id: String,
    decision: String,
    rules: Option<Vec<String>>,
    command_rules: Option<Vec<CommandRule>>,
    folder: Option<String>,
    folders: Option<Vec<String>>,
    prompt_kind: Option<String>,
    hosts: Option<Vec<String>>,
) -> Result<()> {
    // Never act on a decision that does not match a prompt the backend is
    // actually waiting on. This stops a renderer from persisting an allow rule
    // or extra folder without a real, user-visible prompt.
    let Some(pending) = state.broker.pending_prompt(&request_id) else {
        return Ok(());
    };
    // The renderer's `folder`/`folders` are intentionally ignored as grants: the
    // backend persists only the folders it proposed, so a renderer cannot widen
    // access. `folders` is intersected with what the prompt offered below.
    let _ = (prompt_kind, folder);
    let allowed = decision != "deny" && decision != "deny_always";
    let is_web = pending.kind.starts_with("web");
    let is_command = pending.kind == "command";
    let chosen_rules =
        command_rules_for_decision(&pending, &decision, command_rules.unwrap_or_default());
    // Only folders this prompt actually offered can be whitelisted. Deduplicate
    // while preserving the backend order.
    let mut chosen_folders: Vec<String> = Vec::new();
    for candidate in folders.unwrap_or_default() {
        let candidate = candidate.trim().to_string();
        if candidate.is_empty() {
            continue;
        }
        if pending.folders.iter().any(|folder| folder == &candidate)
            && !chosen_folders.contains(&candidate)
        {
            chosen_folders.push(candidate);
        }
    }
    // Websites a command prompt offered, intersected like folders.
    let mut chosen_hosts: Vec<String> = Vec::new();
    for candidate in hosts.unwrap_or_default() {
        let candidate = candidate.trim().to_lowercase();
        if pending.hosts.iter().any(|host| host == &candidate) && !chosen_hosts.contains(&candidate)
        {
            chosen_hosts.push(candidate);
        }
    }
    // A website prompt saves the rule the user edited only while it still
    // covers the requested host (and, to allow, stays narrow); otherwise the
    // backend's proposed host. Command decision metadata is display-only.
    let rule = if is_command {
        chosen_rules.first().map(|rule| rule.value().to_string())
    } else {
        let requested_host = pending
            .url
            .as_deref()
            .and_then(|url| reqwest::Url::parse(url).ok())
            .and_then(|url| url.host_str().map(str::to_string));
        let edited = rules
            .unwrap_or_default()
            .into_iter()
            .next()
            .map(|rule| rule.trim().to_lowercase())
            .filter(|rule| {
                is_web
                    && requested_host.as_deref().is_some_and(|host| {
                        crate::permissions::website_rule_fits(rule, host, allowed)
                    })
            });
        edited.or_else(|| {
            pending
                .suggested_rule
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
    };
    let folder = pending
        .folder
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    // Whether this decision granted anything reusable (a rule, folder or
    // website). Queued prompts the grant covers are then auto-resolved, like
    // opencode's "always" reply approving every pending request it matches.
    let mut grants_applied = false;
    if is_web {
        let mut settings = state.settings();
        let mut changed = false;
        if allowed && decision == "allow_always" {
            if let Some(rule) = &rule {
                if !settings
                    .permissions
                    .allowed_websites
                    .iter()
                    .any(|entry| entry == rule)
                {
                    settings.permissions.allowed_websites.push(rule.clone());
                    changed = true;
                }
            }
        }
        if !allowed && decision == "deny_always" {
            if let Some(rule) = &rule {
                if !settings
                    .permissions
                    .denied_websites
                    .iter()
                    .any(|entry| entry == rule)
                {
                    settings.permissions.denied_websites.push(rule.clone());
                    changed = true;
                }
            }
        }
        if allowed && decision == "allow_session" {
            if let Some(rule) = &rule {
                state.permissions.add_session_website(rule);
                grants_applied = true;
            }
        }
        if changed {
            grants_applied = true;
            config::save_settings(&state.settings_path, &settings)?;
            state.set_settings(settings);
        }
    } else if allowed && decision == "allow_always" {
        let mut settings = state.settings();
        let mut changed = false;
        if is_command {
            for rule in &chosen_rules {
                if !settings
                    .permissions
                    .command_rules
                    .iter()
                    .any(|entry| entry == rule)
                {
                    settings.permissions.command_rules.push(rule.clone());
                    changed = true;
                }
            }
        }
        if let Some(folder) = &folder {
            if !settings
                .permissions
                .extra_folders
                .iter()
                .any(|entry| entry == folder)
            {
                settings.permissions.extra_folders.push(folder.clone());
                changed = true;
            }
        }
        for candidate in &chosen_folders {
            if !settings
                .permissions
                .extra_folders
                .iter()
                .any(|entry| entry == candidate)
            {
                settings.permissions.extra_folders.push(candidate.clone());
                changed = true;
            }
        }
        for host in &chosen_hosts {
            if !settings
                .permissions
                .allowed_websites
                .iter()
                .any(|entry| entry == host)
            {
                settings.permissions.allowed_websites.push(host.clone());
                changed = true;
            }
        }
        if changed {
            grants_applied = true;
            config::save_settings(&state.settings_path, &settings)?;
            state.set_settings(settings);
        }
    } else if allowed && decision == "allow_session" {
        // A command granted "in this chat" is remembered for the whole
        // conversation (root session, shared with subagents) while a folder or
        // website granted for the session stays available until the app
        // restarts. None of these are written to settings.
        if is_command {
            for rule in &chosen_rules {
                state
                    .permissions
                    .add_session_command_rule(&pending.grant_session_id, rule);
                grants_applied = true;
            }
        }
        if let Some(folder) = &folder {
            state.permissions.add_session_folder(folder);
            grants_applied = true;
        }
        for candidate in &chosen_folders {
            state.permissions.add_session_folder(candidate);
            grants_applied = true;
        }
        for host in &chosen_hosts {
            state.permissions.add_session_website(host);
            grants_applied = true;
        }
    } else if !allowed && decision == "deny_always" && is_command {
        // Persist chosen scopes or the backend-owned exact fallback for an
        // unscoped shell command. MCP prompts have no remembered fallback.
        let mut settings = state.settings();
        let mut changed = false;
        for rule in &chosen_rules {
            if !settings
                .permissions
                .denied_command_rules
                .iter()
                .any(|entry| entry == rule)
            {
                settings.permissions.denied_command_rules.push(rule.clone());
                changed = true;
            }
        }
        if changed {
            config::save_settings(&state.settings_path, &settings)?;
            state.set_settings(settings);
        }
    }
    state.broker.resolve(
        &request_id,
        PermissionDecision {
            allowed,
            rule,
            folder,
            decided_by: "user".to_string(),
            decision: Some(decision.clone()),
        },
    );
    if !allowed {
        // opencode's reject cascade: one denial stops the chat's whole pending
        // batch instead of making the user deny each queued prompt.
        state
            .broker
            .deny_chat(&pending.grant_session_id, &request_id);
    } else if grants_applied {
        // A fresh grant (rule, folder or website) covers other queued prompts
        // of this chat; resolve them without asking again.
        state
            .broker
            .auto_resolve(&pending.grant_session_id, &state.permissions);
    }
    Ok(())
}

/// The newest permission decisions of one chat (or of all chats), newest first.
#[tauri::command]
pub fn list_permission_audit(
    state: State<'_, AppState>,
    conversation_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<crate::models::PermissionAuditEntry>> {
    state
        .db
        .list_permission_audit(conversation_id.as_deref(), limit.unwrap_or(500).min(5_000))
}

/// Deletes the permission history of one chat, or all of it.
#[tauri::command]
pub fn clear_permission_audit(
    state: State<'_, AppState>,
    conversation_id: Option<String>,
) -> Result<()> {
    state.db.clear_permission_audit(conversation_id.as_deref())
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
            settings
                .permissions
                .allowed_websites
                .iter()
                .any(|entry| entry == &rule)
        } else {
            settings
                .permissions
                .denied_websites
                .iter()
                .any(|entry| entry == &rule)
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
        settings
            .permissions
            .allowed_websites
            .retain(|entry| entry != &rule);
    } else {
        settings
            .permissions
            .denied_websites
            .retain(|entry| entry != &rule);
    }
    config::save_settings(&state.settings_path, &settings)?;
    state.set_settings(settings.clone());
    Ok(settings)
}

#[tauri::command]
pub fn add_command_rule(
    state: State<'_, AppState>,
    rule: CommandRule,
    allow: bool,
) -> Result<Settings> {
    let mut settings = state.settings();
    let rule = rule.trimmed();
    if !rule.value().is_empty() {
        let list = if allow {
            &mut settings.permissions.command_rules
        } else {
            &mut settings.permissions.denied_command_rules
        };
        if !list.iter().any(|entry| entry == &rule) {
            list.push(rule);
            config::save_settings(&state.settings_path, &settings)?;
            state.set_settings(settings.clone());
        }
    }
    Ok(settings)
}

#[tauri::command]
pub fn delete_command_rule(
    state: State<'_, AppState>,
    rule: CommandRule,
    allow: bool,
) -> Result<Settings> {
    let mut settings = state.settings();
    if allow {
        settings
            .permissions
            .command_rules
            .retain(|entry| entry != &rule);
    } else {
        settings
            .permissions
            .denied_command_rules
            .retain(|entry| entry != &rule);
    }
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
pub async fn get_git_info(state: State<'_, AppState>, project_id: String) -> Result<GitInfo> {
    in_project(&state, &project_id, |root| Ok(git::project_git_info(root))).await
}

fn project_root(state: &AppState, project_id: &str) -> Result<PathBuf> {
    let project = state.db.get_project(project_id)?;
    Ok(PathBuf::from(project.path))
}

/// Runs blocking work (git processes, hooks, network, large work trees) on a
/// worker thread. Tauri runs synchronous commands on the main thread, where
/// they would freeze the window until they return.
async fn blocking<T, F>(operation: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| AppError::msg(error.to_string()))?
}

/// Runs a git operation on a project's work tree off the main thread.
async fn in_project<T, F>(state: &AppState, project_id: &str, operation: F) -> Result<T>
where
    F: FnOnce(&Path) -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    let root = project_root(state, project_id)?;
    blocking(move || operation(&root)).await
}

#[tauri::command]
pub async fn get_git_status(state: State<'_, AppState>, project_id: String) -> Result<GitStatus> {
    in_project(&state, &project_id, git::project_git_status).await
}

#[tauri::command]
pub async fn get_git_refs(state: State<'_, AppState>, project_id: String) -> Result<GitRefs> {
    in_project(&state, &project_id, git::project_git_refs).await
}

#[tauri::command]
pub async fn get_git_commits(
    state: State<'_, AppState>,
    project_id: String,
    query: Option<String>,
    path: Option<String>,
    skip: Option<usize>,
    limit: Option<usize>,
) -> Result<Vec<GitCommit>> {
    in_project(&state, &project_id, move |root| {
        git::project_commits(
            root,
            query.as_deref(),
            path.as_deref(),
            skip.unwrap_or(0),
            limit.unwrap_or(50),
        )
    })
    .await
}

#[tauri::command]
pub async fn get_git_commit(
    state: State<'_, AppState>,
    project_id: String,
    hash: String,
) -> Result<GitCommitDetail> {
    in_project(&state, &project_id, move |root| {
        git::project_commit_detail(root, &hash)
    })
    .await
}

#[tauri::command]
pub async fn get_git_commit_file_diff(
    state: State<'_, AppState>,
    project_id: String,
    hash: String,
    path: String,
) -> Result<FileDiff> {
    in_project(&state, &project_id, move |root| {
        git::project_commit_file_diff(root, &hash, &path)
    })
    .await
}

#[tauri::command]
pub async fn get_git_file_diff(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    staged: bool,
) -> Result<FileDiff> {
    in_project(&state, &project_id, move |root| {
        git::project_file_diff(root, &path, staged)
    })
    .await
}

/// The diff of one changed path split into hunks, for line staging.
#[tauri::command]
pub async fn get_git_file_hunks(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    staged: bool,
    context: u32,
    ignore_whitespace: bool,
) -> Result<GitHunkDiff> {
    in_project(&state, &project_id, move |root| {
        git::project_file_hunks(root, &path, staged, context, ignore_whitespace)
    })
    .await
}

/// Stages, unstages or discards single lines of a hunk diff.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn git_apply_lines(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    staged: bool,
    action: String,
    context: u32,
    fingerprint: String,
    lines: Vec<u32>,
) -> Result<()> {
    in_project(&state, &project_id, move |root| {
        git::git_apply_lines(root, &path, staged, &action, context, &fingerprint, &lines)
    })
    .await
}

#[tauri::command]
pub async fn git_stage(
    state: State<'_, AppState>,
    project_id: String,
    path: Option<String>,
) -> Result<()> {
    in_project(&state, &project_id, move |root| {
        git::git_stage(root, path.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(
    state: State<'_, AppState>,
    project_id: String,
    path: Option<String>,
) -> Result<()> {
    in_project(&state, &project_id, move |root| {
        git::git_unstage(root, path.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn git_stage_paths(
    state: State<'_, AppState>,
    project_id: String,
    paths: Vec<String>,
) -> Result<()> {
    in_project(&state, &project_id, move |root| {
        git::git_stage_paths(root, &paths)
    })
    .await
}

#[tauri::command]
pub async fn git_unstage_paths(
    state: State<'_, AppState>,
    project_id: String,
    paths: Vec<String>,
) -> Result<()> {
    in_project(&state, &project_id, move |root| {
        git::git_unstage_paths(root, &paths)
    })
    .await
}

/// Discards unstaged changes; the one command for single files and selections,
/// so both behave the same.
#[tauri::command]
pub async fn git_discard_paths(
    state: State<'_, AppState>,
    project_id: String,
    paths: Vec<String>,
) -> Result<()> {
    in_project(&state, &project_id, move |root| {
        git::git_discard_paths(root, &paths)
    })
    .await
}

#[tauri::command]
pub async fn get_git_blame(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> Result<Vec<GitBlameLine>> {
    in_project(&state, &project_id, move |root| {
        git::project_blame(root, &path)
    })
    .await
}

#[tauri::command]
pub async fn git_ignore(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> Result<()> {
    in_project(&state, &project_id, move |root| {
        git::git_ignore(root, &path)
    })
    .await
}

/// Resolves a conflicted path with `ours` or `theirs`.
#[tauri::command]
pub async fn git_resolve_conflict(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    side: String,
) -> Result<()> {
    in_project(&state, &project_id, move |root| {
        git::git_resolve_conflict(root, &path, &side)
    })
    .await
}

#[tauri::command]
pub async fn git_cherry_pick(
    state: State<'_, AppState>,
    project_id: String,
    hash: String,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_cherry_pick(root, &hash)
    })
    .await
}

#[tauri::command]
pub async fn git_revert(
    state: State<'_, AppState>,
    project_id: String,
    hash: String,
) -> Result<String> {
    in_project(&state, &project_id, move |root| git::git_revert(root, &hash)).await
}

#[tauri::command]
pub async fn git_reset(
    state: State<'_, AppState>,
    project_id: String,
    hash: String,
    mode: String,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_reset(root, &hash, &mode)
    })
    .await
}

#[tauri::command]
pub async fn git_checkout_commit(
    state: State<'_, AppState>,
    project_id: String,
    hash: String,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_checkout_commit(root, &hash)
    })
    .await
}

/// Staged diff text sent to the model; enough to describe most commits
/// without paying for a huge prompt.
const COMMIT_MESSAGE_MAX_PATCH_CHARS: usize = 40_000;

const COMMIT_MESSAGE_SYSTEM_PROMPT: &str = "You write git commit messages for staged changes. Reply with the commit message only, without quotes, code fences or commentary. Start with a subject line of at most 72 characters in the imperative mood that says what the change does. If the change needs explaining, add a blank line and a short body that says what changed and why, wrapped at 72 characters; leave the body out for small, obvious changes. Follow the style of the recent commit subjects you are given, including any prefix convention such as \"feat:\" or a ticket number, and write in their language.";

/// Drafts a commit message for the staged changes with the configured model.
#[tauri::command]
pub async fn git_generate_commit_message(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<String> {
    let settings = state.settings();
    let api_key = config::get_api_key(config::OPENROUTER_PROVIDER)?
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| AppError::msg("No OpenRouter API key configured. Add one in Settings."))?;
    let model = settings
        .model
        .commit_message_model
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| settings.model.default_model.clone())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::msg("No model configured. Pick a default model in Settings."))?;
    let summary = in_project(&state, &project_id, |root| {
        git::staged_summary(root, COMMIT_MESSAGE_MAX_PATCH_CHARS)
    })
    .await?;

    let mut prompt = String::new();
    if let Some(branch) = &summary.branch {
        prompt.push_str(&format!("Branch: {branch}\n\n"));
    }
    if !summary.recent_subjects.is_empty() {
        prompt.push_str("Recent commit subjects:\n");
        for subject in &summary.recent_subjects {
            prompt.push_str(&format!("- {subject}\n"));
        }
        prompt.push('\n');
    }
    prompt.push_str(&format!("Staged files:\n{}\n\nStaged diff", summary.stat));
    if summary.truncated {
        prompt.push_str(" (cut off; the file list above is complete)");
    }
    prompt.push_str(&format!(":\n{}", summary.patch));

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
    let registration = state.register_cancel(&format!("commit-message:{project_id}"));
    let mut reply = String::new();
    let result = client
        .stream_chat(
            &api_key,
            &model,
            vec![
                ChatMessage::text("system", COMMIT_MESSAGE_SYSTEM_PROMPT),
                ChatMessage::text("user", prompt),
            ],
            None,
            None,
            fallback_pricing,
            &[],
            false,
            registration.token(),
            &mut |chunk| {
                if let ChatChunk::Delta(text) = chunk {
                    reply.push_str(&text);
                }
            },
        )
        .await;
    drop(registration);
    result?;

    let message = clean_commit_message(&reply);
    if message.is_empty() {
        return Err(AppError::msg("The model returned an empty commit message."));
    }
    Ok(message)
}

/// Strips what models tend to wrap a commit message in: code fences,
/// surrounding quotes and blank lines.
fn clean_commit_message(reply: &str) -> String {
    let lines: Vec<&str> = reply
        .trim()
        .lines()
        .filter(|line| !line.trim_start().starts_with("```"))
        .collect();
    let text = lines.join("\n");
    let text = text.trim();
    let text = text
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .unwrap_or(text);
    text.trim().to_string()
}

#[tauri::command]
pub async fn reveal_path(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> Result<()> {
    in_project(&state, &project_id, move |root| {
        git::reveal_path(root, &path)
    })
    .await
}

#[tauri::command]
pub async fn git_commit(
    state: State<'_, AppState>,
    project_id: String,
    message: String,
    amend: bool,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_commit(root, &message, amend)
    })
    .await
}

#[tauri::command]
pub async fn git_checkout(
    state: State<'_, AppState>,
    project_id: String,
    branch: String,
    track: Option<bool>,
    local_branch: Option<String>,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_checkout(
            root,
            &branch,
            track.unwrap_or(false),
            local_branch.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn git_fetch(state: State<'_, AppState>, project_id: String) -> Result<String> {
    in_project(&state, &project_id, git::git_fetch).await
}

#[tauri::command]
pub async fn git_pull(
    state: State<'_, AppState>,
    project_id: String,
    strategy: Option<String>,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_pull(root, strategy.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn git_push(state: State<'_, AppState>, project_id: String) -> Result<String> {
    in_project(&state, &project_id, git::git_push).await
}

#[tauri::command]
pub async fn git_fast_forward(
    state: State<'_, AppState>,
    project_id: String,
    branch: String,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_fast_forward(root, &branch)
    })
    .await
}

#[tauri::command]
pub async fn git_merge(
    state: State<'_, AppState>,
    project_id: String,
    branch: String,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_merge(root, &branch)
    })
    .await
}

#[tauri::command]
pub async fn git_rebase(
    state: State<'_, AppState>,
    project_id: String,
    onto: String,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_rebase(root, &onto)
    })
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseTodoEntry {
    pub action: String,
    pub hash: String,
}

#[tauri::command]
pub async fn git_rebase_interactive(
    state: State<'_, AppState>,
    project_id: String,
    onto: String,
    todo: Vec<RebaseTodoEntry>,
) -> Result<String> {
    let entries: Vec<(String, String)> = todo
        .into_iter()
        .map(|entry| (entry.action, entry.hash))
        .collect();
    in_project(&state, &project_id, move |root| {
        git::git_rebase_interactive(root, &onto, &entries)
    })
    .await
}

#[tauri::command]
pub async fn get_git_rebase_commits(
    state: State<'_, AppState>,
    project_id: String,
    onto: String,
) -> Result<Vec<GitCommit>> {
    in_project(&state, &project_id, move |root| {
        git::project_rebase_commits(root, &onto)
    })
    .await
}

#[tauri::command]
pub async fn git_branch_create(
    state: State<'_, AppState>,
    project_id: String,
    name: String,
    start_point: Option<String>,
    checkout: bool,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_branch_create(root, &name, start_point.as_deref(), checkout)
    })
    .await
}

#[tauri::command]
pub async fn git_tag_create(
    state: State<'_, AppState>,
    project_id: String,
    name: String,
    target: Option<String>,
    message: Option<String>,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_tag_create(root, &name, target.as_deref(), message.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn git_branch_rename(
    state: State<'_, AppState>,
    project_id: String,
    from: String,
    to: String,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_branch_rename(root, &from, &to)
    })
    .await
}

#[tauri::command]
pub async fn git_branch_delete(
    state: State<'_, AppState>,
    project_id: String,
    branch: String,
    remote: bool,
    force: Option<bool>,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_branch_delete(root, &branch, remote, force.unwrap_or(false))
    })
    .await
}

#[tauri::command]
pub async fn git_set_upstream(
    state: State<'_, AppState>,
    project_id: String,
    branch: String,
    upstream: String,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_set_upstream(root, &branch, &upstream)
    })
    .await
}

#[tauri::command]
pub async fn git_push_branch(
    state: State<'_, AppState>,
    project_id: String,
    branch: String,
    remote: String,
    set_upstream: bool,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_push_branch(root, &branch, &remote, set_upstream)
    })
    .await
}

#[tauri::command]
pub async fn git_operation_abort(
    state: State<'_, AppState>,
    project_id: String,
    operation: String,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_operation_abort(root, &operation)
    })
    .await
}

#[tauri::command]
pub async fn git_operation_continue(
    state: State<'_, AppState>,
    project_id: String,
    operation: String,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_operation_continue(root, &operation)
    })
    .await
}

#[tauri::command]
pub async fn git_stash_push(
    state: State<'_, AppState>,
    project_id: String,
    message: Option<String>,
    include_untracked: bool,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_stash_push(root, message.as_deref(), include_untracked)
    })
    .await
}

#[tauri::command]
pub async fn git_stash_apply(
    state: State<'_, AppState>,
    project_id: String,
    stash: String,
    hash: String,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_stash_apply(root, &stash, &hash)
    })
    .await
}

#[tauri::command]
pub async fn git_stash_pop(
    state: State<'_, AppState>,
    project_id: String,
    stash: String,
    hash: String,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_stash_pop(root, &stash, &hash)
    })
    .await
}

#[tauri::command]
pub async fn git_stash_drop(
    state: State<'_, AppState>,
    project_id: String,
    stash: String,
    hash: String,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_stash_drop(root, &stash, &hash)
    })
    .await
}

#[tauri::command]
pub async fn git_init(state: State<'_, AppState>, project_id: String) -> Result<String> {
    in_project(&state, &project_id, git::git_init).await
}

#[tauri::command]
pub async fn git_clone(state: State<'_, AppState>, url: String, path: String) -> Result<Project> {
    let destination = PathBuf::from(&path);
    let target = destination.clone();
    blocking(move || git::git_clone(&url, &target)).await?;
    let canonical = destination.canonicalize().unwrap_or(destination);
    state.db.upsert_project(&canonical.to_string_lossy())
}

#[tauri::command]
pub async fn git_tag_delete(
    state: State<'_, AppState>,
    project_id: String,
    name: String,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_tag_delete(root, &name)
    })
    .await
}

#[tauri::command]
pub async fn git_tag_push(
    state: State<'_, AppState>,
    project_id: String,
    remote: String,
    name: String,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_tag_push(root, &remote, &name)
    })
    .await
}

#[tauri::command]
pub async fn git_submodule_update(
    state: State<'_, AppState>,
    project_id: String,
    path: Option<String>,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_submodule_update(root, path.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn git_pull_request_url(
    state: State<'_, AppState>,
    project_id: String,
    remote: String,
    branch: String,
) -> Result<String> {
    in_project(&state, &project_id, move |root| {
        git::git_pull_request_url(root, &remote, &branch)
    })
    .await
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<()> {
    // Only allow web links through the OS opener. This blocks `file:`,
    // `javascript:`, and custom protocol handlers.
    let parsed =
        reqwest::Url::parse(url.trim()).map_err(|_| AppError::msg("invalid URL".to_string()))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::msg(
            "only http(s) links can be opened".to_string(),
        ));
    }
    let url = parsed.to_string();
    let status = {
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg(&url).status()
        }
        #[cfg(target_os = "windows")]
        {
            // Hands the URL straight to ShellExecute. Going through `cmd /C
            // start` would let cmd.exe interpret `&` and `|`, which are valid
            // in a URL's query string, as command separators.
            std::process::Command::new("rundll32")
                .args(["url.dll,FileProtocolHandler", &url])
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

/// Adds a single file to the asset-protocol scope so the webview may load it.
/// Only paths the user picked through the OS dialog (or that are already saved
/// in settings) reach this, so the scope never widens to the whole filesystem.
pub fn allow_asset_path(app: &AppHandle, path: &str) {
    let path = path.trim();
    if path.is_empty() {
        return;
    }
    if let Err(error) = app.asset_protocol_scope().allow_file(Path::new(path)) {
        log::warn!("could not allow asset path {path}: {error}");
    }
}

/// Opens a native file picker for a background image or sound and grants the
/// chosen file access to the asset protocol. The grant happens only after the
/// user confirms a file, so a compromised webview cannot widen the scope.
#[tauri::command]
pub async fn pick_asset_file(app: AppHandle, kind: String) -> Result<Option<String>> {
    // `blocking_pick_file` waits for the dialog and must not run on the main
    // thread, which is where synchronous commands run.
    blocking(move || pick_asset_file_blocking(&app, &kind)).await
}

fn pick_asset_file_blocking(app: &AppHandle, kind: &str) -> Result<Option<String>> {
    let (title, extensions): (&str, &[&str]) = match kind {
        "sound" => (
            "Select sound file",
            &[
                "mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus", "webm",
            ],
        ),
        _ => (
            "Select background image",
            &["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "svg"],
        ),
    };
    let picked = app
        .dialog()
        .file()
        .set_title(title)
        .add_filter(title, extensions)
        .blocking_pick_file();
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|error| AppError::msg(error.to_string()))?;
    allow_asset_path(app, &path.to_string_lossy());
    Ok(Some(path.to_string_lossy().to_string()))
}

fn open_shadow(state: &AppState, project_id: &str) -> Result<Arc<ShadowRepo>> {
    let project = state.db.get_project(project_id)?;
    Ok(Arc::new(ShadowRepo::open(
        &state.data_dir,
        project_id,
        Path::new(&project.path),
    )?))
}

/// Resolving a session's changes can stage the whole project in the shadow
/// repository, so it runs off the main thread.
#[tauri::command]
pub async fn get_session_changes(app: AppHandle, session_id: String) -> Result<Vec<FileChange>> {
    blocking(move || session_changes_resolved(&app.state::<AppState>(), &session_id)).await
}

#[tauri::command]
pub async fn get_file_diff(app: AppHandle, session_id: String, path: String) -> Result<FileDiff> {
    blocking(move || session_file_diff(&app.state::<AppState>(), &session_id, &path)).await
}

fn session_file_diff(state: &AppState, session_id: &str, path: &str) -> Result<FileDiff> {
    let session = state.db.get_session(session_id)?;
    let project = state.db.get_project(&session.project_id)?;
    let base = state.db.session_base_commit(session_id)?;
    let change = session_changes_resolved(state, session_id)?
        .into_iter()
        .find(|change| change.path == path);
    let old = match base {
        Some(base) => open_shadow(state, &session.project_id)?.side_at(&base, path),
        None => git::DiffSide::Missing,
    };
    let entry = git::project_entry(Path::new(&project.path), path)?;
    let mut diff = git::build_file_diff(path, old, git::worktree_side(&entry));
    // Keep the counts and status the session's change list shows.
    if let Some(change) = change {
        diff.additions = change.additions;
        diff.deletions = change.deletions;
        diff.status = change.status;
    }
    Ok(diff)
}

/// Reads rule files and resolves the session's changes (which can stage the
/// whole project in the shadow repository), so it runs off the main thread.
#[tauri::command]
pub async fn get_project_rules(
    app: AppHandle,
    project_id: String,
    session_id: Option<String>,
) -> Result<Vec<ProjectRule>> {
    blocking(move || {
        collect_project_rules(&app.state::<AppState>(), &project_id, session_id.as_deref())
    })
    .await
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
        let changes = session_changes_resolved(state, session_id).unwrap_or_default();
        let paths: Vec<&str> = changes.iter().map(|change| change.path.as_str()).collect();
        for directory in nested_rule_directories(project_root, &paths) {
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

/// The directories between the project root and each changed file, ordered
/// from least to most specific: the prompt tells the model that the last rule
/// file listed wins on conflict.
fn nested_rule_directories(project_root: &Path, changed: &[&str]) -> Vec<PathBuf> {
    let mut directories: Vec<PathBuf> = Vec::new();
    for path in changed {
        let mut current = project_root.join(path);
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
    directories.sort_by(|left, right| {
        left.components()
            .count()
            .cmp(&right.components().count())
            .then_with(|| left.cmp(right))
    });
    directories
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

/// Restoring files stages and checks out the whole project in the shadow
/// repository, so it runs off the main thread.
#[tauri::command]
pub async fn revert_to_message(
    app: AppHandle,
    message_id: String,
    restore_files: bool,
) -> Result<RevertResult> {
    blocking(move || {
        revert_to_message_blocking(&app.state::<AppState>(), &message_id, restore_files)
    })
    .await
}

fn revert_to_message_blocking(
    state: &AppState,
    message_id: &str,
    restore_files: bool,
) -> Result<RevertResult> {
    let message = state.db.get_message(message_id)?;
    if message.role != "user" {
        return Err(AppError::msg("Only user prompts can be reverted to."));
    }
    let session = state.db.get_session(&message.session_id)?;
    let mut restored = Vec::new();
    if restore_files {
        if let Some(base) = message.base_commit.as_deref() {
            let shadow = open_shadow(state, &session.project_id)?;
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
    request_id: Option<String>,
    channel: Channel<RoutedEvent>,
) -> Result<Message> {
    // Tauri delivers an invoke again when its IPC fetch fails (a webview
    // reload mid-turn does that). The repeat waits for the original instead of
    // starting a second turn, which would cancel the running one and resolve
    // its pending permission prompts as denied.
    let publish = match request_id.as_deref().map(|id| state.sends.claim(id)) {
        Some(SendClaim::Duplicate(mut original)) => {
            let outcome = original
                .wait_for(Option::is_some)
                .await
                .ok()
                .and_then(|outcome| (*outcome).clone());
            return match outcome {
                Some(outcome) => outcome.map_err(AppError::msg),
                None => Err(AppError::msg(
                    "The original request ended without a result.",
                )),
            };
        }
        Some(SendClaim::First(publish)) => Some(publish),
        None => None,
    };
    let result = run_send_message(
        state,
        session_id,
        content,
        model,
        reasoning_effort,
        provider,
        attachments,
        mentions,
        resume,
        channel,
    )
    .await;
    if let Some(publish) = publish {
        publish.send_replace(Some(match &result {
            Ok(message) => Ok(message.clone()),
            Err(error) => Err(error.to_string()),
        }));
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn run_send_message(
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

    // Everything the turn emits goes through `events`, so `attach_session` can
    // move the stream to a new channel if the webview reloads mid-turn.
    let events = SwappableSink::new(channel_sink(channel));
    let sink = events.sink();

    let mode = config::resolve_mode(&setup.settings, setup.session.mode_id.as_deref());
    // Dropped on every exit path below, unregistering this turn but never a
    // newer one that replaced it.
    let registration = state.register_turn(&session_id, events);
    let cancel = registration.token();
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
    let skills = if mode.include_global_prompts {
        crate::discovery::skill_catalog(
            &setup.settings.integrations.skill_folders,
            &setup.settings.integrations.skills_disabled,
            &setup.settings.integrations.skills_disabled_items,
            setup.settings.integrations.skills_auto_discovery,
            &state.marketplace.installed_skill_dirs(),
        )
    } else {
        Vec::new()
    };
    let system_prompt = build_system_prompt(
        &setup.settings,
        &setup.session,
        &mode,
        &mcp_manager,
        &rules,
        &skills,
        &setup.project_root,
    );

    let cached_model = state
        .cached_models()
        .and_then(|models| models.into_iter().find(|entry| entry.id == model));
    let fallback_pricing = cached_model.as_ref().map(|entry| {
        (
            entry.prompt_price_per_m / 1_000_000.0,
            entry.completion_price_per_m / 1_000_000.0,
        )
    });
    let context_length = cached_model
        .as_ref()
        .map(|entry| entry.context_length)
        .unwrap_or(0);

    let request = TurnRequest {
        api_key: setup.api_key,
        model: model.clone(),
        reasoning_effort: setup.reasoning,
        provider: setup.selected_provider,
        system_prompt,
        session_id: session_id.clone(),
        conversation_id: setup
            .session
            .parent_session_id
            .clone()
            .unwrap_or_else(|| session_id.clone()),
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
        file_ignore,
        context_message_limit: setup.settings.model.context_message_limit,
        context_length,
        max_tool_iterations: setup.settings.model.max_tool_iterations,
        auto_continue: setup.session.auto_continue
            || setup.settings.model.auto_continue_all_sessions,
        fallback_pricing,
        base_commit: setup.base_commit,
        resume: setup.resume,
        plan_only: mode.plan_only,
        read_only: mode.read_only,
        mcp_progressive_disclosure: setup.settings.integrations.mcp_progressive_disclosure,
        skills,
        prompt_caching: setup.settings.model.prompt_caching,
        subagent_model: setup
            .settings
            .model
            .subagent_model
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| model.clone()),
        compaction_model: setup
            .settings
            .model
            .compaction_model
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| model.clone()),
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
        agent::run_turn(&deps, request, sink.clone()).await
    };

    let send = |event: StreamEvent| {
        (sink)(RoutedEvent {
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
            .latest_user_message(session_id)?
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
    let approval_cancel = cancel.clone();
    if !mentions.is_empty() {
        let mut mention_runtime = ToolRuntime {
            call_id: "mention".to_string(),
            project_root: project_root.to_path_buf(),
            permissions: state.permissions.clone(),
            file_ignore,
            session_id: session_id.to_string(),
            conversation_id: session_id.to_string(),
            shadow,
            processes: state.processes.clone(),
            broker: state.broker.clone(),
            questions: state.questions.clone(),
            http: state.http.clone(),
            mcp: None,
            skills: Vec::new(),
            justification: None,
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
        context.push_str(&mentions::resolve_skill(
            settings,
            skill,
            &installed_skill_dirs,
        ));
    }

    let mut mcp_errors: Vec<String> = Vec::new();
    let mut configs = Vec::new();
    if !mcp_servers.is_empty() {
        let available = crate::discovery::discover_mcp_servers(
            &settings.integrations.mcp_folders,
            &settings.integrations.mcp_disabled,
            &settings.integrations.mcp_disabled_servers,
            settings.integrations.mcp_auto_discovery,
        );
        for name in &mcp_servers {
            match available.iter().find(|config| &config.name == name) {
                Some(config) if state.mcp.is_approved(session_id, config) => {
                    configs.push(config.clone());
                }
                Some(config) => {
                    // Starting a server spawns a process or opens a network
                    // connection, so require explicit user approval and show the
                    // exact command/URL and where it came from.
                    let description = match (&config.command, &config.url) {
                        (Some(command), _) => {
                            let args = config.args.join(" ");
                            if args.is_empty() {
                                command.clone()
                            } else {
                                format!("{command} {args}")
                            }
                        }
                        (None, Some(url)) => url.clone(),
                        _ => continue,
                    };
                    let allowed = state
                        .broker
                        .ask(
                            crate::broker::PermissionPrompt {
                                kind: "command".to_string(),
                                operation: crate::broker::PermissionOperation::McpStart,
                                cwd: std::env::current_dir()
                                    .ok()
                                    .map(|path| path.canonicalize().unwrap_or(path)),
                                project_root: project_root.to_path_buf(),
                                title: format!("Start MCP server '{}'?", config.name),
                                detail: format!(
                                    "The assistant wants to start MCP server '{}' configured in {}.",
                                    config.name, config.source
                                ),
                                command: Some(description),
                                path: None,
                                folder: None,
                                url: config.url.clone(),
                                suggested_rule: None,
                                segments: Vec::new(),
                                risk: None,
                                scope_options: Vec::new(),
                                folders: Vec::new(),
                                hosts: Vec::new(),
                                grant_session_id: session_id.to_string(),
                                justification: None,
                            },
                            &approval_cancel,
                            session_id,
                            sink,
                        )
                        .await
                        .allowed;
                    if allowed {
                        // Remembered for this chat, for exactly this command,
                        // environment and URL.
                        state.mcp.approve(session_id, config);
                        configs.push(config.clone());
                    } else {
                        mcp_errors.push(format!(
                            "MCP server '{}' was not approved and was skipped.",
                            config.name
                        ));
                    }
                }
                None => mcp_errors.push(format!(
                    "No MCP server named '{name}' was found in the configured sources."
                )),
            }
        }
    }
    // Reuses the servers of the session's previous turn when they still match,
    // and stops them when this turn needs none.
    let mcp_manager = state.mcp.manager(session_id, configs).await;
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
    skills: &[crate::models::SkillEntry],
    project_root: &Path,
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

    system_prompt.push_str(&environment_section(project_root));

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

    if !skills.is_empty() {
        system_prompt.push_str("\n\n# Skills\n");
        system_prompt.push_str(
            "The following skills are available. When one applies to the user's request, call the `skill` tool with its name to load the full instructions before proceeding. Do not load a skill that is not relevant.\n",
        );
        for skill in skills {
            let description = skill.description.trim();
            if description.is_empty() {
                system_prompt.push_str(&format!("\n- {}", skill.name));
            } else {
                system_prompt.push_str(&format!("\n- {}: {}", skill.name, description));
            }
        }
    }

    system_prompt
}

/// Tells the model where it runs, so it does not probe the filesystem with
/// guessed paths (`cd /Users/*/project || cd ../project; pwd`) that only
/// trigger permission prompts.
fn environment_section(project_root: &Path) -> String {
    format!(
        "\n\n# Environment\n- Project root: {}\n- bash commands already run in the project root unless you pass `cwd`; do not `cd` into it or probe for it with `pwd`/`ls`.\n- Relative paths in tools resolve against the project root. Paths outside it require user approval.",
        project_root.display()
    )
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
    let registration = state.register_cancel(&format!("handover:{session_id}"));
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
            false,
            registration.token(),
            &mut |chunk| {
                if let ChatChunk::Delta(text) = chunk {
                    summary.push_str(&text);
                }
            },
        )
        .await;
    drop(registration);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_messages_lose_fences_and_quotes() {
        assert_eq!(
            clean_commit_message("```\nAdd login\n\nExplain why.\n```\n"),
            "Add login\n\nExplain why."
        );
        assert_eq!(clean_commit_message("\"Fix typo\"\n"), "Fix typo");
        assert_eq!(clean_commit_message("  \n "), "");
    }

    #[test]
    fn nested_rule_directories_list_the_most_specific_last() {
        let root = Path::new("/work/app");
        let directories = nested_rule_directories(
            root,
            &["src/core/deep/file.rs", "src/lib.rs", "docs/guide.md", "README.md"],
        );
        let relative: Vec<String> = directories
            .iter()
            .map(|directory| directory.strip_prefix(root).unwrap().display().to_string())
            .collect();
        assert_eq!(relative, ["docs", "src", "src/core", "src/core/deep"]);
    }

    #[test]
    fn plain_http_base_urls_are_limited_to_loopback() {
        for url in [
            "http://localhost:11434/v1",
            "http://127.0.0.1:8080",
            "http://127.0.0.2",
            "http://[::1]:1234/api",
            "https://openrouter.ai/api/v1",
            "",
        ] {
            assert_eq!(validate_base_url(url), Ok(()), "{url}");
        }
        for url in [
            "http://example.com",
            "http://10.0.0.1",
            "http://[::2]",
            "http://localhost.example.com",
            "ftp://localhost",
        ] {
            assert!(validate_base_url(url).is_err(), "{url}");
        }
    }
}
