use crate::broker::{PermissionBroker, PermissionOperation, PermissionPrompt, QuestionBroker};
use crate::db::Db;
use crate::error::{AppError, Result};
use crate::git::{count_line_changes, ignored_paths, GitProbe, ShadowRepo};
use crate::mcp::McpManager;
use crate::models::{
    Attachment, EventSink, FileChange, PermissionAuditEntry, PermissionDecision, QuestionItem,
    QuestionOption, RoutedEvent, SkillEntry, StreamEvent,
};
use crate::permissions::{
    self, CommandDecision, FileIgnoreConfig, LivePermissions, WebsiteDecision,
};
use crate::processes::{kill_tree, OutputBuffer, ProcessRegistry, RunningProcess};
use crate::read_formats::{self, Format};
use crate::sandbox;
use globset::Glob;
use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const MAX_TOOL_OUTPUT: usize = 30_000;
/// How much of an output saved to a file its tool result still shows.
const SPILLED_OUTPUT_BYTES: usize = 16_000;
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
    /// Root session for the conversation; session grants are keyed by this so
    /// subagents share the chat's "allow in this chat" rules.
    pub conversation_id: String,
    pub shadow: Arc<ShadowRepo>,
    pub processes: Arc<ProcessRegistry>,
    /// The files this chat's agents have seen (see `FileLedger`).
    pub files: Arc<FileLedger>,
    pub broker: Arc<PermissionBroker>,
    pub questions: Arc<QuestionBroker>,
    pub http: reqwest::Client,
    pub mcp: Option<Arc<McpManager>>,
    /// Catalogue of discovered skills the `skill` tool can load on demand.
    pub skills: Vec<SkillEntry>,
    /// The call's `reason` argument, shown in any permission prompt it raises.
    pub justification: Option<String>,
    /// Whether the model that made the call takes pictures: `read` hands it
    /// an image file only then.
    pub vision: bool,
    /// The call is made in a mode that changes no files: planning, read-only,
    /// a subagent that explores or checks.
    pub read_only: bool,
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
    /// Images the call shows the user in the chat. They are stored with the
    /// result and never sent to the model.
    pub attachments: Vec<Attachment>,
}

impl ToolOutcome {
    pub fn ok(result: String) -> Self {
        Self {
            result: truncate(result),
            status: "ok".to_string(),
            changes: Vec::new(),
            attachments: Vec::new(),
        }
    }

    pub fn error(result: impl Into<String>) -> Self {
        Self {
            result: truncate(result.into()),
            status: "error".to_string(),
            changes: Vec::new(),
            attachments: Vec::new(),
        }
    }

    pub fn cancelled() -> Self {
        Self {
            result: "Command cancelled.".to_string(),
            status: "canceled".to_string(),
            changes: Vec::new(),
            attachments: Vec::new(),
        }
    }

    /// Outcome of a permission prompt that did not end in an allow. Only the
    /// user's own denial is reported as one: a prompt that was cancelled,
    /// stopped or timed out says so, otherwise the transcript and the model
    /// (which is told not to retry denied actions) blame the user for it.
    pub(crate) fn refused(decision: &PermissionDecision) -> Self {
        let (status, result) = match decision.decided_by.as_str() {
            "" | "user" => ("denied", "The user denied this action."),
            "cascade" => (
                "denied",
                "Denied because the user denied another permission request from this chat.",
            ),
            "grant" => (
                "denied",
                "Denied by a deny rule the user added while this request was waiting.",
            ),
            "timeout" => (
                "canceled",
                "The permission request timed out before the user answered it.",
            ),
            _ => (
                "canceled",
                "Cancelled before the user answered the permission request.",
            ),
        };
        Self {
            result: result.to_string(),
            status: status.to_string(),
            changes: Vec::new(),
            attachments: Vec::new(),
        }
    }

    /// A call one of the user's hooks refused before it ran, with what the
    /// hook said. The user set the hook up, so the agent is not to work
    /// around it.
    pub(crate) fn refused_by_hook(reason: &str) -> Self {
        Self::denied_with_reason(format!(
            "A hook the user set up refused this call:\n{reason}\n\nDo not try to get around it; change the call or ask the user."
        ))
    }

    fn denied_with_reason(reason: impl Into<String>) -> Self {
        Self {
            result: reason.into(),
            status: "denied".to_string(),
            changes: Vec::new(),
            attachments: Vec::new(),
        }
    }
}

/// The files each session's agent has read or written, so that `write` does
/// not replace a file whose content the agent has never seen. A session is
/// forgotten when its history is compacted: what it read is then gone from
/// its context too.
#[derive(Default)]
pub struct FileLedger {
    seen: Mutex<HashMap<String, HashSet<PathBuf>>>,
}

impl FileLedger {
    pub fn note(&self, session_id: &str, path: &Path) {
        self.seen
            .lock()
            .unwrap()
            .entry(session_id.to_string())
            .or_default()
            .insert(permission_path(path));
    }

    pub fn knows(&self, session_id: &str, path: &Path) -> bool {
        self.seen
            .lock()
            .unwrap()
            .get(session_id)
            .is_some_and(|paths| paths.contains(&permission_path(path)))
    }

    pub fn forget(&self, session_id: &str) {
        self.seen.lock().unwrap().remove(session_id);
    }
}

/// Other names models use for an argument of a built-in tool. A model that
/// was trained on another agent's tools answers with that agent's names, and
/// would otherwise be told that an argument it did send is missing.
fn argument_aliases(tool: &str) -> &'static [(&'static str, &'static [&'static str])] {
    const PATH: (&str, &[&str]) = (
        "path",
        &["file_path", "filePath", "filepath", "file", "filename"],
    );
    const FOLDER: (&str, &[&str]) = ("path", &["directory", "dir", "folder"]);
    match tool {
        "read" => &[
            PATH,
            ("offset", &["start_line", "line"]),
            ("limit", &["max_lines", "line_count"]),
        ],
        "write" => &[PATH, ("content", &["contents", "text", "file_text"])],
        "edit" => &[
            PATH,
            ("old_string", &["old_str", "oldString", "old_text"]),
            ("new_string", &["new_str", "newString", "new_text"]),
            ("replace_all", &["replaceAll"]),
        ],
        "ls" | "glob" => &[FOLDER],
        "grep" => &[
            FOLDER,
            ("pattern", &["regex", "query"]),
            ("include", &["glob", "file_pattern"]),
            ("ignore_case", &["case_insensitive", "-i"]),
            ("context", &["context_lines", "-C"]),
        ],
        "bash" => &[
            ("command", &["cmd", "script"]),
            ("cwd", &["workdir", "working_directory"]),
        ],
        "bash_output" => &[("id", &["process_id", "processId", "bash_id"])],
        "webfetch" => &[("url", &["link"])],
        "websearch" => &[("query", &["q", "search"])],
        _ => &[],
    }
}

/// The declared type of every argument of the built-in tools, by tool.
fn argument_types(tool: &str) -> Option<&'static HashMap<String, String>> {
    static TYPES: OnceLock<HashMap<String, HashMap<String, String>>> = OnceLock::new();
    TYPES
        .get_or_init(|| {
            base_tool_schemas()
                .iter()
                .filter_map(|schema| {
                    let name = schema.pointer("/function/name")?.as_str()?;
                    let properties = schema
                        .pointer("/function/parameters/properties")?
                        .as_object()?;
                    let types = properties
                        .iter()
                        .filter_map(|(key, property)| {
                            Some((key.clone(), property.get("type")?.as_str()?.to_string()))
                        })
                        .collect();
                    Some((name.to_string(), types))
                })
                .collect()
        })
        .get(tool)
}

/// Parses the arguments of a tool call as the model sent them. Arguments
/// that are not a JSON object are an error the model is told about, so it
/// can send the call again instead of guessing at a "missing argument". For
/// built-in tools, well-known other names of an argument are accepted and
/// values of a near-miss type (`"10"` for an integer) are converted.
pub fn parse_arguments(tool: &str, raw: &str) -> std::result::Result<Value, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(json!({}));
    }
    let mut value: Value = serde_json::from_str(raw).map_err(|error| {
        let cut_off = if error.is_eof() {
            " Your output ended before the call was complete: send less in one call, for example a long file in several parts."
        } else {
            ""
        };
        format!(
            "The arguments of this {tool} call are not valid JSON ({error}), so it was not run.{cut_off} Send the call again with the arguments as one JSON object."
        )
    })?;
    // Some models send the arguments object once more encoded as a string.
    if let Value::String(inner) = &value {
        if let Ok(parsed @ Value::Object(_)) = serde_json::from_str::<Value>(inner) {
            value = parsed;
        }
    }
    let Value::Object(arguments) = &mut value else {
        return Err(format!(
            "The arguments of this {tool} call must be a JSON object, so it was not run. Send the call again with the arguments as one JSON object."
        ));
    };
    for (name, aliases) in argument_aliases(tool) {
        if arguments.contains_key(*name) {
            continue;
        }
        if let Some(alias) = aliases.iter().find(|alias| arguments.contains_key(**alias)) {
            if let Some(found) = arguments.remove(*alias) {
                arguments.insert(name.to_string(), found);
            }
        }
    }
    if let Some(types) = argument_types(tool) {
        for (key, argument) in arguments.iter_mut() {
            let converted = match (types.get(key).map(String::as_str), &*argument) {
                (Some("integer"), Value::String(text)) => {
                    text.trim().parse::<i64>().ok().map(Value::from)
                }
                (Some("integer"), Value::Number(number)) if !number.is_i64() => number
                    .as_f64()
                    .filter(|float| float.fract() == 0.0)
                    .map(|float| Value::from(float as i64)),
                (Some("boolean"), Value::String(text)) => {
                    match text.trim().to_ascii_lowercase().as_str() {
                        "true" => Some(Value::Bool(true)),
                        "false" => Some(Value::Bool(false)),
                        _ => None,
                    }
                }
                (Some("string"), Value::Number(number)) => Some(Value::from(number.to_string())),
                _ => None,
            };
            if let Some(converted) = converted {
                *argument = converted;
            }
        }
    }
    Ok(value)
}

/// Argument a tool call uses to tell the user, in one sentence, why it needs
/// the action. Shown in any permission prompt the call raises.
pub const REASON_ARGUMENT: &str = "reason";

/// Longest justification shown in a permission prompt, in characters.
const MAX_JUSTIFICATION_CHARS: usize = 300;

/// Built-in tools whose calls can raise a permission prompt, and whether the
/// model must always explain itself (the tool usually or always asks).
const PROMPTING_TOOLS: [(&str, bool); 10] = [
    ("read", false),
    ("write", false),
    ("edit", false),
    ("glob", false),
    ("grep", false),
    ("ls", false),
    ("bash", true),
    ("webfetch", true),
    ("websearch", false),
    ("screenshot", false),
];

/// Adds the `reason` argument to a tool schema. Leaves schemas that already
/// declare their own `reason` (an MCP tool's) or take no object untouched.
pub fn add_reason_argument(schema: &mut Value, required: bool) {
    let Some(parameters) = schema
        .pointer_mut("/function/parameters")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    if parameters
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("object")
        != "object"
    {
        return;
    }
    let properties = parameters.entry("properties").or_insert_with(|| json!({}));
    let Some(properties) = properties.as_object_mut() else {
        return;
    };
    if properties.contains_key(REASON_ARGUMENT) {
        return;
    }
    properties.insert(
        REASON_ARGUMENT.to_string(),
        json!({
            "type": "string",
            "description": "One short sentence telling the user why you need this call. It is shown in the permission prompt when the call needs approval, e.g. 'Run the test suite to verify the fix.'"
        }),
    );
    if required {
        if let Some(list) = parameters
            .entry("required")
            .or_insert_with(|| json!([]))
            .as_array_mut()
        {
            list.push(json!(REASON_ARGUMENT));
        }
    }
}

/// The call's `reason`, whitespace-collapsed and capped so a prompt stays
/// readable.
fn justification(reason: Option<&Value>) -> Option<String> {
    let collapsed = reason?
        .as_str()?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if collapsed.is_empty() {
        return None;
    }
    if collapsed.chars().count() <= MAX_JUSTIFICATION_CHARS {
        return Some(collapsed);
    }
    let mut capped: String = collapsed
        .chars()
        .take(MAX_JUSTIFICATION_CHARS - 1)
        .collect();
    capped.push('…');
    Some(capped)
}

pub fn tool_schemas() -> Vec<Value> {
    let mut schemas = base_tool_schemas();
    for schema in &mut schemas {
        let name = schema.pointer("/function/name").and_then(Value::as_str);
        if let Some((_, required)) = PROMPTING_TOOLS.iter().find(|(tool, _)| Some(*tool) == name) {
            add_reason_argument(schema, *required);
        }
    }
    schemas
}

fn base_tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "read",
                "description": "Read a file from the filesystem. Returns line-numbered content. Read a file before you change it. For a large file, find the place with grep first and read only that part with offset and limit. Also reads a picture (png, jpg, gif, webp), which you then see, a PDF as text and a Jupyter notebook as its cells.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File path, relative to the project root or absolute" },
                        "offset": { "type": "integer", "description": "1-based line number to start reading from" },
                        "limit": { "type": "integer", "description": "Maximum number of lines to read (default 2000)" },
                        "pages": { "type": "string", "description": "PDF only: the pages to read, e.g. \"3\" or \"1-5\" (default: the first 10)" }
                    },
                    "required": ["path"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "write",
                "description": "Create a new file, or replace all of an existing one, with the given content. Prefer edit for existing files: it sends only what changes. An existing file has to be read before it can be replaced.",
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
                "description": "Replace a string in an existing file. old_string must be the exact current text without the line-number prefix from read; minor indentation and whitespace differences are tolerated. It must match uniquely unless replace_all is true: include a few neighbouring lines when the text occurs more than once. The result shows the lines around the change, so the file need not be read again to check it.",
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
                "description": "Find files by name with a glob pattern, e.g. '**/*.ts'. Respects .gitignore. Use it instead of find or ls -R in bash.",
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
                "description": "Search file contents with a regular expression. Returns path:line: text. Set context to see the code around each match instead of reading the whole file, and output \"files\" to find where something lives before looking closer.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Rust/RE2-style regular expression" },
                        "path": { "type": "string", "description": "Directory to search in (default project root)" },
                        "include": { "type": "string", "description": "Glob filter for file paths, e.g. '*.ts'" },
                        "ignore_case": { "type": "boolean", "description": "Match letters whatever their case" },
                        "context": { "type": "integer", "description": "Lines to show before and after each match (default 0, max 10)" },
                        "output": { "type": "string", "enum": ["lines", "files"], "description": "\"lines\" (default) returns every matching line; \"files\" returns only the matching files, each with its number of matches" },
                        "limit": { "type": "integer", "description": "Maximum number of matches, or of files with output \"files\" (default 200, max 1000)" }
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
                "description": "Run a shell command in the project: tests, builds, git and other project commands. To read, search or change files use read, grep, glob and edit instead of cat, grep, find or sed. A command still running after timeout_seconds keeps running in the background (dev servers, watchers) and can be stopped by the user; read the rest of its output with bash_output. Keep each call to one task: when one part of a long `;`/`&&` chain needs approval, the whole line waits. Put temporary files in the scratch folder named in the environment section, not in /tmp.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "Shell command to run" },
                        "cwd": { "type": "string", "description": "Working directory (default project root)" },
                        "timeout_seconds": { "type": "integer", "description": "Seconds to wait for the command before it is moved to the background (default 10, max 600). Set it for builds and test runs that take longer." }
                    },
                    "required": ["command"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "bash_output",
                "description": "Wait for a command that bash moved to the background and read what it has printed since you last looked, with how it ended. Use it to get the result of a long build or test run instead of running the command again.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "The process id from the bash result" },
                        "wait_seconds": { "type": "integer", "description": "Wait up to this long for the command to finish (default 30, max 300). 0 answers at once." }
                    },
                    "required": ["id"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "screenshot",
                "description": "Show the user a picture in the chat: a page of the running app rendered in a headless browser (url), or an image or HTML file (path). Use it after a change to the user interface so the user sees the result and can react to it. You do not see the picture yourself; the result lists what the page logged to the browser console, errors included. To get the user's verdict, follow up with the question tool.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": { "type": "string", "description": "Page to render, e.g. http://localhost:4200/settings. Start the dev server with bash first." },
                        "path": { "type": "string", "description": "Instead of url: an image (png, jpg, webp, gif) to show as it is, or an HTML file to render" },
                        "caption": { "type": "string", "description": "A few words on what the picture shows" },
                        "width": { "type": "integer", "description": "Viewport width in pixels (default 1280)" },
                        "height": { "type": "integer", "description": "Viewport height in pixels (default 800). Use a tall viewport to show a long page." }
                    }
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "webfetch",
                "description": "Fetch a URL and return its readable text. The user must approve each website the first time; say why you need it in reason.",
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
                "description": "Ask the user one or more questions and wait for their answers before continuing. Use this whenever you are blocked on a decision, need a preference, or requirements are ambiguous instead of guessing or ending your turn with an open question. Provide concise options when a small set of choices covers the answer; the user can always type a custom answer. Mark the option you would pick with recommended, and set multiSelect when several options can apply at once. Ask several related questions in one call.",
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
                                                "description": { "type": "string", "description": "Optional clarification of what this option means" },
                                                "recommended": { "type": "boolean", "description": "Set true on the option you recommend (list it first and say why in its description); the user sees it marked as recommended. Do not add \"(Recommended)\" to the label." }
                                            },
                                            "required": ["label"]
                                        }
                                    },
                                    "multiSelect": { "type": "boolean", "description": "Set true when the options are not mutually exclusive so the user can pick several (checkboxes); the answer's selected list then holds every picked label. Defaults to false (pick one)." }
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
                "description": "Spawn a subagent to work on a focused task in parallel with the main agent. The subagent has the same tools and project access, runs its own tool loop, and returns a concise report when done. Use this to parallelize independent work (e.g. investigate several areas at once, or offload a self-contained subtask). Multiple task calls in one turn run concurrently. For a question that takes searching or reading many files, use mode \"explore\": the files stay out of your own context and you get back only what matters. After a larger or risky change, mode \"verify\" has a second agent check it with fresh eyes.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "description": { "type": "string", "description": "Short 3-5 word name for the subagent, shown in the UI" },
                        "prompt": { "type": "string", "description": "Detailed instructions for the subagent. Include everything it needs; it cannot see this conversation." },
                        "mode": { "type": "string", "enum": ["explore", "verify"], "description": "Set to \"explore\" for a subagent that only searches and reads: it cannot edit files and reports what it found as path:line references. Set to \"verify\" for one that checks your work: it is given the list of changed files, runs the project's checks without editing, and reports PASS or FAIL per check; say in prompt what the change is meant to do. Omit for a subagent that does the work itself." },
                        "model": { "type": "string", "description": "Set only when the user asked for a specific model for this subagent: the model as the user named it (e.g. \"deepseek flash\"), or an exact model id. Do not guess or complete an id; pumr matches the name against the connected providers and asks the user when it fits several models. Omit to use the default subagent model." }
                    },
                    "required": ["description", "prompt"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "todo",
                "description": "Keep a task list for work that takes three or more steps. The user sees it, and it is handed back to you when earlier messages are compacted, so progress survives a long session. Send the whole list every time. Mark a task in_progress before you start it and completed as soon as it is done, with one task in_progress at a time. Leave it out for small tasks.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "todos": {
                            "type": "array",
                            "description": "The whole task list, in the order the tasks are worked on.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "content": { "type": "string", "description": "What to do, in a few words" },
                                    "status": { "type": "string", "enum": ["pending", "in_progress", "completed"] }
                                },
                                "required": ["content", "status"]
                            }
                        }
                    },
                    "required": ["todos"]
                }
            }
        }),
    ]
}

/// The agent's `todo` call: stores the task list it sent for the session and
/// answers with the list as it now stands. Handled apart from `execute`,
/// which has no database.
pub fn write_todos(db: &Db, session_id: &str, arguments: &Value) -> ToolOutcome {
    let Some(entries) = arguments.get("todos").and_then(Value::as_array) else {
        return ToolOutcome::error("The todo tool requires a 'todos' array.");
    };
    let todos: Vec<Value> = entries
        .iter()
        .filter_map(|entry| {
            let content = entry.get("content").and_then(Value::as_str)?.trim();
            let status = entry
                .get("status")
                .and_then(Value::as_str)
                .filter(|status| matches!(*status, "in_progress" | "completed"))
                .unwrap_or("pending");
            (!content.is_empty()).then(|| json!({ "content": content, "status": status }))
        })
        .collect();
    let stored = Value::Array(todos).to_string();
    if let Err(error) = db.set_session_todos(session_id, &stored) {
        return ToolOutcome::error(format!("Could not store the task list: {error}"));
    }
    match render_todos(&stored) {
        Some(list) => ToolOutcome::ok(format!("Task list updated.\n{list}")),
        None => ToolOutcome::ok("Task list cleared.".to_string()),
    }
}

