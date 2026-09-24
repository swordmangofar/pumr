use crate::broker::{PermissionBroker, QuestionBroker};
use crate::db::{Db, NewMessage};
use crate::error::Result;
use crate::git::ShadowRepo;
use crate::mcp::McpManager;
use crate::models::{
    Attachment, EventSink, FileChange, Message, RoutedEvent, StreamEvent, ToolCallRecord,
};
use crate::permissions::{FileIgnoreConfig, LivePermissions};
use crate::processes::ProcessRegistry;
use crate::providers::openrouter::{
    ChatChunk, ChatMessage, ChatUsage, OpenRouterClient, ProviderRouting, ReasoningSetting,
};
use crate::tools::{self, ToolOutcome, ToolRuntime};
use serde_json::{json, Value};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

const MAX_SUBAGENT_DEPTH: usize = 1;

#[derive(Clone)]
pub struct TurnRequest {
    pub api_key: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub provider: Option<String>,
    pub system_prompt: String,
    pub session_id: String,
    pub project_id: String,
    pub depth: usize,
    pub project_root: PathBuf,
    pub extra_folders: Vec<PathBuf>,
    pub command_rules: Vec<String>,
    pub file_ignore: Arc<FileIgnoreConfig>,
    pub context_message_limit: usize,
    /// The selected model's context window in tokens (0 when unknown). Used to
    /// trim history so large projects don't overflow the provider's limit.
    pub context_length: i64,
    /// Maximum number of consecutive tool-requesting model turns before the
    /// loop pauses (or auto-continues).
    pub max_tool_iterations: usize,
    /// When true, keep going past the iteration limit instead of pausing.
    pub auto_continue: bool,
    pub fallback_pricing: Option<(f64, f64)>,
    pub base_commit: String,
    /// True when this turn continues a paused prompt. `base_commit` then points
    /// at that prompt's original snapshot rather than the previous turn.
    pub resume: bool,
    /// Planning modes disable the write/edit tools so the agent can only plan.
    pub plan_only: bool,
    pub cancel: CancellationToken,
}

#[derive(Clone)]
pub struct TurnDeps {
    pub db: Arc<Db>,
    pub shadow: Arc<ShadowRepo>,
    pub processes: Arc<ProcessRegistry>,
    pub broker: Arc<PermissionBroker>,
    pub questions: Arc<QuestionBroker>,
    pub permissions: Arc<LivePermissions>,
    pub client: OpenRouterClient,
    pub http: reqwest::Client,
    pub mcp: Arc<McpManager>,
}

pub struct TurnResult {
    pub message: Message,
    pub usage: ChatUsage,
    pub cancelled: bool,
    /// True when the loop paused at the tool-iteration limit instead of
    /// finishing with a final answer.
    pub limit_reached: bool,
    pub error: Option<String>,
}

