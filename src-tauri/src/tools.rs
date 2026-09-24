use crate::broker::{PermissionBroker, PermissionPrompt, QuestionBroker};
use crate::error::{AppError, Result};
use crate::git::{count_line_changes, ignored_paths, GitProbe, ShadowRepo};
use crate::mcp::McpManager;
use crate::models::{
    EventSink, FileChange, QuestionItem, QuestionOption, RoutedEvent, StreamEvent,
};
use crate::permissions::{self, CommandDecision, FileIgnoreConfig, LivePermissions, WebsiteDecision};
use crate::processes::{ProcessRegistry, RunningProcess};
use globset::Glob;
use ignore::WalkBuilder;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const MAX_TOOL_OUTPUT: usize = 30_000;
const BACKGROUND_AFTER_SECONDS: u64 = 10;
const MAX_WEB_BYTES: usize = 2_000_000;
const WEB_TIMEOUT_SECONDS: u64 = 30;
const SEARCH_BASE_URL: &str = "https://html.duckduckgo.com/html/";

pub struct ToolRuntime {
    pub call_id: String,
    pub project_root: PathBuf,
    pub permissions: Arc<LivePermissions>,
    pub file_ignore: Arc<FileIgnoreConfig>,
    pub session_id: String,
    pub shadow: Arc<ShadowRepo>,
    pub processes: Arc<ProcessRegistry>,
    pub broker: Arc<PermissionBroker>,
    pub questions: Arc<QuestionBroker>,
    pub http: reqwest::Client,
    pub mcp: Option<Arc<McpManager>>,
    pub cancel: CancellationToken,
    pub emit: EventSink,
}

impl ToolRuntime {
    pub fn send(&self, event: StreamEvent) {
        (self.emit)(RoutedEvent {
            session_id: self.session_id.clone(),
            event,
        });
    }
}

pub struct ToolOutcome {
    pub result: String,
    pub status: String,
    pub changes: Vec<FileChange>,
}

impl ToolOutcome {
    pub fn ok(result: String) -> Self {
        Self {
            result: truncate(result),
            status: "ok".to_string(),
            changes: Vec::new(),
        }
    }

    pub fn error(result: impl Into<String>) -> Self {
        Self {
            result: truncate(result.into()),
            status: "error".to_string(),
            changes: Vec::new(),
        }
    }

    pub fn cancelled() -> Self {
        Self {
            result: "Command cancelled.".to_string(),
            status: "canceled".to_string(),
            changes: Vec::new(),
        }
    }

    fn denied() -> Self {
        Self {
            result: "The user denied this action.".to_string(),
            status: "denied".to_string(),
            changes: Vec::new(),
        }
    }

    fn denied_with_reason(reason: impl Into<String>) -> Self {
        Self {
            result: reason.into(),
            status: "denied".to_string(),
            changes: Vec::new(),
        }
    }
}

pub fn tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "read",
                "description": "Read a file from the filesystem. Returns line-numbered content.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File path, relative to the project root or absolute" },
                        "offset": { "type": "integer", "description": "1-based line number to start reading from" },
                        "limit": { "type": "integer", "description": "Maximum number of lines to read (default 2000)" }
                    },
                    "required": ["path"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "write",
                "description": "Create or overwrite a file with the given content. Prefer edit for existing files.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File path, relative to the project root or absolute" },
                        "content": { "type": "string", "description": "Full file content" }
                    },
                    "required": ["path", "content"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "edit",
                "description": "Replace an exact string in an existing file. old_string must match exactly and uniquely unless replace_all is true.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File path, relative to the project root or absolute" },
                        "old_string": { "type": "string", "description": "Exact text to replace" },
                        "new_string": { "type": "string", "description": "Replacement text" },
                        "replace_all": { "type": "boolean", "description": "Replace every occurrence" }
                    },
                    "required": ["path", "old_string", "new_string"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "glob",
                "description": "Find files by glob pattern, e.g. '**/*.ts'. Respects .gitignore.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Glob pattern" },
                        "path": { "type": "string", "description": "Directory to search in (default project root)" }
                    },
                    "required": ["pattern"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "grep",
                "description": "Search file contents with a regular expression. Returns path:line: text.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Rust/RE2-style regular expression" },
                        "path": { "type": "string", "description": "Directory to search in (default project root)" },
                        "include": { "type": "string", "description": "Glob filter for file paths, e.g. '*.ts'" }
                    },
                    "required": ["pattern"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "ls",
                "description": "List directory entries.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Directory path (default project root)" }
                    }
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "bash",
                "description": "Run a shell command in the project. Long-running commands (dev servers, watchers) are moved to the background automatically and can be stopped by the user.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "Shell command to run" },
                        "cwd": { "type": "string", "description": "Working directory (default project root)" },
                        "timeout_seconds": { "type": "integer", "description": "Seconds before moving to background (default 10, max 120)" }
                    },
                    "required": ["command"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "webfetch",
                "description": "Fetch a URL and return its readable text. The user must approve each website the first time; remember to explain why you need it.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": { "type": "string", "description": "Absolute http(s) URL to fetch" }
                    },
                    "required": ["url"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "websearch",
                "description": "Search the web (DuckDuckGo) and return result titles, URLs and snippets. Follow up with webfetch to read a promising result.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Search query" },
                        "max_results": { "type": "integer", "description": "Maximum number of results (default 8, max 20)" }
                    },
                    "required": ["query"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "question",
                "description": "Ask the user one or more questions and wait for their answers before continuing. Use this whenever you are blocked on a decision, need a preference, or requirements are ambiguous instead of guessing or ending your turn with an open question. Provide concise options when a small set of choices covers the answer; the user can always type a custom answer. Ask several related questions in one call.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "questions": {
                            "type": "array",
                            "description": "One or more questions shown together in a single prompt.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "header": { "type": "string", "description": "Very short label for the question (a few words)" },
                                    "question": { "type": "string", "description": "The full question to show the user" },
                                    "options": {
                                        "type": "array",
                                        "description": "Suggested answers the user can click. Keep to 2-5 concise options; omit for an open question.",
                                        "items": {
                                            "type": "object",
                                            "properties": {
                                                "label": { "type": "string", "description": "Short answer text" },
                                                "description": { "type": "string", "description": "Optional clarification of what this option means" }
                                            },
                                            "required": ["label"]
                                        }
                                    },
                                    "multiSelect": { "type": "boolean", "description": "Allow selecting more than one option. Defaults to false." }
                                },
                                "required": ["question"]
                            }
                        }
                    },
                    "required": ["questions"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "task",
                "description": "Spawn a subagent to work on a focused task in parallel with the main agent. The subagent has the same tools and project access, runs its own tool loop, and returns a concise report when done. Use this to parallelize independent work (e.g. investigate several areas at once, or offload a self-contained subtask). Multiple task calls in one turn run concurrently.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "description": { "type": "string", "description": "Short 3-5 word name for the subagent, shown in the UI" },
                        "prompt": { "type": "string", "description": "Detailed instructions for the subagent. Include everything it needs; it cannot see this conversation." }
                    },
                    "required": ["description", "prompt"]
                }
            }
        }),
    ]
}

