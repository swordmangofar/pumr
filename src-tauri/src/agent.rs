use crate::broker::PermissionBroker;
use crate::db::{Db, NewMessage};
use crate::error::Result;
use crate::git::ShadowRepo;
use crate::models::{EventSink, FileChange, Message, RoutedEvent, StreamEvent, ToolCallRecord};
use crate::processes::ProcessRegistry;
use crate::providers::openrouter::{
    ChatChunk, ChatMessage, ChatUsage, OpenRouterClient, ProviderRouting, ReasoningSetting,
};
use crate::tools::{self, ToolOutcome, ToolRuntime};
use serde_json::{json, Value};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

const MAX_TOOL_ITERATIONS: usize = 25;
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
    pub allowed_websites: Vec<String>,
    pub denied_websites: Vec<String>,
    pub context_message_limit: usize,
    pub fallback_pricing: Option<(f64, f64)>,
    pub base_commit: String,
    pub cancel: CancellationToken,
}

#[derive(Clone)]
pub struct TurnDeps {
    pub db: Arc<Db>,
    pub shadow: Arc<ShadowRepo>,
    pub processes: Arc<ProcessRegistry>,
    pub broker: Arc<PermissionBroker>,
    pub client: OpenRouterClient,
    pub http: reqwest::Client,
}

pub struct TurnResult {
    pub message: Message,
    pub usage: ChatUsage,
    pub cancelled: bool,
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

    let mut tool_schemas = tools::tool_schemas();
    if request.depth >= MAX_SUBAGENT_DEPTH {
        tool_schemas.retain(|schema| {
            schema.pointer("/function/name").and_then(Value::as_str) != Some("task")
        });
    }
    let mut total_usage = ChatUsage::default();
    let mut iterations = 0usize;
    let mut final_message: Option<Message> = None;
    let mut final_error: Option<String> = None;
    let mut final_cancelled = false;