pub async fn run_turn(
    deps: &TurnDeps,
    request: TurnRequest,
    sink: EventSink,
) -> Result<TurnResult> {
    let emit = {
        let sink = sink.clone();
        let session_id = request.session_id.clone();
        move |event: StreamEvent| {
            (sink)(RoutedEvent {
                session_id: session_id.clone(),
                event,
            });
        }
    };

    let tool_schemas = build_tool_schemas(deps, &request);
    let mut total_usage = ChatUsage::default();
    let mut iterations = 0usize;
    let mut final_message: Option<Message> = None;
    let mut final_error: Option<String> = None;
    let mut final_cancelled = false;
    let mut limit_reached = false;
    let max_iterations = request.max_tool_iterations.max(1);

    loop {
        iterations += 1;
        if iterations > max_iterations {
            if request.auto_continue && request.depth == 0 {
                emit(StreamEvent::LimitReached {
                    iterations: max_iterations as i64,
                    auto_continued: true,
                });
                iterations = 0;
            } else {
                emit(StreamEvent::LimitReached {
                    iterations: max_iterations as i64,
                    auto_continued: false,
                });
                limit_reached = true;
                break;
            }
        }

        let placeholder = deps.db.append_message(
            &request.session_id,
            NewMessage::assistant(Some(&request.model), request.provider.as_deref()),
        )?;
        emit(StreamEvent::Started {
            message: placeholder.clone(),
        });

        let history = build_history(deps, &request, &tool_schemas)?;
        let routing = request
            .provider
            .as_deref()
            .map(str::trim)
            .and_then(provider_routing);
        let reasoning = request
            .reasoning_effort
            .as_deref()
            .and_then(ReasoningSetting::from_effort);

        let mut content = String::new();
        let mut reasoning_text = String::new();
        let mut iteration_usage = ChatUsage::default();
        let mut tool_calls: Vec<ToolCallRecord> = Vec::new();
        let mut stream_error: Option<String> = None;
        let mut stream_cancelled = false;

        let model_start = std::time::Instant::now();
        let stream_result = deps
            .client
            .stream_chat(
                &request.api_key,
                &request.model,
                history,
                reasoning,
                routing,
                request.fallback_pricing,
                &tool_schemas,
                request.cancel.clone(),
                &mut |chunk| match chunk {
                    ChatChunk::Delta(text) => {
                        content.push_str(&text);
                        emit(StreamEvent::Delta { text });
                    }
                    ChatChunk::Reasoning(text) => {
                        reasoning_text.push_str(&text);
                        emit(StreamEvent::Reasoning { text });
                    }
                    ChatChunk::Usage(chunk_usage) => {
                        iteration_usage = chunk_usage.clone();
                        emit(StreamEvent::Usage {
                            prompt_tokens: chunk_usage.prompt_tokens,
                            completion_tokens: chunk_usage.completion_tokens,
                            cached_tokens: chunk_usage.cached_tokens,
                            cost: chunk_usage.cost,
                        });
                    }
                },
            )
            .await;

        match stream_result {
            Ok(outcome) => {
                if outcome.usage.prompt_tokens > 0 || outcome.usage.cost > 0.0 {
                    iteration_usage = outcome.usage;
                }
                tool_calls = outcome.tool_calls;
                stream_cancelled = outcome.cancelled;
            }
            Err(error) => stream_error = Some(error.to_string()),
        }
        let model_duration_ms = model_start.elapsed().as_millis() as i64;
        accumulate_usage(&mut total_usage, &iteration_usage);

        if stream_error.is_some() || stream_cancelled || tool_calls.is_empty() {
            let message = deps.db.update_assistant_message(
                &placeholder.id,
                &content,
                &reasoning_text,
                iteration_usage.cost,
                iteration_usage.prompt_tokens,
                iteration_usage.completion_tokens,
                iteration_usage.cached_tokens,
                &[],
                &[],
                model_duration_ms,
            )?;
            final_error = stream_error;
            final_cancelled = stream_cancelled;
            final_message = Some(message);
            break;
        }

        let assistant = deps.db.update_assistant_message(
            &placeholder.id,
            &content,
            &reasoning_text,
            iteration_usage.cost,
            iteration_usage.prompt_tokens,
            iteration_usage.completion_tokens,
            iteration_usage.cached_tokens,
            &tool_calls,
            &[],
            model_duration_ms,
        )?;
        emit(StreamEvent::Assistant { message: assistant });

        if execute_tool_calls(deps, &request, &sink, &tool_calls, &emit).await? {
            let message = deps.db.append_message(
                &request.session_id,
                NewMessage::assistant(Some(&request.model), request.provider.as_deref()),
            )?;
            final_message = Some(message);
            final_cancelled = true;
            break;
        }
    }

    if final_message.is_none() {
        let message = deps.db.append_message(
            &request.session_id,
            NewMessage::assistant(Some(&request.model), request.provider.as_deref()),
        )?;
        final_message = Some(message);
    }

    // Freeze this session's own changes at the end of the turn so that later
    // turns of *other* sessions in the same project cannot leak into it.
    let changes = finalize_changes(deps, &request);
    if !changes.is_empty() {
        emit(StreamEvent::Changes { changes });
    }

    Ok(TurnResult {
        message: final_message.unwrap(),
        usage: total_usage,
        cancelled: final_cancelled,
        limit_reached,
        error: final_error,
    })
}

/// Builds the tool schema set for a turn: built-in tools plus this session's
/// MCP servers, then strips mutating tools in plan-only modes and delegation
/// tools at the maximum subagent depth.
fn build_tool_schemas(deps: &TurnDeps, request: &TurnRequest) -> Vec<Value> {
    let mut tool_schemas = tools::tool_schemas();
    tool_schemas.extend(deps.mcp.schemas());
    if request.plan_only {
        tool_schemas.retain(|schema| {
            !matches!(
                schema.pointer("/function/name").and_then(Value::as_str),
                Some("write") | Some("edit") | Some("bash")
            )
        });
    }
    if request.depth >= MAX_SUBAGENT_DEPTH {
        tool_schemas.retain(|schema| {
            !matches!(
                schema.pointer("/function/name").and_then(Value::as_str),
                Some("task") | Some("question")
            )
        });
    }
    tool_schemas
}