pub async fn execute(runtime: &mut ToolRuntime, name: &str, arguments: &Value) -> ToolOutcome {
    match name {
        "read" => read_file(runtime, arguments).await,
        "write" => write_file(runtime, arguments).await,
        "edit" => edit_file(runtime, arguments).await,
        "glob" => glob_files(runtime, arguments).await,
        "grep" => grep_files(runtime, arguments).await,
        "ls" => list_dir(runtime, arguments).await,
        "bash" => run_bash(runtime, arguments).await,
        "webfetch" => web_fetch(runtime, arguments).await,
        "websearch" => web_search(runtime, arguments).await,
        "question" => ask_question(runtime, arguments).await,
        other if other.starts_with("mcp__") => call_mcp_tool(runtime, other, arguments).await,
        other => ToolOutcome::error(format!("Unknown tool: {other}")),
    }
}

async fn call_mcp_tool(runtime: &mut ToolRuntime, name: &str, arguments: &Value) -> ToolOutcome {
    let Some(manager) = runtime.mcp.clone() else {
        return ToolOutcome::error(format!("MCP tool '{name}' is not available."));
    };
    // MCP tools run server-side and bypass the built-in command gate, so require
    // an explicit user decision before every invocation.
    let preview = serde_json::json!({ "tool": name, "arguments": arguments }).to_string();
    let allowed = runtime
        .broker
        .ask(
            PermissionPrompt {
                kind: "command".to_string(),
                title: format!("Run MCP tool {name}?"),
                detail: "The assistant wants to call an MCP server tool. Review the arguments before allowing."
                    .to_string(),
                command: Some(preview),
                path: None,
                folder: None,
                url: None,
                suggested_rule: None,
                segments: Vec::new(),
                risk: None,
                scope_options: Vec::new(),
            },
            &runtime.cancel,
            &runtime.session_id,
            &runtime.emit,
        )
        .await
        .allowed;
    if !allowed {
        return ToolOutcome::denied();
    }
    match manager.call(name, arguments.clone()).await {
        Ok((text, is_error)) => {
            if is_error {
                ToolOutcome::error(text)
            } else {
                ToolOutcome::ok(text)
            }
        }
        Err(error) => ToolOutcome::error(error.to_string()),
    }
}

