use crate::error::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const KEYRING_SERVICE: &str = "pumr";
pub const OPENROUTER_PROVIDER: &str = "openrouter";

pub fn default_system_prompt() -> String {
    r#"You are pumr, an agentic coding assistant running locally on the user's machine.

You help with software engineering tasks in the user's active project. You are precise, pragmatic and terse. Prefer the smallest correct change over broad rewrites.

Tools:
- Use read, glob and grep to inspect the codebase before changing anything. Never invent file contents or APIs.
- Use edit for targeted changes (exact string replacement) and write only for new files or full rewrites.
- Use bash to run tests, builds and git commands. Prefer project scripts (pnpm/npm scripts) over ad-hoc commands.
- Use webfetch to read a specific URL and websearch to look things up on the web. The user must approve every new website; if a website is denied, do not retry it.
- Use task to spawn subagents for independent work in parallel. Give each subagent a complete, self-contained prompt: it cannot see this conversation. Multiple task calls in one turn run concurrently. Prefer doing the work yourself for small tasks.
- Use question to ask the user when you are blocked on a decision, need a preference, or requirements are ambiguous. Prefer this over ending your turn with an open question: provide concise options when a small set of choices fits, and the user can always type a custom answer.
- Long-running commands are moved to the background automatically; tell the user they can stop them from the running processes indicator.
- Some tool calls require user approval. If a tool is denied, do not retry it; adapt or ask the user.

Guidelines:
- Explain briefly what changed and why after making changes.
- Respect the project's existing conventions, tooling and style.
- Never run destructive commands (rm, deletes, database drops, force pushes) without approval; pumr enforces this.
- Ask for clarification when requirements are ambiguous instead of guessing.
- Format code in fenced blocks with the correct language tag."#
        .to_string()
}

pub fn default_security_prompt() -> String {
    r#"# Security best practices

- Never hardcode secrets, API keys, tokens or passwords in source code. Use environment variables or the project's secret management and document required variables.
- Validate and sanitize all external input at the trust boundary, and use parameterized queries instead of string-concatenated SQL.
- Follow the principle of least privilege for file access, network calls, credentials and permissions.
- Avoid adding new dependencies for trivial functionality; prefer the standard library and already-vendored packages.
- Do not weaken existing security controls (TLS verification, authentication, authorization checks, sandboxing) to make a task easier. If a trade-off is truly necessary, call it out explicitly.
- When you find a vulnerability, explain the risk and propose a minimal, safe fix rather than a broad rewrite."#
        .to_string()
}

pub fn default_testing_prompt() -> String {
    r#"# Testing

- Add or update tests for every behavior change and make sure the existing suite still passes.
- Write focused tests that assert observable behavior rather than implementation details.
- Cover the important paths: the happy path, boundary values and error/failure cases.
- Prefer deterministic tests. Do not rely on wall-clock time, network access or shared mutable state unless strictly required.
- Keep tests readable and maintainable by using the project's existing test framework, naming and helpers.
- Run the relevant tests before reporting a task as complete and state which tests you ran."#
        .to_string()
}

pub fn default_architecture_prompt() -> String {
    r#"# Software architecture

- Respect the existing architecture and module boundaries. Do not introduce a parallel pattern for a problem that is already solved.
- Keep responsibilities separated and dependencies pointing in the established direction.
- Prefer small, cohesive units with explicit interfaces over large, tightly coupled ones.
- Avoid speculative abstractions and premature generalization. Add indirection only when there is a concrete, present need.
- When a change requires an architectural decision, explain the trade-offs and pick the option that is simplest to maintain.
- Keep cross-cutting concerns (logging, errors, configuration) consistent with existing conventions."#
        .to_string()
}

pub fn default_ui_ux_prompt() -> String {
    r#"# UI/UX design

- Start from the user's goal and the existing design language. Match the components, spacing, typography and color tokens already used in the project.
- Prefer clear hierarchy, generous whitespace and consistent alignment over decoration. Every element should earn its place.
- Design the full range of states: empty, loading, error, disabled, hover, focus and success. Never ship only the happy path.
- Make interactions predictable and accessible: keyboard navigation, visible focus, sufficient contrast, correct semantics/ARIA roles and never rely on color alone.
- Keep copy short, concrete and action-oriented; label controls with what they do.
- Reuse existing components before introducing new ones. If a new pattern is unavoidable, keep it small, composable and consistent.
- When a design decision is ambiguous, use the question tool to confirm intent (audience, tone, density, target platform) instead of guessing."#
        .to_string()
}