/// Runs the tool calls the model requested, executing `task` calls as parallel
/// subagents and the rest inline. Returns `true` when the turn was cancelled
/// part-way through.
async fn execute_tool_calls(
    deps: &TurnDeps,
    request: &TurnRequest,
    sink: &EventSink,
    tool_calls: &[ToolCallRecord],
    emit: &impl Fn(StreamEvent),
) -> Result<bool> {
    let mut pending_agents: Vec<(
        ToolCallRecord,
        tokio::task::JoinHandle<ToolOutcome>,
        std::time::Instant,
    )> = Vec::new();
    let mut cancelled = false;
    for call in tool_calls {
        emit(StreamEvent::ToolStart {
            call_id: call.id.clone(),
            name: call.name.clone(),
            summary: summarize(request, &call.name, &call.arguments),
            arguments: call.arguments.clone(),
        });

        // A cancelled turn must still leave a tool output for every requested
        // call, otherwise the stored transcript is invalid for strict providers
        // (Azure/OpenAI reject calls without a matching output).
        if request.cancel.is_cancelled() {
            cancelled = true;
            let outcome = ToolOutcome::error("Tool call cancelled before it ran.");
            record_tool_outcome(deps, request, call, &outcome, 0, emit)?;
            continue;
        }

        if call.name == "task" {
            let arguments: Value =
                serde_json::from_str(&call.arguments).unwrap_or_else(|_| json!({}));
            let deps_owned = deps.clone();
            let request_owned = request.clone();
            let sink_owned = sink.clone();
            let started = std::time::Instant::now();
            let handle = tokio::spawn(async move {
                run_subagent(&deps_owned, &request_owned, arguments, sink_owned).await
            });
            pending_agents.push((call.clone(), handle, started));
        } else {
            let started = std::time::Instant::now();
            let outcome = execute_call(deps, request, call, sink).await;
            let duration_ms = started.elapsed().as_millis() as i64;
            record_tool_outcome(deps, request, call, &outcome, duration_ms, emit)?;
            // A tool that observed the cancellation (e.g. a long grep) reports it
            // through the token, not this loop's pre-check. Surface it so the turn
            // stops instead of asking the model for another iteration.
            if request.cancel.is_cancelled() {
                cancelled = true;
            }
        }
    }

    for (call, handle, started) in pending_agents {
        let outcome = match handle.await {
            Ok(outcome) => outcome,
            Err(error) => ToolOutcome::error(format!("Subagent failed: {error}")),
        };
        let duration_ms = started.elapsed().as_millis() as i64;
        record_tool_outcome(deps, request, &call, &outcome, duration_ms, emit)?;
        if request.cancel.is_cancelled() {
            cancelled = true;
        }
    }
    Ok(cancelled)
}

/// Persists a tool result and emits the matching stream event. Shared by the
/// inline and subagent paths so both stay in sync.
fn record_tool_outcome(
    deps: &TurnDeps,
    request: &TurnRequest,
    call: &ToolCallRecord,
    outcome: &ToolOutcome,
    duration_ms: i64,
    emit: &impl Fn(StreamEvent),
) -> Result<()> {
    deps.db.append_message(
        &request.session_id,
        NewMessage::tool(
            &call.id,
            &call.name,
            &outcome.result,
            &outcome.status,
            &outcome.changes,
            duration_ms,
        ),
    )?;
    emit(StreamEvent::ToolEnd {
        call_id: call.id.clone(),
        name: call.name.clone(),
        status: outcome.status.clone(),
        result: outcome.result.clone(),
        changes: outcome.changes.clone(),
    });
    Ok(())
}

fn run_subagent<'a>(
    deps: &'a TurnDeps,
    request: &'a TurnRequest,
    arguments: Value,
    sink: EventSink,
) -> Pin<Box<dyn Future<Output = ToolOutcome> + Send + 'a>> {
    Box::pin(async move {
        if request.depth >= MAX_SUBAGENT_DEPTH {
            return ToolOutcome::error("Subagents cannot spawn further subagents.");
        }
        let description = arguments
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let prompt = arguments
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if prompt.is_empty() {
            return ToolOutcome::error("The task tool requires a non-empty 'prompt'.");
        }
        let title: String = if description.is_empty() {
            prompt
                .lines()
                .next()
                .unwrap_or("Subtask")
                .chars()
                .take(60)
                .collect()
        } else {
            description.chars().take(60).collect()
        };

        let child_system_prompt = format!(
            "{}\n\n# Subagent\nYou are a subagent spawned by the main agent to complete one focused task.\nTask: {title}\nWork autonomously with the tools available. Do not ask the user questions. When you are done, reply with a concise report of what you did, which files you changed, and anything the main agent must know.",
            request.system_prompt
        );

        let child = match deps.db.create_sub_session(
            &request.project_id,
            &request.session_id,
            &title,
            Some(&request.model),
            request.reasoning_effort.as_deref(),
            request.provider.as_deref(),
            Some(&child_system_prompt),
        ) {
            Ok(session) => session,
            Err(error) => return ToolOutcome::error(format!("Could not start subagent: {error}")),
        };

        (sink)(RoutedEvent {
            session_id: request.session_id.clone(),
            event: StreamEvent::SubAgentStarted {
                session: child.clone(),
            },
        });

        let base_commit = match deps.shadow.snapshot(&format!("subagent: {title}")) {
            Ok(commit) => commit,
            Err(error) => {
                let _ = deps.db.set_agent_status(&child.id, "error");
                emit_status(&sink, &child.id, "error");
                return ToolOutcome::error(format!("Could not snapshot project: {error}"));
            }
        };
        if let Err(error) = deps.db.append_message(
            &child.id,
            NewMessage::user(&prompt, "", Some(&base_commit), &[], &[]),
        ) {
            let _ = deps.db.set_agent_status(&child.id, "error");
            emit_status(&sink, &child.id, "error");
            return ToolOutcome::error(format!("Could not record subagent prompt: {error}"));
        }

        let child_request = TurnRequest {
            api_key: request.api_key.clone(),
            model: request.model.clone(),
            reasoning_effort: request.reasoning_effort.clone(),
            provider: request.provider.clone(),
            system_prompt: child_system_prompt,
            session_id: child.id.clone(),
            project_id: request.project_id.clone(),
            depth: request.depth + 1,
            project_root: request.project_root.clone(),
            extra_folders: request.extra_folders.clone(),
            command_rules: request.command_rules.clone(),
            file_ignore: request.file_ignore.clone(),
            context_message_limit: request.context_message_limit,
            context_length: request.context_length,
            max_tool_iterations: request.max_tool_iterations,
            auto_continue: false,
            fallback_pricing: request.fallback_pricing,
            base_commit,
            resume: false,
            plan_only: request.plan_only,
            cancel: request.cancel.clone(),
        };

        let result = run_turn(deps, child_request, sink.clone()).await;

        let status = match &result {
            Ok(turn) if turn.cancelled => "stopped",
            Ok(turn) if turn.error.is_some() => "error",
            Ok(_) => "done",
            Err(_) => "error",
        };
        let _ = deps.db.set_agent_status(&child.id, status);
        emit_status(&sink, &child.id, status);

        match result {
            Ok(turn) => {
                let _ = deps.db.add_session_usage(
                    &child.id,
                    turn.usage.cost,
                    turn.usage.prompt_tokens,
                    turn.usage.completion_tokens,
                    turn.usage.cached_tokens,
                );
                let report = if turn.message.content.trim().is_empty() {
                    "Subagent finished without a written report.".to_string()
                } else {
                    turn.message.content.clone()
                };
                if turn.error.is_some() || turn.cancelled {
                    ToolOutcome::error(report)
                } else {
                    ToolOutcome::ok(report)
                }
            }
            Err(error) => ToolOutcome::error(format!("Subagent failed: {error}")),
        }
    })
}