/// A stored task list as a checklist, or `None` when it is empty.
pub fn render_todos(stored: &str) -> Option<String> {
    let todos: Vec<Value> = serde_json::from_str(stored).unwrap_or_default();
    let lines: Vec<String> = todos
        .iter()
        .filter_map(|entry| {
            let content = entry.get("content").and_then(Value::as_str)?;
            Some(match entry.get("status").and_then(Value::as_str) {
                Some("completed") => format!("- [x] {content}"),
                Some("in_progress") => format!("- [ ] {content} (in progress)"),
                _ => format!("- [ ] {content}"),
            })
        })
        .collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

pub async fn execute(runtime: &mut ToolRuntime, name: &str, arguments: &Value) -> ToolOutcome {
    // A direct MCP tool may declare its own `reason`; `call_mcp_tool` decides.
    if !name.starts_with("mcp__") {
        runtime.justification = justification(arguments.get(REASON_ARGUMENT));
    }
    match name {
        "read" => read_file(runtime, arguments).await,
        "write" => write_file(runtime, arguments).await,
        "edit" => edit_file(runtime, arguments).await,
        "glob" => glob_files(runtime, arguments).await,
        "grep" => grep_files(runtime, arguments).await,
        "ls" => list_dir(runtime, arguments).await,
        "bash" => run_bash(runtime, arguments).await,
        "bash_output" => bash_output(runtime, arguments).await,
        "screenshot" => crate::screenshot::take(runtime, arguments).await,
        "webfetch" => web_fetch(runtime, arguments).await,
        "websearch" => web_search(runtime, arguments).await,
        "question" => ask_question(runtime, arguments).await,
        "skill" => load_skill(runtime, arguments).await,
        "tool_search" => search_mcp_tools(runtime, arguments).await,
        "mcp_invoke" => invoke_mcp_tool(runtime, arguments).await,
        other if other.starts_with("mcp__") => call_mcp_tool(runtime, other, arguments).await,
        other => ToolOutcome::error(format!("Unknown tool: {other}")),
    }
}

/// Schema for the progressive-disclosure search tool. Added to the tool set
/// only when MCP schemas are deferred (see `agent::build_tool_schemas`).
pub fn tool_search_schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "tool_search",
            "description": "Search the connected MCP tools by keyword and get their input schema. Use this when you need an MCP capability that is not already in your tool list, then call it with mcp_invoke.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Keywords describing the capability you need" },
                    "limit": { "type": "integer", "description": "Maximum number of matches (default 8, max 20)" }
                },
                "required": ["query"]
            }
        }
    })
}

/// Schema for invoking a deferred MCP tool by name.
pub fn mcp_invoke_schema() -> Value {
    let mut schema = json!({
        "type": "function",
        "function": {
            "name": "mcp_invoke",
            "description": "Invoke an MCP tool by its exposed name. Find the name and its input schema with tool_search first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "tool": { "type": "string", "description": "The exposed MCP tool name, e.g. mcp__server__tool" },
                    "arguments": { "type": "object", "description": "Arguments object matching the tool's input schema" }
                },
                "required": ["tool"]
            }
        }
    });
    add_reason_argument(&mut schema, true);
    schema
}

/// Schema for loading a discovered skill's instructions on demand.
pub fn skill_schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "skill",
            "description": "Load a skill's full instructions by name. The available skills are listed in your system prompt. Use this when a skill applies to the user's request.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "The skill name to load" }
                },
                "required": ["name"]
            }
        }
    })
}

async fn load_skill(runtime: &mut ToolRuntime, arguments: &Value) -> ToolOutcome {
    let name = arguments
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() {
        return ToolOutcome::error("The skill tool requires a 'name'.");
    }
    let Some(entry) = runtime
        .skills
        .iter()
        .find(|skill| skill.name == name)
        .cloned()
    else {
        let available: Vec<&str> = runtime
            .skills
            .iter()
            .map(|skill| skill.name.as_str())
            .collect();
        return ToolOutcome::error(format!(
            "No skill named '{name}'. Available skills: {}.",
            if available.is_empty() {
                "(none)".to_string()
            } else {
                available.join(", ")
            }
        ));
    };

    match crate::discovery::skill_instructions(&name, Path::new(&entry.path)) {
        Some(instructions) => ToolOutcome::ok(instructions),
        None => ToolOutcome::error(format!("Skill '{name}' has no readable instructions.")),
    }
}

async fn search_mcp_tools(runtime: &mut ToolRuntime, arguments: &Value) -> ToolOutcome {
    let Some(manager) = runtime.mcp.clone() else {
        return ToolOutcome::error("No MCP tools are available in this session.");
    };
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if query.is_empty() {
        return ToolOutcome::error("The tool_search query is empty.");
    }
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(8)
        .clamp(1, 20) as usize;
    let matches = manager.search(&query, limit);
    if matches.is_empty() {
        return ToolOutcome::ok(format!(
            "No MCP tools match '{query}'. Try different keywords."
        ));
    }
    let mut output = format!("MCP tools matching '{query}':\n");
    for tool in matches {
        output.push_str(&format!(
            "\n- {} (server: {})\n  {}\n  input schema: {}\n",
            tool.exposed_name, tool.server, tool.description, tool.input_schema
        ));
    }
    output.push_str(
        "\nCall one with mcp_invoke: { tool: <exposed name>, arguments: <input object> }.",
    );
    ToolOutcome::ok(output)
}

async fn invoke_mcp_tool(runtime: &mut ToolRuntime, arguments: &Value) -> ToolOutcome {
    let Some(name) = arguments.get("tool").and_then(Value::as_str) else {
        return ToolOutcome::error("mcp_invoke requires the 'tool' exposed MCP tool name.");
    };
    let call_arguments = arguments
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    call_mcp_tool(runtime, name, &call_arguments).await
}

async fn call_mcp_tool(runtime: &mut ToolRuntime, name: &str, arguments: &Value) -> ToolOutcome {
    let Some(manager) = runtime.mcp.clone() else {
        return ToolOutcome::error(format!("MCP tool '{name}' is not available."));
    };
    // The `reason` we add to MCP schemas is for the prompt, not the server;
    // a tool that declares its own `reason` keeps it.
    let mut arguments = arguments.clone();
    if !manager.declares_argument(name, REASON_ARGUMENT) {
        if let Some(reason) = arguments
            .as_object_mut()
            .and_then(|object| object.remove(REASON_ARGUMENT))
        {
            if runtime.justification.is_none() {
                runtime.justification = justification(Some(&reason));
            }
        }
    }
    let arguments = &arguments;
    let preview = serde_json::json!({ "tool": name, "arguments": arguments }).to_string();
    // MCP tools run server-side and bypass the built-in command gate, so every
    // call needs the user's decision: one made for this call, or one they
    // asked to be remembered for this tool of this exact server.
    let grant = manager.tool_grant(name);
    // In a mode that changes no files, a tool that does not say it only reads
    // could change them on its server's side. An approval the user gave it
    // for other work does not cover that, and none is remembered from here.
    let unvouched = runtime.read_only && !manager.reads_only(name);
    let grant = grant.filter(|_| !unvouched);
    let remembered = grant.as_ref().and_then(|grant| {
        runtime
            .permissions
            .mcp_tool_grant_scope(&runtime.conversation_id, grant)
    });
    if let Some(scope) = remembered {
        let reason = match scope {
            crate::permissions::McpGrantScope::Always => {
                "remembered approval: MCP tool always allowed"
            }
            crate::permissions::McpGrantScope::Chat => {
                "remembered approval: MCP tool allowed in this chat"
            }
        };
        audit_unprompted(runtime, "command", &preview, true, reason.to_string());
        return run_mcp_tool(runtime, &manager, name, arguments).await;
    }
    let decision = runtime
        .broker
        .ask(
            PermissionPrompt {
                kind: "command".to_string(),
                operation: PermissionOperation::McpTool,
                cwd: Some(permission_path(&runtime.project_root)),
                project_root: runtime.project_root.clone(),
                title: format!("Run MCP tool {name}?"),
                detail: if unvouched {
                    "This chat is in a mode that changes no files, and this MCP tool does not say that it only reads. Review the arguments before allowing."
                } else {
                    "The assistant wants to call an MCP server tool. Review the arguments before allowing."
                }
                .to_string(),
                command: Some(preview),
                path: None,
                folder: None,
                url: None,
                suggested_rule: None,
                segments: Vec::new(),
                risk: None,
                scope_options: Vec::new(),
                folders: Vec::new(),
                hosts: Vec::new(),
                grant_session_id: runtime.conversation_id.clone(),
                mcp_tool: grant,
                secret_folders: Vec::new(),
                justification: runtime.justification.clone(),
            },
            &runtime.cancel,
            &runtime.session_id,
            &runtime.emit,
        )
        .await;
    if !decision.allowed {
        return ToolOutcome::refused(&decision);
    }
    run_mcp_tool(runtime, &manager, name, arguments).await
}

/// Calls an MCP tool the user has allowed and turns its answer into a result.
async fn run_mcp_tool(
    runtime: &ToolRuntime,
    manager: &McpManager,
    name: &str,
    arguments: &Value,
) -> ToolOutcome {
    // Stop ends the call even when the server does not answer.
    let result = tokio::select! {
        _ = runtime.cancel.cancelled() => return ToolOutcome::cancelled(),
        result = manager.call(name, arguments.clone()) => result,
    };
    match result {
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
                        let (label, suffixed) = strip_recommended_suffix(label);
                        Some(QuestionOption {
                            label: label.to_string(),
                            description: entry
                                .get("description")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            recommended: suffixed
                                || entry
                                    .get("recommended")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
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

/// Older system prompts (still saved in users' settings) tell the model to
/// mark its pick by appending "(Recommendation)" to the label. Strips such a
/// marker so the UI shows a badge instead, and reports whether one was found.
fn strip_recommended_suffix(label: &str) -> (&str, bool) {
    const MARKERS: [&str; 4] = [
        "(recommended)",
        "(recommendation)",
        "[recommended]",
        "[recommendation]",
    ];
    // ASCII lowercasing keeps byte offsets, and every marker is ASCII, so the
    // cut below always lands on a char boundary.
    let lower = label.to_ascii_lowercase();
    for marker in MARKERS {
        if lower.ends_with(marker) {
            let stripped = label[..label.len() - marker.len()]
                .trim_end_matches(|c: char| c.is_whitespace() || matches!(c, '-' | '–' | '—'));
            if !stripped.is_empty() {
                return (stripped, true);
            }
        }
    }
    (label, false)
}

pub(crate) fn arg_str(arguments: &Value, key: &str) -> Result<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| AppError::msg(format!("Missing argument '{key}'")))
}

pub(crate) fn relative_display(runtime: &ToolRuntime, path: &Path) -> String {
    if let Ok(relative) = path.strip_prefix(&runtime.project_root) {
        return relative.to_string_lossy().replace('\\', "/");
    }
    for folder in &runtime.permissions.folders_for(&runtime.conversation_id) {
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
    // A file in the scratch folder or another folder the user opened is
    // judged below that folder: the names above it (`~/.cache`, `/tmp`) say
    // nothing about the file, and neither does the project's `.gitignore`.
    if !path.starts_with(&runtime.project_root) {
        // An exemption may name such a file by its whole path.
        if runtime.file_ignore.is_exempt(&relative) {
            return None;
        }
        let below = relative_display(runtime, path);
        return runtime.file_ignore.ignore_reason(&below, false);
    }
    let probe = GitProbe {
        project_root: &runtime.project_root,
        shadow: Some(&runtime.shadow),
    };
    let gitignored = !relative.is_empty() && probe.is_ignored(&relative);
    runtime.file_ignore.ignore_reason(&relative, gitignored)
}

/// Canonicalize existing resources, but retain the full absolute path for new files.
fn permission_path(path: &Path) -> PathBuf {
    path.canonicalize()
        .unwrap_or_else(|_| std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf()))
}

pub(crate) async fn ensure_path_access(
    runtime: &mut ToolRuntime,
    absolute: &Path,
    label: &str,
    operation: PermissionOperation,
) -> std::result::Result<(), ToolOutcome> {
    let extra = runtime.permissions.folders_for(&runtime.conversation_id);
    if permissions::path_is_inside(absolute, &runtime.project_root, &extra)
        && !permissions::symlink_escapes(absolute, &runtime.project_root, &extra)
    {
        return Ok(());
    }
    // A skill's instructions refer to the files next to them, which are named
    // to the agent when it loads the skill. Reading those is part of using a
    // skill the user enabled; writing there or running something is not.
    if operation == PermissionOperation::Read
        && runtime.skills.iter().any(|skill| {
            let folder = Path::new(&skill.path);
            permissions::path_is_inside(absolute, folder, &[])
                && !permissions::symlink_escapes(absolute, folder, &[])
        })
    {
        return Ok(());
    }
    let folder = if absolute.is_dir() {
        absolute.to_path_buf()
    } else {
        absolute
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| absolute.to_path_buf())
    };
    // Granting the home directory or `/` would open everything below it, so
    // a path directly in one of them can only be allowed once.
    let folder = (!permissions::is_too_broad_folder(&folder)).then(|| folder.display().to_string());
    let decision = runtime
        .broker
        .ask(
            PermissionPrompt {
                kind: "folder".to_string(),
                operation,
                cwd: Some(permission_path(&runtime.project_root)),
                project_root: runtime.project_root.clone(),
                title: format!("Access {label} outside the project?"),
                detail: format!("The assistant wants to access {}.", absolute.display()),
                command: None,
                path: Some(permission_path(absolute).display().to_string()),
                folder,
                url: None,
                suggested_rule: None,
                segments: Vec::new(),
                risk: None,
                scope_options: Vec::new(),
                folders: Vec::new(),
                hosts: Vec::new(),
                grant_session_id: runtime.conversation_id.clone(),
                mcp_tool: None,
                secret_folders: Vec::new(),
                justification: runtime.justification.clone(),
            },
            &runtime.cancel,
            &runtime.session_id,
            &runtime.emit,
        )
        .await;
    if decision.allowed {
        Ok(())
    } else {
        Err(ToolOutcome::refused(&decision))
    }
}

/// Whether `path` is an environment file that the user's rules keep from the
/// agent. Writing one takes the user's yes, as a credential file does; a
/// template such as `.env.example` or a file the user exempted does not.
fn guarded_env_file(runtime: &ToolRuntime, path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default();
    permissions::is_env_file(&name)
        && !permissions::is_env_example(&name)
        // The switch of the rule is private to the rules: whether they hide a
        // plain `.env` says how it stands.
        && runtime.file_ignore.category_reason(Path::new(".env")).is_some()
        // Exempted by the path `read` judges it by (see `file_ignore_reason`).
        && !runtime.file_ignore.is_exempt(&ignore_relative(runtime, path))
        && !runtime.file_ignore.is_exempt(&relative_display(runtime, path))
}

async fn ensure_write_access(
    runtime: &mut ToolRuntime,
    absolute: &Path,
) -> std::result::Result<(), ToolOutcome> {
    ensure_path_access(runtime, absolute, "file", PermissionOperation::Write).await?;
    let relative = relative_display(runtime, absolute);
    if runtime.file_ignore.sensitive_reason(absolute).is_none()
        && !guarded_env_file(runtime, absolute)
    {
        return Ok(());
    }
    let reason = "this is a sensitive file (env, key, database, credentials)".to_string();
    let decision = runtime
        .broker
        .ask(
            PermissionPrompt {
                kind: "file".to_string(),
                operation: PermissionOperation::Write,
                cwd: Some(permission_path(&runtime.project_root)),
                project_root: runtime.project_root.clone(),
                title: format!("Modify {}?", relative),
                detail: format!("The assistant wants to modify {relative}, but {reason}."),
                command: None,
                path: Some(permission_path(absolute).display().to_string()),
                folder: None,
                url: None,
                suggested_rule: None,
                segments: Vec::new(),
                risk: None,
                scope_options: Vec::new(),
                folders: Vec::new(),
                hosts: Vec::new(),
                grant_session_id: runtime.conversation_id.clone(),
                mcp_tool: None,
                secret_folders: Vec::new(),
                justification: runtime.justification.clone(),
            },
            &runtime.cancel,
            &runtime.session_id,
            &runtime.emit,
        )
        .await;
    if decision.allowed {
        Ok(())
    } else {
        Err(ToolOutcome::refused(&decision))
    }
}

async fn read_file(runtime: &mut ToolRuntime, arguments: &Value) -> ToolOutcome {
    let path = match arg_str(arguments, "path") {
        Ok(path) => path,
        Err(error) => return ToolOutcome::error(error.to_string()),
    };
    let absolute = permissions::resolve_path(&runtime.project_root, &path);
    if let Err(outcome) =
        ensure_path_access(runtime, &absolute, "file", PermissionOperation::Read).await
    {
        return outcome;
    }
    if let Some(reason) = file_ignore_reason(runtime, &absolute) {
        let relative = relative_display(runtime, &absolute);
        return ToolOutcome::error(format!(
            "Refusing to read {relative}: {reason}. Change the file access rules in Settings → Agent rules if the assistant should access it."
        ));
    }
    if let Some(sensitive) = runtime.file_ignore.sensitive_reason(&absolute) {
        let relative = relative_display(runtime, &absolute);
        let decision = runtime
            .broker
            .ask(
                PermissionPrompt {
                    kind: "file".to_string(),
                    operation: PermissionOperation::Read,
                    cwd: Some(permission_path(&runtime.project_root)),
                    project_root: runtime.project_root.clone(),
                    title: format!("Read {relative}?"),
                    detail: format!("{relative} looks like a sensitive file: {sensitive}."),
                    command: None,
                    path: Some(permission_path(&absolute).display().to_string()),
                    folder: None,
                    url: None,
                    suggested_rule: None,
                    segments: Vec::new(),
                    risk: None,
                    scope_options: Vec::new(),
                    folders: Vec::new(),
                    hosts: Vec::new(),
                    grant_session_id: runtime.conversation_id.clone(),
                    mcp_tool: None,
                    secret_folders: Vec::new(),
                    justification: runtime.justification.clone(),
                },
                &runtime.cancel,
                &runtime.session_id,
                &runtime.emit,
            )
            .await;
        if !decision.allowed {
            return ToolOutcome::refused(&decision);
        }
    }
    let bytes = match tokio::fs::read(&absolute).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return ToolOutcome::error(format!("Cannot read {}: {error}", absolute.display()))
        }
    };
    let relative = relative_display(runtime, &absolute);
    // A notebook is shown as its cells, whose lines are not those of the file.
    let (content, numbered) = match read_formats::format_of(&absolute, &bytes) {
        Format::Picture(mime_type) => return read_picture(runtime, &relative, mime_type, &bytes),
        Format::Pdf => return read_pdf(&relative, bytes, arguments).await,
        format => match String::from_utf8(bytes) {
            Ok(text) if format == Format::Notebook => match read_formats::render_notebook(&text) {
                Some(cells) => (cells, false),
                None => (text, true),
            },
            Ok(text) => (text, true),
            Err(error) => {
                let bytes = error.as_bytes();
                return ToolOutcome::error(format!(
                    "{relative} is {} ({} bytes), not UTF-8 text. read shows text files, pictures (png, jpg, gif, webp), PDFs and Jupyter notebooks.",
                    read_formats::binary_kind(bytes),
                    bytes.len()
                ));
            }
        },
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
        if numbered {
            output.push_str(&format!("{}\t{}\n", offset + index, line));
        } else {
            output.push_str(&format!("{line}\n"));
        }
    }
    let shown_end = (offset - 1 + limit).min(lines.len());
    if lines.len() > shown_end {
        output.push_str(&format!(
            "\n… {} has {} lines total; showing {}-{}. Continue with offset={} and the same limit to read on.",
            if numbered { "file" } else { "notebook text" },
            lines.len(),
            offset,
            shown_end,
            shown_end + 1
        ));
    }
    runtime.files.note(&runtime.session_id, &absolute);
    ToolOutcome::ok(output)
}

/// A picture `read` was given. It is stored with the result, which shows it
/// in the chat, and the history hands it to the model after the results of
/// the step (see `agent::stored_history`).
fn read_picture(
    runtime: &ToolRuntime,
    relative: &str,
    mime_type: &str,
    bytes: &[u8],
) -> ToolOutcome {
    if !runtime.vision {
        return ToolOutcome::error(format!(
            "{relative} is a picture, and the model in use does not take pictures. Show it to the user with the screenshot tool (path) and ask what you need to know about it."
        ));
    }
    if bytes.len() > read_formats::MAX_PICTURE_BYTES {
        return ToolOutcome::error(format!(
            "{relative} is {:.1} MB, more than the {} MB a model takes. Save a smaller copy to the scratch folder (for example with `sips -Z 1600` on macOS or ImageMagick's `magick -resize 1600x1600`) and read that.",
            bytes.len() as f64 / (1024.0 * 1024.0),
            read_formats::MAX_PICTURE_BYTES / (1024 * 1024)
        ));
    }
    let mut outcome = ToolOutcome::ok(format!(
        "{relative} is a picture ({mime_type}, {} KB). It follows the tool results of this step.",
        bytes.len().div_ceil(1024)
    ));
    outcome.attachments = vec![read_formats::picture(relative, mime_type, bytes)];
    outcome
}

/// Text of a PDF's pages that one result holds, leaving room for the lines
/// around it.
const PDF_TEXT_BYTES: usize = MAX_TOOL_OUTPUT - 2_000;