/// Presents one or more questions to the user and blocks the tool loop until
/// they answer or skip. The answers are returned as JSON so the model can rely
/// on the structure and the UI can render them from history.
async fn ask_question(runtime: &mut ToolRuntime, arguments: &Value) -> ToolOutcome {
    let Some(items) = arguments.get("questions").and_then(Value::as_array) else {
        return ToolOutcome::error("The question tool requires a non-empty 'questions' array.");
    };

    let mut questions: Vec<QuestionItem> = Vec::new();
    for item in items {
        let question = item
            .get("question")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if question.is_empty() {
            continue;
        }
        let header = item
            .get("header")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let header: String = if header.is_empty() {
            question.chars().take(30).collect()
        } else {
            header.chars().take(60).collect()
        };
        let options = item
            .get("options")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| {
                        let label = entry.get("label").and_then(Value::as_str)?.trim();
                        if label.is_empty() {
                            return None;
                        }
                        Some(QuestionOption {
                            label: label.to_string(),
                            description: entry
                                .get("description")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        questions.push(QuestionItem {
            header,
            question: question.to_string(),
            options,
            multi_select: item
                .get("multiSelect")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
    }

    if questions.is_empty() {
        return ToolOutcome::error("The question tool requires at least one non-empty question.");
    }

    let answers = runtime
        .questions
        .ask(
            questions,
            &runtime.cancel,
            &runtime.session_id,
            &runtime.emit,
        )
        .await;

    let payload = match answers {
        Some(answers) => json!({ "answers": answers, "skipped": false }),
        None => json!({ "answers": [], "skipped": true }),
    };
    ToolOutcome::ok(payload.to_string())
}

fn arg_str(arguments: &Value, key: &str) -> Result<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| AppError::msg(format!("Missing argument '{key}'")))
}

fn relative_display(runtime: &ToolRuntime, path: &Path) -> String {
    if let Ok(relative) = path.strip_prefix(&runtime.project_root) {
        return relative.to_string_lossy().replace('\\', "/");
    }
    for folder in &runtime.permissions.extra_folders() {
        if let Ok(relative) = path.strip_prefix(folder) {
            return relative.to_string_lossy().replace('\\', "/");
        }
    }
    path.to_string_lossy().replace('\\', "/")
}

/// Relative path used for ignore matching, always relative to the project root.
fn ignore_relative(runtime: &ToolRuntime, path: &Path) -> String {
    path.strip_prefix(&runtime.project_root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}

/// Reason the agent should not touch a path, or `None` if it is allowed.
fn file_ignore_reason(runtime: &ToolRuntime, path: &Path) -> Option<&'static str> {
    let relative = ignore_relative(runtime, path);
    let probe = GitProbe {
        project_root: &runtime.project_root,
        shadow: Some(&runtime.shadow),
    };
    let gitignored = !relative.is_empty() && probe.is_ignored(&relative);
    runtime
        .file_ignore
        .ignore_reason(path, &relative, gitignored)
}

async fn ensure_path_access(runtime: &mut ToolRuntime, absolute: &Path, label: &str) -> bool {
    let extra = runtime.permissions.extra_folders();
    if permissions::path_is_inside(absolute, &runtime.project_root, &extra)
        && !permissions::symlink_escapes(absolute, &runtime.project_root, &extra)
    {
        return true;
    }
    let folder = if absolute.is_dir() {
        absolute.to_path_buf()
    } else {
        absolute
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| absolute.to_path_buf())
    };
    runtime
        .broker
        .ask(
            PermissionPrompt {
                kind: "folder".to_string(),
                title: format!("Access {label} outside the project?"),
                detail: format!(
                    "The assistant wants to access {}. Allow once, or add the folder permanently so it never asks again.",
                    absolute.display()
                ),
                command: None,
                path: Some(absolute.display().to_string()),
                folder: Some(folder.display().to_string()),
                url: None,
                suggested_rule: None,
                segments: Vec::new(),
                risk: None,
                scope_options: Vec::new(),
            },
            &runtime.cancel,
            &runtime.session_id,
            &runtime.emit,
        )
        .await
        .allowed
}

async fn ensure_write_access(runtime: &mut ToolRuntime, absolute: &Path) -> bool {
    if !ensure_path_access(runtime, absolute, "file").await {
        return false;
    }
    let relative = relative_display(runtime, absolute);
    if runtime.file_ignore.sensitive_reason(absolute).is_none() {
        return true;
    }
    let reason = "this is a sensitive file (env, key, database, credentials)".to_string();
    runtime
        .broker
        .ask(
            PermissionPrompt {
                kind: "file".to_string(),
                title: format!("Modify {}?", relative),
                detail: format!("The assistant wants to modify {relative}, but {reason}."),
                command: None,
                path: Some(relative),
                folder: None,
                url: None,
                suggested_rule: None,
                segments: Vec::new(),
                risk: None,
                scope_options: Vec::new(),
            },
            &runtime.cancel,
            &runtime.session_id,
            &runtime.emit,
        )
        .await
        .allowed
}

async fn read_file(runtime: &mut ToolRuntime, arguments: &Value) -> ToolOutcome {
    let path = match arg_str(arguments, "path") {
        Ok(path) => path,
        Err(error) => return ToolOutcome::error(error.to_string()),
    };
    let absolute = permissions::resolve_path(&runtime.project_root, &path);
    if !ensure_path_access(runtime, &absolute, "file").await {
        return ToolOutcome::denied();
    }
    if let Some(reason) = file_ignore_reason(runtime, &absolute) {
        let relative = relative_display(runtime, &absolute);
        return ToolOutcome::error(format!(
            "Refusing to read {relative}: {reason}. Change the file access rules in Settings → Agent rules if the assistant should access it."
        ));
    }
    if let Some(sensitive) = runtime.file_ignore.sensitive_reason(&absolute) {
        let relative = relative_display(runtime, &absolute);
        let allowed = runtime
            .broker
            .ask(
                PermissionPrompt {
                    kind: "file".to_string(),
                    title: format!("Read {relative}?"),
                    detail: format!("{relative} looks like a sensitive file: {sensitive}."),
                    command: None,
                    path: Some(relative),
                    folder: None,
                    url: None,
                    suggested_rule: None,
                    segments: Vec::new(),
                    risk: None,
                    scope_options: Vec::new(),
                },
                &runtime.cancel,
                &runtime.session_id,
                &runtime.emit,
            )
            .await
            .allowed;
        if !allowed {
            return ToolOutcome::denied();
        }
    }
    let content = match tokio::fs::read_to_string(&absolute).await {
        Ok(content) => content,
        Err(error) => {
            return ToolOutcome::error(format!("Cannot read {}: {error}", absolute.display()))
        }
    };
    let lines: Vec<&str> = content.lines().collect();
    let offset = arguments
        .get("offset")
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .max(1) as usize;
    let limit = arguments
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(2000)
        .max(1) as usize;
    let mut output = String::new();
    for (index, line) in lines.iter().skip(offset - 1).take(limit).enumerate() {
        output.push_str(&format!("{}\t{}\n", offset + index, line));
    }
    let shown_end = (offset - 1 + limit).min(lines.len());
    if lines.len() > shown_end {
        output.push_str(&format!(
            "\n… file has {} lines total; showing {}-{}",
            lines.len(),
            offset,
            shown_end
        ));
    }
    ToolOutcome::ok(output)
}

async fn write_file(runtime: &mut ToolRuntime, arguments: &Value) -> ToolOutcome {
    let path = match arg_str(arguments, "path") {
        Ok(path) => path,
        Err(error) => return ToolOutcome::error(error.to_string()),
    };
    let content = match arg_str(arguments, "content") {
        Ok(content) => content,
        Err(error) => return ToolOutcome::error(error.to_string()),
    };
    let absolute = permissions::resolve_path(&runtime.project_root, &path);
    if !ensure_write_access(runtime, &absolute).await {
        return ToolOutcome::denied();
    }
    if let Some(parent) = absolute.parent() {
        if let Err(error) = tokio::fs::create_dir_all(parent).await {
            return ToolOutcome::error(format!("Cannot create {}: {error}", parent.display()));
        }
    }
    let existed = absolute.exists();
    let old = tokio::fs::read_to_string(&absolute)
        .await
        .unwrap_or_default();
    if let Err(error) = tokio::fs::write(&absolute, &content).await {
        return ToolOutcome::error(format!("Cannot write {}: {error}", absolute.display()));
    }
    let (additions, deletions) = count_line_changes(&old, &content);
    let relative = relative_display(runtime, &absolute);
    ToolOutcome {
        result: truncate(format!(
            "Wrote {} lines to {relative}.",
            content.lines().count()
        )),
        status: "ok".to_string(),
        changes: vec![FileChange {
            path: relative,
            additions,
            deletions,
            status: if existed { "M" } else { "A" }.to_string(),
        }],
    }
}

async fn edit_file(runtime: &mut ToolRuntime, arguments: &Value) -> ToolOutcome {
    let path = match arg_str(arguments, "path") {
        Ok(path) => path,
        Err(error) => return ToolOutcome::error(error.to_string()),
    };
    let old_string = match arg_str(arguments, "old_string") {
        Ok(value) => value,
        Err(error) => return ToolOutcome::error(error.to_string()),
    };
    let new_string = match arg_str(arguments, "new_string") {
        Ok(value) => value,
        Err(error) => return ToolOutcome::error(error.to_string()),
    };
    let replace_all = arguments
        .get("replace_all")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let absolute = permissions::resolve_path(&runtime.project_root, &path);
    if !ensure_write_access(runtime, &absolute).await {
        return ToolOutcome::denied();
    }
    let current = match tokio::fs::read_to_string(&absolute).await {
        Ok(content) => content,
        Err(error) => {
            return ToolOutcome::error(format!("Cannot read {}: {error}", absolute.display()))
        }
    };
    let occurrences = current.matches(&old_string).count();
    if occurrences == 0 {
        return ToolOutcome::error(
            "old_string was not found. Read the file and provide the exact current text.",
        );
    }
    if occurrences > 1 && !replace_all {
        return ToolOutcome::error(format!(
            "old_string occurs {occurrences} times. Add more context to make it unique or set replace_all."
        ));
    }
    let updated = if replace_all {
        current.replace(&old_string, &new_string)
    } else {
        current.replacen(&old_string, &new_string, 1)
    };
    if let Err(error) = tokio::fs::write(&absolute, &updated).await {
        return ToolOutcome::error(format!("Cannot write {}: {error}", absolute.display()));
    }
    let (additions, deletions) = count_line_changes(&current, &updated);
    let relative = relative_display(runtime, &absolute);
    ToolOutcome {
        result: truncate(format!(
            "Edited {relative} ({occurrences} replacement{}).",
            if occurrences == 1 { "" } else { "s" }
        )),
        status: "ok".to_string(),
        changes: vec![FileChange {
            path: relative,
            additions,
            deletions,
            status: "M".to_string(),
        }],
    }
}

/// Build a directory walker that never descends into `.git` and that prunes
/// generated/dependency directories unless the user allowed scanning them.
/// `.gitignore` is handled separately so user exemptions can override it.
fn file_walker(base: &Path, project_root: &Path, config: &Arc<FileIgnoreConfig>) -> ignore::Walk {
    let root = project_root.to_path_buf();
    let config = config.clone();
    let mut builder = WalkBuilder::new(base);
    builder
        .hidden(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false);
    builder.filter_entry(move |entry| {
        let path = entry.path();
        if path
            .components()
            .any(|component| component.as_os_str() == ".git")
        {
            return false;
        }
        let relative = path
            .strip_prefix(&root)
            .map(|value| value.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"));
        if config.is_exempt(&relative) {
            return true;
        }
        let is_dir = entry
            .file_type()
            .map(|kind| kind.is_dir())
            .unwrap_or(false);
        if is_dir
            && !config.scan_generated_files
            && !config.has_exemptions()
            && config.is_generated_path(path)
            && !config.generated_rule_disabled(path)
        {
            return false;
        }
        true
    });
    builder.build()
}

async fn glob_files(runtime: &mut ToolRuntime, arguments: &Value) -> ToolOutcome {
    let pattern = match arg_str(arguments, "pattern") {
        Ok(pattern) => pattern,
        Err(error) => return ToolOutcome::error(error.to_string()),
    };
    let base = arguments
        .get("path")
        .and_then(Value::as_str)
        .map(|path| permissions::resolve_path(&runtime.project_root, path))
        .unwrap_or_else(|| runtime.project_root.clone());
    if !ensure_path_access(runtime, &base, "directory").await {
        return ToolOutcome::denied();
    }
    let matcher = match Glob::new(&pattern) {
        Ok(glob) => glob.compile_matcher(),
        Err(error) => return ToolOutcome::error(format!("Invalid pattern: {error}")),
    };
    let mut candidates: Vec<PathBuf> = Vec::new();
    for entry in file_walker(&base, &runtime.project_root, &runtime.file_ignore).flatten() {
        if runtime.cancel.is_cancelled() {
            return ToolOutcome::cancelled();
        }
        if candidates.len() >= 100_000 {
            break;
        }
        candidates.push(entry.path().to_path_buf());
    }
    let ignored = if runtime.file_ignore.respect_gitignore {
        ignored_paths(&runtime.project_root, &candidates)
    } else {
        HashSet::new()
    };
    let mut results: Vec<String> = Vec::new();
    for path in &candidates {
        if runtime.cancel.is_cancelled() {
            return ToolOutcome::cancelled();
        }
        if results.len() >= 500 {
            break;
        }
        let relative_to_base = path.strip_prefix(&base).unwrap_or(path);
        if !matcher.is_match(relative_to_base) {
            continue;
        }
        let relative = ignore_relative(runtime, path);
        if runtime
            .file_ignore
            .ignore_reason(path, &relative, ignored.contains(path))
            .is_some()
        {
            continue;
        }
        results.push(relative_display(runtime, path));
    }
    if results.is_empty() {
        return ToolOutcome::ok(format!("No files match '{pattern}'."));
    }
    results.sort();
    ToolOutcome::ok(results.join("\n"))
}

async fn grep_files(runtime: &mut ToolRuntime, arguments: &Value) -> ToolOutcome {
    let pattern = match arg_str(arguments, "pattern") {
        Ok(pattern) => pattern,
        Err(error) => return ToolOutcome::error(error.to_string()),
    };
    let regex = match Regex::new(&pattern) {
        Ok(regex) => regex,
        Err(error) => return ToolOutcome::error(format!("Invalid regex: {error}")),
    };
    let include = match arguments.get("include").and_then(Value::as_str) {
        Some(include) => match Glob::new(include) {
            Ok(glob) => Some(glob.compile_matcher()),
            Err(error) => return ToolOutcome::error(format!("Invalid include pattern: {error}")),
        },
        None => None,
    };
    let base = arguments
        .get("path")
        .and_then(Value::as_str)
        .map(|path| permissions::resolve_path(&runtime.project_root, path))
        .unwrap_or_else(|| runtime.project_root.clone());
    if !ensure_path_access(runtime, &base, "directory").await {
        return ToolOutcome::denied();
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    for entry in file_walker(&base, &runtime.project_root, &runtime.file_ignore).flatten() {
        if runtime.cancel.is_cancelled() {
            return ToolOutcome::cancelled();
        }
        if candidates.len() >= 200_000 {
            break;
        }
        if entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
        {
            candidates.push(entry.path().to_path_buf());
        }
    }
    let ignored = if runtime.file_ignore.respect_gitignore {
        ignored_paths(&runtime.project_root, &candidates)
    } else {
        HashSet::new()
    };
    let mut results: Vec<String> = Vec::new();
    'outer: for path in &candidates {
        if runtime.cancel.is_cancelled() {
            return ToolOutcome::cancelled();
        }
        let relative_to_base = path.strip_prefix(&base).unwrap_or(path);
        if let Some(include) = &include {
            if !include.is_match(relative_to_base) {
                continue;
            }
        }
        let relative = ignore_relative(runtime, path);
        if runtime
            .file_ignore
            .ignore_reason(path, &relative, ignored.contains(path))
            .is_some()
        {
            continue;
        }
        let metadata = match std::fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.len() > 1_000_000 {
            continue;
        }
        let content = match std::fs::read_to_string(path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let display = relative_display(runtime, path);
        for (index, line) in content.lines().enumerate() {
            if regex.is_match(line) {
                results.push(format!("{display}:{}: {}", index + 1, line.trim_end()));
                if results.len() >= 200 {
                    break 'outer;
                }
            }
        }
    }
    if results.is_empty() {
        return ToolOutcome::ok(format!("No matches for '{pattern}'."));
    }
    ToolOutcome::ok(results.join("\n"))
}

async fn list_dir(runtime: &mut ToolRuntime, arguments: &Value) -> ToolOutcome {
    let base = arguments
        .get("path")
        .and_then(Value::as_str)
        .map(|path| permissions::resolve_path(&runtime.project_root, path))
        .unwrap_or_else(|| runtime.project_root.clone());
    if !ensure_path_access(runtime, &base, "directory").await {
        return ToolOutcome::denied();
    }
    let mut entries = match tokio::fs::read_dir(&base).await {
        Ok(entries) => entries,
        Err(error) => {
            return ToolOutcome::error(format!("Cannot list {}: {error}", base.display()))
        }
    };
    let mut items: Vec<(bool, String, PathBuf)> = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry
            .file_type()
            .await
            .map(|file_type| file_type.is_dir())
            .unwrap_or(false);
        items.push((is_dir, name, entry.path()));
    }
    let paths: Vec<PathBuf> = items.iter().map(|(_, _, path)| path.clone()).collect();
    let ignored = if runtime.file_ignore.respect_gitignore {
        ignored_paths(&runtime.project_root, &paths)
    } else {
        HashSet::new()
    };
    items.retain(|(_, _, path)| {
        let relative = ignore_relative(runtime, path);
        runtime
            .file_ignore
            .ignore_reason(path, &relative, ignored.contains(path))
            .is_none()
    });
    items.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(a.1.to_lowercase().cmp(&b.1.to_lowercase()))
    });
    let output = items
        .into_iter()
        .take(1000)
        .map(|(is_dir, name, _)| if is_dir { format!("{name}/") } else { name })
        .collect::<Vec<_>>()
        .join("\n");
    ToolOutcome::ok(output)
}

enum WebsiteAccess {
    Allowed,
    DeniedByRule(String),
    DeniedByUser,
}

/// Ask the user for permission before the agent reaches a website. Rules are
/// matched against the host: deny rules win, then allow rules, then the user.
async fn ensure_website_access(runtime: &mut ToolRuntime, url: &str, kind: &str) -> WebsiteAccess {
    let Some(host) = reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
    else {
        return WebsiteAccess::DeniedByRule("The URL does not contain a valid host.".to_string());
    };
    match permissions::evaluate_website(
        &host,
        &runtime.permissions.allowed_websites(),
        &runtime.permissions.denied_websites(),
    ) {
        WebsiteDecision::Allow => WebsiteAccess::Allowed,
        WebsiteDecision::Deny { reason } => WebsiteAccess::DeniedByRule(reason),
        WebsiteDecision::Ask {
            reason,
            suggested_rule,
        } => {
            let allowed = runtime
                .broker
                .ask(
                    PermissionPrompt {
                        kind: kind.to_string(),
                        title: format!("Visit {host}?"),
                        detail: format!(
                            "{reason} The assistant wants to access this website. Allow once, always allow it, or deny it."
                        ),
                        command: None,
                        path: None,
                        folder: None,
                        url: Some(url.to_string()),
                        suggested_rule: Some(suggested_rule),
                        segments: Vec::new(),
                        risk: None,
                        scope_options: Vec::new(),
                    },
                    &runtime.cancel,
                    &runtime.session_id,
                    &runtime.emit,
                )
                .await
                .allowed;
            if allowed {
                WebsiteAccess::Allowed
            } else {
                WebsiteAccess::DeniedByUser
            }
        }
    }
}

async fn read_web_body(response: reqwest::Response) -> std::result::Result<Vec<u8>, String> {
    let mut response = response;
    let mut buffer: Vec<u8> = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if buffer.len() + chunk.len() > MAX_WEB_BYTES {
                    let remaining = MAX_WEB_BYTES.saturating_sub(buffer.len());
                    buffer.extend_from_slice(&chunk[..remaining]);
                    break;
                }
                buffer.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(error) => return Err(format!("Failed to read the response: {error}")),
        }
    }
    Ok(buffer)
}