fn emit_status(sink: &EventSink, session_id: &str, status: &str) {
    (sink)(RoutedEvent {
        session_id: session_id.to_string(),
        event: StreamEvent::SubAgentStatus {
            status: status.to_string(),
        },
    });
}

/// Maps a stored provider selection to OpenRouter routing preferences. The
/// `auto*` values are presets; anything else is treated as a provider slug.
fn provider_routing(provider: &str) -> Option<ProviderRouting> {
    match provider {
        "" | "auto" => None,
        "auto:throughput" => Some(ProviderRouting {
            order: Vec::new(),
            allow_fallbacks: true,
            sort: Some("throughput".to_string()),
        }),
        "auto:price" => Some(ProviderRouting {
            order: Vec::new(),
            allow_fallbacks: true,
            sort: Some("price".to_string()),
        }),
        // `auto:value` is resolved to a concrete provider before the request
        // reaches the agent; if it still arrives, prefer the cheaper provider.
        "auto:value" => Some(ProviderRouting {
            order: Vec::new(),
            allow_fallbacks: true,
            sort: Some("price".to_string()),
        }),
        slug => Some(ProviderRouting {
            order: vec![slug.to_string()],
            allow_fallbacks: true,
            sort: None,
        }),
    }
}

fn build_history(
    deps: &TurnDeps,
    request: &TurnRequest,
    tool_schemas: &[Value],
) -> Result<Vec<ChatMessage>> {
    let messages = deps
        .db
        .list_messages_limited(&request.session_id, request.context_message_limit)?;

    let mut history = vec![ChatMessage::text("system", request.system_prompt.clone())];
    for message in messages {
        match message.role.as_str() {
            "user" => {
                if let Some(content) =
                    user_content(&message.content, &message.attachments, &message.context)
                {
                    history.push(ChatMessage::parts("user", content));
                }
            }
            "assistant" => {
                if !message.tool_calls.is_empty() {
                    let calls: Vec<Value> = message
                        .tool_calls
                        .iter()
                        .map(|call| {
                            json!({
                                "id": call.id,
                                "type": "function",
                                "function": {
                                    "name": call.name,
                                    "arguments": call.arguments
                                }
                            })
                        })
                        .collect();
                    history.push(ChatMessage::assistant_tool_calls(
                        message.content,
                        Value::Array(calls),
                    ));
                } else if !message.content.is_empty() {
                    history.push(ChatMessage::text("assistant", message.content));
                }
            }
            "tool" => {
                if let Some(call_id) = message.tool_call_id {
                    history.push(ChatMessage::tool_result(&call_id, message.content));
                }
            }
            _ => {}
        }
    }

    let overhead: usize = tool_schemas
        .iter()
        .map(|schema| estimate_tokens(&schema.to_string()))
        .sum();
    let history = trim_to_budget(history, request.context_length, overhead);
    Ok(sanitize(history))
}

