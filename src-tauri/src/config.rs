use crate::error::Result;
use crate::models::CommandRule;
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
- Use question to ask the user when you are blocked on a decision, need a preference, or requirements are ambiguous. Prefer this over ending your turn with an open question: provide concise options when a small set of choices fits, and the user can always type a custom answer. When you have a preferred option, put it first and append the literal text "(Recommendation)" to the end of its label, with a short description explaining why.
- Long-running commands are moved to the background automatically; tell the user they can stop them from the running processes indicator.
- Some tool calls require user approval. Give such calls a one-sentence reason argument explaining why you need them; the user sees it in the approval prompt. If a tool is denied, do not retry it; adapt or ask the user.

Guidelines:
- Explain briefly what changed and why after making changes.
- Respect the project's existing conventions, tooling and style.
- Never run destructive commands (rm, deletes, database drops, force pushes) without approval; pumr enforces this.
- Ask for clarification when requirements are ambiguous instead of guessing.
- Before reporting a task as complete, verify it: run the project's build, tests or lint when they exist, and state exactly what you ran and the outcome. Report what passed, what failed and what you could not verify; never claim success you have not checked.
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

pub fn default_verifier_prompt() -> String {
    r#"# Verification

You are a read-only verifier. Do not modify code, configuration or documentation — the write and edit tools are disabled. Your job is to produce trustworthy evidence about whether a change actually works.

- Identify the project's verification contract before guessing commands: read the rule files, README, package manifest scripts and CI configuration.
- Prefer the project's single build/test entry point when one exists; run the narrowest check that covers the change first, then the full applicable set.
- Run the commands yourself and capture real output. Never infer success from reading source.
- Report each check as PASS (ran and succeeded), FAIL (ran and failed), BLOCKED (could not run — say why) or NOT_RUN (skipped — say why). Never claim a check passed when it was not run.
- Lead with the outcome, then the exact commands and relevant output. Name the likely cause of any failure."#
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
    /// Keeps the read tools and `bash` but disables `write`/`edit`, so the
    /// agent can reproduce and verify behaviour without changing the project.
    #[serde(default)]
    pub read_only: bool,
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
            read_only: false,
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
            read_only: false,
            builtin: true,
        },
        Mode {
            id: "verification".to_string(),
            name: "Verification".to_string(),
            description:
                "Verifies a change without modifying it: reproduces behaviour, runs the project's build and tests, and reports PASS/FAIL/BLOCKED evidence."
                    .to_string(),
            system_prompt: default_verifier_prompt(),
            user_prompt_ids: Vec::new(),
            mcp_servers: Vec::new(),
            skills: Vec::new(),
            include_global_prompts: true,
            include_project_rules: true,
            plan_only: false,
            read_only: true,
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
            read_only: false,
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
    /// Schema version of the settings file. Missing means 0 (pre-versioning),
    /// which lets `load_settings` migrate older files exactly once.
    pub settings_version: u32,
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
    #[serde(flatten)]
    pub window: WindowSettings,
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
    pub openrouter_base_url: String,
    pub default_model: Option<String>,
    pub handover_model: Option<String>,
    pub default_reasoning_effort: Option<String>,
    pub favorite_models: Vec<String>,
    /// Remembered provider/routing selection per model id, so the composer can
    /// restore a model's provider choice (e.g. "auto:throughput") when it is
    /// selected again.
    pub provider_by_model: std::collections::BTreeMap<String, String>,
    pub context_message_limit: usize,
    /// Maximum number of consecutive model turns that may request tool calls
    /// before the agent pauses. Acts as a safety valve against runaway loops.
    pub max_tool_iterations: usize,
    /// When enabled, the agent automatically continues past the tool-iteration
    /// limit for all sessions instead of pausing and asking the user.
    pub auto_continue_all_sessions: bool,
    /// Model used for subagents. Empty falls back to the session's model.
    pub subagent_model: Option<String>,
    /// Model used to summarise trimmed history (compaction). Empty falls back
    /// to the session's model.
    pub compaction_model: Option<String>,
    /// Reserved for model-generated session titles. Empty falls back to the
    /// session's model.
    pub title_model: Option<String>,
    /// Whether to mark the stable prompt prefix as cacheable. OpenRouter
    /// forwards the marker to providers that support prompt caching.
    pub prompt_caching: bool,
}