/// The text of a PDF: the pages asked for, or its first ones, as many as fit
/// in a result whole.
async fn read_pdf(relative: &str, bytes: Vec<u8>, arguments: &Value) -> ToolOutcome {
    if bytes.len() > read_formats::MAX_PDF_BYTES {
        return ToolOutcome::error(format!(
            "{relative} is {} MB, more than the {} MB read takes a PDF's text from.",
            bytes.len() / (1024 * 1024),
            read_formats::MAX_PDF_BYTES / (1024 * 1024)
        ));
    }
    let parsed = tokio::task::spawn_blocking(move || read_formats::pdf_pages(&bytes)).await;
    let pages = match parsed {
        Ok(Ok(pages)) if !pages.is_empty() => pages,
        Ok(Ok(_)) => return ToolOutcome::error(format!("{relative} is a PDF without pages.")),
        Ok(Err(reason)) => {
            return ToolOutcome::error(format!("Cannot read {relative} as a PDF: {reason}."))
        }
        Err(error) => {
            return ToolOutcome::error(format!("Cannot read {relative} as a PDF: {error}."))
        }
    };
    let total = pages.len();
    let asked = arguments
        .get("pages")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|spec| !spec.is_empty());
    let chosen: Vec<usize> = match asked {
        Some(spec) => match read_formats::page_selection(spec, total) {
            Ok(chosen) => chosen,
            Err(reason) => return ToolOutcome::error(reason),
        },
        None => (1..=total.min(read_formats::DEFAULT_PDF_PAGES)).collect(),
    };
    if chosen.iter().all(|page| pages[page - 1].trim().is_empty()) {
        return ToolOutcome::error(format!(
            "{relative} has no text on {}: it is probably a scan, whose pages are pictures. read cannot show those.",
            if chosen.len() == total { "its pages".to_string() } else { format!("page {}", read_formats::page_ranges(&chosen)) }
        ));
    }

    // Whole pages only: a result cut in the middle of the text would lose
    // the pages the model asked for without saying which.
    let mut shown: Vec<usize> = Vec::new();
    let mut size = 0usize;
    for page in &chosen {
        let length = pages[page - 1].trim().len() + 32;
        if !shown.is_empty() && size + length > PDF_TEXT_BYTES {
            break;
        }
        size += length;
        shown.push(*page);
    }
    let last_shown = shown.last().copied().unwrap_or(1);
    // What is left to read: the rest of what was asked for, or the pages
    // after a first look.
    let last_wanted = match asked {
        Some(_) => chosen.last().copied().unwrap_or(total),
        None => total.min(last_shown + read_formats::DEFAULT_PDF_PAGES),
    };
    let mut output = format!(
        "{relative}: PDF, {total} page(s). Below is the text of page {}.",
        read_formats::page_ranges(&shown)
    );
    if last_shown < last_wanted {
        output.push_str(&format!(
            " Read on with pages=\"{}-{last_wanted}\".",
            last_shown + 1
        ));
    }
    output.push_str("\n\n");
    output.push_str(&read_formats::render_pdf(&pages, &shown));
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
    // Replacing a file takes having read it, and a file `read` refuses is
    // never read: asking the user about it first would waste their yes.
    if absolute.starts_with(&runtime.project_root)
        && !runtime.files.knows(&runtime.session_id, &absolute)
        && std::fs::metadata(&absolute).is_ok_and(|file| file.is_file() && file.len() > 0)
    {
        if let Some(reason) = file_ignore_reason(runtime, &absolute) {
            let relative = relative_display(runtime, &absolute);
            return ToolOutcome::error(format!(
                "{relative} already exists and was not replaced: {reason}, so you cannot read it first. Ask the user to change it, or to allow it in Settings → Agent rules."
            ));
        }
    }
    if let Err(outcome) = ensure_write_access(runtime, &absolute).await {
        return outcome;
    }
    if let Some(parent) = absolute.parent() {
        if let Err(error) = tokio::fs::create_dir_all(parent).await {
            return ToolOutcome::error(format!("Cannot create {}: {error}", parent.display()));
        }
    }
    let existed = absolute.exists();
    let known = runtime.files.knows(&runtime.session_id, &absolute);
    // Read as bytes: a file that is not UTF-8 text holds something as well,
    // and `read` never showed it.
    let old = match String::from_utf8(tokio::fs::read(&absolute).await.unwrap_or_default()) {
        Ok(old) => old,
        Err(error) if !known => {
            let relative = relative_display(runtime, &absolute);
            return ToolOutcome::error(format!(
                "{relative} already exists ({} bytes, not UTF-8 text) and you have not read it in this chat, so it was not replaced. It cannot be read as text: convert or remove it with a command first if it is to be replaced.",
                error.as_bytes().len()
            ));
        }
        // What can be read of it is what the change is counted against.
        Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
    };
    // Replacing a file the agent never looked at loses whatever is in it.
    if !old.trim().is_empty() && !known {
        let relative = relative_display(runtime, &absolute);
        return ToolOutcome::error(format!(
            "{relative} already exists ({} lines) and you have not read it in this chat, so it was not replaced. Read it first; then change it with edit, or call write again to replace all of it.",
            old.lines().count()
        ));
    }
    // `read` shows a file without its `\r`, so the content for a file of
    // `\r\n` lines comes back with `\n` alone: the file keeps its line endings.
    let content =
        if !content.contains('\r') && old.matches("\r\n").count() * 2 > old.matches('\n').count() {
            content.replace('\n', "\r\n")
        } else {
            content
        };
    if let Err(error) = tokio::fs::write(&absolute, &content).await {
        return ToolOutcome::error(format!("Cannot write {}: {error}", absolute.display()));
    }
    runtime.files.note(&runtime.session_id, &absolute);
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
        attachments: Vec::new(),
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
    // The result of an edit shows the lines around it, and a failed one the
    // closest text: a file `read` refuses is not to be seen this way either.
    if let Some(reason) = file_ignore_reason(runtime, &absolute) {
        let relative = relative_display(runtime, &absolute);
        return ToolOutcome::error(format!(
            "Refusing to edit {relative}: {reason}. Change the file access rules in Settings → Agent rules if the assistant should access it."
        ));
    }
    if let Err(outcome) = ensure_write_access(runtime, &absolute).await {
        return outcome;
    }
    let current = match tokio::fs::read_to_string(&absolute).await {
        Ok(content) => content,
        Err(error) => {
            return ToolOutcome::error(format!("Cannot read {}: {error}", absolute.display()))
        }
    };
    let mut applied = apply_edit(&current, &old_string, &new_string, replace_all);
    // Text copied from `read` output with its line numbers still on it.
    if matches!(applied, Err(EditError::NotFound)) {
        if let Some(old) = strip_line_numbers(&old_string) {
            let new = strip_line_numbers(&new_string).unwrap_or_else(|| new_string.clone());
            applied = apply_edit(&current, &old, &new, replace_all);
        }
    }
    let (updated, occurrences) = match applied {
        Ok(applied) => applied,
        Err(EditError::EmptyOldString) => {
            return ToolOutcome::error(
                "old_string must not be empty. Provide the exact current text to replace.",
            )
        }
        Err(EditError::NotFound) => {
            let relative = relative_display(runtime, &absolute);
            return ToolOutcome::error(match closest_text(&current, &old_string) {
                Some(closest) => format!(
                    "old_string was not found in {relative}. The closest text is:\n{closest}\nCopy the text to replace exactly from there, without the line numbers."
                ),
                None => format!(
                    "old_string was not found in {relative}, and nothing in the file is close to it. Read the file with the read tool and copy the exact current text, without line-number prefixes or surrounding quotes."
                ),
            });
        }
        Err(EditError::NotUnique(count)) => {
            return ToolOutcome::error(format!(
                "old_string occurs {count} times. Add more surrounding context to make it unique or set replace_all to true."
            ));
        }
    };
    if let Err(error) = tokio::fs::write(&absolute, &updated).await {
        return ToolOutcome::error(format!("Cannot write {}: {error}", absolute.display()));
    }
    runtime.files.note(&runtime.session_id, &absolute);
    let (additions, deletions) = count_line_changes(&current, &updated);
    let relative = relative_display(runtime, &absolute);
    let loose = if current.contains(&old_string) {
        ""
    } else {
        " old_string matched only with its whitespace or line numbers ignored."
    };
    ToolOutcome {
        result: truncate(format!(
            "Edited {relative} ({occurrences} replacement{}).{loose}{}",
            if occurrences == 1 { "" } else { "s" },
            edited_region(&current, &updated)
        )),
        status: "ok".to_string(),
        changes: vec![FileChange {
            path: relative,
            additions,
            deletions,
            status: "M".to_string(),
        }],
        attachments: Vec::new(),
    }
}

/// Lines of context shown around an edit, and how many lines of it at most.
const EDIT_CONTEXT_LINES: usize = 2;
const EDIT_SHOWN_LINES: usize = 16;
/// Longest line shown in an edit result, in characters.
const EDIT_SHOWN_COLUMNS: usize = 200;

fn numbered_line(number: usize, line: &str) -> String {
    if line.chars().count() <= EDIT_SHOWN_COLUMNS {
        return format!("{number}\t{line}\n");
    }
    let shown: String = line.chars().take(EDIT_SHOWN_COLUMNS).collect();
    format!("{number}\t{shown}…\n")
}

/// What an edit left behind, as the numbered lines around the change: the
/// agent sees where the edit landed and how it sits in its surroundings
/// without reading the file again.
fn edited_region(before: &str, after: &str) -> String {
    let old: Vec<&str> = before.lines().collect();
    let new: Vec<&str> = after.lines().collect();
    let same_start = old
        .iter()
        .zip(&new)
        .take_while(|(left, right)| left == right)
        .count();
    let same_end = old[same_start..]
        .iter()
        .rev()
        .zip(new[same_start..].iter().rev())
        .take_while(|(left, right)| left == right)
        .count();
    let changed_end = new.len() - same_end;
    let from = same_start.saturating_sub(EDIT_CONTEXT_LINES);
    let upto = (changed_end + EDIT_CONTEXT_LINES).min(new.len());
    if from >= upto {
        return String::new();
    }
    let shown = (upto - from).min(EDIT_SHOWN_LINES);
    let mut region = format!(" It now reads, from line {}:\n", from + 1);
    for (index, line) in new[from..from + shown].iter().enumerate() {
        region.push_str(&numbered_line(from + index + 1, line));
    }
    if upto - from > shown {
        region.push_str(&format!(
            "… ({} more lines changed, up to line {upto})\n",
            upto - from - shown
        ));
    }
    region
}

/// `text` without the line numbers `read` puts in front of every line, when
/// every line of it carries one.
fn strip_line_numbers(text: &str) -> Option<String> {
    let mut stripped = Vec::new();
    let mut numbered = false;
    for line in text.lines() {
        let rest = line.trim_start_matches(|character: char| character.is_ascii_digit());
        if rest.len() < line.len() && rest.starts_with('\t') {
            numbered = true;
            stripped.push(&rest[1..]);
        } else if line.trim().is_empty() {
            stripped.push(line);
        } else {
            return None;
        }
    }
    numbered.then(|| stripped.join("\n"))
}

/// How alike two lines are, from 0 to 1: the share of neighbouring character
/// pairs they have in common, whitespace aside.
fn line_similarity(left: &str, right: &str) -> f64 {
    let pairs = |text: &str| -> Vec<(char, char)> {
        let characters: Vec<char> = text
            .chars()
            .filter(|character| !character.is_whitespace())
            .take(EDIT_SHOWN_COLUMNS)
            .collect();
        characters.windows(2).map(|pair| (pair[0], pair[1])).collect()
    };
    let (left, mut right) = (pairs(left), pairs(right));
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let total = left.len() + right.len();
    let mut shared = 0usize;
    for pair in left {
        if let Some(index) = right.iter().position(|other| *other == pair) {
            right.swap_remove(index);
            shared += 1;
        }
    }
    2.0 * shared as f64 / total as f64
}

/// The part of `content` that an `old_string` which matched nowhere most
/// likely meant, as numbered lines: the lines from the one most like its
/// first line. `None` when nothing in the file comes close.
fn closest_text(content: &str, old: &str) -> Option<String> {
    /// Files longer than this are not searched for a near match.
    const MAX_LINES: usize = 20_000;
    let wanted: Vec<&str> = old.lines().collect();
    // The first line with enough on it to tell lines apart.
    let (anchor_at, anchor) = wanted
        .iter()
        .map(|line| line.trim())
        .enumerate()
        .find(|(_, line)| line.len() >= 4)?;
    let lines: Vec<&str> = content.lines().collect();
    if lines.len() > MAX_LINES {
        return None;
    }
    // Reversed, so that of equally close lines the first one wins.
    let (found, score) = lines
        .iter()
        .enumerate()
        .rev()
        .map(|(index, line)| (index, line_similarity(line.trim(), anchor)))
        .max_by(|left, right| left.1.total_cmp(&right.1))?;
    if score < 0.6 {
        return None;
    }
    let start = found.saturating_sub(anchor_at);
    let length = wanted.len().clamp(1, EDIT_SHOWN_LINES);
    let mut closest = String::new();
    for (index, line) in lines.iter().enumerate().skip(start).take(length) {
        closest.push_str(&numbered_line(index + 1, line));
    }
    Some(closest)
}

#[derive(Debug)]
enum EditError {
    EmptyOldString,
    NotFound,
    NotUnique(usize),
}

enum EditMatch {
    Exact(Vec<(usize, usize)>),
    LineTrimmed {
        ranges: Vec<(usize, usize)>,
        old_indent: String,
        target_indent: String,
    },
    Whitespace {
        ranges: Vec<(usize, usize)>,
        old_indent: String,
        target_indent: String,
    },
}

impl EditMatch {
    fn ranges(&self) -> &[(usize, usize)] {
        match self {
            EditMatch::Exact(ranges) => ranges,
            EditMatch::LineTrimmed { ranges, .. } | EditMatch::Whitespace { ranges, .. } => ranges,
        }
    }
}

/// Apply an exact-string edit, falling back to progressively more forgiving
/// matchers so small differences in indentation or whitespace do not fail the
/// edit. Returns the updated content and the number of replacements made.
fn apply_edit(
    content: &str,
    old: &str,
    new: &str,
    replace_all: bool,
) -> std::result::Result<(String, usize), EditError> {
    if old.is_empty() {
        return Err(EditError::EmptyOldString);
    }
    let matched = find_match(content, old);
    let ranges = matched.ranges();
    if ranges.is_empty() {
        return Err(EditError::NotFound);
    }
    if ranges.len() > 1 && !replace_all {
        return Err(EditError::NotUnique(ranges.len()));
    }
    let replacement = match &matched {
        EditMatch::LineTrimmed {
            old_indent,
            target_indent,
            ..
        }
        | EditMatch::Whitespace {
            old_indent,
            target_indent,
            ..
        } => reindent(new, old_indent, target_indent),
        EditMatch::Exact(_) => new.to_string(),
    };
    // `read` shows no `\r`, so the model writes `\n` into a file of `\r\n`
    // lines as well. One it did send is not doubled.
    let crlf = content
        .contains("\r\n")
        .then(|| replacement.replace("\r\n", "\n").replace('\n', "\r\n"));
    let take = if replace_all { ranges.len() } else { 1 };
    let mut result = String::with_capacity(content.len() + replacement.len());
    let mut cursor = 0;
    let mut replaced = 0;
    for (start, end) in ranges.iter().take(take) {
        if *start < cursor {
            continue;
        }
        result.push_str(&content[cursor..*start]);
        let text = match &crlf {
            Some(crlf) if ends_lines_with_crlf(content, *start) => crlf,
            _ => &replacement,
        };
        // A match that began in the middle of a `\r\n` left its `\r` behind.
        result.push_str(match text.strip_prefix('\r') {
            Some(rest) if rest.starts_with('\n') && result.ends_with('\r') => rest,
            _ => text,
        });
        cursor = *end;
        replaced += 1;
    }
    result.push_str(&content[cursor..]);
    Ok((result, replaced))
}

/// Whether the line `position` is on ends in `\r\n`; for a last line without
/// a line break, whether the line before it does.
fn ends_lines_with_crlf(content: &str, position: usize) -> bool {
    content[position..]
        .find('\n')
        .map(|offset| position + offset)
        .or_else(|| content[..position].rfind('\n'))
        .is_some_and(|newline| content[..newline].ends_with('\r'))
}

/// Try an exact byte-for-byte match first, then a line-trimmed match (ignores
/// leading/trailing whitespace on each line), then a whitespace-normalised
/// match (any run of whitespace equals any other).
fn find_match(content: &str, old: &str) -> EditMatch {
    let exact = exact_ranges(content, old);
    if !exact.is_empty() {
        return EditMatch::Exact(exact);
    }
    let trimmed = line_trimmed_ranges(content, old);
    if !trimmed.ranges().is_empty() {
        return trimmed;
    }
    whitespace_ranges(content, old)
}

fn leading_whitespace(line: &str) -> &str {
    &line[..line.len() - line.trim_start().len()]
}

/// Rewrite `new` so its indentation matches the file when `old` was matched
/// with different leading whitespace.
fn reindent(new: &str, old_indent: &str, target_indent: &str) -> String {
    if old_indent == target_indent {
        return new.to_string();
    }
    let mut result = String::with_capacity(new.len());
    for (index, line) in new.split('\n').enumerate() {
        if index > 0 {
            result.push('\n');
        }
        if line.trim().is_empty() {
            result.push_str(line);
            continue;
        }
        match line.strip_prefix(old_indent) {
            Some(rest) => {
                result.push_str(target_indent);
                result.push_str(rest);
            }
            None => result.push_str(line),
        }
    }
    result
}

fn exact_ranges(content: &str, old: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut cursor = 0;
    while let Some(position) = content[cursor..].find(old) {
        let start = cursor + position;
        ranges.push((start, start + old.len()));
        cursor = start + old.len();
    }
    ranges
}

/// A line together with its byte span. `end` includes the trailing newline
/// (if any); `text` excludes it. `content_end` is `start + text.len()`.
struct LineSpan<'a> {
    start: usize,
    end: usize,
    text: &'a str,
}

fn line_spans(content: &str) -> Vec<LineSpan<'_>> {
    let bytes = content.as_bytes();
    let mut spans = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\n' {
            let text_end = if index > start && bytes[index - 1] == b'\r' {
                index - 1
            } else {
                index
            };
            spans.push(LineSpan {
                start,
                end: index + 1,
                text: &content[start..text_end],
            });
            start = index + 1;
        }
        index += 1;
    }
    if start <= content.len() {
        spans.push(LineSpan {
            start,
            end: content.len(),
            text: &content[start..],
        });
    }
    spans
}

fn line_trimmed_ranges(content: &str, old: &str) -> EditMatch {
    let haystack = line_spans(content);
    let needle: Vec<&str> = old.lines().collect();
    let mut target_indent = String::new();
    let mut old_indent = String::new();
    let mut ranges = Vec::new();
    if !needle.is_empty() && needle.len() <= haystack.len() {
        old_indent = leading_whitespace(needle[0]).to_string();
        for index in 0..=(haystack.len() - needle.len()) {
            let matched = needle
                .iter()
                .zip(&haystack[index..index + needle.len()])
                .all(|(expected, span)| expected.trim() == span.text.trim());
            if matched {
                if ranges.is_empty() {
                    target_indent = leading_whitespace(haystack[index].text).to_string();
                }
                let start = haystack[index].start;
                let last = &haystack[index + needle.len() - 1];
                let end = if old.ends_with('\n') {
                    last.end
                } else {
                    last.start + last.text.len()
                };
                ranges.push((start, end));
            }
        }
    }
    EditMatch::LineTrimmed {
        ranges,
        old_indent,
        target_indent,
    }
}

fn normalize_whitespace(text: &str) -> (String, Vec<usize>) {
    let mut normalized = String::with_capacity(text.len());
    let mut map = Vec::with_capacity(text.len());
    let mut in_whitespace = false;
    for (index, character) in text.char_indices() {
        if character.is_whitespace() {
            if !in_whitespace {
                normalized.push(' ');
                map.push(index);
                in_whitespace = true;
            }
        } else {
            let before = normalized.len();
            normalized.push(character);
            for _ in before..normalized.len() {
                map.push(index);
            }
            in_whitespace = false;
        }
    }
    (normalized, map)
}

/// Where the part of `run` begins that the whitespace `lead` at the start of
/// a needle stands for. `run` is all the whitespace in front of the match,
/// which reaches back to the line above: the needle has only as many of its
/// line breaks as `lead` has, and the indentation after the last of them.
fn leading_share(run: &str, lead: &str) -> usize {
    let breaks = lead.matches('\n').count();
    let from = run
        .rmatch_indices('\n')
        .nth(breaks)
        .map_or(0, |(index, _)| index + 1);
    // What stands before the first line break is the end of the line above,
    // and a needle that begins with the break has nothing of it.
    if lead.starts_with(['\n', '\r']) {
        return from + run[from..].find(['\n', '\r']).unwrap_or(0);
    }
    from
}

/// How much of `run`, all the whitespace after a match, the whitespace
/// `trail` at the end of a needle stands for: as many line breaks as `trail`
/// has, and what follows the last of them only when `trail` has that too.
/// The rest is the indentation of the next line.
fn trailing_share(run: &str, trail: &str) -> usize {
    let breaks = trail.matches('\n').count();
    let next_break = run.match_indices('\n').nth(breaks).map(|(index, _)| index);
    let within = &run[..next_break.unwrap_or(run.len())];
    if trail.ends_with('\n') {
        return within.rfind('\n').map_or(within.len(), |index| index + 1);
    }
    match next_break {
        Some(_) => within.trim_end_matches('\r').len(),
        None => within.len(),
    }
}

fn whitespace_ranges(content: &str, old: &str) -> EditMatch {
    let (haystack, map) = normalize_whitespace(content);
    let (needle, _) = normalize_whitespace(old);
    // The whitespace `old` begins and ends with. Normalised it is one space
    // that matches a whole run in the file, and that run also holds the line
    // break and the indentation of the lines next to the match.
    let lead = &old[..old.len() - old.trim_start().len()];
    let trail = &old[old.trim_end().len()..];
    let mut ranges = Vec::new();
    let mut old_indent = String::new();
    let mut target_indent = String::new();
    // Whitespace alone would match every run of it in the file.
    if !old.trim().is_empty() {
        let mut cursor = 0;
        while let Some(position) = haystack[cursor..].find(&needle) {
            let start = cursor + position;
            let end = start + needle.len();
            let mut from = map[start];
            let mut upto = map.get(end).copied().unwrap_or(content.len());
            if !lead.is_empty() {
                let run = &content[from..map[start + 1]];
                // A match that begins its line takes `new` from the
                // indentation `old` came with to the one the file has.
                if ranges.is_empty() && (from == 0 || run.contains('\n')) {
                    old_indent = lead.rsplit('\n').next().unwrap_or_default().to_string();
                    target_indent = run.rsplit('\n').next().unwrap_or_default().to_string();
                }
                from += leading_share(run, lead);
            }
            if !trail.is_empty() {
                let text_end = map[end - 1];
                upto = text_end + trailing_share(&content[text_end..upto], trail);
            }
            ranges.push((from, upto));
            cursor = end;
        }
    }
    EditMatch::Whitespace {
        ranges,
        old_indent,
        target_indent,
    }
}