pub fn default_code_review_prompt() -> String {
    r#"# Code review

Review the requested changes and report findings. Do not modify code unless the user explicitly asks you to fix something.

- Group findings by severity: Critical, High, Medium, Low. For each finding give the exact location (file:line), the concrete impact and an actionable explanation.
- Critical/High: correctness bugs, security issues, data loss, crashes and broken contracts.
- Medium: maintainability, performance, missing tests, error handling and unhandled edge cases.
- Low: naming, style, documentation and minor polish.
- Be specific. Cite the code and, where useful, a minimal suggested change. Do not pad the review with praise or restate the diff.

After presenting the findings, ask the user what to do about each issue using the question tool. For every finding offer the options "Fix it", "Skip" and "Explain in more detail" — the user can always type their own answer. Ask about one finding at a time and wait for the answer before moving on. Only start fixing once the user confirms."#
        .to_string()
}

pub fn default_documentation_writer_prompt() -> String {
    r#"# Documentation writer

- If the user has not specified exactly what to document (which files, symbols, audience or format), ask with the question tool before writing. Do not guess the scope.
- Identify the intended audience (end users, contributors or API consumers) and match the level of detail and tone to it.
- Read the actual code and existing docs first. Document real behavior, never assumptions. Do not invent parameters, return values or side effects.
- Actively look for edge cases, error conditions, defaults and anything you are unsure about, and ask the user to confirm them with the question tool instead of documenting a guess.
- Cover purpose, usage examples, parameters, return values, errors, side effects and constraints.
- Keep documentation close to the code it describes, follow the project's existing documentation style and keep examples runnable."#
        .to_string()
}

pub fn default_bugfixer_prompt() -> String {
    r#"# Bugfixer

- Before changing anything, reproduce the bug and gather evidence (stack traces, logs, failing tests, minimal inputs). Do not guess at the cause.
- If the report is vague or you cannot reproduce it, use the question tool to pinpoint the bug: ask for exact steps, expected vs actual behavior, environment/version, recent changes and any error output. Ask follow-up questions until the reproduction is clear.
- Once you have a hypothesis, confirm it with the smallest possible check before editing. If you cannot find the bug directly, switch to systematic debugging: bisect the code path, add temporary logging or a failing test, inspect state at each step and narrow down the cause instead of changing code speculatively.
- Fix the root cause, not the symptom. Keep the change minimal and add a regression test that fails before and passes after the fix.
- Explain what the bug was, why it happened and why the fix is correct. Call out related code paths that might have the same defect."#
        .to_string()
}