/// Rough token estimate. ASCII text averages ~4 characters per token while
/// non-ASCII (CJK, emoji, ...) is closer to one token per character.
fn estimate_tokens(text: &str) -> usize {
    let mut ascii = 0usize;
    let mut other = 0usize;
    for ch in text.chars() {
        if ch.is_ascii() {
            ascii += 1;
        } else {
            other += 1;
        }
    }
    ascii.div_ceil(4) + other
}

fn part_token_estimate(part: &Value) -> usize {
    match part.get("type").and_then(Value::as_str) {
        Some("text") => part
            .get("text")
            .and_then(Value::as_str)
            .map(estimate_tokens)
            .unwrap_or(0),
        // Images and files are tokenized by the provider from their decoded
        // content, not their base64 size, so use a conservative flat estimate.
        Some("image_url") => 1_000,
        Some("file") => 4_000,
        _ => 0,
    }
}

fn content_token_estimate(content: &Value) -> usize {
    match content {
        Value::String(text) => estimate_tokens(text),
        Value::Array(parts) => parts.iter().map(part_token_estimate).sum(),
        _ => 0,
    }
}

fn message_token_estimate(message: &ChatMessage) -> usize {
    let tool_calls = message
        .tool_calls
        .as_ref()
        .map(|calls| estimate_tokens(&calls.to_string()))
        .unwrap_or(0);
    content_token_estimate(&message.content) + tool_calls + 4
}

/// Input token budget derived from the model's context window. We reserve
/// roughly a quarter (capped) for the model's output, then subtract the tool
/// schemas that are sent alongside the messages.
fn context_token_budget(context_length: i64, overhead: usize) -> Option<usize> {
    if context_length <= 0 {
        return None;
    }
    let context_length = context_length as usize;
    let reserve = (context_length / 4).clamp(2_048, 16_384);
    Some(context_length.saturating_sub(reserve).saturating_sub(overhead).max(1_024))
}

fn truncate_text(text: &str, budget: usize) -> String {
    let mut result = String::new();
    let mut ascii = 0usize;
    let mut other = 0usize;
    for ch in text.chars() {
        if ch.is_ascii() {
            ascii += 1;
        } else {
            other += 1;
        }
        if ascii.div_ceil(4) + other > budget {
            break;
        }
        result.push(ch);
    }
    result
}

/// Shrinks a single message to fit `budget`, preferring to keep the most recent
/// content and dropping any tool call.
fn truncate_message(mut message: ChatMessage, budget: usize) -> ChatMessage {
    if message_token_estimate(&message) <= budget {
        return message;
    }
    match message.content {
        Value::Array(parts) => {
            let mut remaining = budget;
            let mut kept: Vec<Value> = Vec::new();
            for part in parts.into_iter().rev() {
                let is_text = part.get("type").and_then(Value::as_str) == Some("text");
                if is_text {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        let truncated = truncate_text(text, remaining);
                        if !truncated.is_empty() {
                            remaining = remaining.saturating_sub(estimate_tokens(&truncated));
                            kept.push(json!({ "type": "text", "text": truncated }));
                        }
                    }
                } else {
                    let cost = part_token_estimate(&part);
                    if cost <= remaining {
                        remaining -= cost;
                        kept.push(part);
                    }
                }
            }
            kept.reverse();
            message.content = Value::Array(kept);
        }
        _ => {
            let text = content_to_text(&message.content);
            message.content = Value::String(truncate_text(&text, budget));
        }
    }
    message.tool_calls = None;
    message
}

/// Drops the oldest messages (and, if needed, shrinks the newest) until the
/// estimated token count fits the model's context window. The system prompt is
/// always kept but capped so it cannot consume the whole budget.
fn trim_to_budget(
    history: Vec<ChatMessage>,
    context_length: i64,
    overhead: usize,
) -> Vec<ChatMessage> {
    let Some(budget) = context_token_budget(context_length, overhead) else {
        return history;
    };
    let mut history = history;
    if history.is_empty() {
        return history;
    }

    if message_token_estimate(&history[0]) > budget / 2 {
        history[0] = truncate_message(history[0].clone(), budget / 2);
    }

    // Estimate once, then subtract as messages are dropped so the total is not
    // recomputed over the whole transcript on every removal.
    let mut total: usize = history.iter().map(message_token_estimate).sum();
    let mut drop_end = 1;
    while history.len() - drop_end > 1 && total > budget {
        total -= message_token_estimate(&history[drop_end]);
        drop_end += 1;
    }
    if drop_end > 1 {
        history.drain(1..drop_end);
    }

    if history.len() > 1 && total > budget {
        let remaining = budget.saturating_sub(message_token_estimate(&history[0]));
        let index = history.len() - 1;
        let shrunk = truncate_message(history[index].clone(), remaining);
        if content_token_estimate(&shrunk.content) == 0 && shrunk.tool_calls.is_none() {
            history.remove(index);
        } else {
            history[index] = shrunk;
        }
    }

    history
}