/// Build a directory walker that never descends into `.git` and that prunes
/// generated/dependency directories (`node_modules`, `target`, `dist`, …)
/// regardless of `scanGeneratedFiles`. That flag only controls whether
/// generated *files* (`*.min.js`, `*.log`, …) are surfaced, so a project with
/// dependencies enabled can still be searched quickly. A user exemption or an
/// explicitly disabled generated rule re-enables the matching subtree.
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
        // Judge directory names only below the project root, so a project that
        // itself lives under e.g. `/tmp` or `~/build` is not pruned whole.
        let inside = path.strip_prefix(&root).unwrap_or(path);
        if inside
            .components()
            .any(|component| component.as_os_str() == ".git")
        {
            return false;
        }
        let relative = inside.to_string_lossy().replace('\\', "/");
        if config.is_exempt(&relative) {
            return true;
        }
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        if is_dir
            && !config.has_exemptions()
            && config.is_generated_path(inside)
            && !config.generated_rule_explicitly_disabled(inside)
        {
            return false;
        }
        true
    });
    builder.build()
}

/// Files and folders `glob` looks at in one search, and matches it lists.
const GLOB_WALK_LIMIT: usize = 100_000;
const GLOB_SHOWN: usize = 500;

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
    if let Err(outcome) =
        ensure_path_access(runtime, &base, "directory", PermissionOperation::Read).await
    {
        return outcome;
    }
    let matcher = match Glob::new(&pattern) {
        Ok(glob) => glob.compile_matcher(),
        Err(error) => return ToolOutcome::error(format!("Invalid pattern: {error}")),
    };
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut walk_cut = false;
    for entry in file_walker(&base, &runtime.project_root, &runtime.file_ignore).flatten() {
        if runtime.cancel.is_cancelled() {
            return ToolOutcome::cancelled();
        }
        if candidates.len() >= GLOB_WALK_LIMIT {
            walk_cut = true;
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
        let relative_to_base = path.strip_prefix(&base).unwrap_or(path);
        if !matcher.is_match(relative_to_base) {
            continue;
        }
        let relative = ignore_relative(runtime, path);
        if runtime
            .file_ignore
            .ignore_reason(&relative, ignored.contains(path))
            .is_some()
        {
            continue;
        }
        results.push(relative_display(runtime, path));
    }
    let walk_note = if walk_cut {
        format!(
            "\n\n… looked at the first {GLOB_WALK_LIMIT} files and folders only. Add path to search a part of the project."
        )
    } else {
        String::new()
    };
    if results.is_empty() {
        return ToolOutcome::ok(format!("No files match '{pattern}'.{walk_note}"));
    }
    // Sorted before it is cut, so the same search shows the same files.
    results.sort();
    let total = results.len();
    results.truncate(GLOB_SHOWN);
    let mut output = results.join("\n");
    if total > GLOB_SHOWN {
        output.push_str(&format!(
            "\n\n… showing the first {GLOB_SHOWN} of {total} matches only. Narrow the pattern or add path to see more."
        ));
    }
    output.push_str(&walk_note);
    ToolOutcome::ok(output)
}

/// Files `grep` looks at in one search.
const GREP_WALK_LIMIT: usize = 200_000;
/// How much of a file's start tells a binary file from text.
const BINARY_PROBE_BYTES: usize = 8_000;

/// Whether a file that is not UTF-8 text is a binary one and not text in
/// another encoding. Judged the way git does, by a NUL byte near the start;
/// UTF-16 text has those too and is known by its byte order mark.
fn looks_binary(start: &[u8]) -> bool {
    let start = &start[..start.len().min(BINARY_PROBE_BYTES)];
    start.contains(&0) && !start.starts_with(&[0xff, 0xfe]) && !start.starts_with(&[0xfe, 0xff])
}

/// The first bytes of a file, as many as `looks_binary` judges by.
fn file_start(path: &Path) -> Vec<u8> {
    use std::io::Read;
    let mut start = Vec::new();
    if let Ok(file) = std::fs::File::open(path) {
        let _ = file.take(BINARY_PROBE_BYTES as u64).read_to_end(&mut start);
    }
    start
}

async fn grep_files(runtime: &mut ToolRuntime, arguments: &Value) -> ToolOutcome {
    let pattern = match arg_str(arguments, "pattern") {
        Ok(pattern) => pattern,
        Err(error) => return ToolOutcome::error(error.to_string()),
    };
    let ignore_case = arguments
        .get("ignore_case")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let regex = match RegexBuilder::new(&pattern)
        .case_insensitive(ignore_case)
        .build()
    {
        Ok(regex) => regex,
        Err(error) => return ToolOutcome::error(format!("Invalid regex: {error}")),
    };
    let context = arguments
        .get("context")
        .and_then(Value::as_u64)
        .map_or(0, |lines| lines.min(10) as usize);
    let files_only = arguments.get("output").and_then(Value::as_str) == Some("files");
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .map_or(200, |limit| limit.clamp(1, 1_000) as usize);
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
    if let Err(outcome) =
        ensure_path_access(runtime, &base, "directory", PermissionOperation::Read).await
    {
        return outcome;
    }
    // A search aimed at one file says why it cannot look into it, as `read`
    // does. In a folder such a file is passed over.
    let single = !base.is_dir();
    if single {
        if let Some(reason) = file_ignore_reason(runtime, &base) {
            let relative = relative_display(runtime, &base);
            return ToolOutcome::error(format!(
                "Refusing to search {relative}: {reason}. Change the file access rules in Settings → Agent rules if the assistant should access it."
            ));
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut walk_cut = false;
    for entry in file_walker(&base, &runtime.project_root, &runtime.file_ignore).flatten() {
        if runtime.cancel.is_cancelled() {
            return ToolOutcome::cancelled();
        }
        if candidates.len() >= GREP_WALK_LIMIT {
            walk_cut = true;
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
    // The same search lists its matches in the same order every time.
    candidates.sort();
    let ignored = if runtime.file_ignore.respect_gitignore {
        ignored_paths(&runtime.project_root, &candidates)
    } else {
        HashSet::new()
    };
    let mut results: Vec<String> = Vec::new();
    // Matches reported, or files with `output: "files"`.
    let mut found = 0usize;
    let mut capped = false;
    // Credential files are read only after a prompt (see `read_file`), so grep
    // leaves them out instead of printing their contents.
    let mut sensitive_skipped = 0usize;
    // Text files left out for their size or their encoding. Binary files are
    // not counted: no search looks into those, and a project full of pictures
    // would have every search say so.
    let (mut too_large, mut not_text) = (0usize, 0usize);
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
            .ignore_reason(&relative, ignored.contains(path))
            .is_some()
        {
            continue;
        }
        if runtime.file_ignore.sensitive_reason(path).is_some() {
            sensitive_skipped += 1;
            continue;
        }
        let metadata = match std::fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.len() > 1_000_000 {
            if single {
                return ToolOutcome::error(format!(
                    "{} is {:.1} MB, more than the 1 MB grep searches. Search it with a command such as rg, or read it in parts.",
                    relative_display(runtime, path),
                    metadata.len() as f64 / 1_000_000.0
                ));
            }
            if !looks_binary(&file_start(path)) {
                too_large += 1;
            }
            continue;
        }
        let content = match std::fs::read(path).map(String::from_utf8) {
            Ok(Ok(content)) => content,
            Ok(Err(error)) => {
                if single {
                    return ToolOutcome::error(format!(
                        "{} is not UTF-8 text, so grep cannot search it.",
                        relative_display(runtime, path)
                    ));
                }
                if !looks_binary(error.as_bytes()) {
                    not_text += 1;
                }
                continue;
            }
            Err(_) => continue,
        };
        let lines: Vec<&str> = content.lines().collect();
        let hits: Vec<usize> = (0..lines.len())
            .filter(|index| regex.is_match(lines[*index]))
            .collect();
        if hits.is_empty() {
            continue;
        }
        if found >= limit {
            capped = true;
            break;
        }
        let display = relative_display(runtime, path);
        if files_only {
            found += 1;
            results.push(format!("{display}: {}", hits.len()));
            continue;
        }
        // End of what was printed of this file, so the context of two close
        // matches is not printed twice.
        let mut printed = 0usize;
        for hit in &hits {
            if found >= limit {
                capped = true;
                break 'outer;
            }
            found += 1;
            if context == 0 {
                results.push(format!("{display}:{}: {}", hit + 1, lines[*hit].trim_end()));
                continue;
            }
            let start = hit.saturating_sub(context).max(printed);
            let end = (hit + context + 1).min(lines.len());
            if !results.is_empty() && (printed == 0 || start > printed) {
                results.push("--".to_string());
            }
            for (index, line) in lines.iter().enumerate().take(end).skip(start) {
                // Like ripgrep: `:` marks a matching line, `-` one of context.
                let mark = if hits.binary_search(&index).is_ok() {
                    ':'
                } else {
                    '-'
                };
                results.push(format!(
                    "{display}{mark}{}{mark} {}",
                    index + 1,
                    line.trim_end()
                ));
            }
            printed = end;
        }
    }
    let files = |count: usize| format!("{count} file{}", if count == 1 { "" } else { "s" });
    let mut skipped: Vec<String> = Vec::new();
    if sensitive_skipped > 0 {
        skipped.push(format!(
            "{sensitive_skipped} file{} that look like credentials or keys were not searched; read one with the read tool to ask the user for access.",
            if sensitive_skipped == 1 { "" } else { "s" }
        ));
    }
    // Text the search did not look into: without a word of it, "no matches"
    // reads as "nowhere in the project".
    let mut unsearched: Vec<String> = Vec::new();
    if too_large > 0 {
        unsearched.push(format!("{} over 1 MB", files(too_large)));
    }
    if not_text > 0 {
        unsearched.push(format!("{} not in UTF-8", files(not_text)));
    }
    if !unsearched.is_empty() {
        skipped.push(format!("Not searched: {}.", unsearched.join(", ")));
    }
    if walk_cut {
        skipped.push(format!(
            "… searched the first {GREP_WALK_LIMIT} files only. Add path to search a part of the project."
        ));
    }
    let skipped_note = (!skipped.is_empty()).then(|| skipped.join("\n"));
    if results.is_empty() {
        let mut output = format!("No matches for '{pattern}'.");
        if let Some(note) = skipped_note {
            output.push_str(&format!("\n\n{note}"));
        }
        return ToolOutcome::ok(output);
    }
    let mut output = results.join("\n");
    if capped {
        output.push_str(&format!(
            "\n\n… showing the first {limit} {} only. Narrow the pattern or add include/path to see more.",
            if files_only { "files" } else { "matches" }
        ));
    }
    if let Some(note) = skipped_note {
        output.push_str(&format!("\n\n{note}"));
    }
    ToolOutcome::ok(output)
}

/// Entries `ls` lists of one folder.
const LIST_SHOWN: usize = 1000;

async fn list_dir(runtime: &mut ToolRuntime, arguments: &Value) -> ToolOutcome {
    let base = arguments
        .get("path")
        .and_then(Value::as_str)
        .map(|path| permissions::resolve_path(&runtime.project_root, path))
        .unwrap_or_else(|| runtime.project_root.clone());
    if let Err(outcome) =
        ensure_path_access(runtime, &base, "directory", PermissionOperation::Read).await
    {
        return outcome;
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
            .ignore_reason(&relative, ignored.contains(path))
            .is_none()
    });
    items.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(a.1.to_lowercase().cmp(&b.1.to_lowercase()))
    });
    let total = items.len();
    let mut output = items
        .into_iter()
        .take(LIST_SHOWN)
        .map(|(is_dir, name, _)| if is_dir { format!("{name}/") } else { name })
        .collect::<Vec<_>>()
        .join("\n");
    // Without this the agent takes an entry beyond the cut for missing.
    if total > LIST_SHOWN {
        output.push_str(&format!(
            "\n\n… showing the first {LIST_SHOWN} of {total} entries only. Use glob with a pattern to find the others."
        ));
    }
    ToolOutcome::ok(output)
}

/// Records a decision made without a prompt in the permission audit log:
/// allowed by a rule, an automatic approval or a read-only check, or denied
/// by a deny rule. Prompted decisions are recorded by the broker.
fn audit_unprompted(
    runtime: &ToolRuntime,
    kind: &str,
    subject: &str,
    allowed: bool,
    reason: String,
) {
    runtime.broker.audit(PermissionAuditEntry {
        id: 0,
        created_at: 0,
        session_id: runtime.session_id.clone(),
        conversation_id: runtime.conversation_id.clone(),
        kind: kind.to_string(),
        subject: subject.to_string(),
        allowed,
        decided_by: if allowed { "auto" } else { "rule" }.to_string(),
        decision: None,
        reason,
        rule: None,
    });
}

pub(crate) enum WebsiteAccess {
    Allowed,
    DeniedByRule(String),
    /// The prompt ended without an allow; `decided_by` says who ended it.
    Refused(PermissionDecision),
}

/// Ask the user for permission before the agent reaches a website. Rules are
/// matched against the host: deny rules win, then allow rules, then the user.
pub(crate) async fn ensure_website_access(
    runtime: &mut ToolRuntime,
    url: &str,
    kind: &str,
) -> WebsiteAccess {
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
        WebsiteDecision::Allow => {
            audit_unprompted(
                runtime,
                kind,
                url,
                true,
                format!("{host} is on the allowed websites list"),
            );
            WebsiteAccess::Allowed
        }
        WebsiteDecision::Deny { reason } => {
            audit_unprompted(runtime, kind, url, false, reason.clone());
            WebsiteAccess::DeniedByRule(reason)
        }
        WebsiteDecision::Ask {
            reason,
            suggested_rule,
        } => {
            let decision = runtime
                .broker
                .ask(
                    PermissionPrompt {
                        kind: kind.to_string(),
                        operation: PermissionOperation::Fetch,
                        cwd: Some(permission_path(&runtime.project_root)),
                        project_root: runtime.project_root.clone(),
                        title: format!("Visit {host}?"),
                        detail: reason,
                        command: None,
                        path: None,
                        folder: None,
                        url: Some(url.to_string()),
                        suggested_rule: Some(suggested_rule),
                        segments: Vec::new(),
                        risk: None,
                        scope_options: Vec::new(),
                        folders: Vec::new(),
                        hosts: Vec::new(),
                        grant_session_id: runtime.conversation_id.clone(),
                        mcp_tool: None,
                        secret_folders: Vec::new(),
                        justification: runtime.justification.clone(),
                    },
                    &runtime.cancel,
                    &runtime.session_id,
                    &runtime.emit,
                )
                .await;
            if decision.allowed {
                WebsiteAccess::Allowed
            } else {
                WebsiteAccess::Refused(decision)
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
/// unique-local, carrier-grade NAT, benchmarking, reserved, unspecified,
/// multicast and similar (SSRF protection). IPv6 forms that embed an IPv4
/// address (mapped `::ffff:a.b.c.d`, compatible, NAT64 `64:ff9b::/96` and
/// 6to4 `2002::/16`) are judged by that IPv4 address.
fn blocked_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let [first, second, ..] = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_multicast()
                || first == 0
                // 100.64.0.0/10 carrier-grade NAT.
                || (first == 100 && (second & 0xc0) == 64)
                // 198.18.0.0/15 benchmarking.
                || (first == 198 && (second & 0xfe) == 18)
                // 192.0.0.0/24 IETF protocol assignments.
                || (first == 192 && second == 0 && v4.octets()[2] == 0)
                // 240.0.0.0/4 reserved.
                || first >= 240
        }
        std::net::IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4() {
                // `::1` is also "compatible" with 0.0.0.1, which is blocked.
                return blocked_ip(std::net::IpAddr::V4(v4));
            }
            let segments = v6.segments();
            if segments[0] == 0x0064 && segments[1] == 0xff9b {
                let [a, b] = segments[6].to_be_bytes();
                let [c, d] = segments[7].to_be_bytes();
                return blocked_ip(std::net::IpAddr::V4(std::net::Ipv4Addr::new(a, b, c, d)));
            }
            if segments[0] == 0x2002 {
                let [a, b] = segments[1].to_be_bytes();
                let [c, d] = segments[2].to_be_bytes();
                return blocked_ip(std::net::IpAddr::V4(std::net::Ipv4Addr::new(a, b, c, d)));
            }
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                // fec0::/10 deprecated site-local.
                || (segments[0] & 0xffc0) == 0xfec0
                // 2001:db8::/32 documentation.
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        }
    }
}

/// Resolves the URL host and rejects it when any resolved address is non-public.
/// This runs on every hop so a redirect cannot reach internal services after
/// the initial allowlist check. The checked addresses are returned so the
/// request connects to exactly those: resolving the name a second time would
/// let a DNS rebind swap in a private address after the check.
async fn ensure_host_public(
    url: &reqwest::Url,
) -> std::result::Result<Vec<std::net::SocketAddr>, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "The URL does not contain a valid host.".to_string())?;
    let port = url.port_or_known_default().unwrap_or(443);
    let lookup = host.trim_start_matches('[').trim_end_matches(']');
    let addresses: Vec<std::net::SocketAddr> = tokio::net::lookup_host((lookup, port))
        .await
        .map_err(|error| format!("Could not resolve {host}: {error}"))?
        .collect();
    if addresses.is_empty() {
        return Err(format!("Could not resolve {host}."));
    }
    if addresses.iter().any(|address| blocked_ip(address.ip())) {
        return Err(format!(
            "{host} resolves to a non-public address and was blocked."
        ));
    }
    Ok(addresses)
}