pub fn default_planning_prompt() -> String {
    r#"# Planning mode

You are in planning mode. Do NOT implement anything yet. The write and edit tools are disabled, and you must not run commands that modify the project.

Work with the user to turn the request into a concrete, agreed implementation plan:

- Inspect the codebase first with read, glob, grep, ls and read-only shell commands so the plan is grounded in the real code. Never invent files, APIs or behavior.
- Use the question tool whenever requirements, scope, constraints or trade-offs are ambiguous. Ask instead of guessing, and offer concrete options when a small set fits.
- Lay out the affected areas, the exact files that will change and what each change does, in the order you would make them.
- Call out trade-offs, edge cases, risks, migration concerns and how each step will be verified (tests, manual checks).
- Keep refining the plan with the user until they agree. When the plan is ready, summarize it and remind the user to switch to a mode that allows implementation to proceed.

Do not produce code changes, diffs or file writes in this mode — only analysis and the plan."#
        .to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mode {
    pub id: String,
    pub name: String,
    /// Short description shown in the modes panel and the composer picker.
    #[serde(default)]
    pub description: String,
    /// Extra system prompt appended when this mode is active.
    #[serde(default)]
    pub system_prompt: String,
    /// Ids of `user_system_prompts` that this mode pulls in.
    #[serde(default)]
    pub user_prompt_ids: Vec<String>,
    /// MCP servers to connect automatically while this mode is active.
    #[serde(default)]
    pub mcp_servers: Vec<String>,
    /// Skills whose instructions are loaded automatically while this mode is active.
    #[serde(default)]
    pub skills: Vec<String>,
    /// Whether the globally enabled built-in and user prompts apply in this mode.
    #[serde(default)]
    pub include_global_prompts: bool,
    /// Whether project rule files (AGENTS.md) are appended in this mode.
    #[serde(default)]
    pub include_project_rules: bool,
    /// Disables the write/edit tools so the agent can only plan.
    #[serde(default)]
    pub plan_only: bool,
    #[serde(default)]
    pub builtin: bool,
}

pub const DEFAULT_MODE_ID: &str = "coding";

pub fn default_modes() -> Vec<Mode> {
    vec![
        Mode {
            id: "coding".to_string(),
            name: "Coding".to_string(),
            description:
                "Full coding mode. The main system prompt is combined with the system prompts you have activated, project rules, MCP servers and skills."
                    .to_string(),
            system_prompt: String::new(),
            user_prompt_ids: Vec::new(),
            mcp_servers: Vec::new(),
            skills: Vec::new(),
            include_global_prompts: true,
            include_project_rules: true,
            plan_only: false,
            builtin: true,
        },
        Mode {
            id: "planning".to_string(),
            name: "Planning".to_string(),
            description:
                "Plans a feature together with you and produces an implementation plan. Cannot write or edit files."
                    .to_string(),
            system_prompt: default_planning_prompt(),
            user_prompt_ids: Vec::new(),
            mcp_servers: Vec::new(),
            skills: Vec::new(),
            include_global_prompts: true,
            include_project_rules: true,
            plan_only: true,
            builtin: true,
        },
        Mode {
            id: "nacked".to_string(),
            name: "Nacked".to_string(),
            description:
                "Fast mode. Uses only the main system prompt — no activated prompts, project rules, MCP servers or skills."
                    .to_string(),
            system_prompt: String::new(),
            user_prompt_ids: Vec::new(),
            mcp_servers: Vec::new(),
            skills: Vec::new(),
            include_global_prompts: false,
            include_project_rules: false,
            plan_only: false,
            builtin: true,
        },
    ]
}

/// Looks up the mode for a session, falling back to the default coding mode and
/// finally to the first configured mode. Always returns a usable mode.
pub fn resolve_mode(settings: &Settings, mode_id: Option<&str>) -> Mode {
    let requested = mode_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| settings.modes.default_mode_id.trim());
    let id = if requested.is_empty() {
        DEFAULT_MODE_ID
    } else {
        requested
    };
    settings
        .modes
        .modes
        .iter()
        .find(|mode| mode.id == id)
        .or_else(|| {
            settings
                .modes
                .modes
                .iter()
                .find(|mode| mode.id == DEFAULT_MODE_ID)
        })
        .cloned()
        .unwrap_or_else(|| default_modes().into_iter().next().unwrap())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSystemPrompt {
    pub id: String,
    pub name: String,
    pub prompt: String,
    #[serde(default)]
    pub enabled: bool,
}

pub fn default_user_system_prompts() -> Vec<UserSystemPrompt> {
    vec![
        UserSystemPrompt {
            id: "ui-ux-designing".to_string(),
            name: "UI/UX Designing".to_string(),
            prompt: default_ui_ux_prompt(),
            enabled: false,
        },
        UserSystemPrompt {
            id: "code-review".to_string(),
            name: "Code Review".to_string(),
            prompt: default_code_review_prompt(),
            enabled: false,
        },
        UserSystemPrompt {
            id: "documentation-writer".to_string(),
            name: "Documentation Writer".to_string(),
            prompt: default_documentation_writer_prompt(),
            enabled: false,
        },
        UserSystemPrompt {
            id: "bugfixer".to_string(),
            name: "Bugfixer".to_string(),
            prompt: default_bugfixer_prompt(),
            enabled: false,
        },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomTheme {
    pub scheme: String,
    pub ink: String,
    pub navy: String,
    pub accent: String,
    pub mist: String,
    pub white: String,
}

impl Default for CustomTheme {
    fn default() -> Self {
        Self {
            scheme: "light".to_string(),
            ink: "#fbf1c7".to_string(),
            navy: "#ebdbb2".to_string(),
            accent: "#458588".to_string(),
            mist: "#504945".to_string(),
            white: "#050505".to_string(),
        }
    }
}

/// User settings, grouped by concern. Groups are `#[serde(flatten)]`ed so the
/// on-disk/JSON shape stays flat (and the frontend contract is unchanged).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    #[serde(flatten)]
    pub prompts: PromptSettings,
    #[serde(flatten)]
    pub modes: ModeSettings,
    #[serde(flatten)]
    pub model: ModelSettings,
    #[serde(flatten)]
    pub permissions: PermissionSettings,
    #[serde(flatten)]
    pub integrations: IntegrationSettings,
    #[serde(flatten)]
    pub appearance: AppearanceSettings,
    #[serde(flatten)]
    pub interface: InterfaceSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PromptSettings {
    pub default_system_prompt: String,
    pub security_system_prompt_enabled: bool,
    pub security_system_prompt: String,
    pub testing_system_prompt_enabled: bool,
    pub testing_system_prompt: String,
    pub architecture_system_prompt_enabled: bool,
    pub architecture_system_prompt: String,
    pub user_system_prompts: Vec<UserSystemPrompt>,
}

impl Default for PromptSettings {
    fn default() -> Self {
        Self {
            default_system_prompt: default_system_prompt(),
            security_system_prompt_enabled: false,
            security_system_prompt: default_security_prompt(),
            testing_system_prompt_enabled: false,
            testing_system_prompt: default_testing_prompt(),
            architecture_system_prompt_enabled: false,
            architecture_system_prompt: default_architecture_prompt(),
            user_system_prompts: default_user_system_prompts(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModeSettings {
    pub modes: Vec<Mode>,
    pub default_mode_id: String,
}

impl Default for ModeSettings {
    fn default() -> Self {
        Self {
            modes: default_modes(),
            default_mode_id: DEFAULT_MODE_ID.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelSettings {
    pub budget_usd: f64,
    pub openrouter_base_url: String,
    pub default_model: Option<String>,
    pub handover_model: Option<String>,
    pub default_reasoning_effort: Option<String>,
    pub favorite_models: Vec<String>,
    pub context_message_limit: usize,
    /// Maximum number of consecutive model turns that may request tool calls
    /// before the agent pauses. Acts as a safety valve against runaway loops.
    pub max_tool_iterations: usize,
    /// When enabled, the agent automatically continues past the tool-iteration
    /// limit for all sessions instead of pausing and asking the user.
    pub auto_continue_all_sessions: bool,
}

impl Default for ModelSettings {
    fn default() -> Self {
        Self {
            budget_usd: 0.0,
            openrouter_base_url: crate::providers::openrouter::DEFAULT_BASE_URL.to_string(),
            default_model: None,
            handover_model: None,
            default_reasoning_effort: Some("medium".to_string()),
            favorite_models: Vec::new(),
            context_message_limit: 40,
            max_tool_iterations: 35,
            auto_continue_all_sessions: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PermissionSettings {
    pub extra_folders: Vec<String>,
    pub command_rules: Vec<String>,
    pub allowed_websites: Vec<String>,
    pub denied_websites: Vec<String>,
    pub ignore_gitignored: bool,
    pub scan_generated_files: bool,
    pub ignore_local_databases: bool,
    pub ignore_env_files: bool,
    pub file_ignore_exemptions: Vec<String>,
    pub file_ignore_disabled: Vec<String>,
    pub file_ignore_enabled: Vec<String>,
    pub file_ignore_advanced: bool,
}

impl Default for PermissionSettings {
    fn default() -> Self {
        Self {
            extra_folders: Vec::new(),
            command_rules: Vec::new(),
            allowed_websites: Vec::new(),
            denied_websites: Vec::new(),
            ignore_gitignored: true,
            scan_generated_files: false,
            ignore_local_databases: false,
            ignore_env_files: true,
            file_ignore_exemptions: Vec::new(),
            file_ignore_disabled: Vec::new(),
            file_ignore_enabled: Vec::new(),
            file_ignore_advanced: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IntegrationSettings {
    pub mcp_auto_discovery: bool,
    pub mcp_folders: Vec<String>,
    pub mcp_disabled: Vec<String>,
    /// Individual servers the user switched off, as `(config path, server name)`
    /// pairs. Lets a single server be hidden without disabling its whole file.
    pub mcp_disabled_servers: Vec<crate::models::McpServerRef>,
    pub skills_auto_discovery: bool,
    pub skill_folders: Vec<String>,
    pub skills_disabled: Vec<String>,
    /// Individual skills the user switched off, as `(root path, skill name)`
    /// pairs. Lets a single skill be hidden without disabling its whole root.
    pub skills_disabled_items: Vec<crate::models::SkillRef>,
    /// Secure default: only show curated/verified marketplace entries and block
    /// installing from unverified sources unless the user opts out.
    pub marketplace_verified_only: bool,
}

impl Default for IntegrationSettings {
    fn default() -> Self {
        Self {
            mcp_auto_discovery: true,
            mcp_folders: Vec::new(),
            mcp_disabled: Vec::new(),
            mcp_disabled_servers: Vec::new(),
            skills_auto_discovery: true,
            skill_folders: Vec::new(),
            skills_disabled: Vec::new(),
            skills_disabled_items: Vec::new(),
            marketplace_verified_only: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppearanceSettings {
    pub language: String,
    pub reply_language: Option<String>,
    pub theme: String,
    pub custom_theme: CustomTheme,
    pub high_contrast: bool,
    pub background: String,
    pub background_image: String,
    pub background_opacity: f64,
    pub background_blur: f64,
    pub glass_opacity: f64,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            language: "en".to_string(),
            reply_language: None,
            theme: "midnight".to_string(),
            custom_theme: CustomTheme::default(),
            high_contrast: false,
            background: String::new(),
            background_image: String::new(),
            background_opacity: 1.0,
            background_blur: 0.0,
            glass_opacity: 1.0,
        }
    }
}

/// The primary shortcut modifier for the current platform: `Cmd` on macOS and
/// `Ctrl` elsewhere.
pub fn default_hotkey_modifier() -> &'static str {
    if cfg!(target_os = "macos") {
        "Cmd"
    } else {
        "Ctrl"
    }
}

pub fn default_open_tab_hotkey() -> String {
    format!("{}+T", default_hotkey_modifier())
}

pub fn default_close_tab_hotkey() -> String {
    format!("{}+W", default_hotkey_modifier())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InterfaceSettings {
    pub keep_awake: bool,
    pub tabs_multiline: bool,
    pub paste_word_limit: usize,
    pub open_tab_hotkey: String,
    pub close_tab_hotkey: String,
    pub sounds_enabled: bool,
    pub sound_volume: f64,
    pub done_sound: String,
    pub permission_sound: String,
    pub error_sound: String,
    pub done_sound_path: String,
    pub permission_sound_path: String,
    pub error_sound_path: String,
}

impl Default for InterfaceSettings {
    fn default() -> Self {
        Self {
            keep_awake: true,
            tabs_multiline: true,
            paste_word_limit: 500,
            open_tab_hotkey: default_open_tab_hotkey(),
            close_tab_hotkey: default_close_tab_hotkey(),
            sounds_enabled: true,
            sound_volume: 0.6,
            done_sound: "chime".to_string(),
            permission_sound: "ping".to_string(),
            error_sound: "alert".to_string(),
            done_sound_path: String::new(),
            permission_sound_path: String::new(),
            error_sound_path: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultSystemPrompts {
    pub default_system_prompt: String,
    pub security_system_prompt: String,
    pub testing_system_prompt: String,
    pub architecture_system_prompt: String,
    pub user_system_prompts: Vec<UserSystemPrompt>,
}

pub fn default_system_prompts() -> DefaultSystemPrompts {
    DefaultSystemPrompts {
        default_system_prompt: default_system_prompt(),
        security_system_prompt: default_security_prompt(),
        testing_system_prompt: default_testing_prompt(),
        architecture_system_prompt: default_architecture_prompt(),
        user_system_prompts: default_user_system_prompts(),
    }
}

pub fn load_settings(path: &Path) -> Settings {
    let mut settings = std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
        .unwrap_or_default();
    merge_default_user_system_prompts(&mut settings);
    merge_default_modes(&mut settings);
    settings
}

/// Built-in user prompts are always available. If a settings file predates a
/// built-in prompt (or lost it), re-add it while keeping any custom prompts and
/// user edits intact.
fn merge_default_user_system_prompts(settings: &mut Settings) {
    for builtin in default_user_system_prompts() {
        if !settings
            .prompts
            .user_system_prompts
            .iter()
            .any(|prompt| prompt.id == builtin.id)
        {
            settings.prompts.user_system_prompts.push(builtin);
        }
    }
}

/// Built-in modes are always available. Re-add any that are missing while
/// keeping user edits and custom modes intact.
fn merge_default_modes(settings: &mut Settings) {
    for builtin in default_modes() {
        match settings
            .modes
            .modes
            .iter_mut()
            .find(|mode| mode.id == builtin.id)
        {
            // Backfill the description of built-in modes added before
            // descriptions existed, without touching user edits.
            Some(existing) if existing.description.trim().is_empty() => {
                existing.description = builtin.description;
            }
            Some(_) => {}
            None => settings.modes.modes.push(builtin),
        }
    }
    if settings.modes.default_mode_id.trim().is_empty()
        || !settings
            .modes
            .modes
            .iter()
            .any(|mode| mode.id == settings.modes.default_mode_id)
    {
        settings.modes.default_mode_id = DEFAULT_MODE_ID.to_string();
    }
}

pub fn save_settings(path: &Path, settings: &Settings) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(settings)?;
    std::fs::write(path, raw)?;
    Ok(())
}

#[cfg(not(all(debug_assertions, target_os = "macos")))]
fn entry(provider: &str) -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(KEYRING_SERVICE, provider)?)
}

#[cfg(not(all(debug_assertions, target_os = "macos")))]
pub fn set_api_key(provider: &str, key: &str) -> Result<()> {
    entry(provider)?.set_password(key)?;
    Ok(())
}

#[cfg(not(all(debug_assertions, target_os = "macos")))]
pub fn get_api_key(provider: &str) -> Result<Option<String>> {
    match entry(provider)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

#[cfg(not(all(debug_assertions, target_os = "macos")))]
pub fn delete_api_key(provider: &str) -> Result<()> {
    match entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.into()),
    }
}

// On macOS, `tauri dev` runs an ad-hoc signed binary whose signature changes on
// every rebuild. macOS records "Always Allow" keychain permissions against that
// signature, so it can never match and the user is prompted on every launch.
// During development we therefore keep API keys in a plain-text file in the app
// data directory instead of the keychain. Release builds always use the keychain.
#[cfg(all(debug_assertions, target_os = "macos"))]
static DEV_KEY_FILE: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

#[cfg(all(debug_assertions, target_os = "macos"))]
pub fn init_dev_store(data_dir: &Path) {
    let _ = DEV_KEY_FILE.set(data_dir.join("dev-api-keys.json"));
}

#[cfg(not(all(debug_assertions, target_os = "macos")))]
pub fn init_dev_store(_data_dir: &Path) {}

#[cfg(all(debug_assertions, target_os = "macos"))]
mod dev_store {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn path() -> PathBuf {
        DEV_KEY_FILE
            .get()
            .cloned()
            .unwrap_or_else(|| std::env::temp_dir().join("pumr-dev-api-keys.json"))
    }

    fn load() -> HashMap<String, String> {
        std::fs::read_to_string(path())
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn save(keys: &HashMap<String, String>) -> Result<()> {
        let path = path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(keys)?)?;
        Ok(())
    }

    pub fn set(provider: &str, key: &str) -> Result<()> {
        let mut keys = load();
        keys.insert(provider.to_string(), key.to_string());
        save(&keys)
    }

    pub fn get(provider: &str) -> Result<Option<String>> {
        if let Some(key) = load().remove(provider) {
            return Ok(Some(key));
        }
        // One-time migration: a key may already live in the OS keychain from an
        // earlier build. Read it and copy it into the dev store so later launches
        // never touch the keychain (and never re-prompt) again.
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, provider) {
            if let Ok(key) = entry.get_password() {
                if !key.trim().is_empty() {
                    let _ = set(provider, &key);
                    return Ok(Some(key));
                }
            }
        }
        Ok(None)
    }

    pub fn delete(provider: &str) -> Result<()> {
        let mut keys = load();
        if keys.remove(provider).is_some() {
            save(&keys)?;
        }
        Ok(())
    }
}

#[cfg(all(debug_assertions, target_os = "macos"))]
pub fn set_api_key(provider: &str, key: &str) -> Result<()> {
    dev_store::set(provider, key)
}

#[cfg(all(debug_assertions, target_os = "macos"))]
pub fn get_api_key(provider: &str) -> Result<Option<String>> {
    dev_store::get(provider)
}

#[cfg(all(debug_assertions, target_os = "macos"))]
pub fn delete_api_key(provider: &str) -> Result<()> {
    dev_store::delete(provider)
}

pub fn has_api_key(provider: &str) -> Result<bool> {
    Ok(get_api_key(provider)?.is_some_and(|key| !key.trim().is_empty()))
}