    loop {
        iterations += 1;
        if iterations > MAX_TOOL_ITERATIONS {
            final_error = Some(format!(
                "Stopped after {MAX_TOOL_ITERATIONS} tool iterations without a final answer."
            ));
            break;
        }

        let placeholder = deps.db.append_message(
            &request.session_id,
            NewMessage::assistant(Some(&request.model), request.provider.as_deref()),
        )?;
        emit(StreamEvent::Started {
            message: placeholder.clone(),
        });

        let history = build_history(deps, &request)?;
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
        accumulate_usage(&mut total_usage, &iteration_usage);

        if stream_error.is_some() || stream_cancelled || tool_calls.is_empty() {
            let changes = compute_changes(deps, &request);
            let message = deps.db.update_assistant_message(
                &placeholder.id,
                &content,
                &reasoning_text,
                iteration_usage.cost,
                iteration_usage.prompt_tokens,
                iteration_usage.completion_tokens,
                iteration_usage.cached_tokens,
                &[],
                &changes,
            )?;
            if !changes.is_empty() {
                emit(StreamEvent::Changes {
                    changes: changes.clone(),
                });
            }
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
        )?;
        emit(StreamEvent::Assistant { message: assistant });

        let mut pending_agents: Vec<(ToolCallRecord, tokio::task::JoinHandle<ToolOutcome>)> =
            Vec::new();
        for call in &tool_calls {
            if request.cancel.is_cancelled() {
                final_cancelled = true;
                break;
            }
            emit(StreamEvent::ToolStart {
                call_id: call.id.clone(),
                name: call.name.clone(),
                summary: summarize(&call.name, &call.arguments),
                arguments: call.arguments.clone(),
            });

            if call.name == "task" {
                let arguments: Value =
                    serde_json::from_str(&call.arguments).unwrap_or_else(|_| json!({}));
                let deps_owned = deps.clone();
                let request_owned = request.clone();
                let sink_owned = sink.clone();
                let handle = tokio::spawn(async move {
                    run_subagent(&deps_owned, &request_owned, arguments, sink_owned).await
                });
                pending_agents.push((call.clone(), handle));
            } else {
                let outcome = execute_call(deps, &request, call, &sink).await;
                deps.db.append_message(
                    &request.session_id,
                    NewMessage::tool(
                        &call.id,
                        &call.name,
                        &outcome.result,
                        &outcome.status,
                        &outcome.changes,
                    ),
                )?;
                emit(StreamEvent::ToolEnd {
                    call_id: call.id.clone(),
                    name: call.name.clone(),
                    status: outcome.status.clone(),
                    result: outcome.result.clone(),
                    changes: outcome.changes.clone(),
                });
            }
        }

        for (call, handle) in pending_agents {
            let outcome = match handle.await {
                Ok(outcome) => outcome,
                Err(error) => ToolOutcome::error(format!("Subagent failed: {error}")),
            };
            deps.db.append_message(
                &request.session_id,
                NewMessage::tool(
                    &call.id,
                    &call.name,
                    &outcome.result,
                    &outcome.status,
                    &outcome.changes,
                ),
            )?;
            emit(StreamEvent::ToolEnd {
                call_id: call.id.clone(),
                name: call.name.clone(),
                status: outcome.status.clone(),
                result: outcome.result.clone(),
                changes: outcome.changes.clone(),
            });
        }

        if final_cancelled {
            let message = deps.db.append_message(
                &request.session_id,
                NewMessage::assistant(Some(&request.model), request.provider.as_deref()),
            )?;
            final_message = Some(message);
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

    Ok(TurnResult {
        message: final_message.unwrap(),
        usage: total_usage,
        cancelled: final_cancelled,
        error: final_error,
    })
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
        if let Err(error) = deps
            .db
            .append_message(&child.id, NewMessage::user(&prompt, Some(&base_commit)))
        {
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
            allowed_websites: request.allowed_websites.clone(),
            denied_websites: request.denied_websites.clone(),
            context_message_limit: request.context_message_limit,
            fallback_pricing: request.fallback_pricing,
            base_commit,
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

fn build_history(deps: &TurnDeps, request: &TurnRequest) -> Result<Vec<ChatMessage>> {
    let mut messages = deps.db.list_messages(&request.session_id)?;
    let limit = request.context_message_limit;
    if limit > 0 && messages.len() > limit {
        messages.drain(..messages.len() - limit);
    }

    let mut history = vec![ChatMessage::text("system", request.system_prompt.clone())];
    for message in messages {
        match message.role.as_str() {
            "user" => {
                if !message.content.is_empty() {
                    history.push(ChatMessage::text("user", message.content));
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
    Ok(sanitize(history))
}

fn sanitize(history: Vec<ChatMessage>) -> Vec<ChatMessage> {
    let mut sanitized: Vec<ChatMessage> = Vec::new();
    for message in history {
        if message.role == "tool" {
            if sanitized
                .last()
                .map(|previous| previous.tool_calls.is_some())
                .unwrap_or(false)
            {
                sanitized.push(message);
            }
            continue;
        }
        if message.tool_calls.is_none() && !sanitized.is_empty() {
            let previous_has_dangling_calls = sanitized
                .last()
                .map(|previous| previous.tool_calls.is_some())
                .unwrap_or(false);
            if previous_has_dangling_calls {
                if let Some(previous) = sanitized.pop() {
                    if let Value::String(text) = previous.content {
                        if !text.is_empty() {
                            sanitized.push(ChatMessage::text("assistant", text));
                        }
                    }
                }
            }
        }
        sanitized.push(message);
    }
    if sanitized
        .last()
        .map(|previous| previous.tool_calls.is_some())
        .unwrap_or(false)
    {
        if let Some(previous) = sanitized.pop() {
            if let Value::String(text) = previous.content {
                if !text.is_empty() {
                    sanitized.push(ChatMessage::text("assistant", text));
                }
            }
        }
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
        extra_folders: request.extra_folders.clone(),
        command_rules: request.command_rules.clone(),
        allowed_websites: request.allowed_websites.clone(),
        denied_websites: request.denied_websites.clone(),
        session_id: request.session_id.clone(),
        shadow: deps.shadow.clone(),
        processes: deps.processes.clone(),
        broker: deps.broker.clone(),
        http: deps.http.clone(),
        cancel: request.cancel.clone(),
        emit: sink.clone(),
    };
    tools::execute(&mut runtime, &call.name, &arguments).await
}

fn compute_changes(deps: &TurnDeps, request: &TurnRequest) -> Vec<FileChange> {
    deps.shadow
        .changes_since(&request.base_commit)
        .unwrap_or_default()
}

fn summarize(name: &str, arguments: &str) -> String {
    let parsed: Value = serde_json::from_str(arguments).unwrap_or_else(|_| json!({}));
    match name {
        "bash" => parsed
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        "read" | "write" | "edit" | "ls" => parsed
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
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
        _ => arguments.chars().take(120).collect(),
    }
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
}
