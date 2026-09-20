use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub path: String,
    pub name: String,
    pub created_at: i64,
    pub last_opened_at: i64,
    pub session_count: i64,
    pub total_cost: f64,
    /// User-chosen accent color as a hex string (e.g. `#f59e0b`). When unset the
    /// UI derives a stable color from the project identity.
    #[serde(default)]
    pub color: Option<String>,
    /// Id of a built-in icon from the fixed set. Ignored when `icon_image` is set.
    #[serde(default)]
    pub icon: Option<String>,
    /// Data URL of an uploaded square image. Takes precedence over `icon`.
    #[serde(default)]
    pub icon_image: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub provider: Option<String>,
    pub system_prompt: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub cost: f64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cached_tokens: i64,
    pub message_count: i64,
    #[serde(default)]
    pub parent_session_id: Option<String>,
    #[serde(default)]
    pub agent_status: Option<String>,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub mode_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRecord {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub additions: i64,
    pub deletions: i64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub mime_type: String,
    #[serde(default)]
    pub size: i64,
    /// Either `"image"` (vision payload) or `"text"` (inlined file contents).
    pub kind: String,
    #[serde(default)]
    pub lines: Option<i64>,
    /// Raw base64 for images (no data-URL prefix), file contents for text.
    #[serde(default)]
    pub data: String,
}

impl Attachment {
    pub fn is_image(&self) -> bool {
        self.kind == "image"
    }

    pub fn is_pdf(&self) -> bool {
        self.kind == "pdf"
    }
}

/// A user-supplied context reference inserted from the composer with `@`.
///
/// `kind` is one of `file`, `directory`, `website`, `skill` or `mcp`; `value`
/// is a project-relative path, an absolute URL, a skill name or an MCP server
/// name respectively. `label` is the text shown to the user.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mention {
    pub kind: String,
    pub value: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub session_id: String,
    pub seq: i64,
    pub role: String,
    pub content: String,
    pub reasoning: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub cost: f64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cached_tokens: i64,
    pub created_at: i64,
    #[serde(default)]
    pub tool_calls: Vec<ToolCallRecord>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub status: Option<String>,
    #[serde(default)]
    pub changes: Vec<FileChange>,
    pub base_commit: Option<String>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    #[serde(default)]
    pub mentions: Vec<Mention>,
    /// Content resolved from `mentions` (file contents, directory trees, web
    /// pages, skill instructions). Sent to the model but never displayed.
    #[serde(default)]
    pub context: String,
}

/// A file or folder that can be referenced from the composer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub path: String,
    pub kind: String,
}

/// The text content of a file opened from the workspace tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    pub path: String,
    pub content: String,
    pub language: String,
}

/// An MCP tool exposed to the agent loop.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub server: String,
    pub name: String,
    pub exposed_name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub context_length: i64,
    pub prompt_price_per_m: f64,
    pub completion_price_per_m: f64,
    pub cache_read_price_per_m: f64,
    pub supports_reasoning: bool,
    pub supports_vision: bool,
    pub supports_tools: bool,
    pub input_modalities: Vec<String>,
    pub supported_parameters: Vec<String>,
    pub created: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointInfo {
    pub name: String,
    pub slug: String,
    pub provider_name: String,
    pub provider_slug: String,
    pub context_length: i64,
    pub prompt_price_per_m: f64,
    pub completion_price_per_m: f64,
    pub cache_read_price_per_m: f64,
    pub uptime_last_5m: Option<f64>,
    pub uptime_last_30m: Option<f64>,
    pub uptime_last_1d: Option<f64>,
    pub throughput_last_30m: Option<f64>,
    pub latency_last_30m: Option<f64>,
    pub max_completion_tokens: Option<i64>,
    pub quantization: Option<String>,
    pub supports_implicit_caching: bool,
    pub training: Option<bool>,
    pub retains_prompts: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub slug: String,
    pub name: String,
    pub icon_url: Option<String>,
    pub headquarters: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendSummary {
    pub total_cost: f64,
    pub today_cost: f64,
    pub session_cost: f64,
    pub budget_usd: f64,
    pub remaining_usd: Option<f64>,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cached_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailySpend {
    pub date: String,
    pub cost: f64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cached_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpend {
    pub model: String,
    pub provider: Option<String>,
    pub cost: f64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cached_tokens: i64,
    pub messages: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSpend {
    pub session_id: String,
    pub title: String,
    pub project_id: String,
    pub parent_session_id: Option<String>,
    pub cost: f64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cached_tokens: i64,
    pub messages: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendStats {
    pub total_cost: f64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cached_tokens: i64,
    pub messages: i64,
    pub sessions: i64,
    pub daily: Vec<DailySpend>,
    pub by_model: Vec<ModelSpend>,
    pub by_session: Vec<SessionSpend>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub head: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRule {
    pub path: String,
    pub scope: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_content: String,
    pub new_content: String,
    pub language: String,
    pub additions: i64,
    pub deletions: i64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub id: String,
    pub session_id: String,
    pub command: String,
    pub cwd: String,
    pub started_at: i64,
    pub running: bool,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecision {
    pub allowed: bool,
    #[serde(default)]
    pub rule: Option<String>,
    #[serde(default)]
    pub folder: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionItem {
    pub header: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    #[serde(default)]
    pub multi_select: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnswer {
    pub header: String,
    pub question: String,
    #[serde(default)]
    pub selected: Vec<String>,
    #[serde(default)]
    pub custom: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCandidate {
    pub path: String,
    pub label: String,
    pub source: String,
    pub format: String,
    pub servers: Vec<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCandidate {
    pub path: String,
    pub label: String,
    pub source: String,
    pub skills: Vec<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StreamEvent {
    Started {
        message: Message,
    },
    Delta {
        text: String,
    },
    Reasoning {
        text: String,
    },
    Usage {
        prompt_tokens: i64,
        completion_tokens: i64,
        cached_tokens: i64,
        cost: f64,
    },
    Assistant {
        message: Message,
    },
    ToolStart {
        call_id: String,
        name: String,
        summary: String,
        arguments: String,
    },
    ToolDelta {
        call_id: String,
        text: String,
    },
    ToolEnd {
        call_id: String,
        name: String,
        status: String,
        result: String,
        changes: Vec<FileChange>,
    },
    PermissionRequest {
        request_id: String,
        prompt_kind: String,
        title: String,
        detail: String,
        command: Option<String>,
        path: Option<String>,
        folder: Option<String>,
        url: Option<String>,
        suggested_rule: Option<String>,
    },
    PermissionResolved {
        request_id: String,
        allowed: bool,
    },
    QuestionRequest {
        request_id: String,
        questions: Vec<QuestionItem>,
    },
    QuestionResolved {
        request_id: String,
        answers: Option<Vec<QuestionAnswer>>,
    },
    Changes {
        changes: Vec<FileChange>,
    },
    Done {
        message: Message,
        session: Session,
    },
    Stopped {
        message: Message,
    },
    SubAgentStarted {
        session: Session,
    },
    SubAgentStatus {
        status: String,
    },
    Error {
        message: String,
    },
}

/// A stream event tagged with the session it belongs to. Subagents stream their
/// own events through the same channel, so consumers route by `session_id`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutedEvent {
    pub session_id: String,
    pub event: StreamEvent,
}

/// Cloneable sink used by the agent loop. The routed session id is supplied by
/// the emitter, which allows parallel subagents to share one sink.
pub type EventSink = Arc<dyn Fn(RoutedEvent) + Send + Sync>;