/// True for addresses the agent must never reach: loopback, private, link-local,
/// unique-local, unspecified, multicast and similar (SSRF protection).
fn blocked_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.octets()[0] == 0
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

/// Resolves the URL host and rejects it when any resolved address is non-public.
/// This runs on every hop so a redirect or DNS rebind cannot reach internal
/// services after the initial allowlist check.
async fn ensure_host_public(url: &reqwest::Url) -> std::result::Result<(), String> {
    let host = url
        .host_str()
        .ok_or_else(|| "The URL does not contain a valid host.".to_string())?;
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| format!("Could not resolve {host}: {error}"))?;
    let mut resolved = false;
    for address in addresses {
        resolved = true;
        if blocked_ip(address.ip()) {
            return Err(format!(
                "{host} resolves to a non-public address and was blocked."
            ));
        }
    }
    if !resolved {
        return Err(format!("Could not resolve {host}."));
    }
    Ok(())
}

pub(crate) async fn web_fetch(runtime: &mut ToolRuntime, arguments: &Value) -> ToolOutcome {
    let url = match arg_str(arguments, "url") {
        Ok(url) => url,
        Err(error) => return ToolOutcome::error(error.to_string()),
    };
    let parsed = match reqwest::Url::parse(url.trim()) {
        Ok(parsed) => parsed,
        Err(error) => return ToolOutcome::error(format!("Invalid URL: {error}")),
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return ToolOutcome::error("Only http(s) URLs can be fetched.");
    }
    match ensure_website_access(runtime, parsed.as_str(), "web").await {
        WebsiteAccess::Allowed => {}
        WebsiteAccess::DeniedByRule(reason) => {
            return ToolOutcome::error(format!("Blocked: {reason}"))
        }
        WebsiteAccess::DeniedByUser => return ToolOutcome::denied(),
    }

    // Follow redirects manually so every hop is re-checked against the website
    // rules and the private-address block, then fetch the final URL.
    let client = match reqwest::Client::builder()
        .user_agent("pumr/0.1")
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(WEB_TIMEOUT_SECONDS))
        .build()
    {
        Ok(client) => client,
        Err(error) => return ToolOutcome::error(format!("HTTP client error: {error}")),
    };
    let mut current = parsed.clone();
    let mut redirects = 0;
    let response = loop {
        if let Err(reason) = ensure_host_public(&current).await {
            return ToolOutcome::error(reason);
        }
        let response = match client
            .get(current.clone())
            .header(
                reqwest::header::ACCEPT,
                "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
            )
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => return ToolOutcome::error(format!("Request failed: {error}")),
        };
        if !response.status().is_redirection() {
            break response;
        }
        if redirects >= 5 {
            return ToolOutcome::error("Too many redirects.");
        }
        let Some(location) = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
        else {
            return ToolOutcome::error("Redirect without a Location header.");
        };
        let next = match current.join(location) {
            Ok(next) => next,
            Err(error) => return ToolOutcome::error(format!("Invalid redirect target: {error}")),
        };
        if !matches!(next.scheme(), "http" | "https") {
            return ToolOutcome::error("Redirected to a non-http(s) URL.");
        }
        if next.host_str() != current.host_str() {
            match ensure_website_access(runtime, next.as_str(), "web").await {
                WebsiteAccess::Allowed => {}
                WebsiteAccess::DeniedByRule(reason) => {
                    return ToolOutcome::error(format!("Blocked: {reason}"))
                }
                WebsiteAccess::DeniedByUser => return ToolOutcome::denied(),
            }
        }
        current = next;
        redirects += 1;
    };
    let status = response.status();
    if !status.is_success() {
        return ToolOutcome::error(format!(
            "{} returned HTTP {}.",
            current.host_str().unwrap_or("The server"),
            status.as_u16()
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let body = match read_web_body(response).await {
        Ok(body) => body,
        Err(error) => return ToolOutcome::error(error),
    };
    let text = String::from_utf8_lossy(&body);
    let output = if content_type.contains("html") || content_type.is_empty() {
        html_to_text(&text)
    } else {
        text.to_string()
    };
    if output.trim().is_empty() {
        return ToolOutcome::ok(format!("{} returned no readable text.", current.as_str()));
    }
    ToolOutcome::ok(format!("# {}\n\n{}", current.as_str(), output))
}

struct SearchResult {
    title: String,
    url: String,
    snippet: String,
}

async fn web_search(runtime: &mut ToolRuntime, arguments: &Value) -> ToolOutcome {
    let query = match arg_str(arguments, "query") {
        Ok(query) => query,
        Err(error) => return ToolOutcome::error(error.to_string()),
    };
    let query = query.trim().to_string();
    if query.is_empty() {
        return ToolOutcome::error("The search query is empty.");
    }
    let max_results = arguments
        .get("max_results")
        .and_then(Value::as_u64)
        .unwrap_or(8)
        .clamp(1, 20) as usize;
    let search_url = format!("{SEARCH_BASE_URL}?q={}", percent_encode(&query));

    match ensure_website_access(runtime, &search_url, "websearch").await {
        WebsiteAccess::Allowed => {}
        WebsiteAccess::DeniedByRule(reason) => {
            return ToolOutcome::error(format!("Blocked: {reason}"))
        }
        WebsiteAccess::DeniedByUser => return ToolOutcome::denied(),
    }

    let response = match runtime
        .http
        .get(&search_url)
        .timeout(Duration::from_secs(WEB_TIMEOUT_SECONDS))
        .header(reqwest::header::ACCEPT, "text/html")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return ToolOutcome::error(format!("Search request failed: {error}")),
    };
    if !response.status().is_success() {
        return ToolOutcome::error(format!(
            "Search failed with HTTP {}.",
            response.status().as_u16()
        ));
    }
    let body = match read_web_body(response).await {
        Ok(body) => body,
        Err(error) => return ToolOutcome::error(error),
    };
    let html = String::from_utf8_lossy(&body);
    let results = parse_duckduckgo(&html);
    if results.is_empty() {
        return ToolOutcome::ok(format!("No web results found for '{query}'."));
    }
    let mut output = format!("Web results for '{query}':\n");
    for (index, result) in results.into_iter().take(max_results).enumerate() {
        output.push_str(&format!(
            "\n{}. {}\n   {}\n   {}\n",
            index + 1,
            if result.title.is_empty() {
                "(untitled)"
            } else {
                &result.title
            },
            result.url,
            result.snippet
        ));
    }
    ToolOutcome::ok(output)
}

fn parse_duckduckgo(html: &str) -> Vec<SearchResult> {
    let Ok(anchor) = Regex::new(r"(?is)<a\b([^>]*)>(.*?)</a>") else {
        return Vec::new();
    };
    let Ok(snippet_re) = Regex::new(r#"(?is)class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</a>"#)
    else {
        return Vec::new();
    };

    let mut anchors: Vec<(usize, usize, String, String)> = Vec::new();
    for capture in anchor.captures_iter(html) {
        let attributes = &capture[1];
        if !attributes.contains("result__a") {
            continue;
        }
        let Some(href) = attr_value(attributes, "href") else {
            continue;
        };
        let full = capture.get(0).unwrap();
        anchors.push((full.end(), full.start(), href, capture[2].to_string()));
    }

    let mut results: Vec<SearchResult> = Vec::new();
    for (index, (end, _, href, inner)) in anchors.iter().enumerate() {
        let region_end = anchors
            .get(index + 1)
            .map(|next| next.1)
            .unwrap_or(html.len());
        let region = html.get(*end..region_end.min(html.len())).unwrap_or("");
        let snippet = snippet_re
            .captures(region)
            .map(|capture| strip_tags(&capture[1]))
            .unwrap_or_default();
        let url = normalize_duckduckgo_href(href);
        if url.is_empty() {
            continue;
        }
        results.push(SearchResult {
            title: strip_tags(inner),
            url,
            snippet,
        });
    }
    results
}

fn attr_value(attributes: &str, name: &str) -> Option<String> {
    let pattern = format!(r#"(?is)\b{}\s*=\s*"([^"]*)""#, regex::escape(name));
    Regex::new(&pattern)
        .ok()?
        .captures(attributes)
        .map(|capture| capture[1].to_string())
}

fn normalize_duckduckgo_href(href: &str) -> String {
    let href = href.trim();
    let candidate = if let Some(rest) = href.strip_prefix("//") {
        format!("https://{rest}")
    } else {
        href.to_string()
    };
    if let Some(target) = query_param(&candidate, "uddg") {
        let decoded = percent_decode(&target);
        if !decoded.trim().is_empty() {
            return decoded;
        }
    }
    candidate
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let query = url.split_once('?')?.1.split('#').next().unwrap_or("");
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if name == key {
            return Some(value.to_string());
        }
    }
    None
}

fn html_to_text(html: &str) -> String {
    let Ok(ignored) = Regex::new(
        r"(?is)<script\b[^>]*>.*?</script>|<style\b[^>]*>.*?</style>|<noscript\b[^>]*>.*?</noscript>|<svg\b[^>]*>.*?</svg>|<template\b[^>]*>.*?</template>|<head\b[^>]*>.*?</head>",
    ) else {
        return strip_tags(html);
    };
    let without_ignored = ignored.replace_all(html, " ");
    let Ok(breaks) = Regex::new(
        r"(?i)<(?:/p|/div|/li|/tr|/h[1-6]|/section|/article|/blockquote|/pre|br|hr)\s*/?>",
    ) else {
        return strip_tags(&without_ignored);
    };
    let with_breaks = breaks.replace_all(&without_ignored, "\n");
    strip_tags(&with_breaks)
}

fn strip_tags(input: &str) -> String {
    let Ok(tags) = Regex::new(r"(?s)<[^>]+>") else {
        return collapse_whitespace(&decode_entities(input));
    };
    collapse_whitespace(&decode_entities(&tags.replace_all(input, " ")))
}

fn decode_entities(input: &str) -> String {
    let Ok(entities) = Regex::new(r"&(#x?[0-9a-fA-F]+|[a-zA-Z]+);") else {
        return input.to_string();
    };
    entities
        .replace_all(input, |captures: &regex::Captures| {
            let entity = &captures[1];
            if let Some(hex) = entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
            {
                return u32::from_str_radix(hex, 16)
                    .ok()
                    .and_then(char::from_u32)
                    .map(String::from)
                    .unwrap_or_else(|| captures[0].to_string());
            }
            if let Some(decimal) = entity.strip_prefix('#') {
                return decimal
                    .parse::<u32>()
                    .ok()
                    .and_then(char::from_u32)
                    .map(String::from)
                    .unwrap_or_else(|| captures[0].to_string());
            }
            match entity {
                "amp" => "&".to_string(),
                "lt" => "<".to_string(),
                "gt" => ">".to_string(),
                "quot" => "\"".to_string(),
                "apos" => "'".to_string(),
                "nbsp" => " ".to_string(),
                "mdash" => "—".to_string(),
                "ndash" => "–".to_string(),
                "hellip" => "…".to_string(),
                "copy" => "©".to_string(),
                "reg" => "®".to_string(),
                "trade" => "™".to_string(),
                "laquo" => "«".to_string(),
                "raquo" => "»".to_string(),
                _ => captures[0].to_string(),
            }
        })
        .to_string()
}

fn collapse_whitespace(input: &str) -> String {
    let mut output = String::new();
    let mut blank_lines = 0;
    for line in input.lines() {
        let trimmed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if trimmed.is_empty() {
            blank_lines += 1;
            if blank_lines > 1 {
                continue;
            }
        } else {
            blank_lines = 0;
        }
        output.push_str(&trimmed);
        output.push('\n');
    }
    output.trim().to_string()
}

fn percent_encode(input: &str) -> String {
    let mut output = String::new();
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(byte as char)
            }
            b' ' => output.push('+'),
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                output.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        if bytes[index] == b'+' {
            output.push(b' ');
        } else {
            output.push(bytes[index]);
        }
        index += 1;
    }
    String::from_utf8_lossy(&output).to_string()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

async fn run_bash(runtime: &mut ToolRuntime, arguments: &Value) -> ToolOutcome {
    let command = match arg_str(arguments, "command") {
        Ok(command) => command,
        Err(error) => return ToolOutcome::error(error.to_string()),
    };
    let cwd = arguments
        .get("cwd")
        .and_then(Value::as_str)
        .map(|path| permissions::resolve_path(&runtime.project_root, path))
        .unwrap_or_else(|| runtime.project_root.clone());
    if !ensure_path_access(runtime, &cwd, "directory").await {
        return ToolOutcome::denied();
    }

    let mut allowed_rules = runtime.permissions.command_rules();
    allowed_rules.extend(runtime.permissions.session_command_rules(&runtime.session_id));
    let denied_rules = runtime.permissions.denied_command_rules();
    let decision = permissions::evaluate_command(
        &command,
        &runtime.project_root,
        &runtime.permissions.extra_folders(),
        &allowed_rules,
        &denied_rules,
    );
    if let CommandDecision::Deny { reason } = decision {
        return ToolOutcome::denied_with_reason(reason);
    }
    if let CommandDecision::Ask {
        reason,
        suggested_rule,
        segments,
        risk,
        scope_options,
    } = decision
    {
        let allowed = runtime
            .broker
            .ask(
                PermissionPrompt {
                    kind: "command".to_string(),
                    title: "Run command?".to_string(),
                    detail: reason,
                    command: Some(command.clone()),
                    path: None,
                    folder: None,
                    url: None,
                    suggested_rule: Some(suggested_rule),
                    segments,
                    risk: Some(risk),
                    scope_options,
                },
                &runtime.cancel,
                &runtime.session_id,
                &runtime.emit,
            )
            .await
            .allowed;
        if !allowed {
            return ToolOutcome::denied();
        }
    }

    let mut process = if cfg!(windows) {
        let mut process = Command::new("cmd");
        process.arg("/C").arg(&command);
        process
    } else {
        let mut process = Command::new("sh");
        process.arg("-c").arg(&command);
        process
    };
    process
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => return ToolOutcome::error(format!("Cannot start command: {error}")),
    };

    let output = Arc::new(Mutex::new(String::new()));
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<String>();
    spawn_reader(child.stdout.take(), output.clone(), sender.clone());
    spawn_reader(child.stderr.take(), output.clone(), sender.clone());
    drop(sender);

    let child_handle: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(Some(child)));
    let running = Arc::new(AtomicBool::new(true));
    let (exit_sender, mut exit_receiver) = tokio::sync::oneshot::channel::<i32>();
    spawn_waiter(child_handle.clone(), running.clone(), exit_sender);

    let timeout = arguments
        .get("timeout_seconds")
        .and_then(Value::as_u64)
        .unwrap_or(BACKGROUND_AFTER_SECONDS)
        .clamp(1, 120);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);
    let mut exit_code: Option<i32> = None;
    let mut moved_to_background = false;
    let mut channel_closed = false;

    loop {
        tokio::select! {
            _ = runtime.cancel.cancelled() => {
                if let Some(child) = child_handle.lock().unwrap().as_mut() {
                    let _ = child.start_kill();
                }
                return ToolOutcome::cancelled();
            }
            chunk = receiver.recv(), if !channel_closed => {
                match chunk {
                    Some(text) => runtime.send(StreamEvent::ToolDelta {
                        call_id: runtime.call_id.clone(),
                        text,
                    }),
                    None => channel_closed = true,
                }
            }
            result = &mut exit_receiver => {
                exit_code = result.ok();
                break;
            }
            _ = tokio::time::sleep_until(deadline) => {
                moved_to_background = true;
                break;
            }
        }
    }

    tokio::time::sleep(Duration::from_millis(80)).await;
    let buffered = output.lock().unwrap().clone();

    if moved_to_background {
        let id = Uuid::new_v4().to_string();
        runtime.processes.insert(Arc::new(RunningProcess {
            id: id.clone(),
            session_id: runtime.session_id.clone(),
            command: command.clone(),
            cwd: cwd.display().to_string(),
            started_at: crate::db::now_ms(),
            output: output.clone(),
            child: child_handle,
            running,
        }));
        return ToolOutcome::ok(format!(
            "Command is still running after {timeout}s and was moved to the background (process id: {id}). The user can stop it from the running processes indicator.\n\nOutput so far:\n{buffered}"
        ));
    }

    match exit_code {
        Some(0) => ToolOutcome::ok(if buffered.trim().is_empty() {
            "Command finished successfully (no output).".to_string()
        } else {
            format!("Command finished successfully.\n{buffered}")
        }),
        Some(code) => ToolOutcome {
            result: truncate(format!("Command failed with exit code {code}.\n{buffered}")),
            status: "error".to_string(),
            changes: Vec::new(),
        },
        None => ToolOutcome::error("Command did not report an exit code."),
    }
}

