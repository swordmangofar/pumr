use crate::agent::{self, TurnDeps, TurnRequest};
use crate::config::{self, Settings};
use crate::db::NewMessage;
use crate::error::{AppError, Result};
use crate::git::{project_git_info, ShadowRepo};
use crate::models::{
    Attachment, EndpointInfo, EventSink, FileChange, FileDiff, GitInfo, Message, ModelInfo,
    PermissionDecision, ProcessInfo, Project, ProjectRule, ProviderInfo, QuestionAnswer,
    RoutedEvent, Session, SpendSummary, StreamEvent,
};
use crate::state::AppState;
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
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<Settings> {
    config::save_settings(&state.settings_path, &settings)?;
    state.power.set_enabled(settings.keep_awake);
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
) -> Result<Session> {
    state.db.touch_project(&project_id)?;
    state.db.create_session(
        &project_id,
        title.as_deref().unwrap_or(DEFAULT_SESSION_TITLE),
        model.as_deref(),
        reasoning_effort.as_deref(),
        provider.as_deref(),
        system_prompt.as_deref(),
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
) -> Result<Session> {
    state.db.update_session(
        &session_id,
        title.as_deref(),
        model.as_deref(),
        reasoning_effort.as_deref(),
        provider.as_deref(),
        system_prompt.as_deref(),
    )
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
    state.db.spend(session_id.as_deref(), settings.budget_usd)
}

#[tauri::command]
pub fn stop_generation(state: State<'_, AppState>, session_id: String) {
    state.cancel(&session_id);
}

#[tauri::command]
pub fn discover_mcp_sources(
    folders: Vec<String>,
    disabled: Vec<String>,
    auto_discovery: bool,
) -> Vec<crate::models::McpCandidate> {
    crate::discovery::discover_mcp(&folders, &disabled, auto_discovery)
}

#[tauri::command]
pub fn discover_skills(
    folders: Vec<String>,
    disabled: Vec<String>,
    auto_discovery: bool,
) -> Vec<crate::models::SkillCandidate> {
    crate::discovery::discover_skills(&folders, &disabled, auto_discovery)
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
                if !settings.allowed_websites.iter().any(|entry| entry == rule) {
                    settings.allowed_websites.push(rule.clone());
                    changed = true;
                }
            }
        }
        if !allowed && decision == "deny_always" {
            if let Some(rule) = &rule {
                if !settings.denied_websites.iter().any(|entry| entry == rule) {
                    settings.denied_websites.push(rule.clone());
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
            if !settings.command_rules.iter().any(|entry| entry == rule) {
                settings.command_rules.push(rule.clone());
                changed = true;
            }
        }
        if let Some(folder) = &folder {
            if !settings.extra_folders.iter().any(|entry| entry == folder) {
                settings.extra_folders.push(folder.clone());
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
            settings.allowed_websites.iter().any(|entry| entry == &rule)
        } else {
            settings.denied_websites.iter().any(|entry| entry == &rule)
        };
        if !exists {
            if allow {
                settings.allowed_websites.push(rule);
            } else {
                settings.denied_websites.push(rule);
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
        settings.allowed_websites.retain(|entry| entry != &rule);
    } else {
        settings.denied_websites.retain(|entry| entry != &rule);
    }
    config::save_settings(&state.settings_path, &settings)?;
    state.set_settings(settings.clone());
    Ok(settings)
}

#[tauri::command]
pub fn add_command_rule(state: State<'_, AppState>, rule: String) -> Result<Settings> {
    let mut settings = state.settings();
    let rule = rule.trim().to_string();
    if !rule.is_empty() && !settings.command_rules.iter().any(|entry| entry == &rule) {
        settings.command_rules.push(rule);
        config::save_settings(&state.settings_path, &settings)?;
        state.set_settings(settings.clone());
    }
    Ok(settings)
}

#[tauri::command]
pub fn delete_command_rule(state: State<'_, AppState>, rule: String) -> Result<Settings> {
    let mut settings = state.settings();
    settings.command_rules.retain(|entry| entry != &rule);
    config::save_settings(&state.settings_path, &settings)?;
    state.set_settings(settings.clone());
    Ok(settings)
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
    let session = state.db.get_session(&session_id)?;
    let Some(base) = state.db.session_base_commit(&session_id)? else {
        return Ok(Vec::new());
    };
    let shadow = open_shadow(&state, &session.project_id)?;
    shadow.changes_since(&base)
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
    let (old_content, additions, deletions, status) = match base {
        Some(base) => {
            let shadow = open_shadow(&state, &session.project_id)?;
            let old = shadow.file_at(&base, &path).unwrap_or_default();
            let change = shadow
                .changes_since(&base)?
                .into_iter()
                .find(|change| change.path == path);
            (
                old,
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
        if let Ok(changes) = get_session_changes_inner(&state, &session_id) {
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

fn get_session_changes_inner(state: &AppState, session_id: &str) -> Result<Vec<FileChange>> {
    let session = state.db.get_session(session_id)?;
    let Some(base) = state.db.session_base_commit(session_id)? else {
        return Ok(Vec::new());
    };
    let shadow = open_shadow(state, &session.project_id)?;
    shadow.changes_since(&base)
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
    Ok(RevertResult {
        prompt: message.content,
        restored_files: restored,
    })
}

#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    session_id: String,
    content: String,
    model: String,
    reasoning_effort: Option<String>,
    provider: Option<String>,
    attachments: Option<Vec<Attachment>>,
    channel: Channel<RoutedEvent>,
) -> Result<Message> {
    let attachments = attachments.unwrap_or_default();
    let settings = state.settings();
    let api_key = config::get_api_key(config::OPENROUTER_PROVIDER)?
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| AppError::msg("No OpenRouter API key configured. Add one in Settings."))?;

    let session = state.db.get_session(&session_id)?;
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
        .or_else(|| settings.default_reasoning_effort.clone());
    let selected_provider = provider
        .filter(|value| !value.trim().is_empty())
        .or_else(|| session.provider.clone())
        .map(|value| resolve_provider_preset(&state, &model, value));

    let shadow = Arc::new(ShadowRepo::open(
        &state.data_dir,
        &project.id,
        &project_root,
    )?);
    let base_commit = shadow.snapshot(&format!("before: {}", truncate_title(&content)))?;

    let user_message = state.db.append_message(
        &session_id,
        NewMessage::user(&content, Some(&base_commit), &attachments),
    )?;

    if session.title == DEFAULT_SESSION_TITLE {
        let title = truncate_title(&user_message.content);
        if !title.trim().is_empty() {
            state
                .db
                .update_session(&session_id, Some(&title), None, None, None, None)?;
        }
    }

    let mut system_prompt = session
        .system_prompt
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| settings.default_system_prompt.clone());

    for (enabled, prompt) in [
        (
            settings.security_system_prompt_enabled,
            &settings.security_system_prompt,
        ),
        (
            settings.testing_system_prompt_enabled,
            &settings.testing_system_prompt,
        ),
        (
            settings.architecture_system_prompt_enabled,
            &settings.architecture_system_prompt,
        ),
    ] {
        if enabled && !prompt.trim().is_empty() {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(prompt);
        }
    }

    for prompt in &settings.user_system_prompts {
        if prompt.enabled && !prompt.prompt.trim().is_empty() {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(&prompt.prompt);
        }
    }

    let rules = collect_project_rules(&state, &project.id, Some(&session_id)).unwrap_or_default();
    if !rules.is_empty() {
        system_prompt.push_str("\n\n# Project rules\n");
        system_prompt.push_str(
            "The following rule files apply to this project. The most specific file is listed last and wins on conflict.\n",
        );
        for rule in &rules {
            system_prompt.push_str(&format!(
                "\n## {} ({})\n{}\n",
                rule.scope, rule.path, rule.content
            ));
        }
    }

    let fallback_pricing = state
        .cached_models()
        .and_then(|models| models.into_iter().find(|entry| entry.id == model))
        .map(|entry| {
            (
                entry.prompt_price_per_m / 1_000_000.0,
                entry.completion_price_per_m / 1_000_000.0,
            )
        });

    let cancel = state.register_cancel(&session_id);
    let request = TurnRequest {
        api_key,
        model: model.clone(),
        reasoning_effort: reasoning,
        provider: selected_provider,
        system_prompt,
        session_id: session_id.clone(),
        project_id: project.id.clone(),
        depth: 0,
        project_root,
        extra_folders: settings.extra_folders.iter().map(PathBuf::from).collect(),
        command_rules: settings.command_rules.clone(),
        allowed_websites: settings.allowed_websites.clone(),
        denied_websites: settings.denied_websites.clone(),
        context_message_limit: settings.context_message_limit,
        fallback_pricing,
        base_commit,
        cancel,
    };
    let deps = TurnDeps {
        db: state.db.clone(),
        shadow,
        processes: state.processes.clone(),
        broker: state.broker.clone(),
        questions: state.questions.clone(),
        permissions: state.permissions.clone(),
        client: state.provider(),
        http: state.http.clone(),
    };

    let sink: EventSink = {
        let channel = channel.clone();
        Arc::new(move |event: RoutedEvent| {
            let _ = channel.send(event);
        })
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
            let session = state.db.get_session(&session_id)?;
            if let Some(error) = turn.error {
                send(StreamEvent::Error {
                    message: error.clone(),
                });
                return Err(AppError::msg(error));
            }
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