fn user_content(text: &str, attachments: &[Attachment], context: &str) -> Option<Value> {
    if attachments.is_empty() && context.trim().is_empty() {
        return (!text.is_empty()).then(|| Value::String(text.to_string()));
    }
    let mut parts: Vec<Value> = Vec::new();
    if !context.trim().is_empty() {
        parts.push(json!({
            "type": "text",
            "text": format!("# Referenced context\n\n{context}")
        }));
    }
    if !text.is_empty() {
        parts.push(json!({ "type": "text", "text": text }));
    }
    for attachment in attachments {
        if attachment.is_image() {
            let url = format!("data:{};base64,{}", attachment.mime_type, attachment.data);
            parts.push(json!({
                "type": "image_url",
                "image_url": { "url": url }
            }));
        } else if attachment.is_pdf() {
            let data_url = format!("data:application/pdf;base64,{}", attachment.data);
            parts.push(json!({
                "type": "file",
                "file": {
                    "filename": attachment.name,
                    "file_data": data_url
                }
            }));
        } else {
            let mut header = format!("<file name=\"{}\"", attachment.name);
            if let Some(lines) = attachment.lines {
                header.push_str(&format!(" lines=\"{}\"", lines));
            }
            header.push('>');
            parts.push(json!({
                "type": "text",
                "text": format!("{}\n{}\n</file>", header, attachment.data)
            }));
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(Value::Array(parts))
    }
}

fn content_to_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(|value| value.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn call_id(call: &Value) -> Option<&str> {
    call.get("id").and_then(Value::as_str)
}

/// Repairs the transcript so every assistant tool call has exactly one matching
/// tool output and every tool output has a preceding call. Strict providers
/// (Azure/OpenAI) reject requests where the two are out of sync, which happens
/// after a cancelled turn or when older messages are trimmed away.
fn sanitize(history: Vec<ChatMessage>) -> Vec<ChatMessage> {
    let mut sanitized: Vec<ChatMessage> = Vec::new();
    let mut index = 0usize;
    while index < history.len() {
        let message = history[index].clone();

        if message.role == "assistant" && message.tool_calls.is_some() {
            let calls = message
                .tool_calls
                .as_ref()
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();

            let mut results: Vec<ChatMessage> = Vec::new();
            let mut next = index + 1;
            while next < history.len() && history[next].role == "tool" {
                let result = history[next].clone();
                let matches = result
                    .tool_call_id
                    .as_deref()
                    .is_some_and(|id| calls.iter().any(|call| call_id(call) == Some(id)));
                if matches {
                    results.push(result);
                }
                next += 1;
            }

            // Keep only calls that produced an output, ordered to match the
            // call order the model requested them in.
            let mut answered: Vec<Value> = Vec::new();
            let mut ordered_results: Vec<ChatMessage> = Vec::new();
            for call in &calls {
                if let Some(id) = call_id(call) {
                    if let Some(result) = results
                        .iter()
                        .find(|result| result.tool_call_id.as_deref() == Some(id))
                    {
                        answered.push(call.clone());
                        ordered_results.push(result.clone());
                    }
                }
            }

            if answered.is_empty() {
                let text = content_to_text(&message.content);
                if !text.is_empty() {
                    sanitized.push(ChatMessage::text("assistant", text));
                }
            } else {
                let mut assistant = message.clone();
                assistant.tool_calls = Some(Value::Array(answered));
                sanitized.push(assistant);
                sanitized.extend(ordered_results);
            }
            index = next;
            continue;
        }

        // Orphan tool output (its call was trimmed away or never existed).
        if message.role == "tool" {
            index += 1;
            continue;
        }

        sanitized.push(message);
        index += 1;
    }
    sanitized
}

async fn execute_call(
    deps: &TurnDeps,
    request: &TurnRequest,
    call: &ToolCallRecord,
    sink: &EventSink,
) -> ToolOutcome {
    let arguments: Value = serde_json::from_str(&call.arguments).unwrap_or_else(|_| json!({}));
    let mut runtime = ToolRuntime {
        call_id: call.id.clone(),
        project_root: request.project_root.clone(),
        file_ignore: request.file_ignore.clone(),
        session_id: request.session_id.clone(),
        shadow: deps.shadow.clone(),
        processes: deps.processes.clone(),
        broker: deps.broker.clone(),
        questions: deps.questions.clone(),
        permissions: deps.permissions.clone(),
        http: deps.http.clone(),
        mcp: Some(deps.mcp.clone()),
        cancel: request.cancel.clone(),
        emit: sink.clone(),
    };
    tools::execute(&mut runtime, &call.name, &arguments).await
}

fn finalize_changes(deps: &TurnDeps, request: &TurnRequest) -> Vec<FileChange> {
    let (existing, last_commit) = match deps.db.session_changes_record(&request.session_id) {
        Ok(Some(record)) => record,
        Ok(None) => (Vec::new(), None),
        Err(error) => {
            log::warn!(
                "could not read change record for session {}: {error}; leaving it untouched",
                request.session_id
            );
            return Vec::new();
        }
    };

    let after = match deps.shadow.snapshot("change set") {
        Ok(commit) => commit,
        Err(error) => {
            log::warn!(
                "could not snapshot change set for session {}: {error}",
                request.session_id
            );
            return existing;
        }
    };
    // A new prompt snapshots the working tree first, so its `base_commit`
    // already isolates the turn. A resume reuses the original prompt snapshot,
    // so continue from the previous finalize boundary instead.
    let from = if request.resume {
        last_commit.unwrap_or_else(|| request.base_commit.clone())
    } else {
        request.base_commit.clone()
    };
    let increment = match deps.shadow.changes_between(&from, &after) {
        Ok(increment) => increment,
        Err(error) if from != request.base_commit => {
            match deps.shadow.changes_between(&request.base_commit, &after) {
                Ok(increment) => increment,
                Err(fallback) => {
                    log::warn!(
                        "could not diff {from}..{after} ({error}) or {}..{after} ({fallback}); not advancing change record",
                        request.base_commit
                    );
                    return existing;
                }
            }
        }
        Err(error) => {
            log::warn!("could not diff {from}..{after}: {error}; not advancing change record");
            return existing;
        }
    };

    let merged = merge_file_changes(existing, increment);
    if let Err(error) =
        deps.db
            .set_session_changes_record(&request.session_id, &merged, Some(&after))
    {
        log::warn!(
            "could not persist change record for session {}: {error}",
            request.session_id
        );
    }
    merged
}

/// Merges a turn's file changes into a session's cumulative set. Additions and
/// deletions accumulate across turns; a file that was added and later deleted
/// within the session drops out again.
fn merge_file_changes(existing: Vec<FileChange>, increment: Vec<FileChange>) -> Vec<FileChange> {
    let mut merged = existing;
    for change in increment {
        if let Some(index) = merged.iter().position(|entry| entry.path == change.path) {
            // Added earlier in this session and deleted again: net no change.
            if change.status == "D" && merged[index].status == "A" {
                merged.remove(index);
                continue;
            }
            merged[index].additions += change.additions;
            merged[index].deletions += change.deletions;
            if merged[index].status != "A" {
                merged[index].status = change.status.clone();
            }
        } else {
            merged.push(change);
        }
    }
    merged
}

fn summarize(request: &TurnRequest, name: &str, arguments: &str) -> String {
    let parsed: Value = serde_json::from_str(arguments).unwrap_or_else(|_| json!({}));
    match name {
        "bash" => parsed
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        "read" | "write" | "edit" | "ls" => relative_path(
            request,
            parsed.get("path").and_then(Value::as_str).unwrap_or(""),
        ),
        "glob" | "grep" => parsed
            .get("pattern")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        "webfetch" => parsed
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        "websearch" => parsed
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        "task" => parsed
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        "question" => parsed
            .get("questions")
            .and_then(Value::as_array)
            .and_then(|entries| entries.first())
            .and_then(|entry| {
                entry
                    .get("header")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .or_else(|| entry.get("question").and_then(Value::as_str))
            })
            .unwrap_or("")
            .to_string(),
        other if other.starts_with("mcp__") => other.to_string(),
        _ => arguments.chars().take(120).collect(),
    }
}

fn relative_path(request: &TurnRequest, path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        if let Ok(relative) = candidate.strip_prefix(&request.project_root) {
            return relative.to_string_lossy().replace('\\', "/");
        }
        for folder in &request.extra_folders {
            if let Ok(relative) = candidate.strip_prefix(folder) {
                return relative.to_string_lossy().replace('\\', "/");
            }
        }
    }
    path.replace('\\', "/")
}

fn accumulate_usage(total: &mut ChatUsage, usage: &ChatUsage) {
    total.prompt_tokens += usage.prompt_tokens;
    total.completion_tokens += usage.completion_tokens;
    total.cached_tokens += usage.cached_tokens;
    total.cost += usage.cost;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(path: &str, additions: i64, deletions: i64, status: &str) -> FileChange {
        FileChange {
            path: path.to_string(),
            additions,
            deletions,
            status: status.to_string(),
        }
    }

    #[test]
    fn merge_accumulates_additions_and_keeps_added_status() {
        let merged = merge_file_changes(
            vec![change("src/new.ts", 3, 0, "A")],
            vec![change("src/new.ts", 2, 1, "M"), change("src/other.ts", 5, 0, "M")],
        );
        let new_file = merged.iter().find(|c| c.path == "src/new.ts").unwrap();
        assert_eq!(new_file.status, "A");
        assert_eq!((new_file.additions, new_file.deletions), (5, 1));
        assert!(merged.iter().any(|c| c.path == "src/other.ts"));
    }

    #[test]
    fn merge_drops_files_added_and_deleted_within_session() {
        let merged = merge_file_changes(
            vec![change("src/temp.ts", 4, 0, "A")],
            vec![change("src/temp.ts", 0, 4, "D")],
        );
        assert!(merged.is_empty());
    }

    #[test]
    fn provider_presets_map_to_routing() {
        assert!(provider_routing("").is_none());
        assert!(provider_routing("auto").is_none());

        let throughput = provider_routing("auto:throughput").expect("throughput");
        assert_eq!(throughput.sort.as_deref(), Some("throughput"));
        assert!(throughput.order.is_empty());

        let price = provider_routing("auto:price").expect("price");
        assert_eq!(price.sort.as_deref(), Some("price"));

        let slug = provider_routing("relace").expect("slug");
        assert_eq!(slug.order, vec!["relace".to_string()]);
        assert!(slug.sort.is_none());
    }

    #[test]
    fn estimate_tokens_counts_ascii_and_non_ascii() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
        assert_eq!(estimate_tokens("日本語"), 3);
    }

    #[test]
    fn context_budget_reserves_output_room() {
        assert!(context_token_budget(0, 0).is_none());
        let budget = context_token_budget(128_000, 0).expect("budget");
        assert_eq!(budget, 128_000 - 16_384);
        let small = context_token_budget(8_000, 3_000).expect("budget");
        assert_eq!(small, 8_000 - 2_048 - 3_000);
        assert_eq!(context_token_budget(100, 0), Some(1_024));
    }

    #[test]
    fn trim_drops_oldest_messages_to_fit_budget() {
        let system = ChatMessage::text("system", "sys");
        let old = ChatMessage::text("user", "a".repeat(40_000));
        let recent = ChatMessage::text("user", "recent question");
        let trimmed = trim_to_budget(vec![system, old, recent], 12_000, 0);
        assert_eq!(trimmed.len(), 2);
        assert_eq!(trimmed[0].role, "system");
        assert!(content_to_text(&trimmed[1].content).contains("recent question"));
    }

    #[test]
    fn trim_shrinks_a_single_oversized_message() {
        let system = ChatMessage::text("system", "sys");
        let huge = ChatMessage::text("user", "x".repeat(400_000));
        let trimmed = trim_to_budget(vec![system, huge], 20_000, 0);
        assert_eq!(trimmed.len(), 2);
        let total: usize = trimmed.iter().map(message_token_estimate).sum();
        assert!(total <= 20_000, "expected {total} to fit within budget");
    }

    #[test]
    fn trim_caps_the_system_prompt() {
        let system = ChatMessage::text("system", "s".repeat(400_000));
        let trimmed = trim_to_budget(vec![system], 20_000, 0);
        assert_eq!(trimmed.len(), 1);
        assert!(message_token_estimate(&trimmed[0]) <= 10_000);
    }

    fn calls(ids: &[&str]) -> Value {
        Value::Array(
            ids.iter()
                .map(|id| {
                    json!({
                        "id": id,
                        "type": "function",
                        "function": { "name": "read", "arguments": "{}" }
                    })
                })
                .collect(),
        )
    }

    #[test]
    fn sanitize_drops_unanswered_tool_calls() {
        let history = vec![
            ChatMessage::text("user", "go"),
            ChatMessage::assistant_tool_calls("working".into(), calls(&["a", "b"])),
            ChatMessage::tool_result("a", "result a"),
            ChatMessage::text("user", "next"),
        ];
        let sanitized = sanitize(history);
        let assistant = sanitized
            .iter()
            .find(|message| message.tool_calls.is_some())
            .expect("assistant with calls");
        assert_eq!(
            assistant
                .tool_calls
                .as_ref()
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            sanitized.iter().filter(|message| message.role == "tool").count(),
            1
        );
    }

    #[test]
    fn sanitize_orders_tool_outputs_to_match_calls() {
        let history = vec![
            ChatMessage::assistant_tool_calls("".into(), calls(&["a", "b"])),
            ChatMessage::tool_result("b", "result b"),
            ChatMessage::tool_result("a", "result a"),
        ];
        let sanitized = sanitize(history);
        assert_eq!(sanitized.len(), 3);
        assert_eq!(sanitized[1].tool_call_id.as_deref(), Some("a"));
        assert_eq!(sanitized[2].tool_call_id.as_deref(), Some("b"));
    }

    #[test]
    fn sanitize_drops_orphan_tool_outputs() {
        let history = vec![
            ChatMessage::text("user", "go"),
            ChatMessage::tool_result("missing", "stray"),
        ];
        let sanitized = sanitize(history);
        assert_eq!(sanitized.len(), 1);
        assert_eq!(sanitized[0].role, "user");
    }

    #[test]
    fn sanitize_turns_fully_unanswered_call_into_text() {
        let history = vec![
            ChatMessage::text("user", "go"),
            ChatMessage::assistant_tool_calls("partial answer".into(), calls(&["a"])),
        ];
        let sanitized = sanitize(history);
        assert_eq!(sanitized.len(), 2);
        assert!(sanitized[1].tool_calls.is_none());
        assert_eq!(content_to_text(&sanitized[1].content), "partial answer");
    }
}