impl Default for ModelSettings {
    fn default() -> Self {
        Self {
            openrouter_base_url: crate::providers::openrouter::DEFAULT_BASE_URL.to_string(),
            default_model: None,
            handover_model: None,
            default_reasoning_effort: Some("medium".to_string()),
            favorite_models: Vec::new(),
            provider_by_model: std::collections::BTreeMap::new(),
            context_message_limit: 40,
            max_tool_iterations: 35,
            auto_continue_all_sessions: false,
            subagent_model: None,
            compaction_model: None,
            title_model: None,
            prompt_caching: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PermissionSettings {
    pub extra_folders: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_command_allows")]
    pub command_rules: Vec<CommandRule>,
    #[serde(default, deserialize_with = "deserialize_command_denies")]
    pub denied_command_rules: Vec<CommandRule>,
    pub allowed_websites: Vec<String>,
    pub denied_websites: Vec<String>,
    /// Default action of the primary allow button per prompt category.
    pub permission_defaults: PermissionDefaults,
    /// Automatic approvals that skip the prompt for recognizable safe work.
    /// They never bypass the dangerous, outside-project, sensitive-file or
    /// shell-substitution checks, which still ask.
    pub auto_approve_read_only: bool,
    pub auto_approve_package_scripts: bool,
    pub auto_approve_project_executables: bool,
    pub auto_approve_project_commands: bool,
    pub ignore_gitignored: bool,
    pub scan_generated_files: bool,
    pub ignore_local_databases: bool,
    pub ignore_env_files: bool,
    pub file_ignore_exemptions: Vec<String>,
    pub file_ignore_disabled: Vec<String>,
    pub file_ignore_enabled: Vec<String>,
    pub file_ignore_advanced: bool,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StoredCommandRule {
    Typed(CommandRule),
    Legacy(String),
}

fn deserialize_command_allows<'de, D>(deserializer: D) -> std::result::Result<Vec<CommandRule>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // Legacy allows did not preserve matching intent and must be reapproved.
    Ok(Vec::<StoredCommandRule>::deserialize(deserializer)?
        .into_iter()
        .filter_map(|rule| match rule {
            StoredCommandRule::Typed(rule) => Some(rule),
            StoredCommandRule::Legacy(_) => None,
        })
        .collect())
}

fn deserialize_command_denies<'de, D>(deserializer: D) -> std::result::Result<Vec<CommandRule>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Vec::<StoredCommandRule>::deserialize(deserializer)?
        .into_iter()
        .map(|rule| match rule {
            StoredCommandRule::Typed(rule) => rule,
            StoredCommandRule::Legacy(value) => CommandRule::Glob(value),
        })
        .collect())
}

impl Default for PermissionSettings {
    fn default() -> Self {
        Self {
            extra_folders: Vec::new(),
            command_rules: Vec::new(),
            denied_command_rules: Vec::new(),
            allowed_websites: Vec::new(),
            denied_websites: Vec::new(),
            permission_defaults: PermissionDefaults::default(),
            auto_approve_read_only: true,
            auto_approve_package_scripts: true,
            auto_approve_project_executables: true,
            // opencode-style default: any non-dangerous command whose paths stay
            // inside the project runs without asking. Dangerous programs,
            // sensitive files, outside-project paths and shell substitution
            // still always ask.
            auto_approve_project_commands: true,
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

/// Default action used by the primary "allow" button in a permission prompt.
/// `once` focuses the single-use grant, `session` focuses the grant that is
/// remembered for the rest of the chat/app session. Stored as `"once"` or
/// `"session"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PermissionDefaults {
    pub website: String,
    pub command: String,
    pub folder: String,
}

impl Default for PermissionDefaults {
    fn default() -> Self {
        Self {
            website: "once".to_string(),
            command: "session".to_string(),
            folder: "session".to_string(),
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
    /// Defer large MCP tool schemas behind `tool_search`/`mcp_invoke` instead of
    /// inlining them for every request. Falls back to inlining when the schemas
    /// are small relative to the model's context window.
    pub mcp_progressive_disclosure: bool,
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
            mcp_progressive_disclosure: true,
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

pub fn default_new_session_hotkey() -> String {
    format!("{}+T", default_hotkey_modifier())
}

pub fn default_delete_session_hotkey() -> String {
    format!("{}+W", default_hotkey_modifier())
}

pub fn default_window_toggle_hotkey() -> String {
    format!("{}+Shift+Space", default_hotkey_modifier())
}

/// Action applied when the window toggle shortcut is pressed while pumr is
/// already focused.
pub const WINDOW_TOGGLE_HIDE: &str = "hide";
pub const WINDOW_TOGGLE_MINIMIZE: &str = "minimize";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InterfaceSettings {
    pub keep_awake: bool,
    pub tabs_multiline: bool,
    pub paste_word_limit: usize,
    pub open_tab_hotkey: String,
    pub close_tab_hotkey: String,
    pub new_session_hotkey: String,
    pub delete_session_hotkey: String,
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
            new_session_hotkey: default_new_session_hotkey(),
            delete_session_hotkey: default_delete_session_hotkey(),
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

/// Window summoning / Quake-mode behaviour. Disabled by default so pumr never
/// claims a system-wide shortcut unless the user opts in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowSettings {
    /// Whether the global window-toggle shortcut is registered.
    pub window_toggle_enabled: bool,
    /// Canonical global shortcut string, e.g. `Cmd+Shift+F2`.
    pub window_toggle_hotkey: String,
    /// What to do when the shortcut is pressed while pumr is focused:
    /// `hide` or `minimize`.
    pub window_toggle_action: String,
    /// Whether the summoned window fills the active monitor.
    pub window_toggle_maximize: bool,
    /// Interface zoom / display scaling, where `1.0` is 100%.
    pub zoom: f64,
}

impl Default for WindowSettings {
    fn default() -> Self {
        Self {
            window_toggle_enabled: false,
            window_toggle_hotkey: default_window_toggle_hotkey(),
            window_toggle_action: WINDOW_TOGGLE_HIDE.to_string(),
            window_toggle_maximize: false,
            zoom: default_zoom(),
        }
    }
}

/// Default interface zoom (100%).
pub fn default_zoom() -> f64 {
    1.0
}

/// Zoom bounds shared with the frontend so scaling stays usable.
pub const ZOOM_MIN: f64 = 0.5;
pub const ZOOM_MAX: f64 = 2.0;

/// Coerces a persisted zoom value into the supported range, falling back to
/// 100% for corrupt or non-numeric values.
pub fn clamp_zoom(zoom: f64) -> f64 {
    if !zoom.is_finite() {
        return default_zoom();
    }
    zoom.clamp(ZOOM_MIN, ZOOM_MAX)
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
    if migrate_settings(&mut settings) {
        let _ = save_settings(path, &settings);
    }
    merge_default_user_system_prompts(&mut settings);
    merge_default_modes(&mut settings);
    settings
}

/// One-time settings migrations, keyed by `settings_version`. Returns true when
/// a migration ran and the file should be rewritten.
fn migrate_settings(settings: &mut Settings) -> bool {
    if settings.settings_version >= 1 {
        return false;
    }
    // Version 1: opencode-style permission defaults. Normal in-project commands
    // stop asking (dangerous programs, sensitive files, outside-project paths
    // and shell substitution still do), and the focused allow button grants the
    // chat/session scope so one keystroke stops repeat prompts.
    settings.settings_version = 1;
    settings.permissions.auto_approve_project_commands = true;
    settings.permissions.permission_defaults.command = "session".to_string();
    settings.permissions.permission_defaults.folder = "session".to_string();
    true
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
        std::fs::write(&path, serde_json::to_string_pretty(keys)?)?;
        // The dev store holds plaintext keys; keep it readable only by the user.
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn command_rule_migration_through_flattened_settings_preserves_other_fields() {
        let exact = json!({"kind": "exact", "value": "pnpm test '*'"});
        let glob = json!({"kind": "glob", "value": "pnpm *"});
        for (allows, denies, expected_allows, expected_denies) in [
            (
                json!(["pnpm *", "pnpm build"]),
                json!(["rm *"]),
                json!([]),
                json!([{"kind": "glob", "value": "rm *"}]),
            ),
            (
                json!(["old *", exact, glob]),
                json!([exact, "rm *", glob]),
                json!([exact, glob]),
                json!([exact, {"kind": "glob", "value": "rm *"}, glob]),
            ),
            (
                json!([exact, glob]),
                json!([glob, exact]),
                json!([exact, glob]),
                json!([glob, exact]),
            ),
        ] {
            let mut original = serde_json::to_value(Settings::default()).unwrap();
            original["defaultSystemPrompt"] = json!("Custom prompt");
            original["language"] = json!("de");
            original["theme"] = json!("custom");
            original["mcpFolders"] = json!(["/custom/mcp"]);
            original["extraFolders"] = json!(["/custom/files"]);
            original["allowedWebsites"] = json!(["*.example.com"]);
            original["deniedWebsites"] = json!(["ads.example.com"]);
            original["commandRules"] = allows;
            original["deniedCommandRules"] = denies;
            let migrated: Settings = serde_json::from_value(original.clone()).unwrap();
            original["commandRules"] = expected_allows;
            original["deniedCommandRules"] = expected_denies;
            let serialized = serde_json::to_value(&migrated).unwrap();
            assert_eq!(serialized, original);
            let roundtrip: Settings = serde_json::from_value(serialized.clone()).unwrap();
            assert_eq!(serde_json::to_value(roundtrip).unwrap(), serialized);
        }
    }

    #[test]
    fn missing_command_rule_fields_keep_settings_defaults() {        for input in [
            json!({"theme": "custom"}),
            json!({"theme": "custom", "commandRules": ["pnpm *"]}),
            json!({"theme": "custom", "deniedCommandRules": ["rm *"]}),
        ] {
            let settings: Settings = serde_json::from_value(input.clone()).unwrap();
            assert!(settings.permissions.command_rules.is_empty());
            assert_eq!(settings.appearance.theme, "custom");
            let expected = if input.get("deniedCommandRules").is_some() {
                vec![CommandRule::Glob("rm *".into())]
            } else {
                Vec::new()
            };
            assert_eq!(settings.permissions.denied_command_rules, expected);
            assert!(settings.permissions.ignore_gitignored);
        }
    }

    #[test]
    fn version_zero_settings_migrate_to_opencode_style_defaults_once() {
        let mut settings = Settings::default();
        settings.permissions.auto_approve_project_commands = false;
        settings.permissions.permission_defaults.command = "once".to_string();
        settings.permissions.permission_defaults.folder = "once".to_string();

        assert!(migrate_settings(&mut settings));
        assert_eq!(settings.settings_version, 1);
        assert!(settings.permissions.auto_approve_project_commands);
        assert_eq!(settings.permissions.permission_defaults.command, "session");
        assert_eq!(settings.permissions.permission_defaults.folder, "session");
        // Websites keep the single-use default.
        assert_eq!(settings.permissions.permission_defaults.website, "once");

        // The migration runs exactly once, so an explicit opt-out afterwards
        // is never flipped back.
        settings.permissions.auto_approve_project_commands = false;
        settings.permissions.permission_defaults.command = "once".to_string();
        assert!(!migrate_settings(&mut settings));
        assert!(!settings.permissions.auto_approve_project_commands);
        assert_eq!(settings.permissions.permission_defaults.command, "once");
    }

    #[test]
    fn load_settings_migrates_version_zero_files_and_rewrites_them() {
        let unique = format!(
            "pumr-config-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        // A pre-versioning file: no settingsVersion, old defaults materialised.
        let mut stored = serde_json::to_value(Settings::default()).unwrap();
        stored.as_object_mut().unwrap().remove("settingsVersion");
        stored["autoApproveProjectCommands"] = json!(false);
        stored["permissionDefaults"] = json!({"website": "once", "command": "once", "folder": "once"});
        std::fs::write(&path, serde_json::to_string_pretty(&stored).unwrap()).unwrap();

        let settings = load_settings(&path);
        assert_eq!(settings.settings_version, 1);
        assert!(settings.permissions.auto_approve_project_commands);
        assert_eq!(settings.permissions.permission_defaults.command, "session");
        assert_eq!(settings.permissions.permission_defaults.folder, "session");

        // The migrated file was persisted, so reloading does not migrate again.
        let reloaded: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(reloaded["settingsVersion"], json!(1));

        std::fs::remove_dir_all(&dir).ok();
    }
}