/// An HTTP client for one hop of `web_fetch`: it never follows redirects on
/// its own and connects to `host` only at the pre-checked `addresses`.
fn pinned_client(
    host: &str,
    addresses: &[std::net::SocketAddr],
) -> std::result::Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent("pumr/0.1")
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(WEB_TIMEOUT_SECONDS))
        // A proxy would resolve the name itself and bypass the pinned address.
        .no_proxy();
    // An IP literal needs no resolution; a name is pinned to what was checked.
    if host.parse::<std::net::IpAddr>().is_err() {
        builder = builder.resolve_to_addrs(host, addresses);
    }
    builder
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))
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
        WebsiteAccess::Refused(decision) => return ToolOutcome::refused(&decision),
    }

    // Follow redirects manually so every hop is re-checked against the website
    // rules and the private-address block, then fetch the final URL. Each hop
    // connects only to the addresses that passed the block.
    let mut current = parsed.clone();
    let mut redirects = 0;
    let response = loop {
        let addresses = match ensure_host_public(&current).await {
            Ok(addresses) => addresses,
            Err(reason) => return ToolOutcome::error(reason),
        };
        let client = match pinned_client(current.host_str().unwrap_or_default(), &addresses) {
            Ok(client) => client,
            Err(error) => return ToolOutcome::error(error),
        };
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
                WebsiteAccess::Refused(decision) => return ToolOutcome::refused(&decision),
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
        WebsiteAccess::Refused(decision) => return ToolOutcome::refused(&decision),
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
    if let Err(outcome) =
        ensure_path_access(runtime, &cwd, "directory", PermissionOperation::Access).await
    {
        return outcome;
    }

    let mut trace: Vec<String> = Vec::new();
    // A project path is restorable when the turn's snapshot holds it: nothing
    // at or below it is ignored, except output a build recreates.
    let shadow = runtime.shadow.clone();
    let restorable = move |path: &Path| {
        shadow.ignored_entries(path).is_some_and(|entries| {
            entries
                .iter()
                .all(|entry| permissions::is_regenerable(entry))
        })
    };
    let decision = runtime.permissions.evaluate_command(
        &command,
        &runtime.project_root,
        &cwd,
        &runtime.conversation_id,
        Some(&restorable),
        &mut trace,
    );
    // What a prompt for this call names, and the user says yes to with it.
    let mut asked = Asked::default();
    if let CommandDecision::Ask {
        outside_folders,
        secret_folders,
        hosts,
        ..
    } = &decision
    {
        asked.folders = outside_folders.iter().map(PathBuf::from).collect();
        asked.secrets = secret_folders.iter().map(PathBuf::from).collect();
        asked.hosts = !hosts.is_empty();
    }
    match &decision {
        CommandDecision::Deny { reason } => {
            audit_unprompted(runtime, "command", &command, false, reason.clone());
            return ToolOutcome::denied_with_reason(reason.clone());
        }
        CommandDecision::Allow => {
            let reason = if trace.is_empty() {
                "allowed".to_string()
            } else {
                trace.join("; ")
            };
            audit_unprompted(runtime, "command", &command, true, reason);
        }
        CommandDecision::Ask { .. } => {}
    }
    if let CommandDecision::Ask {
        reason,
        suggested_rule,
        segments,
        risk,
        scope_options,
        outside_folders,
        hosts,
        secret_folders,
    } = decision
    {
        let answer = runtime
            .broker
            .ask(
                PermissionPrompt {
                    kind: "command".to_string(),
                    operation: PermissionOperation::Execute,
                    cwd: Some(permission_path(&cwd)),
                    project_root: runtime.project_root.clone(),
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
                    folders: outside_folders,
                    hosts,
                    grant_session_id: runtime.conversation_id.clone(),
                    mcp_tool: None,
                    secret_folders,
                    justification: runtime.justification.clone(),
                },
                &runtime.cancel,
                &runtime.session_id,
                &runtime.emit,
            )
            .await;
        if !answer.allowed {
            return ToolOutcome::refused(&answer);
        }
    }

    let mut policy = command_policy(runtime, &command, &cwd, &asked);
    // Leaving the sandbox is the user's call, every time.
    let wants_out = match arguments.get(UNSANDBOXED_ARGUMENT) {
        Some(Value::Bool(wanted)) => *wanted,
        Some(Value::String(wanted)) => wanted.trim().eq_ignore_ascii_case("true"),
        _ => false,
    };
    if policy.is_some() && wants_out {
        let answer = runtime
            .broker
            .ask(
                PermissionPrompt {
                    kind: "command".to_string(),
                    operation: PermissionOperation::Unsandboxed,
                    cwd: Some(permission_path(&cwd)),
                    project_root: runtime.project_root.clone(),
                    title: "Run command outside the sandbox?".to_string(),
                    detail: "Outside the sandbox this command can change any file your account can, not only those of the project, and read the folders that hold your keys.".to_string(),
                    command: Some(command.clone()),
                    path: None,
                    folder: None,
                    url: None,
                    suggested_rule: None,
                    segments: Vec::new(),
                    risk: None,
                    scope_options: Vec::new(),
                    folders: Vec::new(),
                    hosts: Vec::new(),
                    grant_session_id: runtime.conversation_id.clone(),
                    mcp_tool: None,
                    secret_folders: Vec::new(),
                    justification: runtime.justification.clone(),
                },
                &runtime.cancel,
                &runtime.session_id,
                &runtime.emit,
            )
            .await;
        if !answer.allowed {
            return ToolOutcome::refused(&answer);
        }
        policy = None;
    }

    #[cfg(unix)]
    let preview = TailPreview::open(&command);
    #[cfg(unix)]
    let script = preview
        .as_ref()
        .map_or_else(|| command.clone(), |preview| preview.script(&command));
    #[cfg(not(unix))]
    let script = command.clone();
    let mut process = sandbox::shell(&script, policy.as_ref());
    process
        .current_dir(&cwd)
        // What the user's shell profile exports and pumr, started from a
        // launcher, never got: the settings of their tools and skills.
        .envs(crate::shell_env::command_environment())
        // Python holds back what it prints to a pipe until it has a few
        // kilobytes; the chat shows a command's output as it is printed.
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Its own process group, so stopping the command also stops what it
    // started (see `kill_tree`).
    #[cfg(unix)]
    process.process_group(0);
    #[cfg(unix)]
    if let Some(preview) = &preview {
        preview.inherit(&mut process);
    }

    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => return ToolOutcome::error(format!("Cannot start command: {error}")),
    };
    let pid = child.id();

    let output = Arc::new(Mutex::new(OutputBuffer::default()));
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<String>();
    spawn_reader(child.stdout.take(), Some(output.clone()), sender.clone());
    spawn_reader(child.stderr.take(), Some(output.clone()), sender.clone());
    // Shown in the chat only: the result is what the command itself printed.
    #[cfg(unix)]
    spawn_reader(preview.map(|preview| preview.reader), None, sender.clone());
    drop(sender);

    let child_handle: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(Some(child)));
    let running = Arc::new(AtomicBool::new(true));
    let (exit_sender, mut exit_receiver) = tokio::sync::oneshot::channel::<i32>();
    let exited: Arc<Mutex<Option<i32>>> = Arc::new(Mutex::new(None));
    spawn_waiter(
        child_handle.clone(),
        running.clone(),
        exited.clone(),
        exit_sender,
    );

    let timeout = foreground_seconds(arguments);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);
    let mut exit_code: Option<i32> = None;
    let mut moved_to_background = false;
    let mut channel_closed = false;

    loop {
        tokio::select! {
            _ = runtime.cancel.cancelled() => {
                if let Some(child) = child_handle.lock().unwrap().as_mut() {
                    kill_tree(child, pid);
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

    // The shell has exited: let the readers deliver what is still in the
    // pipes. A process it left running in the background can keep them
    // open, so this waits only briefly.
    if !moved_to_background {
        let drain_until = tokio::time::Instant::now() + Duration::from_millis(500);
        while !channel_closed {
            match tokio::time::timeout_at(drain_until, receiver.recv()).await {
                Ok(Some(text)) => runtime.send(StreamEvent::ToolDelta {
                    call_id: runtime.call_id.clone(),
                    text,
                }),
                Ok(None) | Err(_) => channel_closed = true,
            }
        }
    }
    let (so_far, seen) = {
        let buffer = output.lock().unwrap();
        (buffer.text(), buffer.total())
    };
    let buffered = spill_output(runtime, so_far);

    if moved_to_background {
        // Short enough for a model to copy without a slip.
        let id: String = Uuid::new_v4().simple().to_string().chars().take(8).collect();
        runtime.processes.insert(Arc::new(RunningProcess {
            id: id.clone(),
            session_id: runtime.session_id.clone(),
            command: command.clone(),
            cwd: cwd.display().to_string(),
            started_at: crate::db::now_ms(),
            output: output.clone(),
            child: child_handle,
            pid,
            running,
            exit_code: exited,
            read_upto: Mutex::new(seen),
        }));
        return ToolOutcome::ok(format!(
            "Command is still running after {timeout}s and was moved to the background (process id: {id}). Call bash_output with this id to wait for it and read the rest of its output; do not run the command again. The user can stop it from the running processes indicator.\n\nOutput so far:\n{buffered}"
        ));
    }

    match exit_code {
        Some(0) => ToolOutcome::ok(if buffered.trim().is_empty() {
            "Command finished successfully (no output).".to_string()
        } else {
            format!("Command finished successfully.\n{buffered}")
        }),
        Some(code) => {
            // Said only when the output looks like it: a failing test has
            // nothing to do with the sandbox.
            let hint = policy
                .as_ref()
                .filter(|policy| sandbox::looks_blocked(&buffered, policy))
                .map(sandbox_hint)
                .unwrap_or_default();
            ToolOutcome {
                result: format!(
                    "{}{hint}",
                    truncate(format!("Command failed with exit code {code}.\n{buffered}"))
                ),
                status: "error".to_string(),
                changes: Vec::new(),
                attachments: Vec::new(),
            }
        }
        None => ToolOutcome::error("Command did not report an exit code."),
    }
}

/// The argument with which a `bash` call asks to run outside the sandbox.
const UNSANDBOXED_ARGUMENT: &str = "unsandboxed";

/// Offers `bash` the way out of the sandbox. Left out where commands run
/// unconfined anyway, so that no model spends a thought on it there.
pub fn offer_unsandboxed(schemas: &mut [Value]) {
    for schema in schemas {
        if schema.pointer("/function/name").and_then(Value::as_str) != Some("bash") {
            continue;
        }
        if let Some(properties) = schema
            .pointer_mut("/function/parameters/properties")
            .and_then(Value::as_object_mut)
        {
            properties.insert(
                UNSANDBOXED_ARGUMENT.to_string(),
                json!({
                    "type": "boolean",
                    "description": "Run outside the sandbox that confines commands to the project. Only for a command the sandbox stopped; the user is asked each time."
                }),
            );
        }
    }
}

/// What a prompt in front of a command named: saying yes to the command says
/// yes to these for this one run.
#[derive(Default)]
struct Asked {
    /// Folders outside the project the command touches.
    folders: Vec<PathBuf>,
    /// Folders whose sensitive files it uses.
    secrets: Vec<PathBuf>,
    /// Whether it named hosts that were not allowed yet.
    hosts: bool,
}

/// How the sandbox confines `command`, or `None` when it runs unconfined.
fn command_policy(
    runtime: &ToolRuntime,
    command: &str,
    cwd: &Path,
    asked: &Asked,
) -> Option<sandbox::Policy> {
    let config = runtime.permissions.sandbox();
    if config.mode == sandbox::Mode::Off {
        return None;
    }
    let permissions = &runtime.permissions;
    let mut folders = permissions.folders_for(&runtime.conversation_id);
    folders.extend(asked.folders.iter().cloned());
    let mut released = permissions.secret_folders_for(&runtime.conversation_id);
    released.extend(asked.secrets.iter().cloned());
    // Only asked for where the network is closed, since it means reading
    // the command line once more.
    let network_approved = config.mode == sandbox::Mode::FilesAndNetwork
        && (asked.hosts
            || permissions.contacts_hosts(
                command,
                &runtime.project_root,
                cwd,
                &runtime.conversation_id,
            ));
    config.policy(&sandbox::Call {
        command,
        project_root: &runtime.project_root,
        folders: &folders,
        released: &released,
        network_approved,
    })
}

/// What a command the sandbox seems to have stopped is told about it.
fn sandbox_hint(policy: &sandbox::Policy) -> String {
    let network = if policy.network {
        ""
    } else {
        " and reaches no network but this machine"
    };
    format!(
        "\n\n[pumr] This command ran in the sandbox: it writes only to the project, the scratch folder and temp folders, cannot read the folders that hold keys (such as ~/.ssh){network}. A program with a sandbox of its own, such as a browser, cannot start inside it. If that is what stopped the command, run it again with \"{UNSANDBOXED_ARGUMENT}\": true, which asks the user."
    )
}

/// Longest a command may run before it is moved to the background, in seconds.
const MAX_FOREGROUND_SECONDS: u64 = 600;

/// How long a `bash` call waits for its command before moving it to the
/// background. `timeout` is accepted next to `timeout_seconds`, in seconds
/// or, as other agents' shell tools take it, in milliseconds.
fn foreground_seconds(arguments: &Value) -> u64 {
    let seconds = arguments.get("timeout_seconds").and_then(Value::as_u64);
    let other = arguments
        .get("timeout")
        .and_then(Value::as_u64)
        .map(|value| {
            if value > MAX_FOREGROUND_SECONDS {
                value / 1_000
            } else {
                value
            }
        });
    seconds
        .or(other)
        .unwrap_or(BACKGROUND_AFTER_SECONDS)
        .clamp(1, MAX_FOREGROUND_SECONDS)
}

/// Longest a `bash_output` call waits for a background command, in seconds.
const MAX_OUTPUT_WAIT_SECONDS: u64 = 300;

/// The agent's `bash_output` call: waits for a command `bash` moved to the
/// background and hands over what it has printed since the agent last looked,
/// with how it ended. Without it a build or test run that outlasts `bash` is
/// lost to the agent, which then guesses at the result or runs it again.
async fn bash_output(runtime: &mut ToolRuntime, arguments: &Value) -> ToolOutcome {
    let id = match arg_str(arguments, "id") {
        Ok(id) => id.trim().to_string(),
        Err(error) => return ToolOutcome::error(error.to_string()),
    };
    let Some(process) = runtime.processes.find(&id, &runtime.session_id) else {
        let known: Vec<String> = runtime
            .processes
            .known(&runtime.session_id)
            .into_iter()
            .map(|(id, command)| format!("{id} ({})", head_tail(&command, 80)))
            .collect();
        return ToolOutcome::error(if known.is_empty() {
            format!("No background command has the id '{id}'. None is known for this chat: the user may have stopped it.")
        } else {
            format!(
                "No background command has the id '{id}'. Known: {}.",
                known.join(", ")
            )
        });
    };
    let wait = arguments
        .get("wait_seconds")
        .and_then(Value::as_u64)
        .unwrap_or(30)
        .min(MAX_OUTPUT_WAIT_SECONDS);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(wait);
    while process.running.load(Ordering::SeqCst) && tokio::time::Instant::now() < deadline {
        tokio::select! {
            _ = runtime.cancel.cancelled() => return ToolOutcome::cancelled(),
            _ = tokio::time::sleep(Duration::from_millis(200)) => {}
        }
    }
    let running = process.running.load(Ordering::SeqCst);
    if !running {
        // The readers may still be delivering what was left in the pipes.
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let fresh = {
        let buffer = process.output.lock().unwrap();
        let mut read_upto = process.read_upto.lock().unwrap();
        let fresh = buffer.since(*read_upto);
        *read_upto = buffer.total();
        fresh
    };
    let fresh = spill_output(runtime, fresh);
    let exit_code = *process.exit_code.lock().unwrap();
    let state = match (running, exit_code) {
        (true, _) => format!(
            "Command is still running after {}s (process id: {id}). Call bash_output again to keep waiting.",
            (crate::db::now_ms() - process.started_at).max(0) / 1_000
        ),
        (false, Some(0)) => "Command finished successfully.".to_string(),
        (false, Some(code)) => format!("Command failed with exit code {code}."),
        (false, None) => "Command has ended.".to_string(),
    };
    let result = if fresh.trim().is_empty() {
        format!("{state}\nNo new output.")
    } else {
        format!("{state}\nNew output:\n{fresh}")
    };
    if !running && !matches!(exit_code, Some(0)) {
        return ToolOutcome::error(result);
    }
    ToolOutcome::ok(result)
}

/// What a `tail` in a pipeline reads, copied to the chat while the command
/// runs. Models end most builds and test runs with `| tail -n`, which prints
/// nothing until its input ends, so the user would watch an empty panel for
/// minutes. The command gets a `tail` that also writes what it reads to a pipe
/// of its own: the chat shows that live, while the result the model reads and
/// the command's exit code stay exactly what the real `tail` makes them.
#[cfg(unix)]
struct TailPreview {
    reader: tokio::net::unix::pipe::Receiver,
    writer: std::os::fd::OwnedFd,
}

#[cfg(unix)]
impl TailPreview {
    /// `None` for a command without `tail`, which runs as it is.
    fn open(command: &str) -> Option<Self> {
        if !command.contains("tail") {
            return None;
        }
        let (writer, reader) = tokio::net::unix::pipe::pipe().ok()?;
        // `tee` writes to this end and must wait for the reader, not fail.
        let writer = writer.into_blocking_fd().ok()?;
        Some(Self { reader, writer })
    }

    /// `command` after the definition of the previewing `tail`. Both share a
    /// line, so the line numbers in the shell's messages stay the command's.
    fn script(&self, command: &str) -> String {
        use std::os::fd::AsRawFd;
        format!(
            "tail() {{ if [ -p /dev/stdin ]; then tee /dev/fd/{} 2>/dev/null | command tail \"$@\"; else command tail \"$@\"; fi; }}; {command}",
            self.writer.as_raw_fd()
        )
    }

    /// Hands the pipe's write end to the command `process` starts.
    fn inherit(&self, process: &mut Command) {
        use std::os::fd::AsRawFd;
        let fd = self.writer.as_raw_fd();
        // SAFETY: the closure runs in the forked child before `exec` and only
        // calls `fcntl`, which is async-signal-safe. Should it fail, `tee`
        // cannot open the pipe and passes its input on without a copy.
        unsafe {
            process.pre_exec(move || {
                libc::fcntl(fd, libc::F_SETFD, 0);
                Ok(())
            });
        }
    }
}

/// Reads a command's output as it is printed and sends it on to the chat.
/// `output` collects it for the tool result; a preview has none.
fn spawn_reader<R>(
    reader: Option<R>,
    output: Option<Arc<Mutex<OutputBuffer>>>,
    sender: tokio::sync::mpsc::UnboundedSender<String>,
) where
    R: AsyncReadExt + Unpin + Send + 'static,
{
    let Some(mut reader) = reader else {
        return;
    };
    tokio::spawn(async move {
        let mut buffer = [0u8; 4096];
        // Bytes of a character split across two reads.
        let mut pending: Vec<u8> = Vec::new();
        loop {
            let finished = match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => true,
                Ok(read) => {
                    pending.extend_from_slice(&buffer[..read]);
                    false
                }
            };
            let text = if finished {
                String::from_utf8_lossy(&std::mem::take(&mut pending)).into_owned()
            } else {
                take_utf8(&mut pending)
            };
            if !text.is_empty() {
                if let Some(output) = &output {
                    output.lock().unwrap().push(&text);
                }
                // Nobody listens once the command moved to the background.
                let _ = sender.send(text);
            }
            if finished {
                break;
            }
        }
    });
}

/// Decodes the complete UTF-8 at the start of `pending` and keeps a
/// character that is cut off at its end for the next read. Invalid bytes
/// become U+FFFD.
pub(crate) fn take_utf8(pending: &mut Vec<u8>) -> String {
    let mut text = String::new();
    loop {
        let (valid, invalid) = match std::str::from_utf8(pending) {
            Ok(valid) => {
                text.push_str(valid);
                pending.clear();
                return text;
            }
            Err(error) => (error.valid_up_to(), error.error_len()),
        };
        text.push_str(&String::from_utf8_lossy(&pending[..valid]));
        match invalid {
            None => {
                pending.drain(..valid);
                return text;
            }
            Some(length) => {
                text.push('\u{FFFD}');
                pending.drain(..valid + length);
            }
        }
    }
}

fn spawn_waiter(
    child: Arc<Mutex<Option<Child>>>,
    running: Arc<AtomicBool>,
    exited: Arc<Mutex<Option<i32>>>,
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
                            let code = status.code().unwrap_or(-1);
                            *exited.lock().unwrap() = Some(code);
                            running.store(false, Ordering::SeqCst);
                            if let Some(sender) = exit_sender.take() {
                                let _ = sender.send(code);
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
    head_tail(&text, MAX_TOOL_OUTPUT)
}

/// Fits a command's output into a tool result. An output longer than a result
/// may be is saved whole to the chat's scratch folder, and the result keeps
/// its beginning and end with the path: the model then reads or searches the
/// rest when it needs it, instead of carrying all of it in its context.
fn spill_output(runtime: &ToolRuntime, text: String) -> String {
    if text.len() <= MAX_TOOL_OUTPUT {
        return text;
    }
    let name: String = runtime
        .call_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .collect();
    let saved = runtime
        .permissions
        .ensure_scratch_dir(&runtime.conversation_id)
        .map(|folder| folder.join(format!("output-{name}.txt")))
        .filter(|path| std::fs::write(path, &text).is_ok());
    match saved {
        Some(path) => format!(
            "{}\n\nThe whole output ({} bytes) is saved to {}. Read it with the read tool (offset and limit) or search it with grep.",
            head_tail(&text, SPILLED_OUTPUT_BYTES),
            text.len(),
            path.display()
        ),
        None => truncate(text),
    }
}

/// Truncates to at most `max_bytes` while keeping both the beginning and the
/// end of the output, since failures and errors usually appear at the tail.
/// The split favours the head slightly (~55/45) to preserve the leading context.
pub(crate) fn head_tail(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let notice = format!(
        "\n\n…(output truncated: {} of {} bytes kept; head and tail shown)\n\n",
        max_bytes,
        text.len()
    );
    // When the budget cannot hold the notice plus both ends, fall back to a
    // plain prefix cut so the result never exceeds `max_bytes`.
    if max_bytes <= notice.len() + 1 {
        let end = floor_char_boundary(text, max_bytes);
        return text[..end].to_string();
    }
    let budget = max_bytes - notice.len();
    let head_budget = budget * 55 / 100;
    let tail_budget = budget - head_budget;
    let head_end = floor_char_boundary(text, head_budget);
    let tail_start = ceil_char_boundary(text, text.len().saturating_sub(tail_budget));
    format!("{}{}{}", &text[..head_end], notice, &text[tail_start..])
}

fn floor_char_boundary(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::permissions::AutoApproveConfig;

    fn schema_named(name: &str) -> Value {
        tool_schemas()
            .into_iter()
            .find(|schema| schema.pointer("/function/name").and_then(Value::as_str) == Some(name))
            .unwrap()
    }

    fn requires_reason(schema: &Value) -> bool {
        schema
            .pointer("/function/parameters/required")
            .and_then(Value::as_array)
            .is_some_and(|list| list.iter().any(|entry| entry == REASON_ARGUMENT))
    }

    #[test]
    fn prompting_tools_take_a_reason() {
        for (name, required) in PROMPTING_TOOLS {
            let schema = schema_named(name);
            assert!(
                schema
                    .pointer(&format!(
                        "/function/parameters/properties/{REASON_ARGUMENT}"
                    ))
                    .is_some(),
                "{name}"
            );
            assert_eq!(requires_reason(&schema), required, "{name}");
        }
        assert!(schema_named("question")
            .pointer("/function/parameters/properties/reason")
            .is_none());
        assert!(requires_reason(&mcp_invoke_schema()));
    }

    #[test]
    fn reason_argument_keeps_a_declared_reason_and_fills_empty_schemas() {
        let mut declared = json!({ "function": { "parameters": {
            "type": "object",
            "properties": { "reason": { "type": "integer" } },
            "required": ["reason"]
        } } });
        add_reason_argument(&mut declared, true);
        assert_eq!(
            declared.pointer("/function/parameters/properties/reason/type"),
            Some(&json!("integer"))
        );
        assert_eq!(
            declared.pointer("/function/parameters/required"),
            Some(&json!(["reason"]))
        );

        let mut bare = json!({ "function": { "parameters": { "type": "object" } } });
        add_reason_argument(&mut bare, true);
        assert!(bare
            .pointer("/function/parameters/properties/reason")
            .is_some());
        assert!(requires_reason(&bare));
    }

    #[test]
    fn justification_is_collapsed_and_capped() {
        assert_eq!(justification(None), None);
        assert_eq!(justification(Some(&json!("  \n "))), None);
        assert_eq!(justification(Some(&json!(42))), None);
        assert_eq!(
            justification(Some(&json!("Run  the\ntests."))).as_deref(),
            Some("Run the tests.")
        );
        let long = justification(Some(&json!("a".repeat(1000)))).unwrap();
        assert_eq!(long.chars().count(), MAX_JUSTIFICATION_CHARS);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn non_public_addresses_are_blocked_in_every_form() {
        for address in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.254",
            "198.18.0.1",
            "198.19.255.255",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "0.0.0.0",
            "192.0.0.8",
            "::1",
            "::",
            "fc00::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:169.254.169.254",
            "64:ff9b::a00:1",
            "2002:c0a8:0101::1",
        ] {
            assert!(blocked_ip(address.parse().unwrap()), "{address}");
        }
        for address in [
            "93.184.216.34",
            "1.1.1.1",
            "100.128.0.1",
            "198.20.0.1",
            "2606:4700:4700::1111",
            "::ffff:93.184.216.34",
            "64:ff9b::5db8:d822",
        ] {
            assert!(!blocked_ip(address.parse().unwrap()), "{address}");
        }
    }

    #[test]
    fn permission_paths_are_absolute_and_canonical_when_existing() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join(".env");
        std::fs::write(&file, "secret").unwrap();
        assert_eq!(permission_path(&file), file.canonicalize().unwrap());
        assert_eq!(
            permission_path(directory.path()),
            directory.path().canonicalize().unwrap()
        );
        assert_eq!(
            permission_path(Path::new(".")),
            std::env::current_dir().unwrap().canonicalize().unwrap()
        );

        let missing = directory.path().join("new-directory/.env");
        assert!(!missing.exists());
        assert_eq!(permission_path(&missing), missing);
        assert!(permission_path(&missing).is_absolute());
    }

    #[test]
    fn head_tail_keeps_both_ends_within_budget() {
        let text = format!("{}{}", "a".repeat(1000), "b".repeat(1000));
        let limited = head_tail(&text, 600);
        assert!(limited.starts_with("aaa"));
        assert!(limited.ends_with("bbb"));
        assert!(
            limited.len() <= 600,
            "expected <= 600, got {}",
            limited.len()
        );
        assert!(limited.contains("truncated"));
    }

    #[test]
    fn head_tail_leaves_short_output_untouched() {
        let text = "short output".to_string();
        assert_eq!(head_tail(&text, 100), text);
    }

    #[test]
    fn head_tail_respects_utf8_boundaries() {
        let text = "é".repeat(400);
        let limited = head_tail(&text, 300);
        assert!(limited.len() <= 300);
        // Must remain valid UTF-8; `.chars()` would panic on a broken boundary.
        assert!(limited.chars().count() > 0);
    }

    #[cfg(unix)]
    #[test]
    fn permission_paths_resolve_existing_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join(".env");
        let alias = directory.path().join("alias");
        std::fs::write(&file, "secret").unwrap();
        std::os::unix::fs::symlink(&file, &alias).unwrap();
        assert_eq!(permission_path(&alias), permission_path(&file));
    }

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

    fn walk_relative(base: &Path, config: &Arc<FileIgnoreConfig>) -> Vec<String> {
        let mut found: Vec<String> = file_walker(base, base, config)
            .flatten()
            .filter(|entry| {
                entry
                    .file_type()
                    .map(|kind| kind.is_file())
                    .unwrap_or(false)
            })
            .map(|entry| {
                entry
                    .path()
                    .strip_prefix(base)
                    .unwrap_or(entry.path())
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        found.sort();
        found
    }

    #[test]
    fn walk_prunes_generated_dirs_even_when_scanning_is_enabled() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        std::fs::write(root.join("node_modules/pkg/index.js"), "x").unwrap();
        std::fs::write(root.join("dist/app.js"), "y").unwrap();

        let config = Arc::new(FileIgnoreConfig::new(true, true, false, true, &[]));
        assert_eq!(walk_relative(root, &config), vec!["src/main.rs"]);
    }

    #[test]
    fn walk_reenters_generated_dirs_for_exemptions_and_disabled_rules() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("node_modules/pkg/index.js"), "x").unwrap();
        std::fs::write(root.join("dist/app.js"), "y").unwrap();
        std::fs::write(root.join("src/main.rs"), "z").unwrap();

        let exempted = Arc::new(FileIgnoreConfig::new(
            true,
            true,
            false,
            true,
            &["node_modules/**".to_string()],
        ));
        assert!(walk_relative(root, &exempted).contains(&"node_modules/pkg/index.js".to_string()));

        let disabled = Arc::new(
            FileIgnoreConfig::new(true, true, false, true, &[])
                .with_overrides(&["dir:node_modules".to_string()], &[]),
        );
        let found = walk_relative(root, &disabled);
        assert!(found.contains(&"node_modules/pkg/index.js".to_string()));
        assert!(!found.contains(&"dist/app.js".to_string()));
    }

    #[test]
    fn walk_ignores_generated_names_above_the_project_root() {
        // A checkout under `/tmp`, `~/build`, … must not be pruned as a whole.
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("tmp/project");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        std::fs::write(root.join("node_modules/pkg/index.js"), "x").unwrap();

        let config = Arc::new(FileIgnoreConfig::new(true, true, false, true, &[]));
        assert_eq!(walk_relative(&root, &config), vec!["src/main.rs"]);
    }

    pub(crate) fn test_runtime(project_root: &Path, app_data: &Path) -> ToolRuntime {
        ToolRuntime {
            call_id: "call".to_string(),
            project_root: project_root.to_path_buf(),
            permissions: Arc::new(LivePermissions::new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                AutoApproveConfig::default(),
            )),
            file_ignore: Arc::new(FileIgnoreConfig::default()),
            session_id: "session".to_string(),
            conversation_id: "session".to_string(),
            shadow: Arc::new(ShadowRepo::open(app_data, "project", project_root).unwrap()),
            processes: Arc::new(ProcessRegistry::new()),
            files: Arc::new(FileLedger::default()),
            broker: Arc::new(PermissionBroker::new()),
            questions: Arc::new(QuestionBroker::new()),
            http: reqwest::Client::new(),
            mcp: None,
            skills: Vec::new(),
            justification: None,
            vision: true,
            read_only: false,
            cancel: CancellationToken::new(),
            emit: Arc::new(|_: RoutedEvent| {}),
        }
    }

    #[tokio::test]
    async fn the_files_of_an_enabled_skill_are_read_without_asking() {
        let directory = tempfile::tempdir().unwrap();
        let base = directory.path().canonicalize().unwrap();
        let root = base.join("project");
        let skill = base.join("skills/elevation4/status-pages");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(skill.join("providers")).unwrap();
        std::fs::write(skill.join("SKILL.md"), "See providers/ionos.md").unwrap();
        std::fs::write(skill.join("providers/ionos.md"), "IONOS status page").unwrap();
        std::fs::write(base.join("skills/elevation4/notes.md"), "next to the skill").unwrap();
        let mut runtime = test_runtime(&root, &base.join("app-data"));
        runtime.skills = vec![SkillEntry {
            name: "status-pages".to_string(),
            description: String::new(),
            path: skill.to_string_lossy().to_string(),
        }];
        // Every prompt is counted and answered with No.
        let asked: Arc<Mutex<Vec<String>>> = Arc::default();
        let broker = runtime.broker.clone();
        let seen = asked.clone();
        runtime.emit = Arc::new(move |routed: RoutedEvent| {
            if let StreamEvent::PermissionRequest {
                request_id, title, ..
            } = routed.event
            {
                seen.lock().unwrap().push(title);
                broker.resolve(
                    &request_id,
                    PermissionDecision {
                        allowed: false,
                        rule: None,
                        folder: None,
                        decided_by: "user".to_string(),
                        decision: Some("deny".to_string()),
                    },
                );
            }
        });
        let file = |path: PathBuf| json!({ "path": path.to_string_lossy() });

        // Loading the skill names the file; reading it then needs no prompt.
        let loaded = execute(&mut runtime, "skill", &json!({ "name": "status-pages" })).await;
        assert_eq!(loaded.status, "ok", "{}", loaded.result);
        assert!(
            loaded.result.contains("\n- providers/ionos.md\n"),
            "{}",
            loaded.result
        );
        let read = execute(
            &mut runtime,
            "read",
            &file(skill.join("providers/ionos.md")),
        )
        .await;
        assert_eq!(read.status, "ok", "{}", read.result);
        assert!(read.result.contains("IONOS status page"), "{}", read.result);
        assert!(asked.lock().unwrap().is_empty());

        // A file next to the skill is outside the project like any other.
        let outside = execute(
            &mut runtime,
            "read",
            &file(base.join("skills/elevation4/notes.md")),
        )
        .await;
        assert_ne!(outside.status, "ok", "{}", outside.result);
        assert_eq!(asked.lock().unwrap().len(), 1);

        // And a skill's folder is read from, never written to, without asking.
        let mut write = file(skill.join("providers/new.md"));
        write["content"] = json!("x");
        let written = execute(&mut runtime, "write", &write).await;
        assert_ne!(written.status, "ok", "{}", written.result);
        assert_eq!(asked.lock().unwrap().len(), 2);
        assert!(!skill.join("providers/new.md").exists());
    }

    /// A stdio MCP server with one `echo` tool that answers every request
    /// under the id it came with.
    #[cfg(unix)]
    fn echo_server(dir: &Path) -> crate::mcp::McpServerConfig {
        let script = dir.join("echo-mcp.sh");
        std::fs::write(
            &script,
            r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"initialize"'*) echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"serverInfo\":{\"name\":\"echo\",\"version\":\"1\"}}}" ;;
    *'"tools/list"'*) echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"tools\":[{\"name\":\"echo\",\"description\":\"Echo\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\"}}}}]}}" ;;
    *'"tools/call"'*) echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}" ;;
  esac