fn spawn_reader<R>(
    reader: Option<R>,
    output: Arc<Mutex<String>>,
    sender: tokio::sync::mpsc::UnboundedSender<String>,
) where
    R: AsyncReadExt + Unpin + Send + 'static,
{
    let Some(mut reader) = reader else {
        return;
    };
    tokio::spawn(async move {
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let text = String::from_utf8_lossy(&buffer[..read]).to_string();
                    output.lock().unwrap().push_str(&text);
                    if sender.send(text).is_err() {
                        // no receiver yet, keep buffering
                    }
                }
            }
        }
    });
}

fn spawn_waiter(
    child: Arc<Mutex<Option<Child>>>,
    running: Arc<AtomicBool>,
    exit_sender: tokio::sync::oneshot::Sender<i32>,
) {
    tokio::spawn(async move {
        let mut exit_sender = Some(exit_sender);
        loop {
            {
                let mut guard = child.lock().unwrap();
                if let Some(inner) = guard.as_mut() {
                    match inner.try_wait() {
                        Ok(Some(status)) => {
                            running.store(false, Ordering::SeqCst);
                            if let Some(sender) = exit_sender.take() {
                                let _ = sender.send(status.code().unwrap_or(-1));
                            }
                            break;
                        }
                        Ok(None) => {}
                        Err(_) => {
                            running.store(false, Ordering::SeqCst);
                            if let Some(sender) = exit_sender.take() {
                                let _ = sender.send(-1);
                            }
                            break;
                        }
                    }
                } else {
                    running.store(false, Ordering::SeqCst);
                    if let Some(sender) = exit_sender.take() {
                        let _ = sender.send(-1);
                    }
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    });
}

fn truncate(text: String) -> String {
    if text.len() <= MAX_TOOL_OUTPUT {
        return text;
    }
    let mut end = MAX_TOOL_OUTPUT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…(output truncated)", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_to_text_strips_scripts_and_keeps_breaks() {
        let html = "<html><head><title>x</title></head><body><h1>Hello</h1><script>bad()</script><p>World &amp; friends</p></body></html>";
        let text = html_to_text(html);
        assert!(text.contains("Hello"));
        assert!(text.contains("World & friends"));
        assert!(!text.contains("bad()"));
        assert!(!text.contains("<"));
    }

    #[test]
    fn percent_helpers_round_trip() {
        let encoded = percent_encode("hello world / rust");
        assert_eq!(encoded, "hello+world+%2F+rust");
        assert_eq!(percent_decode("hello+world"), "hello world");
        assert_eq!(
            percent_decode("https%3A%2F%2Fexample.com%2Fa%3Fb%3D1"),
            "https://example.com/a?b=1"
        );
    }

    #[test]
    fn duckduckgo_redirect_links_are_decoded() {
        assert_eq!(
            normalize_duckduckgo_href(
                "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&rut=abc"
            ),
            "https://example.com/"
        );
        assert_eq!(
            normalize_duckduckgo_href("https://docs.rs/"),
            "https://docs.rs/"
        );
    }

    #[test]
    fn duckduckgo_results_are_parsed() {
        let html = r#"
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.rs%2Fserde&amp;rut=x">serde - <b>Rust</b></a>
            <a class="result__snippet">A serialization framework.</a>
            <a rel="nofollow" class="result__a" href="https://example.com/page">Example</a>
            <a class="result__snippet">An example page.</a>
        "#;
        let results = parse_duckduckgo(html);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].url, "https://docs.rs/serde");
        assert_eq!(results[0].title, "serde - Rust");
        assert_eq!(results[0].snippet, "A serialization framework.");
        assert_eq!(results[1].url, "https://example.com/page");
    }
}