done
"#,
        )
        .unwrap();
        crate::mcp::McpServerConfig {
            name: "echo".to_string(),
            command: Some("/bin/sh".to_string()),
            args: vec![script.to_string_lossy().to_string()],
            env: Vec::new(),
            url: None,
            source: "test".to_string(),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_mcp_tool_asks_until_its_approval_is_remembered() {
        use crate::models::McpToolGrant;

        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        let mut runtime = test_runtime(&root, &directory.path().join("app-data"));
        let manager = McpManager::connect(vec![echo_server(directory.path())], None, &|_| {}).await;
        assert!(manager.errors.is_empty(), "{:?}", manager.errors);
        let grant = manager.tool_grant("mcp__echo__echo").unwrap();
        runtime.mcp = Some(Arc::new(manager));

        // Every prompt gets a plain Yes; what it offered to remember is kept.
        let offered: Arc<Mutex<Vec<Option<McpToolGrant>>>> = Arc::default();
        let broker = runtime.broker.clone();
        let seen = offered.clone();
        runtime.emit = Arc::new(move |routed: RoutedEvent| {
            if let StreamEvent::PermissionRequest {
                request_id,
                mcp_tool,
                ..
            } = routed.event
            {
                seen.lock().unwrap().push(mcp_tool);
                broker.resolve(
                    &request_id,
                    PermissionDecision {
                        allowed: true,
                        rule: None,
                        folder: None,
                        decided_by: "user".to_string(),
                        decision: Some("allow_once".to_string()),
                    },
                );
            }
        });
        let audit: Arc<Mutex<Vec<PermissionAuditEntry>>> = Arc::default();
        let log = audit.clone();
        runtime
            .broker
            .set_audit_sink(Arc::new(move |entry| log.lock().unwrap().push(entry)));
        let call = |text: &'static str| json!({ "text": text, "reason": "to test" });

        // Allowed once: the next call asks again.
        for text in ["one", "two"] {
            let outcome = execute(&mut runtime, "mcp__echo__echo", &call(text)).await;
            assert_eq!(outcome.status, "ok", "{}", outcome.result);
        }
        assert_eq!(
            *offered.lock().unwrap(),
            vec![Some(grant.clone()), Some(grant.clone())]
        );

        // Remembered for the chat: no prompt, whatever the arguments, and the
        // permission log says why it ran.
        runtime
            .permissions
            .add_session_mcp_tool_grant("session", &grant);
        let outcome = execute(&mut runtime, "mcp__echo__echo", &call("three")).await;
        assert_eq!(outcome.result, "hello");
        assert_eq!(offered.lock().unwrap().len(), 2);
        let entry = audit.lock().unwrap().last().cloned().unwrap();
        assert!(entry.allowed);
        assert_eq!(entry.decided_by, "auto");
        assert_eq!(
            entry.reason,
            "remembered approval: MCP tool allowed in this chat"
        );
        assert!(entry.subject.contains("three"), "{}", entry.subject);

        // Another chat was not given that approval.
        runtime.conversation_id = "other".to_string();
        let outcome = execute(&mut runtime, "mcp__echo__echo", &call("four")).await;
        assert_eq!(outcome.status, "ok", "{}", outcome.result);
        assert_eq!(offered.lock().unwrap().len(), 3);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_remembered_mcp_tool_asks_again_in_a_mode_that_changes_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        // `save` says nothing of itself; `look` says that it only reads.
        let script = directory.path().join("notes-mcp.sh");
        std::fs::write(
            &script,
            r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"initialize"'*) echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"serverInfo\":{\"name\":\"notes\",\"version\":\"1\"}}}" ;;
    *'"tools/list"'*) echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"tools\":[{\"name\":\"save\",\"inputSchema\":{\"type\":\"object\"}},{\"name\":\"look\",\"inputSchema\":{\"type\":\"object\"},\"annotations\":{\"readOnlyHint\":true}}]}}" ;;
    *'"tools/call"'*) echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}" ;;
  esac
done
"#,
        )
        .unwrap();
        let server = crate::mcp::McpServerConfig {
            name: "notes".to_string(),
            command: Some("/bin/sh".to_string()),
            args: vec![script.to_string_lossy().to_string()],
            env: Vec::new(),
            url: None,
            source: "test".to_string(),
        };
        let mut runtime = test_runtime(&root, &directory.path().join("app-data"));
        let manager = McpManager::connect(vec![server], None, &|_| {}).await;
        assert!(manager.errors.is_empty(), "{:?}", manager.errors);
        for tool in ["mcp__notes__save", "mcp__notes__look"] {
            let grant = manager.tool_grant(tool).unwrap();
            runtime.permissions.add_session_mcp_tool_grant("session", &grant);
        }
        runtime.mcp = Some(Arc::new(manager));

        // What each prompt said and offered to remember; all get a plain Yes.
        let asked: Arc<Mutex<Vec<(String, bool)>>> = Arc::default();
        let (seen, broker) = (asked.clone(), runtime.broker.clone());
        runtime.emit = Arc::new(move |routed: RoutedEvent| {
            if let StreamEvent::PermissionRequest {
                request_id,
                detail,
                mcp_tool,
                ..
            } = routed.event
            {
                seen.lock().unwrap().push((detail, mcp_tool.is_some()));
                broker.resolve(
                    &request_id,
                    PermissionDecision {
                        allowed: true,
                        rule: None,
                        folder: None,
                        decided_by: "user".to_string(),
                        decision: Some("allow_once".to_string()),
                    },
                );
            }
        });

        // While files may change, both run on the approval they were given.
        for tool in ["mcp__notes__save", "mcp__notes__look"] {
            let outcome = execute(&mut runtime, tool, &json!({})).await;
            assert_eq!(outcome.result, "done", "{tool}");
        }
        assert!(asked.lock().unwrap().is_empty());

        // In planning or a read-only mode the approval covers only the tool
        // that says it reads; the other asks, and offers no remembering.
        runtime.read_only = true;
        let outcome = execute(&mut runtime, "mcp__notes__look", &json!({})).await;
        assert_eq!(outcome.result, "done");
        assert!(asked.lock().unwrap().is_empty());
        for _ in 0..2 {
            let outcome = execute(&mut runtime, "mcp__notes__save", &json!({})).await;
            assert_eq!(outcome.result, "done");
        }
        let asked = asked.lock().unwrap();
        assert_eq!(asked.len(), 2);
        assert!(asked[0].0.contains("a mode that changes no files"), "{}", asked[0].0);
        assert!(!asked[0].1 && !asked[1].1);
    }

    #[tokio::test]
    async fn glob_grep_and_list_work_in_a_project_under_tmp() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("tmp/project");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(root.join("node_modules/pkg/index.js"), "fn main() {}\n").unwrap();
        let mut runtime = test_runtime(&root, &directory.path().join("app-data"));

        let globbed = glob_files(&mut runtime, &json!({ "pattern": "**/*.{rs,js}" })).await;
        assert_eq!(globbed.result, "src/main.rs");
        let grepped = grep_files(&mut runtime, &json!({ "pattern": "fn main" })).await;
        assert_eq!(grepped.result, "src/main.rs:1: fn main() {}");
        let listed = list_dir(&mut runtime, &json!({})).await;
        assert_eq!(listed.result, "src/");
    }

    #[tokio::test]
    async fn grep_shows_context_lists_files_and_ignores_case() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("src/a.rs"),
            "use std::fmt;\n\nfn alpha() {}\nfn beta() {}\n\n\n\nfn gamma() {}\n",
        )
        .unwrap();
        std::fs::write(root.join("src/b.rs"), "fn Delta() {}\n").unwrap();
        let mut runtime = test_runtime(&root, &directory.path().join("app-data"));

        // Context lines carry `-`, matches `:`; two close matches share their
        // context and a gap gets a separator.
        let around = grep_files(
            &mut runtime,
            &json!({ "pattern": "fn (alpha|beta|gamma)", "context": 1 }),
        )
        .await;
        assert_eq!(
            around.result,
            "src/a.rs-2- \nsrc/a.rs:3: fn alpha() {}\nsrc/a.rs:4: fn beta() {}\nsrc/a.rs-5- \n--\nsrc/a.rs-7- \nsrc/a.rs:8: fn gamma() {}"
        );

        let files = grep_files(
            &mut runtime,
            &json!({ "pattern": "^fn ", "output": "files" }),
        )
        .await;
        assert_eq!(files.result, "src/a.rs: 3\nsrc/b.rs: 1");

        let exact = grep_files(&mut runtime, &json!({ "pattern": "fn delta" })).await;
        assert_eq!(exact.result, "No matches for 'fn delta'.");
        let any_case = grep_files(
            &mut runtime,
            &json!({ "pattern": "fn delta", "ignore_case": true }),
        )
        .await;
        assert_eq!(any_case.result, "src/b.rs:1: fn Delta() {}");

        let limited = grep_files(&mut runtime, &json!({ "pattern": "^fn ", "limit": 2 })).await;
        assert!(limited
            .result
            .starts_with("src/a.rs:3: fn alpha() {}\nsrc/a.rs:4: fn beta() {}\n\n… showing the first 2 matches only."));
    }

    #[test]
    fn a_long_command_output_is_saved_and_the_result_points_to_it() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        let runtime = test_runtime(&root, &directory.path().join("app-data"));
        runtime
            .permissions
            .set_scratch_root(directory.path().join("scratch"));

        assert_eq!(spill_output(&runtime, "short".to_string()), "short");

        let long = format!("start\n{}end\n", "line of a build log\n".repeat(4_000));
        let result = spill_output(&runtime, long.clone());
        assert!(result.len() < MAX_TOOL_OUTPUT);
        assert!(result.starts_with("start\n"));
        // The scratch root is stored as its canonical path.
        let saved = directory
            .path()
            .canonicalize()
            .unwrap()
            .join("scratch/session/output-call.txt");
        assert!(result.contains(&format!("is saved to {}", saved.display())));
        assert_eq!(std::fs::read_to_string(saved).unwrap(), long);
    }

    #[test]
    fn the_task_list_is_stored_and_rendered_as_a_checklist() {
        let directory = tempfile::tempdir().unwrap();
        let db = Db::open(&directory.path().join("test.db")).unwrap();
        db.migrate().unwrap();
        let project = db.upsert_project("/tmp/pumr-task-list").unwrap();
        let chat = db
            .create_session(&project.id, "chat", None, None, None, None, None)
            .unwrap();

        let written = write_todos(
            &db,
            &chat.id,
            &json!({ "todos": [
                { "content": "Read the parser", "status": "completed" },
                { "content": " Fix the off-by-one ", "status": "in_progress" },
                { "content": "Add a test", "status": "someday" },
                { "content": "  ", "status": "pending" }
            ] }),
        );
        assert_eq!(written.status, "ok");
        assert_eq!(
            written.result,
            "Task list updated.\n- [x] Read the parser\n- [ ] Fix the off-by-one (in progress)\n- [ ] Add a test"
        );
        assert_eq!(
            render_todos(&db.session_todos(&chat.id).unwrap()).as_deref(),
            Some("- [x] Read the parser\n- [ ] Fix the off-by-one (in progress)\n- [ ] Add a test")
        );

        let cleared = write_todos(&db, &chat.id, &json!({ "todos": [] }));
        assert_eq!(cleared.result, "Task list cleared.");
        assert_eq!(render_todos(&db.session_todos(&chat.id).unwrap()), None);
        assert_eq!(write_todos(&db, &chat.id, &json!({})).status, "error");
    }

    #[test]
    fn recommended_suffixes_are_stripped_from_labels() {
        assert_eq!(
            strip_recommended_suffix("Use Postgres (Recommendation)"),
            ("Use Postgres", true)
        );
        assert_eq!(
            strip_recommended_suffix("Use Postgres (recommended)"),
            ("Use Postgres", true)
        );
        assert_eq!(strip_recommended_suffix("Ja – [Recommended]"), ("Ja", true));
        assert_eq!(
            strip_recommended_suffix("Größer (Recommended)"),
            ("Größer", true)
        );
        assert_eq!(
            strip_recommended_suffix("(Recommended)"),
            ("(Recommended)", false)
        );
        assert_eq!(
            strip_recommended_suffix("Recommended settings"),
            ("Recommended settings", false)
        );
    }

    #[tokio::test]
    async fn question_options_carry_the_recommendation_and_multi_select() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        let mut runtime = test_runtime(&root, &directory.path().join("app-data"));
        let asked: Arc<Mutex<Vec<QuestionItem>>> = Arc::default();
        let sink = asked.clone();
        runtime.emit = Arc::new(move |routed: RoutedEvent| {
            if let StreamEvent::QuestionRequest { questions, .. } = routed.event {
                *sink.lock().unwrap() = questions;
            }
        });
        // Already cancelled, so the question is announced and then skipped.
        runtime.cancel.cancel();

        let outcome = ask_question(
            &mut runtime,
            &json!({ "questions": [{
                "question": "Which features?",
                "multiSelect": true,
                "options": [
                    { "label": "Search", "recommended": true },
                    { "label": "Export (Recommendation)" },
                    { "label": "Sync" }
                ]
            }] }),
        )
        .await;

        assert_eq!(outcome.result, r#"{"answers":[],"skipped":true}"#);
        let asked = asked.lock().unwrap();
        assert!(asked[0].multi_select);
        let options: Vec<(&str, bool)> = asked[0]
            .options
            .iter()
            .map(|option| (option.label.as_str(), option.recommended))
            .collect();
        assert_eq!(
            options,
            [("Search", true), ("Export", true), ("Sync", false)]
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

    #[test]
    fn edit_matches_exact_text_once() {
        let (updated, count) = apply_edit("let a = 1;\n", "a = 1", "a = 2", false).unwrap();
        assert_eq!(updated, "let a = 2;\n");
        assert_eq!(count, 1);
    }

    #[test]
    fn edit_replace_all_replaces_every_match() {
        let (updated, count) = apply_edit("x x x", "x", "y", true).unwrap();
        assert_eq!(updated, "y y y");
        assert_eq!(count, 3);
    }

    #[test]
    fn edit_requires_unique_match_without_replace_all() {
        assert!(matches!(
            apply_edit("x x", "x", "y", false),
            Err(EditError::NotUnique(2))
        ));
    }

    #[test]
    fn edit_rejects_empty_old_string() {
        assert!(matches!(
            apply_edit("abc", "", "y", false),
            Err(EditError::EmptyOldString)
        ));
    }

    #[test]
    fn edit_reports_missing_text() {
        assert!(matches!(
            apply_edit("abc", "zzz", "y", false),
            Err(EditError::NotFound)
        ));
    }

    #[test]
    fn edit_restores_indentation_when_old_string_is_flattened() {
        let content = "fn main() {\n    let x = 1;\n    println!(\"{x}\");\n}\n";
        let old = "let x = 1;\nprintln!(\"{x}\");";
        let (updated, count) = apply_edit(content, old, "let x = 2;", false).unwrap();
        assert_eq!(count, 1);
        assert_eq!(updated, "fn main() {\n    let x = 2;\n}\n");
    }

    #[test]
    fn edit_removes_extra_indentation_from_replacement() {
        let content = "fn main() {\n    let x = 1;\n}\n";
        let old = "        let x = 1;";
        let (updated, count) = apply_edit(content, old, "        let x = 2;", false).unwrap();
        assert_eq!(count, 1);
        assert_eq!(updated, "fn main() {\n    let x = 2;\n}\n");
    }

    #[test]
    fn edit_tolerates_whitespace_runs() {
        let (updated, count) =
            apply_edit("a = 1\nb = 2\n", "a = 1   b = 2", "c = 3", false).unwrap();
        assert_eq!(count, 1);
        assert_eq!(updated, "c = 3\n");
    }

    #[test]
    fn edit_tolerates_carriage_returns() {
        let (updated, count) =
            apply_edit("a = 1\r\nb = 2\r\n", "a = 1\nb = 2", "c = 3", false).unwrap();
        assert_eq!(count, 1);
        assert_eq!(updated, "c = 3\r\n");
    }

    /// The file after one edit of it.
    fn edited(content: &str, old: &str, new: &str) -> String {
        apply_edit(content, old, new, false).unwrap().0
    }

    #[test]
    fn edit_by_whitespace_keeps_the_line_break_before_its_indentation() {
        assert_eq!(
            edited(
                "x = 1\n    foo(a, b)\ny = 2\n",
                "    foo(a,  b)",
                "    foo(a, c)"
            ),
            "x = 1\n    foo(a, c)\ny = 2\n"
        );
    }

    #[test]
    fn edit_by_whitespace_keeps_the_indentation_of_the_next_line() {
        assert_eq!(
            edited(
                "if ok:\n    foo(a, b)\n    bar()\n",
                "foo(a,  b)\n",
                "foo(a, c)\n"
            ),
            "if ok:\n    foo(a, c)\n    bar()\n"
        );
        // With both ends in `old`, the line can also be taken out whole.
        assert_eq!(
            edited("if ok:\n    foo(a, b)\n    bar()\n", "    foo(a,  b)\n", ""),
            "if ok:\n    bar()\n"
        );
    }

    #[test]
    fn edit_by_whitespace_keeps_a_line_of_tabs_on_its_own_line() {
        assert_eq!(
            edited("top:\n\tkey:\tvalue\n", "\tkey: value", "\tkey: other"),
            "top:\n\tkey: other\n"
        );
        // The indentation of the file wins over the one `old` came with.
        assert_eq!(
            edited(
                "top:\n\tkey:\tvalue\n",
                "    key: value",
                "    key: other\n    more: 1"
            ),
            "top:\n\tkey: other\n\tmore: 1\n"
        );
    }

    #[test]
    fn edit_does_not_search_for_whitespace_alone() {
        assert!(matches!(
            apply_edit("a b c", "\t\t", "-", true),
            Err(EditError::NotFound)
        ));
    }

    #[test]
    fn edit_keeps_carriage_returns_in_a_replacement_of_several_lines() {
        assert_eq!(
            edited(
                "a = 1\r\nb = 2\r\nc = 3\r\n",
                "a = 1\nb = 2",
                "a = 10\nb = 20"
            ),
            "a = 10\r\nb = 20\r\nc = 3\r\n"
        );
        // One line matched as it is, two put in its place.
        assert_eq!(
            edited("a = 1\r\nb = 2\r\n", "a = 1", "a = 1\nz = 0"),
            "a = 1\r\nz = 0\r\nb = 2\r\n"
        );
        // A `\r` the model did send is not doubled, nor one `old` left behind.
        assert_eq!(
            edited("a = 1\r\nb = 2\r\n", "a = 1\nb = 2", "a = 10\r\nb = 20"),
            "a = 10\r\nb = 20\r\n"
        );
        assert_eq!(
            edited("a = 1\r\nb = 2\r\n", "\nb = 2", "\nb = 20"),
            "a = 1\r\nb = 20\r\n"
        );
        // A file of `\n` lines stays one.
        assert_eq!(
            edited("a = 1\nb = 2\n", "a = 1", "a = 1\nz = 0"),
            "a = 1\nz = 0\nb = 2\n"
        );
    }

    #[test]
    fn only_the_users_own_denial_is_reported_as_one() {
        let refused = |decided_by: &str| {
            ToolOutcome::refused(&PermissionDecision {
                allowed: false,
                rule: None,
                folder: None,
                decided_by: decided_by.to_string(),
                decision: None,
            })
        };
        let user = refused("user");
        assert_eq!(user.status, "denied");
        assert_eq!(user.result, "The user denied this action.");
        assert_eq!(refused("").result, user.result);
        for decided_by in ["cascade", "grant"] {
            let outcome = refused(decided_by);
            assert_eq!(outcome.status, "denied", "{decided_by}");
            assert_ne!(outcome.result, user.result, "{decided_by}");
        }
        for decided_by in ["cancelled", "stopped", "timeout"] {
            let outcome = refused(decided_by);
            assert_eq!(outcome.status, "canceled", "{decided_by}");
            assert_ne!(outcome.result, user.result, "{decided_by}");
        }
    }
}

#[cfg(test)]
mod output_tests {
    use super::*;

    #[test]
    fn characters_split_across_reads_are_decoded_whole() {
        let bytes = "Grüße 🦀".as_bytes();
        let mut pending = Vec::new();
        let mut text = String::new();
        for chunk in bytes.chunks(1) {
            pending.extend_from_slice(chunk);
            text.push_str(&take_utf8(&mut pending));
        }
        assert_eq!(text, "Grüße 🦀");
        assert!(pending.is_empty());
    }

    #[test]
    fn invalid_bytes_become_replacement_characters() {
        let mut pending = vec![b'a', 0xff, b'b'];
        assert_eq!(take_utf8(&mut pending), "a\u{FFFD}b");
        // A cut-off character waits for the rest.
        let mut pending = vec![b'x', 0xc3];
        assert_eq!(take_utf8(&mut pending), "x");
        assert_eq!(pending, vec![0xc3]);
    }
}

#[cfg(test)]
mod guidance_tests {
    use super::tests::test_runtime;
    use super::*;

    #[test]
    fn arguments_under_other_names_and_types_are_understood() {
        let read = parse_arguments(
            "read",
            r#"{ "file_path": "src/a.rs", "offset": "12", "limit": 40.0 }"#,
        )
        .unwrap();
        assert_eq!(read, json!({ "path": "src/a.rs", "offset": 12, "limit": 40 }));

        let edit = parse_arguments(
            "edit",
            r#"{ "path": "a", "old_str": "x", "new_str": "y", "replace_all": "true" }"#,
        )
        .unwrap();
        assert_eq!(
            edit,
            json!({ "path": "a", "old_string": "x", "new_string": "y", "replace_all": true })
        );

        // The tool's own name for an argument wins over another one.
        let grep = parse_arguments("grep", r#"{ "pattern": "a", "query": "b" }"#).unwrap();
        assert_eq!(grep, json!({ "pattern": "a", "query": "b" }));

        // No arguments at all, and an object sent as a string.
        assert_eq!(parse_arguments("ls", "  ").unwrap(), json!({}));
        assert_eq!(
            parse_arguments("ls", r#""{\"path\": \"src\"}""#).unwrap(),
            json!({ "path": "src" })
        );

        // An MCP tool's arguments are its own business.
        let mcp = parse_arguments("mcp__x__y", r#"{ "file_path": "a", "limit": "3" }"#).unwrap();
        assert_eq!(mcp, json!({ "file_path": "a", "limit": "3" }));
    }

    #[test]
    fn arguments_that_are_no_json_object_are_reported() {
        let cut_off = parse_arguments("write", r#"{ "path": "a.rs", "content": "fn main"#)
            .unwrap_err();
        assert!(cut_off.contains("not valid JSON"), "{cut_off}");
        assert!(cut_off.contains("ended before the call was complete"));

        let broken = parse_arguments("read", r#"{ "path": a.rs }"#).unwrap_err();
        assert!(broken.contains("not valid JSON"));
        assert!(!broken.contains("ended before"));

        let list = parse_arguments("read", r#"["a.rs"]"#).unwrap_err();
        assert!(list.contains("must be a JSON object"));
    }

    #[test]
    fn a_command_may_wait_longer_than_the_default() {
        assert_eq!(foreground_seconds(&json!({})), BACKGROUND_AFTER_SECONDS);
        assert_eq!(foreground_seconds(&json!({ "timeout_seconds": 300 })), 300);
        assert_eq!(foreground_seconds(&json!({ "timeout_seconds": 9_000 })), 600);
        // Other agents' shell tools take milliseconds.
        assert_eq!(foreground_seconds(&json!({ "timeout": 120_000 })), 120);
        assert_eq!(foreground_seconds(&json!({ "timeout": 45 })), 45);
    }

    #[tokio::test]
    async fn an_unread_file_is_not_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("kept.rs"), "fn kept() {}\n").unwrap();
        let mut runtime = test_runtime(&root, &directory.path().join("app-data"));

        let refused = write_file(
            &mut runtime,
            &json!({ "path": "kept.rs", "content": "fn other() {}\n" }),
        )
        .await;
        assert_eq!(refused.status, "error");
        assert!(refused.result.contains("have not read it"));
        assert_eq!(
            std::fs::read_to_string(root.join("kept.rs")).unwrap(),
            "fn kept() {}\n"
        );

        // Once read, it may be replaced.
        let read = read_file(&mut runtime, &json!({ "path": "kept.rs" })).await;
        assert_eq!(read.status, "ok");
        let written = write_file(
            &mut runtime,
            &json!({ "path": "kept.rs", "content": "fn other() {}\n" }),
        )
        .await;
        assert_eq!(written.status, "ok", "{}", written.result);

        // A new file, and a file the agent wrote itself, need no reading.
        for content in ["one\n", "two\n"] {
            let outcome = write_file(
                &mut runtime,
                &json!({ "path": "new.rs", "content": content }),
            )
            .await;
            assert_eq!(outcome.status, "ok", "{}", outcome.result);
        }

        // After a compaction the agent no longer knows what it read.
        runtime.files.forget(&runtime.session_id);
        let refused = write_file(
            &mut runtime,
            &json!({ "path": "new.rs", "content": "three\n" }),
        )
        .await;
        assert_eq!(refused.status, "error");
    }

    #[tokio::test]
    async fn an_unread_file_that_is_not_utf8_is_not_replaced() {
        // Latin-1 text, which `read` cannot show.
        let legacy = b"caf\xe9 au lait\n";
        let (_directory, mut runtime) = project_with("legacy.txt", legacy);
        let root = runtime.project_root.clone();

        let refused = write_file(
            &mut runtime,
            &json!({ "path": "legacy.txt", "content": "tea\n" }),
        )
        .await;
        assert_eq!(refused.status, "error");
        assert!(
            refused.result.starts_with(
                "legacy.txt already exists (13 bytes, not UTF-8 text) and you have not read it"
            ),
            "{}",
            refused.result
        );
        assert_eq!(std::fs::read(root.join("legacy.txt")).unwrap(), legacy);

        // A file the agent wrote stays its own after a command converted it,
        // and the change is counted against what can be read of it.
        let write = json!({ "path": "tea.txt", "content": "tea\n" });
        assert_eq!(write_file(&mut runtime, &write).await.status, "ok");
        std::fs::write(root.join("tea.txt"), b"th\xe9\n").unwrap();
        let replaced = write_file(&mut runtime, &write).await;
        assert_eq!(replaced.status, "ok", "{}", replaced.result);
        let change = &replaced.changes[0];
        assert_eq!(
            (change.status.as_str(), change.additions, change.deletions),
            ("M", 1, 1)
        );
    }

    #[tokio::test]
    async fn a_replaced_file_keeps_its_line_endings() {
        let (_directory, mut runtime) = project_with("win.txt", b"one\r\ntwo\r\n");
        let root = runtime.project_root.clone();
        // The agent sees the lines without their `\r`, and sends them back so.
        let read = read_file(&mut runtime, &json!({ "path": "win.txt" })).await;
        assert_eq!(read.result, "1\tone\n2\ttwo\n");

        let written = write_file(
            &mut runtime,
            &json!({ "path": "win.txt", "content": "one\ntwo\nthree\n" }),
        )
        .await;
        assert_eq!(written.status, "ok", "{}", written.result);
        assert_eq!(
            std::fs::read_to_string(root.join("win.txt")).unwrap(),
            "one\r\ntwo\r\nthree\r\n"
        );
        let change = &written.changes[0];
        assert_eq!((change.additions, change.deletions), (1, 0));
    }

    #[tokio::test]
    async fn an_environment_file_is_not_edited() {
        let secret = "API_KEY=hunter2\nDEBUG=1\n";
        let (_directory, mut runtime) = project_with(".env", secret.as_bytes());
        let root = runtime.project_root.clone();
        let asked = answering(&mut runtime, true);

        // An edit that would land, and one whose miss would show the closest text.
        for old in ["API_KEY=", "API_KEY = hunter"] {
            let outcome = edit_file(
                &mut runtime,
                &json!({ "path": ".env", "old_string": old, "new_string": "API_KEY=#" }),
            )
            .await;
            assert_eq!(outcome.status, "error");
            assert!(
                outcome
                    .result
                    .starts_with("Refusing to edit .env: it is an environment file."),
                "{}",
                outcome.result
            );
            assert!(!outcome.result.contains("hunter2"), "{}", outcome.result);
            assert!(!outcome.result.contains("DEBUG"), "{}", outcome.result);
        }
        assert_eq!(std::fs::read_to_string(root.join(".env")).unwrap(), secret);
        assert!(asked.lock().unwrap().is_empty());

        // With the rule switched off the file is read and edited like any other.
        runtime.file_ignore = Arc::new(FileIgnoreConfig::new(true, false, false, false, &[]));
        let outcome = edit_file(
            &mut runtime,
            &json!({ "path": ".env", "old_string": "DEBUG=1", "new_string": "DEBUG=0" }),
        )
        .await;
        assert_eq!(outcome.status, "ok", "{}", outcome.result);
        assert!(asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_folder_above_the_scratch_folder_does_not_hide_its_files() {
        let (directory, mut runtime) = project_with("a.txt", b"");
        // Where Linux keeps it: below `~/.cache`, a name builds leave behind.
        let scratch = directory.path().canonicalize().unwrap().join(".cache/scratch");
        runtime.permissions.set_scratch_root(scratch.clone());
        let notes = scratch.join("session/notes.txt");
        let asked = answering(&mut runtime, false);
        let at = |path: &Path| path.to_string_lossy().to_string();

        let written = write_file(
            &mut runtime,
            &json!({ "path": at(&notes), "content": "one\n" }),
        )
        .await;
        assert_eq!(written.status, "ok", "{}", written.result);
        let edited = edit_file(
            &mut runtime,
            &json!({ "path": at(&notes), "old_string": "one", "new_string": "two" }),
        )
        .await;
        assert_eq!(edited.status, "ok", "{}", edited.result);
        let read = read_file(&mut runtime, &json!({ "path": at(&notes) })).await;
        assert_eq!(read.result, "1\ttwo\n");

        // The rules for names hold there as in the project.
        let env = scratch.join("session/.env");
        std::fs::write(&env, "KEY=value\n").unwrap();
        let read = read_file(&mut runtime, &json!({ "path": at(&env) })).await;
        assert!(read.result.contains("it is an environment file"), "{}", read.result);
        let edited = edit_file(
            &mut runtime,
            &json!({ "path": at(&env), "old_string": "KEY", "new_string": "K" }),
        )
        .await;
        assert!(edited.result.starts_with("Refusing to edit .env:"), "{}", edited.result);
        assert!(asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn writing_an_environment_file_takes_the_users_yes() {
        let (_directory, mut runtime) = project_with(".gitignore", b"scratch/\n");
        let root = runtime.project_root.clone();
        let write = |path: &str| json!({ "path": path, "content": "KEY=value\n" });

        let asked = answering(&mut runtime, false);
        let refused = write_file(&mut runtime, &write(".env")).await;
        assert_eq!(refused.status, "denied", "{}", refused.result);
        assert!(!root.join(".env").exists());
        assert_eq!(*asked.lock().unwrap(), ["Modify .env?"]);

        let asked = answering(&mut runtime, true);
        let written = write_file(&mut runtime, &write("config/.env.local")).await;
        assert_eq!(written.status, "ok", "{}", written.result);
        assert_eq!(*asked.lock().unwrap(), ["Modify config/.env.local?"]);

        // A template holds no values, and a folder that git ignores or a build
        // writes to is where such files go: none of them asks, though `read`
        // refuses what is in the folders.
        let asked = answering(&mut runtime, false);
        for path in [".env.example", "scratch/notes.md", "dist/app.js"] {
            let written = write_file(&mut runtime, &write(path)).await;
            assert_eq!(written.status, "ok", "{path}: {}", written.result);
        }
        let read = read_file(&mut runtime, &json!({ "path": "scratch/notes.md" })).await;
        assert!(read.result.contains("ignored by .gitignore"), "{}", read.result);
        assert!(asked.lock().unwrap().is_empty());

        // The user's rules decide: with the rule off or the file exempted,
        // nothing is asked.
        runtime.file_ignore = Arc::new(FileIgnoreConfig::new(true, false, false, false, &[]));
        let written = write_file(&mut runtime, &write(".env")).await;
        assert_eq!(written.status, "ok", "{}", written.result);
        runtime.file_ignore = Arc::new(FileIgnoreConfig::new(
            true,
            false,
            false,
            true,
            &[".env.test".to_string()],
        ));
        let written = write_file(&mut runtime, &write(".env.test")).await;
        assert_eq!(written.status, "ok", "{}", written.result);
        assert!(asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_environment_file_that_is_there_is_not_asked_about() {
        let (_directory, mut runtime) = project_with(".env", b"API_KEY=secret\n");
        let asked = answering(&mut runtime, true);

        let outcome = write_file(
            &mut runtime,
            &json!({ "path": ".env", "content": "API_KEY=other\n" }),
        )
        .await;
        // It could only be replaced after a read that is refused, so the
        // user is not asked for a yes that leads nowhere.
        assert_eq!(outcome.status, "error", "{}", outcome.result);
        assert!(
            outcome.result.starts_with(".env already exists and was not replaced:")
                && !outcome.result.contains("secret"),
            "{}",
            outcome.result
        );
        assert!(asked.lock().unwrap().is_empty());
        assert_eq!(
            std::fs::read_to_string(runtime.project_root.join(".env")).unwrap(),
            "API_KEY=secret\n"
        );
    }

    #[tokio::test]
    async fn glob_says_when_it_shows_only_some_of_the_matches() {
        let (_directory, mut runtime) = project_with("f000.txt", b"");
        let total = GLOB_SHOWN + 20;
        for index in 1..total {
            std::fs::write(runtime.project_root.join(format!("f{index:03}.txt")), "").unwrap();
        }

        let outcome = glob_files(&mut runtime, &json!({ "pattern": "*.txt" })).await;
        let lines: Vec<&str> = outcome.result.lines().collect();
        // The first by name, in whatever order the folder was walked.
        let first: Vec<String> = (0..GLOB_SHOWN).map(|index| format!("f{index:03}.txt")).collect();
        assert_eq!(lines[..GLOB_SHOWN], first);
        assert_eq!(
            lines[GLOB_SHOWN..],
            [
                "",
                "… showing the first 500 of 520 matches only. Narrow the pattern or add path to see more."
            ]
        );
    }

    #[tokio::test]
    async fn ls_says_when_it_shows_only_some_of_the_entries() {
        let (_directory, mut runtime) = project_with("f0000.txt", b"");
        for index in 1..LIST_SHOWN + 5 {
            std::fs::write(runtime.project_root.join(format!("f{index:04}.txt")), "").unwrap();
        }

        let outcome = list_dir(&mut runtime, &json!({})).await;
        let lines: Vec<&str> = outcome.result.lines().collect();
        assert_eq!(lines.len(), LIST_SHOWN + 2);
        assert_eq!(lines[LIST_SHOWN - 1], "f0999.txt");
        assert_eq!(
            lines[LIST_SHOWN + 1],
            "… showing the first 1000 of 1005 entries only. Use glob with a pattern to find the others."
        );
    }

    #[tokio::test]
    async fn grep_says_which_text_it_did_not_search() {
        let (_directory, mut runtime) = project_with("notes.txt", b"needle here\n");
        let root = runtime.project_root.clone();
        std::fs::write(root.join("big.txt"), "needle\n".repeat(160_000)).unwrap();
        std::fs::write(root.join("legacy.txt"), b"needle caf\xe9\n").unwrap();
        // Binary files are no text of the project: nothing is said of them.
        std::fs::write(root.join("logo.png"), b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR needle").unwrap();
        std::fs::write(root.join("film.bin"), vec![0u8; 1_100_000]).unwrap();

        let left_out = "Not searched: 1 file over 1 MB, 1 file not in UTF-8.";
        let found = grep_files(&mut runtime, &json!({ "pattern": "needle" })).await;
        assert_eq!(found.result, format!("notes.txt:1: needle here\n\n{left_out}"));
        let none = grep_files(&mut runtime, &json!({ "pattern": "absent" })).await;
        assert_eq!(none.result, format!("No matches for 'absent'.\n\n{left_out}"));

        // Aimed at one file, the search says why it did not look into it.
        let aimed_at = |path: &str| json!({ "pattern": "needle", "path": path });
        let big = grep_files(&mut runtime, &aimed_at("big.txt")).await;
        assert_eq!(big.status, "error");
        assert!(
            big.result
                .starts_with("big.txt is 1.1 MB, more than the 1 MB grep searches."),
            "{}",
            big.result
        );
        let legacy = grep_files(&mut runtime, &aimed_at("legacy.txt")).await;
        assert_eq!(legacy.status, "error");
        assert_eq!(
            legacy.result,
            "legacy.txt is not UTF-8 text, so grep cannot search it."
        );
        // So does one the rules keep from the agent, as `read` does.
        std::fs::write(root.join("app.log"), "needle\n").unwrap();
        let hidden = grep_files(&mut runtime, &aimed_at("app.log")).await;
        assert_eq!(hidden.status, "error");
        assert!(
            hidden.result.starts_with(
                "Refusing to search app.log: it is inside a generated or dependency directory."
            ),
            "{}",
            hidden.result
        );
    }

    #[tokio::test]
    async fn an_edit_shows_where_it_landed() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        let lines: String = (1..=20).map(|line| format!("line {line}\n")).collect();
        std::fs::write(root.join("a.txt"), &lines).unwrap();
        let mut runtime = test_runtime(&root, &directory.path().join("app-data"));

        let outcome = edit_file(
            &mut runtime,
            &json!({ "path": "a.txt", "old_string": "line 10\n", "new_string": "ten\nten and a half\n" }),
        )
        .await;
        assert_eq!(outcome.status, "ok", "{}", outcome.result);
        assert_eq!(
            outcome.result,
            "Edited a.txt (1 replacement). It now reads, from line 8:\n8\tline 8\n9\tline 9\n10\tten\n11\tten and a half\n12\tline 11\n13\tline 12\n"
        );
    }

    #[tokio::test]
    async fn a_failed_edit_shows_the_closest_text() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("a.rs"),
            "fn main() {\n    let total = compute(1, 2);\n    println!(\"{total}\");\n}\n",
        )
        .unwrap();
        let mut runtime = test_runtime(&root, &directory.path().join("app-data"));

        let outcome = edit_file(
            &mut runtime,
            &json!({ "path": "a.rs", "old_string": "let total = compute(1, 3);\nprintln!(\"{total}\");", "new_string": "x" }),
        )
        .await;
        assert_eq!(outcome.status, "error");
        assert!(
            outcome.result.contains(
                "The closest text is:\n2\t    let total = compute(1, 2);\n3\t    println!(\"{total}\");\n"
            ),
            "{}",
            outcome.result
        );

        let outcome = edit_file(
            &mut runtime,
            &json!({ "path": "a.rs", "old_string": "class Unrelated extends Thing", "new_string": "x" }),
        )
        .await;
        assert_eq!(outcome.status, "error");
        assert!(outcome.result.contains("nothing in the file is close to it"));
    }

    #[tokio::test]
    async fn text_copied_with_its_line_numbers_still_matches() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.rs"), "fn a() {}\nfn b() {}\nfn c() {}\n").unwrap();
        let mut runtime = test_runtime(&root, &directory.path().join("app-data"));

        let outcome = edit_file(
            &mut runtime,
            &json!({ "path": "a.rs", "old_string": "2\tfn b() {}\n3\tfn c() {}", "new_string": "2\tfn b() { run() }\n3\tfn c() {}" }),
        )
        .await;
        assert_eq!(outcome.status, "ok", "{}", outcome.result);
        assert!(outcome.result.contains("line numbers ignored"));
        assert_eq!(
            std::fs::read_to_string(root.join("a.rs")).unwrap(),
            "fn a() {}\nfn b() { run() }\nfn c() {}\n"
        );
        assert_eq!(strip_line_numbers("fn a() {}\n12\tfn b() {}"), None);
    }

    fn background(runtime: &ToolRuntime, id: &str, output: &str) -> Arc<RunningProcess> {
        let mut buffer = OutputBuffer::default();
        buffer.push(output);
        let seen = buffer.total();
        let process = Arc::new(RunningProcess {
            id: id.to_string(),
            session_id: runtime.session_id.clone(),
            command: "pnpm run test".to_string(),
            cwd: String::new(),
            started_at: crate::db::now_ms(),
            output: Arc::new(Mutex::new(buffer)),
            child: Arc::new(Mutex::new(None)),
            pid: None,
            running: Arc::new(AtomicBool::new(true)),
            exit_code: Arc::new(Mutex::new(None)),
            read_upto: Mutex::new(seen),
        });
        runtime.processes.insert(process.clone());
        process
    }

    #[tokio::test]
    async fn the_rest_of_a_background_command_can_be_read() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        let mut runtime = test_runtime(&root, &directory.path().join("app-data"));
        let process = background(&runtime, "ab12cd34", "compiling\n");

        // Still running: only what is new since the bash result is handed over.
        process.output.lock().unwrap().push("test a ... ok\n");
        let running = bash_output(&mut runtime, &json!({ "id": "ab12cd34", "wait_seconds": 0 })).await;
        assert_eq!(running.status, "ok");
        assert!(running.result.starts_with("Command is still running"));
        assert!(running.result.ends_with("New output:\ntest a ... ok\n"));

        // It ends while the agent waits for it.
        let ending = process.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            ending.output.lock().unwrap().push("test b ... FAILED\n");
            *ending.exit_code.lock().unwrap() = Some(1);
            ending.running.store(false, Ordering::SeqCst);
        });
        let failed = bash_output(&mut runtime, &json!({ "id": "ab12cd34" })).await;
        assert_eq!(failed.status, "error");
        assert_eq!(
            failed.result,
            "Command failed with exit code 1.\nNew output:\ntest b ... FAILED\n"
        );

        // It stays readable after it has ended, with nothing new to say.
        assert!(runtime.processes.list().is_empty());
        let again = bash_output(&mut runtime, &json!({ "id": "ab12cd34" })).await;
        assert!(again.result.ends_with("No new output."));

        let unknown = bash_output(&mut runtime, &json!({ "id": "nope" })).await;
        assert_eq!(unknown.status, "error");
        assert!(unknown.result.contains("Known: ab12cd34 (pnpm run test)"));
    }

    /// What `command` streamed to the chat while it ran, and its result.
    #[cfg(unix)]
    async fn streamed(command: &str) -> (String, ToolOutcome) {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("log.txt"), "one\ntwo\n").unwrap();
        let mut runtime = test_runtime(&root, workspace.path());
        let shown = Arc::new(Mutex::new(String::new()));
        let sink = shown.clone();
        runtime.emit = Arc::new(move |routed: RoutedEvent| {
            if let StreamEvent::ToolDelta { text, .. } = routed.event {
                sink.lock().unwrap().push_str(&text);
            }
        });
        let outcome = run_bash(&mut runtime, &json!({ "command": command })).await;
        let shown = shown.lock().unwrap().clone();
        (shown, outcome)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_command_gets_what_the_users_shell_exports() {
        crate::shell_env::set_command_var("PUMR_TEST_FROM_PROFILE", "set in the profile");
        let (_, outcome) = streamed("printf '%s' \"$PUMR_TEST_FROM_PROFILE\"").await;
        assert_eq!(outcome.status, "ok", "{}", outcome.result);
        assert!(
            outcome.result.ends_with("set in the profile"),
            "{}",
            outcome.result
        );
        // pumr's own environment stays what the desktop session gave it.
        assert!(std::env::var_os("PUMR_TEST_FROM_PROFILE").is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_chat_sees_what_a_tail_holds_back() {
        let (shown, outcome) = streamed("printf 'one\\ntwo\\nthree\\n' | tail -n 1").await;
        assert_eq!(outcome.status, "ok", "{}", outcome.result);
        // The model reads what `tail` kept, the chat every line as it came.
        assert_eq!(outcome.result, "Command finished successfully.\nthree\n");
        assert!(shown.starts_with("one\ntwo\nthree\n"), "{shown}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_tail_of_a_file_and_other_commands_run_as_they_are() {
        let (shown, outcome) = streamed("tail -n 1 log.txt").await;
        assert_eq!(outcome.result, "Command finished successfully.\ntwo\n");
        assert_eq!(shown, "two\n");

        let (shown, outcome) = streamed("printf 'one\\ntwo\\n' | head -n 1").await;
        assert_eq!(outcome.result, "Command finished successfully.\none\n");
        assert_eq!(shown, "one\n");
    }

    /// A project with one file, and the runtime of a call in it.
    fn project_with(name: &str, content: &[u8]) -> (tempfile::TempDir, ToolRuntime) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("project");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(name), content).unwrap();
        let runtime = test_runtime(&root, &directory.path().join("app-data"));
        (directory, runtime)
    }

    #[tokio::test]
    async fn a_picture_is_read_for_a_model_that_takes_pictures() {
        let png = b"\x89PNG\r\n\x1a\nrest of the picture";
        let (_directory, mut runtime) = project_with("shot.png", png);

        let outcome = read_file(&mut runtime, &json!({ "path": "shot.png" })).await;
        assert_eq!(outcome.status, "ok", "{}", outcome.result);
        assert!(outcome.result.starts_with("shot.png is a picture (image/png, 1 KB)."));
        let picture = &outcome.attachments[0];
        assert_eq!((picture.kind.as_str(), picture.name.as_str()), ("image", "shot.png"));
        assert_eq!(
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &picture.data)
                .unwrap(),
            png
        );

        // A model without vision is told so, and gets no picture to choke on.
        runtime.vision = false;
        let outcome = read_file(&mut runtime, &json!({ "path": "shot.png" })).await;
        assert_eq!(outcome.status, "error");
        assert!(outcome.result.contains("does not take pictures"), "{}", outcome.result);
        assert!(outcome.attachments.is_empty());
    }

    #[tokio::test]
    async fn a_picture_too_large_for_a_model_is_not_read() {
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.resize(read_formats::MAX_PICTURE_BYTES + 1, 0);
        let (_directory, mut runtime) = project_with("huge.png", &png);

        let outcome = read_file(&mut runtime, &json!({ "path": "huge.png" })).await;
        assert_eq!(outcome.status, "error");
        assert!(outcome.result.contains("more than the 5 MB"), "{}", outcome.result);
        assert!(outcome.attachments.is_empty());
    }

    #[tokio::test]
    async fn a_pdf_is_read_as_the_text_of_its_pages() {
        let pdf = read_formats::tests::pdf_with(&["Pumas are fast.", "They also climb."]);
        let (_directory, mut runtime) = project_with("pumas.pdf", &pdf);

        let all = read_file(&mut runtime, &json!({ "path": "pumas.pdf" })).await;
        assert_eq!(all.status, "ok", "{}", all.result);
        assert_eq!(
            all.result,
            "pumas.pdf: PDF, 2 page(s). Below is the text of page 1-2.\n\n--- page 1 ---\nPumas are fast.\n\n--- page 2 ---\nThey also climb.\n\n"
        );

        let second = read_file(&mut runtime, &json!({ "path": "pumas.pdf", "pages": "2" })).await;
        assert!(second.result.contains("They also climb."), "{}", second.result);
        assert!(!second.result.contains("Pumas are fast."), "{}", second.result);

        let beyond = read_file(&mut runtime, &json!({ "path": "pumas.pdf", "pages": "5" })).await;
        assert_eq!(beyond.status, "error");
        assert!(beyond.result.contains("this document has 2"), "{}", beyond.result);
    }

    #[tokio::test]
    async fn a_long_pdf_is_read_a_few_pages_at_a_time() {
        let lines: Vec<String> = (1..=25).map(|page| format!("Text of page {page}.")).collect();
        let pages: Vec<&str> = lines.iter().map(String::as_str).collect();
        let (_directory, mut runtime) =
            project_with("long.pdf", &read_formats::tests::pdf_with(&pages));

        let first = read_file(&mut runtime, &json!({ "path": "long.pdf" })).await;
        assert!(
            first.result.starts_with(
                "long.pdf: PDF, 25 page(s). Below is the text of page 1-10. Read on with pages=\"11-20\"."
            ),
            "{}",
            first.result
        );
        assert!(first.result.contains("Text of page 10."));
        assert!(!first.result.contains("Text of page 11."));
    }

    #[tokio::test]
    async fn a_scanned_pdf_says_that_it_has_no_text() {
        let (_directory, mut runtime) =
            project_with("scan.pdf", &read_formats::tests::pdf_with(&[""]));
        let outcome = read_file(&mut runtime, &json!({ "path": "scan.pdf" })).await;
        assert_eq!(outcome.status, "error");
        assert!(outcome.result.contains("probably a scan"), "{}", outcome.result);
    }

    #[tokio::test]
    async fn a_notebook_is_read_as_its_cells() {
        let notebook = json!({
            "cells": [
                { "cell_type": "code", "source": ["speed = 80\n", "print(speed)"],
                  "outputs": [{ "output_type": "stream", "text": "80\n" }] }
            ]
        });
        let (_directory, mut runtime) =
            project_with("speed.ipynb", notebook.to_string().as_bytes());

        let outcome = read_file(&mut runtime, &json!({ "path": "speed.ipynb" })).await;
        assert_eq!(outcome.status, "ok", "{}", outcome.result);
        assert!(
            outcome.result.contains("\n[1] code\nspeed = 80\nprint(speed)\n-- output --\n80\n"),
            "{}",
            outcome.result
        );
        // Not the file's own lines, so they carry no line numbers.
        assert!(!outcome.result.contains("1\t"), "{}", outcome.result);
    }

    #[tokio::test]
    async fn a_binary_file_is_named_instead_of_read() {
        let (_directory, mut runtime) = project_with("bundle.zip", b"PK\x03\x04\xff\xfe");
        let outcome = read_file(&mut runtime, &json!({ "path": "bundle.zip" })).await;
        assert_eq!(outcome.status, "error");
        assert!(
            outcome.result.starts_with(
                "bundle.zip is a zip archive (or an Office document) (6 bytes), not UTF-8 text."
            ),
            "{}",
            outcome.result
        );
    }

    /// A project whose `write.sh` writes a file outside of it, a runtime that
    /// confines commands and runs the script without asking, and the file.
    #[cfg(unix)]
    fn confined_project() -> (tempfile::TempDir, ToolRuntime, PathBuf) {
        // Below the home folder: the system's temp folder stays writable.
        let directory = tempfile::Builder::new()
            .prefix(".pumr-bash-test-")
            .tempdir_in(std::env::var_os("HOME").unwrap())
            .unwrap();
        let base = directory.path().canonicalize().unwrap();
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("write.sh"), "echo escaped > ../escaped.txt\n").unwrap();
        let runtime = test_runtime(&root, &base.join("app-data"));
        runtime.permissions.set_sandbox(sandbox::Config {
            mode: sandbox::Mode::Files,
            ..Default::default()
        });
        runtime.permissions.add_session_command_rule(
            "session",
            &crate::models::CommandRule::Exact("sh write.sh".to_string()),
        );
        (directory, runtime, base.join("escaped.txt"))
    }

    /// Answers every prompt of `runtime` with `allowed` and keeps the titles.
    fn answering(runtime: &mut ToolRuntime, allowed: bool) -> Arc<Mutex<Vec<String>>> {
        let asked: Arc<Mutex<Vec<String>>> = Arc::default();
        let (seen, broker) = (asked.clone(), runtime.broker.clone());
        runtime.emit = Arc::new(move |routed: RoutedEvent| {
            if let StreamEvent::PermissionRequest {
                request_id, title, ..
            } = routed.event
            {
                seen.lock().unwrap().push(title);
                broker.resolve(
                    &request_id,
                    PermissionDecision {
                        allowed,
                        rule: None,
                        folder: None,
                        decided_by: "user".to_string(),
                        decision: Some(if allowed { "allow_once" } else { "deny" }.to_string()),
                    },
                );
            }
        });
        asked
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_sandbox_stops_what_a_command_writes_outside_the_project() {
        if !sandbox::support().files {
            return;
        }
        let (_directory, mut runtime, escaped) = confined_project();
        let asked = answering(&mut runtime, true);

        let outcome = run_bash(&mut runtime, &json!({ "command": "sh write.sh" })).await;
        assert_eq!(outcome.status, "error", "{}", outcome.result);
        assert!(!escaped.exists());
        // The agent learns what stopped the command and how to ask for more.
        assert!(
            outcome.result.contains(
                "[pumr] This command ran in the sandbox: it writes only to the project"
            ) && outcome.result.contains("\"unsandboxed\": true"),
            "{}",
            outcome.result
        );
        assert!(asked.lock().unwrap().is_empty());

        // A command that fails for a reason of its own is told nothing.
        let outcome = run_bash(&mut runtime, &json!({ "command": "false" })).await;
        assert_eq!(outcome.result, "Command failed with exit code 1.\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_confined_command_still_shows_what_its_tail_holds_back() {
        if !sandbox::support().files {
            return;
        }
        let (_directory, mut runtime, _) = confined_project();
        let shown = Arc::new(Mutex::new(String::new()));
        let sink = shown.clone();
        runtime.emit = Arc::new(move |routed: RoutedEvent| {
            if let StreamEvent::ToolDelta { text, .. } = routed.event {
                sink.lock().unwrap().push_str(&text);
            }
        });

        let command = "printf 'one\\ntwo\\nthree\\n' | tail -n 1";
        let outcome = run_bash(&mut runtime, &json!({ "command": command })).await;
        assert_eq!(outcome.result, "Command finished successfully.\nthree\n");
        // The pipe to the chat is one of the command's own file descriptors.
        assert!(shown.lock().unwrap().starts_with("one\ntwo\nthree\n"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn leaving_the_sandbox_takes_the_users_yes_every_time() {
        if !sandbox::support().files {
            return;
        }
        let (_directory, mut runtime, escaped) = confined_project();
        let call = json!({ "command": "sh write.sh", "unsandboxed": true });

        let asked = answering(&mut runtime, false);
        let refused = run_bash(&mut runtime, &call).await;
        assert_eq!(refused.status, "denied", "{}", refused.result);
        assert!(!escaped.exists());

        let asked_again = answering(&mut runtime, true);
        for _ in 0..2 {
            let outcome = run_bash(&mut runtime, &call).await;
            assert_eq!(outcome.status, "ok", "{}", outcome.result);
        }
        assert_eq!(std::fs::read_to_string(&escaped).unwrap(), "escaped\n");
        let title = "Run command outside the sandbox?".to_string();
        assert_eq!(*asked.lock().unwrap(), [title.clone()]);
        // Nothing remembers the yes: the second run asked like the first.
        assert_eq!(*asked_again.lock().unwrap(), [title.clone(), title]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn without_a_sandbox_nothing_is_asked_about_leaving_it() {
        let (_directory, mut runtime, escaped) = confined_project();
        runtime.permissions.set_sandbox(sandbox::Config::default());
        let asked = answering(&mut runtime, false);

        let call = json!({ "command": "sh write.sh", "unsandboxed": true });
        let outcome = run_bash(&mut runtime, &call).await;
        assert_eq!(outcome.status, "ok", "{}", outcome.result);
        assert!(escaped.exists());
        assert!(asked.lock().unwrap().is_empty());
    }

    #[test]
    fn only_bash_is_offered_the_way_out_of_the_sandbox() {
        let mut schemas = tool_schemas();
        offer_unsandboxed(&mut schemas);
        let offered: Vec<&str> = schemas
            .iter()
            .filter(|schema| {
                schema
                    .pointer("/function/parameters/properties/unsandboxed")
                    .is_some()
            })
            .filter_map(|schema| schema.pointer("/function/name")?.as_str())
            .collect();
        assert_eq!(offered, ["bash"]);
        // Where nothing is confined, the schema says nothing of it.
        assert!(!json!(tool_schemas()).to_string().contains("unsandboxed"));
    }

    #[test]
    fn the_tools_for_output_and_pictures_are_offered() {
        let offered: Vec<String> = base_tool_schemas()
            .iter()
            .filter_map(|schema| schema.pointer("/function/name")?.as_str().map(str::to_string))
            .collect();
        for name in ["bash_output", "screenshot", "read", "edit", "todo"] {
            assert!(offered.iter().any(|tool| tool == name), "{name} is not offered");
        }
    }
}

