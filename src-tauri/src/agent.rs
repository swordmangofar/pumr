use crate::broker::{ModelChoiceBroker, PermissionBroker, QuestionBroker};
use crate::db::{Db, NewMessage};
use crate::error::Result;
use crate::git::ShadowRepo;
use crate::hooks::{HookScene, Hooks};
use crate::mcp::McpManager;
use crate::model_match;
use crate::models::{
    Attachment, EventSink, FileChange, Message, ModelInfo, RoutedEvent, SkillEntry, StreamEvent,
    ToolCallRecord,
};
use crate::permissions::{FileIgnoreConfig, LivePermissions};
use crate::processes::ProcessRegistry;
use crate::providers::catalog::{self, ProviderKind};
use crate::providers::openrouter::ProviderRouting;
use crate::providers::{
    ChatChunk, ChatMessage, ChatUsage, LlmClient, PromptCache, ReasoningSetting,
};
use crate::tools::{self, FileLedger, ToolOutcome, ToolRuntime};
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

const MAX_SUBAGENT_DEPTH: usize = 1;

#[derive(Clone)]
pub struct TurnRequest {
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub provider: Option<String>,
    pub system_prompt: String,
    pub session_id: String,
    /// The root session of this conversation. Subagents inherit their parent's
    /// value so session grants ("allow in this chat") are shared across them.
    pub conversation_id: String,
    pub project_id: String,
    pub depth: usize,
    pub project_root: PathBuf,
    pub extra_folders: Vec<PathBuf>,
    pub file_ignore: Arc<FileIgnoreConfig>,
    /// The selected model's context window in tokens (0 when unknown). The
    /// history is compacted before it fills it.
    pub context_length: i64,
    /// Share of the window's input room, in percent, from which the history
    /// is compacted. 0 leaves it until it no longer fits.
    pub auto_compact_threshold: usize,
    /// The history is compacted at this many input tokens at the latest,
    /// however large the window is. 0 sets no such bound.
    pub auto_compact_max_tokens: usize,
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
    /// Read-only modes keep `bash` but disable `write`/`edit`.
    pub read_only: bool,
    /// When true, large MCP schemas are deferred behind `tool_search`/`mcp_invoke`.
    pub mcp_progressive_disclosure: bool,
    /// Discovered skills advertised to the agent and loadable via the `skill` tool.
    pub skills: Vec<SkillEntry>,
    /// Whether to mark the stable prompt prefix as cacheable.
    pub prompt_caching: bool,
    /// Model for subagents, already resolved to the session model when unset.
    pub subagent_model: String,
    /// Model for history compaction, already resolved to the session model.
    pub compaction_model: String,
    /// The project's own check commands (tests, build, lint). When the agent
    /// wants to finish after changing code without having run anything, it is
    /// asked once to run the one that fits. Empty asks for nothing.
    pub completion_checks: Vec<String>,
    /// The user's hooks for this project: commands run before and after tool
    /// calls and when the agent wants to finish.
    pub hooks: Hooks,
    pub cancel: CancellationToken,
}

#[derive(Clone)]
pub struct TurnDeps {
    pub db: Arc<Db>,
    pub shadow: Arc<ShadowRepo>,
    pub processes: Arc<ProcessRegistry>,
    /// The files each session's agent has seen (see `FileLedger`).
    pub files: Arc<FileLedger>,
    pub broker: Arc<PermissionBroker>,
    pub questions: Arc<QuestionBroker>,
    pub model_choices: Arc<ModelChoiceBroker>,
    /// The models of the connected providers, as last listed.
    pub models: Arc<Vec<ModelInfo>>,
    pub permissions: Arc<LivePermissions>,
    /// Sends each request to the provider of its model, with that key.
    pub client: LlmClient,
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
    let mut context = ContextState::default();
    let mut watch = TurnWatch::default();

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

        // Built before the reply's placeholder is stored, so that a compaction
        // it leads to shows in the chat ahead of the reply that follows it.
        let mut history = build_history(deps, &request, &tool_schemas, &mut context, &emit).await?;
        let placeholder = deps.db.append_message(
            &request.session_id,
            NewMessage::assistant(Some(&request.model), request.provider.as_deref()),
        )?;
        emit(StreamEvent::Started {
            message: placeholder.clone(),
        });
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
        let mut shortened = false;

        let model_start = std::time::Instant::now();
        let stream_result = loop {
            let (
                used,
                budget,
                system_tokens,
                history_tokens,
                tool_schema_tokens,
                tool_output_tokens,
            ) = context_usage(
                &history,
                request.context_length,
                &tool_schemas,
                context.scale,
            );
            emit(StreamEvent::ContextUsage {
                used_tokens: used,
                budget_tokens: budget,
                system_tokens,
                history_tokens,
                tool_schema_tokens,
                tool_output_tokens,
            });
            let result = deps
                .client
                .stream_chat(
                    &request.model,
                    history,
                    reasoning.clone(),
                    routing.clone(),
                    request.fallback_pricing,
                    &tool_schemas,
                    PromptCache {
                        enabled: request.prompt_caching,
                        conversation: Some(&request.session_id),
                    },
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
                                cache_write_tokens: chunk_usage.cache_write_tokens,
                                cost: chunk_usage.cost,
                            });
                        }
                    },
                )
                .await;
            // A provider counts tokens its own way, and its window can be
            // smaller than listed. Told that the request was too long, the
            // history is shortened and the request sent once more.
            let overflow = matches!(
                &result,
                Err(error) if is_context_overflow(&error.to_string())
            );
            if !overflow || shortened || request.cancel.is_cancelled() {
                break result;
            }
            shortened = true;
            let before = context.estimated;
            context.overflowed = true;
            context.ceiling = Some((before as f64 * context.scale) as usize * 4 / 5);
            history = build_history(deps, &request, &tool_schemas, &mut context, &emit).await?;
            if context.estimated >= before {
                break result;
            }
        };

        match stream_result {
            Ok(outcome) => {
                if outcome.usage.prompt_tokens > 0 || outcome.usage.cost > 0.0 {
                    iteration_usage = outcome.usage;
                }
                if let Some(content) = &outcome.provider_content {
                    deps.db
                        .set_provider_content(&placeholder.id, &content.to_string())?;
                }
                tool_calls = outcome.tool_calls;
                stream_cancelled = outcome.cancelled;
            }
            Err(error) => stream_error = Some(error.to_string()),
        }
        let model_duration_ms = model_start.elapsed().as_millis() as i64;
        accumulate_usage(&mut total_usage, &iteration_usage);
        if iteration_usage.prompt_tokens > 0 && context.estimated > 0 {
            context.scale =
                (iteration_usage.prompt_tokens as f64 / context.estimated as f64).clamp(0.5, 2.0);
        }

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
            // The agent wants to finish with changes it never checked: it is
            // asked, once, to run a check first.
            if stream_error.is_none() && !stream_cancelled {
                // Only the chat's own agent, and only where it may change code.
                let checks: &[String] =
                    if request.depth == 0 && !request.plan_only && !request.read_only {
                        &request.completion_checks
                    } else {
                        &[]
                    };
                let mut note = watch.unchecked_note(checks);
                // The user's hooks for the end of a turn run once nothing
                // else keeps the agent working. What they report sends it
                // back once; after that they are run and the turn ends.
                if note.is_none() && request.depth == 0 && !request.hooks.is_empty() {
                    let report = request
                        .hooks
                        .turn_end(&hook_scene(deps, &request), &content, watch.hook_heard)
                        .await;
                    if !watch.hook_heard {
                        watch.hook_heard = report.is_some();
                        note = report.map(|report| {
                            format!("{HARNESS_NOTE} A hook the user set up for the end of a turn reports:\n{report}\n\nDeal with it before you finish.")
                        });
                    }
                }
                if let Some(note) = note {
                    emit(StreamEvent::Assistant { message });
                    // Stored, so that the history keeps answering it in every
                    // later request: an answer followed by more work with
                    // nothing in between is refused by strict model servers.
                    let note = deps.db.append_message(
                        &request.session_id,
                        NewMessage {
                            role: crate::db::NOTE_ROLE,
                            content: &note,
                            ..NewMessage::assistant(None, None)
                        },
                    )?;
                    emit(StreamEvent::Note { message: note });
                    continue;
                }
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
            model_duration_ms,
        )?;
        emit(StreamEvent::Assistant { message: assistant });

        if execute_tool_calls(deps, &request, &sink, &tool_calls, &emit, &mut watch).await? {
            let message = deps.db.append_message(
                &request.session_id,
                NewMessage::assistant(Some(&request.model), request.provider.as_deref()),
            )?;
            final_message = Some(message);
            final_cancelled = true;
            break;
        }

        // Surface edits in the changed-files panel as they happen instead of
        // only once the whole turn has finished.
        if tool_calls
            .iter()
            .any(|call| may_mutate_workspace(&call.name))
        {
            if let Some(changes) = preview_changes(deps, &request) {
                emit(StreamEvent::Changes { changes });
            }
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

    accumulate_usage(&mut total_usage, &context.spent);
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
    if deps.permissions.sandboxes() {
        tools::offer_unsandboxed(&mut tool_schemas);
    }
    let mcp_schemas = deps.mcp.schemas();
    if should_defer_mcp(request, &mcp_schemas) {
        // Inline the two discovery tools instead of every MCP schema.
        tool_schemas.push(tools::tool_search_schema());
        tool_schemas.push(tools::mcp_invoke_schema());
    } else {
        // MCP tools ask before running unless the user chose not to be asked
        // again for one, so the model must say why.
        tool_schemas.extend(mcp_schemas.into_iter().map(|mut schema| {
            tools::add_reason_argument(&mut schema, true);
            schema
        }));
    }
    tool_schemas.retain(|schema| {
        schema
            .pointer("/function/name")
            .and_then(Value::as_str)
            .is_none_or(|name| tool_allowed(request, name))
    });
    if !request.skills.is_empty() {
        tool_schemas.push(tools::skill_schema());
    }
    tool_schemas
}

/// Whether the tool `name` may run in this request: planning modes change
/// nothing and run nothing, read-only modes change no files, and a subagent
/// neither delegates nor asks the user. It decides both what the model is
/// offered and what is run, because a model calls a tool it is not offered
/// all the same when the chat's earlier turns, in another mode, used it.
fn tool_allowed(request: &TurnRequest, name: &str) -> bool {
    !match name {
        "write" | "edit" => request.plan_only || request.read_only,
        "bash" | "bash_output" => request.plan_only,
        "task" | "question" => request.depth >= MAX_SUBAGENT_DEPTH,
        _ => false,
    }
}

/// Decides whether MCP schemas should be deferred behind `tool_search`. Only
/// large schema sets (roughly >10% of the context window, with a floor) are
/// deferred, so small setups keep the simpler inline behaviour.
fn should_defer_mcp(request: &TurnRequest, mcp_schemas: &[Value]) -> bool {
    if !request.mcp_progressive_disclosure || mcp_schemas.is_empty() || request.context_length <= 0
    {
        return false;
    }
    let estimated: usize = mcp_schemas
        .iter()
        .map(|schema| estimate_tokens(&schema.to_string()))
        .sum();
    let threshold = (request.context_length as usize / 10).max(4_000);
    estimated > threshold
}

/// Runs the tool calls the model requested. Consecutive read-only calls
/// (`read`, `glob`, `grep`, `ls`, `webfetch`, `websearch`) run concurrently in
/// bounded batches, while mutating calls and `bash` keep their place in the
/// order. `task` calls run as parallel subagents. Returns `true` when the turn
/// was cancelled part-way.
async fn execute_tool_calls(
    deps: &TurnDeps,
    request: &TurnRequest,
    sink: &EventSink,
    tool_calls: &[ToolCallRecord],
    emit: &impl Fn(StreamEvent),
    watch: &mut TurnWatch,
) -> Result<bool> {
    for call in tool_calls {
        emit(StreamEvent::ToolStart {
            call_id: call.id.clone(),
            name: call.name.clone(),
            summary: summarize(request, &call.name, &call.arguments),
            arguments: call.arguments.clone(),
        });
    }

    // A cancelled turn must still leave a tool output for every requested call,
    // otherwise the stored transcript is invalid for strict providers
    // (Azure/OpenAI reject calls without a matching output).
    if request.cancel.is_cancelled() {
        for call in tool_calls {
            let outcome = ToolOutcome::error("Tool call cancelled before it ran.");
            record_tool_outcome(deps, request, call, &outcome, 0, emit)?;
        }
        return Ok(true);
    }

    let mut subagents: Vec<(
        usize,
        tokio::task::JoinHandle<ToolOutcome>,
        std::time::Instant,
    )> = Vec::new();
    // The other calls in the order the model requested them: consecutive
    // read-only calls form one step and run concurrently, while a write, an
    // edit or `bash` runs after the reads before it and before the reads
    // after it, so `edit` followed by `read` sees the edited file.
    enum Step<'a> {
        Reads(Vec<(usize, &'a ToolCallRecord)>),
        Serial(usize, &'a ToolCallRecord),
    }
    let mut steps: Vec<Step> = Vec::new();
    // Models the `task` calls of this batch named, by `model_match::key`, so a
    // name that fits several models asks the user once for all of them.
    let mut named_models: HashMap<String, std::result::Result<String, String>> = HashMap::new();

    for (index, call) in tool_calls.iter().enumerate() {
        if call.name == "task" {
            let (arguments, invalid) = match tools::parse_arguments(&call.name, &call.arguments) {
                Ok(arguments) => (arguments, None),
                Err(reason) => (json!({}), Some(reason)),
            };
            let named = arguments
                .get("model")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty());
            let model = match named {
                // A model named for this task overrides the subagent model.
                Some(name) => match named_models.get(&model_match::key(name)) {
                    Some(model) => model.clone(),
                    None => {
                        let model = named_model(deps, request, sink, name).await;
                        named_models.insert(model_match::key(name), model.clone());
                        model
                    }
                },
                None => Ok(request.subagent_model.clone()),
            };
            let deps_owned = deps.clone();
            let request_owned = request.clone();
            let sink_owned = sink.clone();
            let started = std::time::Instant::now();
            let handle = match (invalid, model) {
                (Some(reason), _) => tokio::spawn(async move { ToolOutcome::error(reason) }),
                (None, Ok(model)) => tokio::spawn(async move {
                    run_subagent(&deps_owned, &request_owned, arguments, model, sink_owned).await
                }),
                // No model was settled: the call fails without a subagent.
                (None, Err(reason)) => tokio::spawn(async move { ToolOutcome::error(reason) }),
            };
            subagents.push((index, handle, started));
        } else if is_read_only_tool(&call.name) {
            match steps.last_mut() {
                Some(Step::Reads(reads)) => reads.push((index, call)),
                _ => steps.push(Step::Reads(vec![(index, call)])),
            }
        } else {
            steps.push(Step::Serial(index, call));
        }
    }

    let mut results: Vec<(usize, ToolOutcome, i64)> = Vec::new();
    // Whether this batch changed files the changed-files panel has not been
    // told about. A command or a subagent can run for minutes, so they are
    // shown before it starts rather than once the whole batch is done.
    let mut unseen_edits = false;
    let show_edits = |unseen: &mut bool| {
        if std::mem::take(unseen) {
            if let Some(changes) = preview_changes(deps, request) {
                emit(StreamEvent::Changes { changes });
            }
        }
    };
    for step in steps {
        match step {
            // Independent reads run concurrently in small batches, keeping
            // per-call timing for the transcript.
            Step::Reads(reads) => {
                for batch in reads.chunks(READ_ONLY_CONCURRENCY) {
                    let futures = batch.iter().map(|(index, call)| {
                        let index = *index;
                        async move {
                            let started = std::time::Instant::now();
                            let outcome = execute_call(deps, request, call, sink).await;
                            let duration_ms = started.elapsed().as_millis() as i64;
                            (index, outcome, duration_ms)
                        }
                    });
                    results.extend(futures_util::future::join_all(futures).await);
                }
            }
            Step::Serial(index, call) => {
                if !matches!(call.name.as_str(), "write" | "edit") {
                    show_edits(&mut unseen_edits);
                }
                let started = std::time::Instant::now();
                let outcome = execute_call(deps, request, call, sink).await;
                let duration_ms = started.elapsed().as_millis() as i64;
                results.push((index, outcome, duration_ms));
                unseen_edits |= may_mutate_workspace(&call.name);
            }
        }
    }

    // Subagents were spawned above; collect their reports now.
    if !subagents.is_empty() {
        show_edits(&mut unseen_edits);
    }
    for (index, handle, started) in subagents {
        let outcome = match handle.await {
            Ok(outcome) => outcome,
            Err(error) => ToolOutcome::error(format!("Subagent failed: {error}")),
        };
        let duration_ms = started.elapsed().as_millis() as i64;
        results.push((index, outcome, duration_ms));
    }

    // Persist and emit in the original call order so the transcript stays stable.
    results.sort_by_key(|(index, _, _)| *index);
    let mut cancelled = false;
    for (index, mut outcome, duration_ms) in results {
        watch.observe(&tool_calls[index], &mut outcome);
        record_tool_outcome(
            deps,
            request,
            &tool_calls[index],
            &outcome,
            duration_ms,
            emit,
        )?;
        if request.cancel.is_cancelled() {
            cancelled = true;
        }
    }
    Ok(cancelled)
}

/// Read-only tools never mutate the workspace and can safely run concurrently.
fn is_read_only_tool(name: &str) -> bool {
    matches!(
        name,
        "read"
            | "glob"
            | "grep"
            | "ls"
            | "webfetch"
            | "websearch"
            | "tool_search"
            | "skill"
            | "bash_output"
            | "screenshot"
    )
}

/// Upper bound on concurrent read-only tool executions per batch.
const READ_ONLY_CONCURRENCY: usize = 8;

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
        NewMessage {
            attachments: &outcome.attachments,
            ..NewMessage::tool(
                &call.id,
                &call.name,
                &outcome.result,
                &outcome.status,
                &outcome.changes,
                duration_ms,
            )
        },
    )?;
    emit(StreamEvent::ToolEnd {
        call_id: call.id.clone(),
        name: call.name.clone(),
        status: outcome.status.clone(),
        result: outcome.result.clone(),
        changes: outcome.changes.clone(),
        attachments: outcome.attachments.clone(),
    });
    Ok(())
}

/// Marks what the harness, not the user or a tool, tells the model.
const HARNESS_NOTE: &str = "[pumr]";

/// The same call with the same result this often gets a note saying so.
const REPEATS_NOTED: usize = 3;
/// This many failed calls of one tool in a row get a note saying so.
const FAILURES_NOTED: usize = 3;

/// What the harness watches over the steps of one turn, to tell the agent
/// what it would otherwise find out late or not at all: that it is going in
/// circles, and that it changed code without running anything afterwards.
#[derive(Default)]
struct TurnWatch {
    /// Code files written since a command last ran.
    unchecked: Vec<String>,
    /// The agent was already asked in this turn to check its changes.
    asked: bool,
    /// Per call (tool and arguments): its last result and how often in a row
    /// it came back the same.
    repeats: HashMap<String, (u64, usize)>,
    /// The tool that failed last and how many times in a row.
    failing: Option<(String, usize)>,
    /// A hook for the end of the turn has sent the agent back to work.
    hook_heard: bool,
}

impl TurnWatch {
    /// Takes note of a finished call and adds to its result what the agent
    /// should know about it.
    fn observe(&mut self, call: &ToolCallRecord, outcome: &mut ToolOutcome) {
        match call.name.as_str() {
            "write" | "edit" if outcome.status == "ok" => {
                for change in &outcome.changes {
                    if is_code_path(&change.path) && !self.unchecked.contains(&change.path) {
                        self.unchecked.push(change.path.clone());
                    }
                }
            }
            // Any command counts: which one checks a change is the agent's call.
            "bash" | "bash_output" if !matches!(outcome.status.as_str(), "denied" | "canceled") => {
                self.unchecked.clear();
            }
            _ => {}
        }

        let mut hasher = DefaultHasher::new();
        (&outcome.status, &outcome.result).hash(&mut hasher);
        let result = hasher.finish();
        let key = format!("{}\n{}", call.name, call.arguments);
        // A check run again after the workspace changed tests other code, so
        // a change starts the count of every other call again. An edit that
        // went through is a change. What a command, a subagent or an MCP tool
        // did is not known, so it counts as one too, unless it is itself a
        // repeat: two commands taking turns with the same results are a
        // circle like any other.
        let seen = self
            .repeats
            .get(&key)
            .is_some_and(|(last, _)| *last == result);
        let changed = outcome.status == "ok"
            && (matches!(call.name.as_str(), "write" | "edit")
                || (may_mutate_workspace(&call.name) && !seen));
        if changed {
            for (other, (_, count)) in self.repeats.iter_mut() {
                if *other != key {
                    *count = 0;
                }
            }
        }
        let repeats = self.repeats.entry(key).or_insert((result, 0));
        if repeats.0 != result {
            *repeats = (result, 0);
        }
        repeats.1 += 1;
        let repeated = repeats.1;

        let failures = if outcome.status == "error" {
            let count = match self.failing.take() {
                Some((name, count)) if name == call.name => count + 1,
                _ => 1,
            };
            self.failing = Some((call.name.clone(), count));
            count
        } else {
            if outcome.status == "ok" {
                self.failing = None;
            }
            0
        };

        if repeated >= REPEATS_NOTED && !matches!(call.name.as_str(), "bash_output" | "question") {
            outcome.result.push_str(&format!(
                "\n\n{HARNESS_NOTE} You have made this exact call {repeated} times with the same result. Repeating it changes nothing: work with the result above, or try something else."
            ));
        } else if failures >= FAILURES_NOTED && failures % FAILURES_NOTED == 0 {
            let advice = match call.name.as_str() {
                "edit" => "Read the file again and copy the text to replace exactly from it.",
                _ => "Read the errors above before the next attempt, and change the approach or ask the user rather than trying the same thing again.",
            };
            outcome.result.push_str(&format!(
                "\n\n{HARNESS_NOTE} {failures} {} calls in a row have failed. {advice}",
                call.name
            ));
        }
    }

    /// What to tell an agent that is about to finish with code it changed
    /// and never ran anything against, given the project's `checks`. `None`
    /// when there is nothing to ask, or it was asked before in this turn.
    fn unchecked_note(&mut self, checks: &[String]) -> Option<String> {
        if self.asked || self.unchecked.is_empty() || checks.is_empty() {
            return None;
        }
        self.asked = true;
        let mut files = self
            .unchecked
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        if self.unchecked.len() > 3 {
            files.push_str(&format!(" and {} more", self.unchecked.len() - 3));
        }
        Some(format!(
            "{HARNESS_NOTE} You changed {files} and ran nothing afterwards. Before you finish, run the narrowest check that covers the change (this project has: {}) and report what it really printed. If no check applies or it cannot run here, say so in one sentence instead.",
            checks.join("; ")
        ))
    }
}

/// Whether a change to `path` can break a build or a test. Prose and
/// pictures cannot, so they ask for no check.
fn is_code_path(path: &str) -> bool {
    let extension = Path::new(path)
        .extension()
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    !matches!(
        extension.as_str(),
        "md" | "mdx"
            | "markdown"
            | "txt"
            | "rst"
            | "adoc"
            | "csv"
            | "tsv"
            | "log"
            | "svg"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "ico"
            | "pdf"
    )
}

/// The model a `task` call asked for by name. A name that fits several
/// models asks the user, once per chat; `Err` tells the agent why the
/// subagent was not started.
async fn named_model(
    deps: &TurnDeps,
    request: &TurnRequest,
    sink: &EventSink,
    name: &str,
) -> std::result::Result<String, String> {
    deps.model_choices
        .settle(
            name,
            &deps.models,
            catalog::provider_of(&request.model).id,
            &request.conversation_id,
            &request.session_id,
            &request.cancel,
            sink,
        )
        .await
}

/// OpenRouter routing, context window and fallback prices for a subagent on
/// `model`. They are the chat's own only when it runs on the chat's model.
fn subagent_model_setup(
    deps: &TurnDeps,
    request: &TurnRequest,
    model: &str,
) -> (Option<String>, i64, Option<(f64, f64)>) {
    if model == request.model {
        return (
            request.provider.clone(),
            request.context_length,
            request.fallback_pricing,
        );
    }
    let info = deps.models.iter().find(|entry| entry.id == model);
    // A provider picked for the chat's model may not serve this one; the
    // `auto` presets fit any model.
    let provider = request
        .provider
        .clone()
        .filter(|provider| provider.trim().starts_with("auto"));
    (
        provider,
        info.map_or(0, |entry| entry.context_length),
        info.map(|entry| {
            (
                entry.prompt_price_per_m / 1_000_000.0,
                entry.completion_price_per_m / 1_000_000.0,
            )
        }),
    )
}

fn run_subagent<'a>(
    deps: &'a TurnDeps,
    request: &'a TurnRequest,
    arguments: Value,
    model: String,
    sink: EventSink,
) -> Pin<Box<dyn Future<Output = ToolOutcome> + Send + 'a>> {
    Box::pin(async move {
        // The user can stop the turn while an earlier `task` call of the
        // batch waits for them to pick its model.
        if request.cancel.is_cancelled() {
            return stopped_before_it_ran();
        }
        if !tool_allowed(request, "task") {
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

        // An explore subagent only looks things up: it reads on behalf of the
        // main agent, which gets the findings without the files in its context.
        // A verify subagent checks the main agent's work with fresh eyes: it
        // runs the project's checks and cannot edit either.
        let mode = arguments.get("mode").and_then(Value::as_str);
        let explore = mode == Some("explore");
        let verify = mode == Some("verify");
        let prompt = if verify {
            format!("{prompt}{}", changed_files_note(deps, request))
        } else {
            prompt
        };
        let child_system_prompt = if verify {
            format!(
                "{}\n\n# Subagent\nYou are a subagent spawned by the main agent to check its work.\nTask: {title}\nYou cannot change files. Judge the work by what you run and read yourself, not by what the task says was done: read the changed code, then run the narrowest checks that cover it (tests, build, lint) and, for a bug fix, the reproduction. Do not ask the user questions. Reply with one line per check: PASS, FAIL, BLOCKED (could not run, and why) or NOT_RUN, each with the command and the output that shows it, then anything in the changed code that looks wrong.",
                request.system_prompt
            )
        } else if explore {
            format!(
                "{}\n\n# Subagent\nYou are a subagent spawned by the main agent to find something out.\nTask: {title}\nSearch and read with the tools available; you cannot change files. Do not ask the user questions. When you are done, reply with what you found: the files that matter as path:line references with a line on each, and quotes only where the exact code matters. The main agent reads your report instead of the files, so leave out what it does not need.",
                request.system_prompt
            )
        } else {
            format!(
                "{}\n\n# Subagent\nYou are a subagent spawned by the main agent to complete one focused task.\nTask: {title}\nWork autonomously with the tools available. Do not ask the user questions. When you are done, reply with a concise report of what you did, which files you changed, and anything the main agent must know.",
                request.system_prompt
            )
        };

        let (provider, context_length, fallback_pricing) =
            subagent_model_setup(deps, request, &model);
        let child = match deps.db.create_sub_session(
            &request.project_id,
            &request.session_id,
            &title,
            Some(&model),
            request.reasoning_effort.as_deref(),
            provider.as_deref(),
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
            model,
            reasoning_effort: request.reasoning_effort.clone(),
            provider,
            system_prompt: child_system_prompt,
            session_id: child.id.clone(),
            conversation_id: request.conversation_id.clone(),
            project_id: request.project_id.clone(),
            depth: request.depth + 1,
            project_root: request.project_root.clone(),
            extra_folders: request.extra_folders.clone(),
            file_ignore: request.file_ignore.clone(),
            context_length,
            auto_compact_threshold: request.auto_compact_threshold,
            auto_compact_max_tokens: request.auto_compact_max_tokens,
            max_tool_iterations: request.max_tool_iterations,
            auto_continue: false,
            fallback_pricing,
            base_commit,
            resume: false,
            plan_only: request.plan_only,
            read_only: request.read_only || explore || verify,
            mcp_progressive_disclosure: request.mcp_progressive_disclosure,
            skills: request.skills.clone(),
            prompt_caching: request.prompt_caching,
            subagent_model: request.subagent_model.clone(),
            compaction_model: request.compaction_model.clone(),
            completion_checks: Vec::new(),
            hooks: request.hooks.clone(),
            cancel: request.cancel.clone(),
        };

        let child_sink = with_parent_changes(
            deps.db.clone(),
            deps.shadow.clone(),
            request.session_id.clone(),
            request.base_commit.clone(),
            request.resume,
            sink.clone(),
        );
        let result = run_turn(deps, child_request, child_sink).await;

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

/// Context bookkeeping that carries over between the steps of one turn.
struct ContextState {
    /// How far the provider's count of the last request was from the estimate
    /// of it. Later estimates are scaled by it.
    scale: f64,
    /// Estimated input tokens of the request built last.
    estimated: usize,
    /// Summarising failed in this turn and is not tried again before the next.
    compaction_failed: bool,
    /// The provider refused the last request as too long, so the history is
    /// compacted whatever the estimate says.
    overflowed: bool,
    /// Input size below the one a provider refused in this turn. The history
    /// is compacted from here, whatever the model's listed window says.
    ceiling: Option<usize>,
    /// What the summaries written during this turn cost.
    spent: ChatUsage,
}

impl Default for ContextState {
    fn default() -> Self {
        Self {
            scale: 1.0,
            estimated: 0,
            compaction_failed: false,
            overflowed: false,
            ceiling: None,
            spent: ChatUsage::default(),
        }
    }
}

/// Starts the message that stands in for compacted history.
const SUMMARY_NOTE: &str = "[Earlier messages of this conversation were replaced by the summary below to save context. Continue from where it leaves off without repeating finished work. File contents read earlier are no longer in context: read a file again before you edit it.]";

/// Sent in place of an old tool output.
const CLEARED_OUTPUT: &str =
    "[Old tool output cleared to save context. Run the tool again if you need it.]";

/// Tool outputs this short are not worth clearing.
const CLEARABLE_MIN_BYTES: usize = 800;

/// Bounds for how much recent tool output stays in full when old output is
/// cleared, in tokens.
const KEPT_TOOL_OUTPUT: (usize, usize) = (4_000, 40_000);

/// Bounds for how much of the newest history stays word for word when the
/// rest is summarised, in tokens.
const KEPT_HISTORY: (usize, usize) = (2_000, 20_000);

/// Smallest input size, in tokens, compaction is ever triggered at.
const MIN_COMPACTION_LIMIT: usize = 2_000;

/// Builds the messages of the next model request: the system prompt, the
/// summary of what was compacted, and every message since. Between two
/// requests it only grows at the end, so a provider can serve everything
/// before that from its prompt cache. Past the compaction limit the history
/// is shortened once, in a way that is stored, and is stable again after.
async fn build_history(
    deps: &TurnDeps,
    request: &TurnRequest,
    tool_schemas: &[Value],
    context: &mut ContextState,
    emit: &impl Fn(StreamEvent),
) -> Result<Vec<ChatMessage>> {
    let overhead = schema_tokens(tool_schemas);
    let replay = catalog::provider_of(&request.model).kind == ProviderKind::Anthropic;
    let pictures = pictures(deps, request);
    let load = |clear_old: bool| {
        stored_history(
            &deps.db,
            &request.session_id,
            &request.system_prompt,
            replay,
            clear_old,
            pictures,
        )
    };
    let mut history = load(true)?;

    let limit = compaction_limit(
        request.context_length,
        request.auto_compact_threshold,
        request.auto_compact_max_tokens,
    );
    // What a provider refused counts for more than the window it lists.
    let limit = match (limit, context.ceiling) {
        (Some(limit), Some(ceiling)) => Some(limit.min(ceiling)),
        (limit, ceiling) => limit.or(ceiling),
    };
    if let Some(limit) = limit {
        let scale = context.scale;
        let used = |history: &[ChatMessage]| {
            ((history_tokens(history) + overhead) as f64 * scale) as usize
        };
        if context.overflowed || used(&history) > limit {
            // Old tool output goes first: it is most of a long tool loop, and
            // the model can fetch any of it again.
            if clear_old_tool_output(&deps.db, &request.session_id, limit)? {
                history = load(true)?;
            }
            // Clearing has to leave real headroom, or the next steps cross
            // the limit again and the history is shortened once more.
            let crowded = used(&history) > limit - limit / 7;
            if (context.overflowed || crowded) && !context.compaction_failed {
                let (_, context_length, fallback_pricing) =
                    subagent_model_setup(deps, request, &request.compaction_model);
                let compactor = Compactor {
                    db: &deps.db,
                    client: &deps.client,
                    session_id: &request.session_id,
                    model: &request.compaction_model,
                    context_length,
                    fallback_pricing,
                    cancel: &request.cancel,
                };
                let keep = (limit / 4).clamp(KEPT_HISTORY.0, KEPT_HISTORY.1);
                let least = if context.overflowed { 0 } else { limit / 5 };
                // The summary is written from the tool output as it was, not
                // from the stubs that replaced the old ones.
                match compact(&compactor, &load(false)?, keep, least, || {
                    emit(StreamEvent::Compacting)
                })
                .await?
                {
                    Compaction::Done { message, usage } => {
                        accumulate_usage(&mut context.spent, &usage);
                        emit(StreamEvent::Compacted { message: *message });
                        // What the agent read is gone from its context too.
                        deps.files.forget(&request.session_id);
                        history = load(true)?;
                    }
                    Compaction::Skipped => {}
                    Compaction::Failed(reason) => {
                        log::warn!("could not compact session {}: {reason}", request.session_id);
                        context.compaction_failed = true;
                    }
                }
            }
        }
    }
    context.overflowed = false;

    let history = sanitize(fit_to_window(history, request.context_length, overhead));
    context.estimated = history_tokens(&history) + overhead;
    Ok(history)
}

/// Input tokens (messages and tool schemas) from which the history is
/// compacted: a share of what the model's window leaves for input, and never
/// more than the configured maximum, because a model loses track of its
/// context long before the window is full. `None` when neither is known.
fn compaction_limit(context_length: i64, threshold: usize, max_tokens: usize) -> Option<usize> {
    let room = context_token_budget(context_length, 0);
    let limit = match threshold {
        // Automatic compaction is off: only what no longer fits is compacted.
        0 => room?,
        percent => {
            let share = room.map(|room| room * percent.min(100) / 100);
            match (share, max_tokens) {
                (Some(share), 0) => share,
                (Some(share), max) => share.min(max),
                (None, 0) => return None,
                (None, max) => max,
            }
        }
    };
    Some(limit.max(MIN_COMPACTION_LIMIT))
}

/// The model history as it is stored: the system prompt, the summary of the
/// latest checkpoint (if any) and the messages after it. With `clear_old`,
/// as for every request, old tool output up to the session's cleared mark is
/// replaced by a stub. `pictures` says what the model does with them: those
/// a tool read are sent only to a model known to take them, and those the
/// user attached to every model but one known not to. A picture that is not
/// sent is named instead.
fn stored_history(
    db: &Db,
    session_id: &str,
    system_prompt: &str,
    replay_provider_content: bool,
    clear_old: bool,
    pictures: Pictures,
) -> Result<Vec<ChatMessage>> {
    let vision = pictures == Pictures::Takes;
    let show_attached = pictures != Pictures::Refuses;
    let checkpoint = db.latest_checkpoint(session_id)?;
    let after = checkpoint.as_ref().map_or(-1, |entry| entry.upto_seq);
    let messages = db.list_messages_after(session_id, after)?;
    let cleared_upto = if clear_old {
        db.cleared_upto(session_id)?
    } else {
        -1
    };
    // Turns a direct provider returned are replayed to it as they came back.
    let mut provider_contents = if replay_provider_content {
        db.provider_contents(session_id)?
    } else {
        Default::default()
    };

    let mut history = vec![ChatMessage::text("system", system_prompt)];
    if let Some(checkpoint) = checkpoint {
        let mut summary =
            ChatMessage::text("user", format!("{SUMMARY_NOTE}\n\n{}", checkpoint.summary));
        // Stands in for the messages it covers, so a pinned prompt is placed
        // relative to it like it would have been to them.
        summary.seq = Some(checkpoint.upto_seq);
        history.push(summary);
    }
    // Pictures the tool results of the step being walked hold for the model.
    let mut pictures: Vec<Attachment> = Vec::new();
    let mut pictures_seq = -1;
    for mut message in messages {
        let seq = message.seq;
        let cleared = seq <= cleared_upto && clearable(&message);
        if message.role != "tool" {
            history.extend(pictures_note(&mut pictures, pictures_seq, vision));
        } else if !cleared && shows_pictures(&message) {
            pictures.extend(
                std::mem::take(&mut message.attachments)
                    .into_iter()
                    .filter(Attachment::is_image),
            );
            pictures_seq = seq;
        }
        let converted = match message.role.as_str() {
            "user" => user_content(
                &message.content,
                &message.attachments,
                &message.context,
                show_attached,
            )
            .map(|content| ChatMessage::parts("user", content)),
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
                                    "arguments": replayed_arguments(&call.arguments)
                                }
                            })
                        })
                        .collect();
                    Some(ChatMessage::assistant_tool_calls(
                        message.content,
                        Value::Array(calls),
                    ))
                } else if !message.content.is_empty() {
                    Some(ChatMessage::text("assistant", message.content))
                } else {
                    None
                }
            }
            "tool" => message.tool_call_id.map(|call_id| {
                let content = if cleared {
                    CLEARED_OUTPUT.to_string()
                } else {
                    message.content
                };
                ChatMessage::tool_result(&call_id, content)
            }),
            crate::db::NOTE_ROLE => Some(ChatMessage::text("user", message.content)),
            _ => None,
        };
        if let Some(mut converted) = converted {
            converted.seq = Some(seq);
            if converted.role == "assistant" {
                converted.provider_content = provider_contents
                    .remove(&message.id)
                    .and_then(|content| serde_json::from_str(&content).ok());
            }
            history.push(converted);
        }
    }
    history.extend(pictures_note(&mut pictures, pictures_seq, vision));
    Ok(history)
}

/// The arguments of a stored call as the model is sent them again. A call
/// the output limit cut off was answered with an error, but its arguments
/// stay half a JSON object, and a model server that parses what it is sent
/// refuses the request with them in it, and so every later one of the chat.
/// Whatever is no JSON object goes back as the empty one; that is also what
/// a call sent with no arguments at all was run with.
fn replayed_arguments(arguments: &str) -> String {
    match serde_json::from_str::<Value>(arguments) {
        Ok(Value::Object(_)) => arguments.to_string(),
        // Encoded once more as a string, they were run as the object in it
        // (see `tools::parse_arguments`).
        Ok(Value::String(inner))
            if matches!(serde_json::from_str::<Value>(&inner), Ok(Value::Object(_))) =>
        {
            inner
        }
        _ => "{}".to_string(),
    }
}

/// What a picture in the history counts for, in tokens. A provider counts it
/// by its size in pixels, not in bytes, so this is a flat estimate.
const PICTURE_TOKENS: usize = 1_000;

/// Whether a stored tool result holds pictures for the model: those `read`
/// returned. The pictures of `screenshot` are for the user alone.
fn shows_pictures(message: &Message) -> bool {
    message.tool_name.as_deref() == Some("read")
        && message.attachments.iter().any(Attachment::is_image)
}

/// The pictures the `read` calls of one step returned, as the message that
/// shows them to the model. A tool result holds text only, whatever the model
/// server, so the pictures follow the results of the step in a note of their
/// own. It is built from the stored results on every request, and so goes
/// when they are cleared or summarised. Without `vision` the model is only
/// told which pictures there were: the chat was switched to it after they
/// were read, and a picture it cannot take would fail every request.
fn pictures_note(pictures: &mut Vec<Attachment>, seq: i64, vision: bool) -> Option<ChatMessage> {
    if pictures.is_empty() {
        return None;
    }
    let mut parts: Vec<Value> = Vec::new();
    for picture in pictures.drain(..) {
        let lead = if parts.is_empty() { HARNESS_NOTE } else { "" };
        let left_out = if vision {
            ""
        } else {
            " left out, because the model in use does not take pictures."
        };
        parts.push(json!({
            "type": "text",
            "text": format!("{lead} Picture read from {}:{left_out}", picture.name).trim_start()
        }));
        if vision {
            parts.push(json!({
                "type": "image_url",
                "image_url": { "url": format!("data:{};base64,{}", picture.mime_type, picture.data) }
            }));
        }
    }
    let mut note = ChatMessage::parts("user", Value::Array(parts));
    note.seq = Some(seq);
    Some(note)
}

/// Estimated tokens a stored tool result takes in the history.
fn tool_result_tokens(message: &Message) -> usize {
    let pictures = if shows_pictures(message) {
        message.attachments.iter().filter(|entry| entry.is_image()).count()
    } else {
        0
    };
    estimate_tokens(&message.content) + pictures * PICTURE_TOKENS
}

/// Whether a stored tool output may be replaced by a stub once it is old.
/// What running the tool again would not bring back stays: loaded skill
/// instructions, subagent reports, the user's answers and the task list.
fn clearable(message: &Message) -> bool {
    message.role == "tool"
        && (message.content.len() > CLEARABLE_MIN_BYTES || shows_pictures(message))
        && !matches!(
            message.tool_name.as_deref(),
            Some("skill" | "task" | "question" | "todo")
        )
}

/// Moves the session's cleared mark forward so that only the newest tool
/// output stays in full. Returns whether it moved, which it only does when
/// that frees a worthwhile share of `limit`: every move changes the history
/// the provider has cached.
fn clear_old_tool_output(db: &Db, session_id: &str, limit: usize) -> Result<bool> {
    let cleared_upto = db.cleared_upto(session_id)?;
    let after = db
        .latest_checkpoint(session_id)?
        .map_or(-1, |entry| entry.upto_seq);
    let messages = db.list_messages_after(session_id, after)?;
    // The output of the newest step has not reached the model yet.
    let newest_step = messages
        .iter()
        .rposition(|message| message.role == "user" || !message.tool_calls.is_empty())
        .unwrap_or(0);
    let keep = (limit / 3).clamp(KEPT_TOOL_OUTPUT.0, KEPT_TOOL_OUTPUT.1);
    let stub = estimate_tokens(CLEARED_OUTPUT);

    let mut kept = 0usize;
    let mut freed = 0usize;
    let mut mark: Option<i64> = None;
    for (index, message) in messages.iter().enumerate().rev() {
        if message.seq <= cleared_upto {
            break;
        }
        if !clearable(message) {
            continue;
        }
        let tokens = tool_result_tokens(message);
        if mark.is_none() && (index >= newest_step || kept < keep) {
            kept += tokens;
            continue;
        }
        mark.get_or_insert(message.seq);
        freed += tokens.saturating_sub(stub);
    }
    match mark {
        Some(seq) if freed >= (limit / 10).max(1_000) => {
            db.set_cleared_upto(session_id, seq)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn schema_tokens(tool_schemas: &[Value]) -> usize {
    tool_schemas
        .iter()
        .map(|schema| estimate_tokens(&schema.to_string()))
        .sum()
}

fn history_tokens(history: &[ChatMessage]) -> usize {
    history.iter().map(message_token_estimate).sum()
}

fn is_summary(message: &ChatMessage) -> bool {
    message.role == "user"
        && message
            .content
            .as_str()
            .is_some_and(|text| text.starts_with(SUMMARY_NOTE))
}

/// Whether the harness, not the user, wrote this user message.
fn is_note(message: &ChatMessage) -> bool {
    let text = match &message.content {
        Value::String(text) => Some(text.as_str()),
        // The pictures of a step (see `pictures_note`).
        Value::Array(parts) => parts
            .first()
            .and_then(|part| part.get("text"))
            .and_then(Value::as_str),
        _ => None,
    };
    message.role == "user" && text.is_some_and(|text| text.starts_with(HARNESS_NOTE))
}

/// Whether this is the note that shows a step's pictures to the model.
fn is_pictures_note(message: &ChatMessage) -> bool {
    message.content.is_array() && is_note(message)
}

/// Last resort for a history that still exceeds the model's window, because
/// compaction is off, failed or had nothing left to summarise: drops the
/// oldest messages for this request only. In a long tool loop the oldest
/// message is the prompt being worked on, so the latest prompt is kept out of
/// the trimming, with its room reserved, and put back where it belongs.
fn fit_to_window(
    mut history: Vec<ChatMessage>,
    context_length: i64,
    overhead: usize,
) -> Vec<ChatMessage> {
    let Some(budget) = context_token_budget(context_length, overhead) else {
        return history;
    };
    if history_tokens(&history) <= budget {
        return history;
    }
    let latest_prompt = history
        .iter()
        .rposition(|message| message.role == "user" && !is_summary(message) && !is_note(message));
    match latest_prompt {
        Some(index) => {
            let prompt = fit_pinned_prompt(history.remove(index), context_length, overhead);
            let reserved = message_token_estimate(&prompt);
            let mut history = trim_to_budget(history, context_length, overhead + reserved);
            place_pinned_prompt(&mut history, prompt);
            history
        }
        None => trim_to_budget(history, context_length, overhead),
    }
}

/// Shortens a pinned prompt that alone would take more than half of the input
/// budget, so the rest of the conversation still fits next to it.
fn fit_pinned_prompt(prompt: ChatMessage, context_length: i64, overhead: usize) -> ChatMessage {
    match context_token_budget(context_length, overhead) {
        Some(budget) if message_token_estimate(&prompt) > budget / 2 => {
            truncate_message(prompt, budget / 2)
        }
        _ => prompt,
    }
}

/// Puts the pinned prompt back before the first message that came after it
/// (or at the end), after the system prompt and anything older, including a
/// summary of what came before it.
fn place_pinned_prompt(history: &mut Vec<ChatMessage>, prompt: ChatMessage) {
    let pinned = prompt.seq.unwrap_or(i64::MIN);
    let index = history
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, message)| message.seq.is_some_and(|seq| seq > pinned))
        .map_or(history.len(), |(index, _)| index);
    history.insert(index.max(1).min(history.len()), prompt);
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
        Some("image_url") => PICTURE_TOKENS,
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
    Some(
        context_length
            .saturating_sub(reserve)
            .saturating_sub(overhead)
            .max(1_024),
    )
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
    message.provider_content = None;
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

const COMPACTION_SYSTEM_PROMPT: &str = r#"You are summarising a coding session so that the same assistant can keep working after its earlier messages are removed from its context. Whatever you leave out is lost to it. Write in the language the user writes in, under these headings, and leave out a heading that has nothing under it:

## Goal
What the user wants, with the constraints and preferences they stated. Quote their instructions where the wording matters.

## Decisions
What was decided and why, including approaches that were tried and dropped.

## Work so far
What was done, with exact file paths, function names and commands. For every file changed, what changed in it.

## Findings
What was learned about the code or the environment that later work depends on: where things live, how they behave, errors that came up and what fixed them.

## State
What works, what is untested or failing, and the exact step that was in progress.

## Next steps
What remains, in order.

Keep identifiers, paths, numbers and error messages exact. Leave out greetings, repetition and raw tool output. If the conversation starts with a summary of what came before, carry over everything in it that still holds. Do not list the task list or repeat the user's latest request word for word; both are added after your summary. Output only the summary."#;

/// Headings of what is added to a summary after the model wrote it.
const TASKS_HEADING: &str = "## Task list";
const LATEST_REQUEST_HEADING: &str = "## Latest user request (verbatim)";

/// How much of the user's latest request is kept word for word, in tokens.
const KEPT_REQUEST_TOKENS: usize = 2_000;

/// What summarising a session's history takes, for a running turn and for a
/// compaction the user asks for.
pub struct Compactor<'a> {
    pub db: &'a Db,
    pub client: &'a LlmClient,
    pub session_id: &'a str,
    pub model: &'a str,
    /// Context window of `model` in tokens (0 when unknown).
    pub context_length: i64,
    pub fallback_pricing: Option<(f64, f64)>,
    pub cancel: &'a CancellationToken,
}

pub enum Compaction {
    /// The checkpoint is stored; `message` is its record in the chat.
    Done {
        message: Box<Message>,
        usage: ChatUsage,
    },
    /// There was too little to summarise.
    Skipped,
    /// The model wrote no summary; says why.
    Failed(String),
}

/// Estimated tokens of the messages a session's next request starts from.
pub fn stored_tokens(db: &Db, session_id: &str) -> Result<usize> {
    // Counted with its pictures: which model comes next is not known here.
    Ok(history_tokens(&stored_history(
        db,
        session_id,
        "",
        false,
        true,
        Pictures::Takes,
    )?))
}

/// Compacts a session's history now, whatever its size: the user asked for it
/// between two turns.
pub async fn compact_now(compactor: &Compactor<'_>) -> Result<Compaction> {
    // The summary is written from the text of the history, so no picture is
    // sent whatever is passed for `vision`.
    let history = stored_history(
        compactor.db,
        compactor.session_id,
        "",
        false,
        false,
        Pictures::Takes,
    )?;
    compact(compactor, &history, KEPT_HISTORY.0, 0, || {}).await
}

/// Summarises all of `history` but its newest stretch of about `keep_tokens`
/// and stores the summary as the session's checkpoint: from the next request
/// on, the history starts with it instead of the messages it covers. Nothing
/// is summarised unless it covers at least `least_tokens` of new messages,
/// since every checkpoint costs a model call and the provider's cached prefix.
async fn compact(
    compactor: &Compactor<'_>,
    history: &[ChatMessage],
    keep_tokens: usize,
    least_tokens: usize,
    on_start: impl FnOnce(),
) -> Result<Compaction> {
    let cut = summary_cut(history, keep_tokens);
    let summarised = history.get(1..cut).unwrap_or_default();
    let Some(upto_seq) = summarised.iter().rev().find_map(|message| message.seq) else {
        return Ok(Compaction::Skipped);
    };
    let fresh: usize = summarised
        .iter()
        .filter(|message| !is_summary(message))
        .map(message_token_estimate)
        .sum();
    if fresh < least_tokens.max(500) || compactor.cancel.is_cancelled() {
        return Ok(Compaction::Skipped);
    }
    on_start();

    // Leaves room for the instructions and the summary, and for the estimate
    // being off for this model.
    let budget =
        context_token_budget(compactor.context_length, 2_000).map_or(100_000, |room| room * 3 / 4);
    let transcript = render_transcript(summarised, budget);
    let mut summary = String::new();
    let mut usage = ChatUsage::default();
    let result = compactor
        .client
        .stream_chat(
            compactor.model,
            vec![
                ChatMessage::text("system", COMPACTION_SYSTEM_PROMPT),
                ChatMessage::text(
                    "user",
                    format!("# Conversation to summarize\n\n{transcript}"),
                ),
            ],
            None,
            None,
            compactor.fallback_pricing,
            &[],
            PromptCache::off(),
            compactor.cancel.clone(),
            &mut |chunk| match chunk {
                ChatChunk::Delta(text) => summary.push_str(&text),
                ChatChunk::Usage(chunk_usage) => usage = chunk_usage,
                ChatChunk::Reasoning(_) => {}
            },
        )
        .await;
    match result {
        Ok(outcome) if outcome.cancelled => {
            return Ok(Compaction::Failed("Compaction was stopped.".to_string()))
        }
        Ok(outcome) => {
            if outcome.usage.prompt_tokens > 0 || outcome.usage.cost > 0.0 {
                usage = outcome.usage;
            }
        }
        Err(error) => return Ok(Compaction::Failed(error.to_string())),
    }
    let mut summary = summary.trim().to_string();
    if summary.is_empty() {
        return Ok(Compaction::Failed(
            "The model returned an empty summary.".to_string(),
        ));
    }

    let todos = compactor.db.session_todos(compactor.session_id)?;
    if let Some(tasks) = tools::render_todos(&todos) {
        summary.push_str(&format!("\n\n{TASKS_HEADING}\n{tasks}"));
    }
    // A summary may paraphrase the request away. Unless a prompt is among the
    // messages that stay, the newest one is kept as the user wrote it.
    if !history[cut..]
        .iter()
        .any(|message| message.role == "user" && !is_note(message))
    {
        if let Some(request) = latest_request(summarised) {
            summary.push_str(&format!("\n\n{LATEST_REQUEST_HEADING}\n{request}"));
        }
    }

    let message = compactor.db.append_checkpoint(
        compactor.session_id,
        &summary,
        upto_seq,
        compactor.model,
        (
            usage.cost,
            usage.prompt_tokens,
            usage.completion_tokens,
            usage.cached_tokens,
        ),
    )?;
    Ok(Compaction::Done {
        message: Box::new(message),
        usage,
    })
}

/// Index of the first message that stays in full when `history` is compacted.
/// The newest step always stays: a prompt, or an assistant message with the
/// tool output answering it, which the model has yet to act on. Older steps
/// stay while they fit in `keep_tokens`. A tool output never starts the kept
/// stretch, since it would be cut off from the call it answers.
fn summary_cut(history: &[ChatMessage], keep_tokens: usize) -> usize {
    let mut cut = history.len();
    let mut kept = 0usize;
    for index in (1..history.len()).rev() {
        kept += message_token_estimate(&history[index]);
        // A step's pictures stay with its tool output.
        if history[index].role == "tool" || is_pictures_note(&history[index]) {
            continue;
        }
        if cut < history.len() && kept > keep_tokens {
            break;
        }
        cut = index;
    }
    cut
}

/// The user's newest request among `messages`, as they wrote it. An earlier
/// summary hands on the one it kept.
fn latest_request(messages: &[ChatMessage]) -> Option<String> {
    let message = messages
        .iter()
        .rev()
        .find(|message| message.role == "user" && !is_note(message))?;
    let request = if is_summary(message) {
        let (_, request) = message
            .content
            .as_str()?
            .split_once(LATEST_REQUEST_HEADING)?;
        request.trim().to_string()
    } else {
        let text = match &message.content {
            // Referenced files and attachments surround the prompt itself.
            Value::Array(parts) => parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .filter(|text| {
                    !text.starts_with("# Referenced context") && !text.starts_with("<file name=")
                })
                .collect::<Vec<_>>()
                .join("\n"),
            other => content_to_text(other),
        };
        truncate_text(text.trim(), KEPT_REQUEST_TOKENS)
    };
    (!request.is_empty()).then_some(request)
}

/// The part of a stored summary the model wrote, without the note before it
/// and what was added after it.
fn summary_body(text: &str) -> &str {
    let text = text.strip_prefix(SUMMARY_NOTE).unwrap_or(text);
    let end = [TASKS_HEADING, LATEST_REQUEST_HEADING]
        .iter()
        .filter_map(|heading| text.find(heading))
        .min()
        .unwrap_or(text.len());
    text[..end].trim()
}

/// Renders `messages` as a role-tagged transcript for the summariser. Long
/// messages are cut, harder each round, until the whole fits `budget` tokens.
fn render_transcript(messages: &[ChatMessage], budget: usize) -> String {
    let mut transcript = String::new();
    for message_tokens in [4_000, 2_000, 1_000, 500, 250] {
        transcript = transcript_with(messages, message_tokens);
        if estimate_tokens(&transcript) <= budget {
            return transcript;
        }
    }
    // Below four bytes a token, to stay within the budget for text that is
    // not plain ASCII.
    tools::head_tail(&transcript, budget * 7 / 2)
}

fn transcript_with(messages: &[ChatMessage], message_tokens: usize) -> String {
    let mut output = String::new();
    for message in messages {
        let text = content_to_text(&message.content);
        let text = if is_summary(message) {
            format!("(Summary of what came before)\n{}", summary_body(&text))
        } else {
            // Errors and results tend to sit at the end of a tool output.
            tools::head_tail(text.trim(), message_tokens * 4)
        };
        if text.is_empty() && message.tool_calls.is_none() {
            continue;
        }
        output.push_str(match message.role.as_str() {
            "assistant" => "Assistant: ",
            "tool" => "Tool result: ",
            _ => "User: ",
        });
        output.push_str(&text);
        for call in message
            .tool_calls
            .as_ref()
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let name = call.pointer("/function/name").and_then(Value::as_str);
            let arguments = call.pointer("/function/arguments").and_then(Value::as_str);
            output.push_str(&format!(
                "\n[calls {} {}]",
                name.unwrap_or("tool"),
                truncate_text(arguments.unwrap_or(""), 150)
            ));
        }
        output.push_str("\n\n");
    }
    output
}

/// Whether a provider's error says the request was longer than the model's
/// context window.
fn is_context_overflow(error: &str) -> bool {
    let error = error.to_lowercase();
    [
        "context length",
        "context_length",
        "context window",
        "maximum context",
        "prompt is too long",
        "input is too long",
        "too many tokens",
        "reduce the length",
    ]
    .iter()
    .any(|marker| error.contains(marker))
}

/// Breaks the next request's input tokens into system prompt, history, tool
/// schemas and tool output, next to the room the model's window leaves for
/// input. They are estimates, scaled by how far the provider's count of the
/// last request was from its estimate.
fn context_usage(
    history: &[ChatMessage],
    context_length: i64,
    tool_schemas: &[Value],
    scale: f64,
) -> (i64, i64, i64, i64, i64, i64) {
    let scaled = |tokens: usize| (tokens as f64 * scale) as i64;
    let tool_schema_tokens = schema_tokens(tool_schemas);
    let system_tokens = history.first().map(message_token_estimate).unwrap_or(0);
    let history_tokens: usize = history.iter().skip(1).map(message_token_estimate).sum();
    let tool_output_tokens: usize = history
        .iter()
        .filter(|message| message.role == "tool")
        .map(message_token_estimate)
        .sum();
    let used = system_tokens + history_tokens + tool_schema_tokens;
    let budget = context_token_budget(context_length, 0).unwrap_or(0);
    (
        scaled(used),
        budget as i64,
        scaled(system_tokens),
        scaled(history_tokens),
        scaled(tool_schema_tokens),
        scaled(tool_output_tokens),
    )
}

/// What a prompt of the user's is sent as. Without `show_pictures`, for a
/// model listed as taking none, a picture attached to it is named instead of
/// sent: the chat may have been switched to that model since, and the picture
/// would fail this request and every later one.
fn user_content(
    text: &str,
    attachments: &[Attachment],
    context: &str,
    show_pictures: bool,
) -> Option<Value> {
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
        if attachment.is_image() && !show_pictures {
            parts.push(json!({
                "type": "text",
                "text": format!(
                    "{HARNESS_NOTE} Picture {}: left out, because the model in use does not take pictures.",
                    attachment.name
                )
            }));
        } else if attachment.is_image() {
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

/// What a hook is told about the turn it runs in.
fn hook_scene<'a>(deps: &'a TurnDeps, request: &'a TurnRequest) -> HookScene<'a> {
    HookScene {
        project_root: &request.project_root,
        session_id: &request.session_id,
        conversation_id: &request.conversation_id,
        cancel: &request.cancel,
        broker: &deps.broker,
    }
}

/// Runs a tool call between the user's hooks: one before it can refuse it,
/// and what one after it reports is added to the result.
async fn execute_call(
    deps: &TurnDeps,
    request: &TurnRequest,
    call: &ToolCallRecord,
    sink: &EventSink,
) -> ToolOutcome {
    if request.hooks.is_empty() {
        return run_call(deps, request, call, sink).await;
    }
    // A call whose arguments are not valid is answered by the tool itself.
    let Ok(arguments) = tools::parse_arguments(&call.name, &call.arguments) else {
        return run_call(deps, request, call, sink).await;
    };
    let scene = hook_scene(deps, request);
    if let Some(reason) = request
        .hooks
        .before_tool(&scene, &call.name, &arguments)
        .await
    {
        return ToolOutcome::refused_by_hook(&reason);
    }
    let mut outcome = run_call(deps, request, call, sink).await;
    if let Some(report) = request
        .hooks
        .after_tool(&scene, &call.name, &arguments, &outcome)
        .await
    {
        outcome.result.push_str(&format!(
            "\n\n{HARNESS_NOTE} A hook the user set up reports on this call:\n{report}"
        ));
    }
    outcome
}

async fn run_call(
    deps: &TurnDeps,
    request: &TurnRequest,
    call: &ToolCallRecord,
    sink: &EventSink,
) -> ToolOutcome {
    // Once the user stops the turn, the calls of the batch that have not
    // started do not run: an edit asked for after a command changes nothing
    // when the command is what the user stopped.
    if request.cancel.is_cancelled() {
        return stopped_before_it_ran();
    }
    if !tool_allowed(request, &call.name) {
        return ToolOutcome::error(format!(
            "The {} tool is not available in this mode, so this call was not run.",
            call.name
        ));
    }
    let arguments = match tools::parse_arguments(&call.name, &call.arguments) {
        Ok(arguments) => arguments,
        Err(reason) => return ToolOutcome::error(reason),
    };
    if call.name == "todo" {
        return tools::write_todos(&deps.db, &request.session_id, &arguments);
    }
    let mut runtime = ToolRuntime {
        call_id: call.id.clone(),
        project_root: request.project_root.clone(),
        file_ignore: request.file_ignore.clone(),
        session_id: request.session_id.clone(),
        conversation_id: request.conversation_id.clone(),
        shadow: deps.shadow.clone(),
        processes: deps.processes.clone(),
        files: deps.files.clone(),
        broker: deps.broker.clone(),
        questions: deps.questions.clone(),
        permissions: deps.permissions.clone(),
        http: deps.http.clone(),
        mcp: Some(deps.mcp.clone()),
        skills: request.skills.clone(),
        justification: None,
        vision: takes_pictures(deps, request),
        read_only: request.plan_only || request.read_only,
        cancel: request.cancel.clone(),
        emit: sink.clone(),
    };
    tools::execute(&mut runtime, &call.name, &arguments).await
}

/// What a call gets that had not started when the user stopped the turn.
/// It is answered all the same: a call without an output makes the stored
/// transcript invalid for strict providers.
fn stopped_before_it_ran() -> ToolOutcome {
    let mut outcome = ToolOutcome::cancelled();
    outcome.result = "Tool call cancelled before it ran.".to_string();
    outcome
}

/// Whether the model of this request takes pictures. A model that is not
/// listed is taken not to: a picture it cannot take would fail this request
/// and every later one of the chat.
fn takes_pictures(deps: &TurnDeps, request: &TurnRequest) -> bool {
    pictures(deps, request) == Pictures::Takes
}

/// What the model of a request does with pictures, as far as its listing
/// says.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Pictures {
    Takes,
    /// The model is not listed, as with a server of the user's own.
    Unknown,
    Refuses,
}

fn pictures(deps: &TurnDeps, request: &TurnRequest) -> Pictures {
    match deps.models.iter().find(|model| model.id == request.model) {
        Some(model) if model.supports_vision => Pictures::Takes,
        Some(_) => Pictures::Refuses,
        None => Pictures::Unknown,
    }
}

/// True when a tool call may have touched the workspace, so the live change
/// set is worth recomputing.
fn may_mutate_workspace(name: &str) -> bool {
    !is_read_only_tool(name) && !matches!(name, "question" | "todo")
}

/// The files this session has changed so far, one per line, for a subagent
/// that checks the work. It comes from the snapshots, not from what the
/// agent says it did.
fn changed_files_note(deps: &TurnDeps, request: &TurnRequest) -> String {
    let changes = preview_changes(deps, request).unwrap_or_default();
    if changes.is_empty() {
        return String::new();
    }
    let mut note = String::from("\n\nFiles changed in this chat, as recorded by pumr:");
    for change in changes.iter().take(40) {
        note.push_str(&format!(
            "\n- {} ({}, +{} -{})",
            change.path, change.status, change.additions, change.deletions
        ));
    }
    if changes.len() > 40 {
        note.push_str(&format!("\n- … and {} more", changes.len() - 40));
    }
    note
}

/// Computes this session's change set as it stands mid-turn, without
/// persisting it or advancing the finalize boundary. Lets the changed-files
/// panel update while the agent is still working; `finalize_changes` still
/// freezes the authoritative record at the end of the turn.
fn preview_changes(deps: &TurnDeps, request: &TurnRequest) -> Option<Vec<FileChange>> {
    live_changes(
        &deps.db,
        &deps.shadow,
        &request.session_id,
        &request.base_commit,
        request.resume,
    )
}

/// The change set of `session_id` while its turn, which began at
/// `base_commit`, is still running: the stored record plus what the working
/// tree has gained since. Also answers a change list read mid-turn.
pub(crate) fn live_changes(
    db: &Db,
    shadow: &ShadowRepo,
    session_id: &str,
    base_commit: &str,
    resume: bool,
) -> Option<Vec<FileChange>> {
    let (existing, last_commit) = match db.session_changes_record(session_id) {
        Ok(Some(record)) => record,
        Ok(None) => (Vec::new(), None),
        Err(_) => return None,
    };
    let from = increment_start(shadow, base_commit, resume, last_commit);
    let increment = shadow
        .changes_since(&from)
        .or_else(|_| shadow.changes_since(base_commit))
        .ok()?;
    Some(merge_file_changes(existing, increment))
}

/// The sink a subagent of `session_id` reports through. Whenever the subagent
/// reports its changes, the change set of `session_id` is sent along, so the
/// changed-files panel of the chat follows the subagent's edits instead of
/// waiting for the `task` call to return.
fn with_parent_changes(
    db: Arc<Db>,
    shadow: Arc<ShadowRepo>,
    session_id: String,
    base_commit: String,
    resume: bool,
    sink: EventSink,
) -> EventSink {
    Arc::new(move |routed: RoutedEvent| {
        let changed = matches!(routed.event, StreamEvent::Changes { .. });
        (sink)(routed);
        if !changed {
            return;
        }
        if let Some(changes) = live_changes(&db, &shadow, &session_id, &base_commit, resume) {
            (sink)(RoutedEvent {
                session_id: session_id.clone(),
                event: StreamEvent::Changes { changes },
            });
        }
    })
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
    let from = increment_start(
        &deps.shadow,
        &request.base_commit,
        request.resume,
        last_commit,
    );
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

/// Where this turn's increment starts. A new prompt snapshots the working
/// tree first, so its `base_commit` isolates the turn. When the change record
/// was pinned after that snapshot (a resume, or the change list was read while
/// the turn ran), the record already holds everything up to its boundary, so
/// counting again from `base_commit` would count those changes twice.
fn increment_start(
    shadow: &ShadowRepo,
    base_commit: &str,
    resume: bool,
    last_commit: Option<String>,
) -> String {
    match last_commit {
        Some(last) if resume || shadow.is_ancestor(base_commit, &last) => last,
        _ => base_commit.to_string(),
    }
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
    let parsed = tools::parse_arguments(name, arguments).unwrap_or_else(|_| json!({}));
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
        "bash_output" => parsed
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        "screenshot" => ["caption", "url", "path"]
            .iter()
            .find_map(|key| parsed.get(*key).and_then(Value::as_str))
            .unwrap_or("")
            .to_string(),
        "todo" => {
            let todos: &[Value] = parsed
                .get("todos")
                .and_then(Value::as_array)
                .map_or(&[], Vec::as_slice);
            let with_status = |status: &'static str| {
                todos.iter().filter(move |entry| {
                    entry.get("status").and_then(Value::as_str) == Some(status)
                })
            };
            let progress = format!("{}/{}", with_status("completed").count(), todos.len());
            let current = with_status("in_progress")
                .next()
                .and_then(|entry| entry.get("content").and_then(Value::as_str));
            match current {
                Some(current) => format!("{progress} · {current}"),
                None => progress,
            }
        }
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
    fn bench_history_helpers_scale() {
        // Exercises the hot history path on a large transcript so algorithmic
        // blow-ups (e.g. quadratic trimming) fail this coarse budget.
        let start = std::time::Instant::now();
        let mut history = vec![ChatMessage::text("system", "s".repeat(2_000))];
        for index in 0..2_000 {
            history.push(ChatMessage::text(
                "user",
                format!("message {index} {}", "x".repeat(500)),
            ));
            history.push(ChatMessage::assistant_tool_calls(
                String::new(),
                calls(&["c"]),
            ));
            history.push(ChatMessage::tool_result("c", "y".repeat(2_000)));
        }
        let trimmed = trim_to_budget(history, 128_000, 0);
        assert!(!trimmed.is_empty());
        let sanitized = sanitize(trimmed);
        assert!(!sanitized.is_empty());
        let elapsed = start.elapsed();
        println!("bench_history_helpers_scale: {elapsed:?}");
        assert!(
            elapsed.as_secs() < 5,
            "history helpers regressed: {elapsed:?}"
        );
    }

    fn call(name: &str, arguments: &str) -> ToolCallRecord {
        ToolCallRecord {
            id: "call".to_string(),
            name: name.to_string(),
            arguments: arguments.to_string(),
        }
    }

    fn edited(path: &str) -> ToolOutcome {
        let mut outcome = ToolOutcome::ok(format!("Edited {path}."));
        outcome.changes = vec![change(path, 1, 1, "M")];
        outcome
    }

    #[test]
    fn finishing_with_unchecked_code_is_questioned_once() {
        let checks = vec!["pnpm run test".to_string(), "cargo test".to_string()];
        let mut watch = TurnWatch::default();
        assert_eq!(watch.unchecked_note(&checks), None);

        watch.observe(&call("edit", "{}"), &mut edited("src/a.ts"));
        watch.observe(&call("write", "{}"), &mut edited("README.md"));
        // A project without checks, a subagent or a read-only mode asks nothing.
        assert_eq!(watch.unchecked_note(&[]), None);
        let note = watch.unchecked_note(&checks).expect("a note");
        assert!(note.starts_with("[pumr] You changed src/a.ts and ran nothing afterwards."));
        assert!(note.contains("pnpm run test; cargo test"));
        assert_eq!(watch.unchecked_note(&checks), None, "only once a turn");
    }

    #[test]
    fn a_command_after_the_last_edit_counts_as_a_check() {
        let checks = vec!["cargo test".to_string()];
        let mut watch = TurnWatch::default();
        watch.observe(&call("edit", "{}"), &mut edited("src/a.rs"));
        watch.observe(
            &call("bash", r#"{"command":"cargo test"}"#),
            &mut ToolOutcome::error("Command failed with exit code 101."),
        );
        assert_eq!(watch.unchecked_note(&checks), None);

        // An edit after it is unchecked again; one that failed changed nothing.
        watch.observe(&call("edit", "{}"), &mut ToolOutcome::error("not found"));
        assert_eq!(watch.unchecked_note(&checks), None);
        watch.observe(&call("edit", "{}"), &mut edited("src/b.rs"));
        assert!(watch.unchecked_note(&checks).is_some());

        // Prose asks for no check.
        let mut watch = TurnWatch::default();
        watch.observe(&call("write", "{}"), &mut edited("docs/guide.md"));
        assert_eq!(watch.unchecked_note(&checks), None);
    }

    #[test]
    fn a_call_repeated_with_the_same_result_is_pointed_out() {
        let mut watch = TurnWatch::default();
        let grep = call("grep", r#"{"pattern":"needle"}"#);
        for round in 1..=4 {
            let mut outcome = ToolOutcome::ok("No matches for 'needle'.".to_string());
            watch.observe(&grep, &mut outcome);
            assert_eq!(
                outcome.result.contains("[pumr] You have made this exact call"),
                round >= 3,
                "round {round}"
            );
        }
        // A different result starts the count again.
        let mut outcome = ToolOutcome::ok("src/a.rs:1: needle".to_string());
        watch.observe(&grep, &mut outcome);
        assert!(!outcome.result.contains("[pumr]"));
    }

    #[test]
    fn a_check_run_again_after_a_change_is_no_repeat() {
        /// Whether `call`, coming back with `result`, is told it is a repeat.
        fn noted(watch: &mut TurnWatch, call: &ToolCallRecord, result: &str) -> bool {
            let mut outcome = ToolOutcome::ok(result.to_string());
            watch.observe(call, &mut outcome);
            outcome
                .result
                .contains("[pumr] You have made this exact call")
        }
        let check = call("bash", r#"{"command":"npx tsc --noEmit"}"#);
        let clean = "Command exited with code 0.";

        // Edit, check, edit, check, edit, check: every run tested other code.
        let mut watch = TurnWatch::default();
        for round in 0..3 {
            watch.observe(&call("edit", "{}"), &mut edited("src/a.ts"));
            assert!(!noted(&mut watch, &check, clean), "round {round}");
        }
        // Run twice more with nothing changed in between, it is one.
        assert!(!noted(&mut watch, &check, clean));
        assert!(noted(&mut watch, &check, clean));
        // An edit that failed changed nothing.
        watch.observe(&call("edit", "{}"), &mut ToolOutcome::error("not found"));
        assert!(noted(&mut watch, &check, clean));

        // A command may have changed something as well ...
        let mut watch = TurnWatch::default();
        let grep = call("grep", r#"{"pattern":"needle"}"#);
        let fix = call("bash", r#"{"command":"sed -i s/needle/pin/ src/a.ts"}"#);
        assert!(!noted(&mut watch, &grep, "No matches."));
        assert!(!noted(&mut watch, &grep, "No matches."));
        assert!(!noted(&mut watch, &fix, clean));
        assert!(!noted(&mut watch, &grep, "No matches."));
        assert!(!noted(&mut watch, &grep, "No matches."));
        // ... but not when it is itself a repeat: calls taking turns with
        // the same results are a circle too.
        assert!(!noted(&mut watch, &fix, clean));
        assert!(noted(&mut watch, &grep, "No matches."));
    }

    #[test]
    fn a_run_of_failures_of_one_tool_is_pointed_out() {
        let mut watch = TurnWatch::default();
        let mut notes = Vec::new();
        for round in 0..3 {
            let mut outcome = ToolOutcome::error(format!("old_string was not found ({round})."));
            watch.observe(&call("edit", &format!(r#"{{"old_string":"{round}"}}"#)), &mut outcome);
            notes.push(outcome.result.contains("[pumr] 3 edit calls in a row have failed"));
        }
        assert_eq!(notes, vec![false, false, true]);

        // A success in between ends the run.
        let mut watch = TurnWatch::default();
        for round in 0..4 {
            let mut outcome = if round == 2 {
                ToolOutcome::ok("fine".to_string())
            } else {
                ToolOutcome::error(format!("failed {round}"))
            };
            watch.observe(&call("bash", &format!(r#"{{"command":"{round}"}}"#)), &mut outcome);
            assert!(!outcome.result.contains("[pumr]"));
        }
    }

    #[test]
    fn merge_accumulates_additions_and_keeps_added_status() {
        let merged = merge_file_changes(
            vec![change("src/new.ts", 3, 0, "A")],
            vec![
                change("src/new.ts", 2, 1, "M"),
                change("src/other.ts", 5, 0, "M"),
            ],
        );
        let new_file = merged.iter().find(|c| c.path == "src/new.ts").unwrap();
        assert_eq!(new_file.status, "A");
        assert_eq!((new_file.additions, new_file.deletions), (5, 1));
        assert!(merged.iter().any(|c| c.path == "src/other.ts"));
    }

    #[test]
    fn a_chat_follows_the_changes_its_subagent_reports() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let project_dir = root.join("project");
        std::fs::create_dir_all(&project_dir).unwrap();
        let db = Db::open(&root.join("pumr.sqlite")).unwrap();
        db.migrate().unwrap();
        let db = Arc::new(db);
        let project = db
            .upsert_project(&project_dir.display().to_string())
            .unwrap();
        let chat = db
            .create_session(&project.id, "chat", None, None, None, None, None)
            .unwrap();
        let shadow = Arc::new(ShadowRepo::open(&root, &project.id, &project_dir).unwrap());
        let base = shadow.snapshot("before: prompt").unwrap();

        let events = Arc::new(std::sync::Mutex::new(Vec::<RoutedEvent>::new()));
        let recorded = events.clone();
        let sink = with_parent_changes(
            db.clone(),
            shadow.clone(),
            chat.id.clone(),
            base,
            false,
            Arc::new(move |event| recorded.lock().unwrap().push(event)),
        );
        let changed_paths = |event: &RoutedEvent| match &event.event {
            StreamEvent::Changes { changes } => changes
                .iter()
                .map(|change| change.path.clone())
                .collect::<Vec<_>>(),
            _ => panic!("expected a change set"),
        };

        // Anything but a change set passes through as it is.
        sink(RoutedEvent {
            session_id: "subagent".to_string(),
            event: StreamEvent::Delta {
                text: "working".to_string(),
            },
        });
        assert_eq!(events.lock().unwrap().len(), 1);

        // The subagent edits a file and reports its own change set.
        std::fs::write(project_dir.join("made.txt"), "by the subagent\n").unwrap();
        sink(RoutedEvent {
            session_id: "subagent".to_string(),
            event: StreamEvent::Changes {
                changes: vec![change("made.txt", 1, 0, "A")],
            },
        });
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[1].session_id, "subagent");
        assert_eq!(events[2].session_id, chat.id);
        assert_eq!(changed_paths(&events[2]), ["made.txt"]);
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
            sanitized
                .iter()
                .filter(|message| message.role == "tool")
                .count(),
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

    fn with_seq(mut message: ChatMessage, seq: i64) -> ChatMessage {
        message.seq = Some(seq);
        message
    }


    #[test]
    fn pinned_prompt_goes_back_before_the_work_that_followed_it() {
        let mut history = vec![
            ChatMessage::text("system", "sys"),
            with_seq(
                ChatMessage::assistant_tool_calls("working".into(), calls(&["a"])),
                11,
            ),
            with_seq(ChatMessage::tool_result("a", "result"), 12),
        ];
        place_pinned_prompt(
            &mut history,
            with_seq(ChatMessage::text("user", "task"), 10),
        );
        assert_eq!(history.len(), 4);
        assert_eq!(content_to_text(&history[1].content), "task");
        assert_eq!(history[2].role, "assistant");
    }

    #[test]
    fn pinned_prompt_keeps_its_place_after_older_messages() {
        let mut history = vec![
            ChatMessage::text("system", "sys"),
            with_seq(
                ChatMessage::text("user", "(Summary of earlier conversation)\n..."),
                1,
            ),
            with_seq(ChatMessage::text("assistant", "older answer"), 8),
            with_seq(
                ChatMessage::assistant_tool_calls("working".into(), calls(&["a"])),
                11,
            ),
            with_seq(ChatMessage::tool_result("a", "result"), 12),
        ];
        place_pinned_prompt(
            &mut history,
            with_seq(ChatMessage::text("user", "task"), 10),
        );
        let roles: Vec<&str> = history
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        assert_eq!(
            roles,
            ["system", "user", "assistant", "user", "assistant", "tool"]
        );
        assert_eq!(content_to_text(&history[3].content), "task");
    }

    #[test]
    fn pinned_prompt_goes_last_when_nothing_followed_it() {
        let mut history = vec![
            ChatMessage::text("system", "sys"),
            with_seq(ChatMessage::text("assistant", "older answer"), 3),
        ];
        place_pinned_prompt(&mut history, with_seq(ChatMessage::text("user", "task"), 4));
        assert_eq!(content_to_text(&history[2].content), "task");
    }

    #[test]
    fn a_huge_pinned_prompt_is_cut_to_half_the_budget() {
        let prompt = with_seq(ChatMessage::text("user", "x".repeat(400_000)), 1);
        let budget = context_token_budget(32_000, 0).unwrap();
        let fitted = fit_pinned_prompt(prompt, 32_000, 0);
        assert!(message_token_estimate(&fitted) <= budget / 2 + 4);
        assert_eq!(fitted.seq, Some(1));

        let small = ChatMessage::text("user", "short task");
        let kept = fit_pinned_prompt(small, 32_000, 0);
        assert_eq!(content_to_text(&kept.content), "short task");
    }

    #[test]
    fn trimming_with_the_prompt_reserved_leaves_room_for_it() {
        let budget = context_token_budget(8_000, 0).unwrap();
        let prompt = with_seq(ChatMessage::text("user", "y".repeat(8_000)), 1);
        let reserved = message_token_estimate(&prompt);
        let mut history = vec![ChatMessage::text("system", "sys")];
        for seq in 2..60 {
            history.push(with_seq(
                ChatMessage::text("assistant", "z".repeat(1_000)),
                seq,
            ));
        }
        let mut history = trim_to_budget(history, 8_000, reserved);
        place_pinned_prompt(&mut history, prompt);
        let total: usize = history.iter().map(message_token_estimate).sum();
        assert!(total <= budget, "{total} > {budget}");
        assert_eq!(content_to_text(&history[1].content), "y".repeat(8_000));
    }

    /// A chat in a fresh database.
    fn chat() -> (tempfile::TempDir, Db, String) {
        let temp = tempfile::tempdir().unwrap();
        let db = Db::open(&temp.path().join("pumr.sqlite")).unwrap();
        db.migrate().unwrap();
        let project = db
            .upsert_project(&temp.path().display().to_string())
            .unwrap();
        let session = db
            .create_session(&project.id, "chat", None, None, None, None, None)
            .unwrap();
        (temp, db, session.id)
    }

    fn prompt(db: &Db, session: &str, text: &str) {
        db.append_message(session, NewMessage::user(text, "", None, &[], &[]))
            .unwrap();
    }

    /// One step of a tool loop: an assistant message calling `read`, and the
    /// tool's output.
    fn step(db: &Db, session: &str, call: &str, output: &str) {
        let assistant = db
            .append_message(session, NewMessage::assistant(Some("model"), None))
            .unwrap();
        let calls = [ToolCallRecord {
            id: call.to_string(),
            name: "read".to_string(),
            arguments: "{}".to_string(),
        }];
        db.update_assistant_message(&assistant.id, "", "", 0.0, 0, 0, 0, &calls, &[], 0)
            .unwrap();
        db.append_message(
            session,
            NewMessage::tool(call, "read", output, "ok", &[], 0),
        )
        .unwrap();
    }

    fn history(db: &Db, session: &str) -> Vec<ChatMessage> {
        stored_history(db, session, "sys", false, true, Pictures::Takes).unwrap()
    }

    fn roles(history: &[ChatMessage]) -> Vec<&str> {
        history
            .iter()
            .map(|message| message.role.as_str())
            .collect()
    }

    fn tool_outputs(history: &[ChatMessage]) -> Vec<String> {
        history
            .iter()
            .filter(|message| message.role == "tool")
            .map(|message| content_to_text(&message.content))
            .collect()
    }

    #[test]
    fn the_history_only_grows_at_its_end() {
        // What a provider cached of one request must open the next one.
        let (_temp, db, session) = chat();
        prompt(&db, &session, "fix the bug");
        for index in 0..60 {
            step(&db, &session, &format!("call-{index}"), "file contents");
        }
        let before = history(&db, &session);
        assert_eq!(before.len(), 1 + 1 + 120);

        step(&db, &session, "one-more", "file contents");
        let after = history(&db, &session);
        assert_eq!(after.len(), before.len() + 2);
        assert_eq!(json!(after[..before.len()]), json!(before));
    }

    #[test]
    fn a_checkpoint_stands_in_for_the_messages_it_covers() {
        let (_temp, db, session) = chat();
        prompt(&db, &session, "fix the bug");
        step(&db, &session, "a", "file a");
        step(&db, &session, "b", "file b");
        // Positions: prompt 0, step a 1-2, step b 3-4.
        let marker = db
            .append_checkpoint(&session, "what happened so far", 2, "model", (0.0, 0, 0, 0))
            .unwrap();
        assert_eq!(marker.role, crate::db::COMPACTION_ROLE);

        let compacted = history(&db, &session);
        assert_eq!(roles(&compacted), ["system", "user", "assistant", "tool"]);
        assert!(is_summary(&compacted[1]));
        assert!(content_to_text(&compacted[1].content).ends_with("what happened so far"));
        assert_eq!(tool_outputs(&compacted), ["file b"]);

        // It is stable too: the next step is appended behind it.
        step(&db, &session, "c", "file c");
        let after = history(&db, &session);
        assert_eq!(json!(after[..compacted.len()]), json!(compacted));

        // Reverting to before the checkpoint brings the messages back.
        db.delete_messages_from(&session, marker.seq).unwrap();
        assert_eq!(
            roles(&history(&db, &session)),
            ["system", "user", "assistant", "tool", "assistant", "tool"]
        );
    }

    #[test]
    fn old_tool_output_is_cleared_once_and_then_stays_put() {
        let (_temp, db, session) = chat();
        prompt(&db, &session, "read everything");
        for index in 0..6 {
            // About 2,000 tokens each.
            step(&db, &session, &format!("call-{index}"), &"x".repeat(8_000));
        }
        // Too little to gain: a move must free a tenth of the limit.
        assert!(!clear_old_tool_output(&db, &session, 400_000).unwrap());
        assert!(!tool_outputs(&history(&db, &session)).contains(&CLEARED_OUTPUT.to_string()));

        // With a limit of 12,000 the newest 4,000 tokens of output stay.
        assert!(clear_old_tool_output(&db, &session, 12_000).unwrap());
        let cleared = history(&db, &session);
        let outputs = tool_outputs(&cleared);
        assert_eq!(outputs[..4], [CLEARED_OUTPUT; 4]);
        assert_eq!(outputs[4..], ["x".repeat(8_000), "x".repeat(8_000)]);
        // A later summary is still written from the output as it was.
        let full = stored_history(&db, &session, "sys", false, false, Pictures::Takes).unwrap();
        assert!(!tool_outputs(&full).contains(&CLEARED_OUTPUT.to_string()));

        // Nothing new is old enough, so the cached history stays as it is.
        assert!(!clear_old_tool_output(&db, &session, 12_000).unwrap());
        step(&db, &session, "one-more", &"x".repeat(8_000));
        let after = history(&db, &session);
        assert_eq!(json!(after[..cleared.len()]), json!(cleared));
    }

    #[test]
    fn the_output_of_the_newest_step_is_never_cleared() {
        let (_temp, db, session) = chat();
        prompt(&db, &session, "read everything");
        step(&db, &session, "old", &"o".repeat(40_000));
        // One step that read six files at once, far more than is kept.
        let assistant = db
            .append_message(&session, NewMessage::assistant(Some("model"), None))
            .unwrap();
        let calls: Vec<ToolCallRecord> = (0..6)
            .map(|index| ToolCallRecord {
                id: format!("new-{index}"),
                name: "read".to_string(),
                arguments: "{}".to_string(),
            })
            .collect();
        db.update_assistant_message(&assistant.id, "", "", 0.0, 0, 0, 0, &calls, &[], 0)
            .unwrap();
        for call in &calls {
            db.append_message(
                &session,
                NewMessage::tool(&call.id, "read", &"n".repeat(40_000), "ok", &[], 0),
            )
            .unwrap();
        }

        assert!(clear_old_tool_output(&db, &session, 12_000).unwrap());
        let outputs = tool_outputs(&history(&db, &session));
        assert_eq!(outputs[0], CLEARED_OUTPUT);
        assert!(outputs[1..].iter().all(|output| output.starts_with('n')));
    }

    #[test]
    fn outputs_a_tool_cannot_bring_back_are_not_cleared() {
        let (_temp, db, session) = chat();
        prompt(&db, &session, "go");
        let answer = "The user picked Postgres. ".repeat(100);
        db.append_message(
            &session,
            NewMessage::tool("q", "question", &answer, "ok", &[], 0),
        )
        .unwrap();
        db.append_message(&session, NewMessage::tool("s", "ls", "src/", "ok", &[], 0))
            .unwrap();
        db.set_cleared_upto(&session, i64::MAX).unwrap();
        assert_eq!(
            tool_outputs(&history(&db, &session)),
            [answer.as_str(), "src/"]
        );
    }

    #[test]
    fn a_note_is_sent_as_a_user_message_but_is_no_prompt() {
        let (_temp, db, session) = chat();
        prompt(&db, &session, "fix the parser");
        let answer = db
            .append_message(&session, NewMessage::assistant(None, None))
            .unwrap();
        db.update_assistant_message(&answer.id, "Done.", "", 0.0, 0, 0, 0, &[], &[], 0)
            .unwrap();
        let note = format!("{HARNESS_NOTE} You changed src/a.rs and ran nothing afterwards.");
        db.append_message(
            &session,
            NewMessage {
                role: crate::db::NOTE_ROLE,
                content: &note,
                ..NewMessage::assistant(None, None)
            },
        )
        .unwrap();

        // The model reads it where it was said, in an order every server takes.
        let sent = history(&db, &session);
        assert_eq!(roles(&sent), vec!["system", "user", "assistant", "user"]);
        assert!(is_note(&sent[3]));
        assert!(!is_note(&sent[1]));
        // What the user asked for is still the prompt before it.
        assert_eq!(latest_request(&sent).as_deref(), Some("fix the parser"));
    }

    #[test]
    fn a_screenshot_stays_with_the_chat_and_out_of_the_model_history() {
        let (_temp, db, session) = chat();
        prompt(&db, &session, "restyle the settings page");
        let picture = Attachment {
            id: "picture".to_string(),
            name: "Settings page".to_string(),
            mime_type: "image/png".to_string(),
            size: 3,
            kind: "image".to_string(),
            lines: None,
            data: "AAAA".to_string(),
        };
        db.append_message(
            &session,
            NewMessage {
                attachments: std::slice::from_ref(&picture),
                ..NewMessage::tool("s", "screenshot", "Shown to the user.", "ok", &[], 0)
            },
        )
        .unwrap();

        // The chat shows the picture ...
        let stored = db.list_messages(&session).unwrap();
        assert_eq!(stored.last().unwrap().attachments[0].data, "AAAA");
        // ... and the model is only told that it was shown.
        let sent = history(&db, &session);
        assert_eq!(tool_outputs(&sent), ["Shown to the user."]);
        assert!(sent
            .iter()
            .all(|message| !message.content.to_string().contains("AAAA")));

        // Deleting the chat deletes the picture with its messages.
        db.delete_session(&session).unwrap();
        assert!(db.list_messages(&session).unwrap().is_empty());
    }

    /// One step that reads a text file and a picture in two calls.
    fn picture_step(db: &Db, session: &str) {
        let assistant = db
            .append_message(session, NewMessage::assistant(Some("model"), None))
            .unwrap();
        let calls = ["text", "picture"].map(|id| ToolCallRecord {
            id: id.to_string(),
            name: "read".to_string(),
            arguments: "{}".to_string(),
        });
        db.update_assistant_message(&assistant.id, "", "", 0.0, 0, 0, 0, &calls, &[], 0)
            .unwrap();
        let picture = Attachment {
            id: "picture".to_string(),
            name: "docs/button.png".to_string(),
            mime_type: "image/png".to_string(),
            size: 3,
            kind: "image".to_string(),
            lines: None,
            data: "AAAA".to_string(),
        };
        db.append_message(
            session,
            NewMessage {
                attachments: std::slice::from_ref(&picture),
                ..NewMessage::tool("picture", "read", "docs/button.png is a picture.", "ok", &[], 0)
            },
        )
        .unwrap();
        db.append_message(
            session,
            NewMessage::tool("text", "read", "1\tbutton {}", "ok", &[], 0),
        )
        .unwrap();
    }

    #[test]
    fn a_picture_that_was_read_follows_the_results_of_its_step() {
        let (_temp, db, session) = chat();
        prompt(&db, &session, "why is the button cut off?");
        picture_step(&db, &session);

        // A tool result holds text on every model server, so the picture
        // comes after both results, in a message of its own.
        let sent = history(&db, &session);
        assert_eq!(
            roles(&sent),
            vec!["system", "user", "assistant", "tool", "tool", "user"]
        );
        assert_eq!(
            sent[5].content,
            json!([
                { "type": "text", "text": "[pumr] Picture read from docs/button.png:" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } }
            ])
        );
        // It is the harness speaking, not a new request of the user.
        assert!(is_note(&sent[5]) && is_pictures_note(&sent[5]));
        assert_eq!(
            latest_request(&sent).as_deref(),
            Some("why is the button cut off?")
        );

        // The next step follows it, and what was sent before stays as it was.
        step(&db, &session, "next", "file contents");
        let later = history(&db, &session);
        assert_eq!(roles(&later)[5..], ["user", "assistant", "tool"]);
        assert_eq!(json!(later[..sent.len()]), json!(sent));
    }

    #[test]
    fn a_picture_goes_when_old_tool_output_is_cleared() {
        let (_temp, db, session) = chat();
        prompt(&db, &session, "why is the button cut off?");
        picture_step(&db, &session);
        let stored = db.list_messages(&session).unwrap();
        let picture = stored
            .iter()
            .find(|message| !message.attachments.is_empty())
            .unwrap();
        // Short as its text is, the result is worth clearing for its picture.
        assert!(clearable(picture));
        assert_eq!(
            tool_result_tokens(picture),
            estimate_tokens(&picture.content) + PICTURE_TOKENS
        );

        db.set_cleared_upto(&session, picture.seq).unwrap();
        let sent = history(&db, &session);
        assert_eq!(roles(&sent), vec!["system", "user", "assistant", "tool", "tool"]);
        assert_eq!(tool_outputs(&sent), [CLEARED_OUTPUT, "1\tbutton {}"]);
        assert!(!json!(sent).to_string().contains("AAAA"));
        // The chat still shows it.
        assert_eq!(picture.attachments[0].data, "AAAA");
    }

    #[test]
    fn a_picture_is_named_but_not_sent_to_a_model_that_takes_none() {
        let (_temp, db, session) = chat();
        prompt(&db, &session, "why is the button cut off?");
        picture_step(&db, &session);

        // The chat was switched to such a model after the picture was read.
        let sent = stored_history(&db, &session, "sys", false, true, Pictures::Unknown).unwrap();
        assert_eq!(
            roles(&sent),
            vec!["system", "user", "assistant", "tool", "tool", "user"]
        );
        assert_eq!(
            sent[5].content,
            json!([{
                "type": "text",
                "text": "[pumr] Picture read from docs/button.png: left out, because the model in use does not take pictures."
            }])
        );
        assert!(!json!(sent).to_string().contains("AAAA"));
        // It is still the harness speaking, and stays with its step.
        assert!(is_note(&sent[5]) && is_pictures_note(&sent[5]));

        // Switched back, the model is shown the picture again.
        let shown = json!(history(&db, &session)).to_string();
        assert!(shown.contains("data:image/png;base64,AAAA"));
    }

    #[test]
    fn a_picture_the_user_attached_is_kept_from_a_model_listed_as_taking_none() {
        let (_temp, db, session) = chat();
        let picture = Attachment {
            id: "shot".to_string(),
            name: "shot.png".to_string(),
            mime_type: "image/png".to_string(),
            size: 3,
            kind: "image".to_string(),
            lines: None,
            data: "BBBB".to_string(),
        };
        db.append_message(
            &session,
            NewMessage::user("what is wrong here?", "", None, std::slice::from_ref(&picture), &[]),
        )
        .unwrap();
        let sent = |pictures: Pictures| {
            let history = stored_history(&db, &session, "sys", false, true, pictures).unwrap();
            json!(history).to_string()
        };

        // The chat was switched to such a model after the prompt was sent.
        let named = sent(Pictures::Refuses);
        assert!(!named.contains("BBBB"));
        assert!(named.contains(
            "[pumr] Picture shot.png: left out, because the model in use does not take pictures."
        ));
        assert!(named.contains("what is wrong here?"));
        // A model that is not listed may well take it: the user attached it.
        assert!(sent(Pictures::Unknown).contains("data:image/png;base64,BBBB"));
        assert!(sent(Pictures::Takes).contains("data:image/png;base64,BBBB"));
    }

    #[test]
    fn compacting_keeps_a_picture_with_the_step_that_read_it() {
        let mut note = ChatMessage::parts(
            "user",
            json!([
                { "type": "text", "text": format!("{HARNESS_NOTE} Picture read from a.png:") },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } }
            ]),
        );
        note.seq = Some(2);
        let history = vec![
            ChatMessage::text("system", "sys"),
            with_seq(ChatMessage::text("user", "t".repeat(8_000)), 0),
            with_seq(
                ChatMessage::assistant_tool_calls(String::new(), calls(&["a"])),
                1,
            ),
            with_seq(ChatMessage::tool_result("a", "a.png is a picture."), 2),
            note,
        ];
        // The step is larger than what is kept and stays whole all the same.
        assert_eq!(summary_cut(&history, 100), 2);
    }

    #[test]
    fn compacting_keeps_the_newest_step_whole() {
        let history = vec![
            ChatMessage::text("system", "sys"),
            with_seq(ChatMessage::text("user", "t".repeat(8_000)), 0),
            with_seq(
                ChatMessage::assistant_tool_calls(String::new(), calls(&["a"])),
                1,
            ),
            with_seq(ChatMessage::tool_result("a", "x".repeat(4_000)), 2),
            with_seq(
                ChatMessage::assistant_tool_calls(String::new(), calls(&["b"])),
                3,
            ),
            with_seq(ChatMessage::tool_result("b", "y".repeat(400_000)), 4),
        ];
        // A step larger than what is kept stays all the same, and never
        // starts with the output of a call that was summarised away.
        assert_eq!(summary_cut(&history, 100), 4);
        // With room, the step before it stays too.
        assert_eq!(summary_cut(&history, 102_000), 2);
        assert_eq!(summary_cut(&history, 1_000_000), 1);
        assert_eq!(summary_cut(&history[..1], 100), 1);
    }

    #[test]
    fn the_compaction_limit_follows_the_window_and_the_maximum() {
        let room = 128_000 - 16_384;
        assert_eq!(compaction_limit(128_000, 70, 0), Some(room * 70 / 100));
        assert_eq!(compaction_limit(128_000, 70, 50_000), Some(50_000));
        // A window of a million tokens is not filled to 70%.
        assert_eq!(compaction_limit(1_000_000, 70, 150_000), Some(150_000));
        // An unknown window leaves the maximum alone.
        assert_eq!(compaction_limit(0, 70, 150_000), Some(150_000));
        assert_eq!(compaction_limit(0, 70, 0), None);
        // Switched off, only what no longer fits is compacted.
        assert_eq!(compaction_limit(128_000, 0, 150_000), Some(room));
        assert_eq!(compaction_limit(0, 0, 150_000), None);
    }

    #[test]
    fn the_latest_request_is_kept_word_for_word() {
        let request = ChatMessage::parts(
            "user",
            json!([
                { "type": "text", "text": "# Referenced context\n\nfile body" },
                { "type": "text", "text": "rename the function" },
                { "type": "text", "text": "<file name=\"a.txt\">\nattached\n</file>" }
            ]),
        );
        assert_eq!(
            latest_request(&[request]).as_deref(),
            Some("rename the function")
        );

        // An earlier summary hands on the request it kept.
        let summary = ChatMessage::text(
            "user",
            format!(
                "{SUMMARY_NOTE}\n\n## Goal\nRename it.\n\n{TASKS_HEADING}\n- [ ] rename\n\n{LATEST_REQUEST_HEADING}\nrename the function"
            ),
        );
        assert!(is_summary(&summary));
        assert_eq!(
            latest_request(std::slice::from_ref(&summary)).as_deref(),
            Some("rename the function")
        );
        assert_eq!(
            summary_body(&content_to_text(&summary.content)),
            "## Goal\nRename it."
        );
        assert_eq!(
            latest_request(&[ChatMessage::text("assistant", "hi")]),
            None
        );
    }

    #[test]
    fn the_transcript_for_the_summary_fits_its_budget() {
        let mut messages = vec![ChatMessage::text("user", "find the bug")];
        for index in 0..40 {
            messages.push(ChatMessage::assistant_tool_calls(
                format!("looking at file {index}"),
                calls(&["c"]),
            ));
            messages.push(ChatMessage::tool_result(
                "c",
                "line of code\n".repeat(2_000),
            ));
        }
        let roomy = render_transcript(&messages, 1_000_000);
        assert!(roomy.contains("User: find the bug"));
        assert!(roomy.contains("[calls read {}]"));
        assert!(roomy.contains("looking at file 39"));

        let tight = render_transcript(&messages, 8_000);
        assert!(estimate_tokens(&tight) <= 8_000);
        // The oldest and the newest messages both survive the cut.
        assert!(tight.contains("User: find the bug"));
        assert!(tight.contains("looking at file 39"));
    }

    #[test]
    fn a_window_too_small_for_the_history_keeps_the_latest_prompt() {
        let mut history = vec![
            ChatMessage::text("system", "sys"),
            with_seq(ChatMessage::text("user", "the task"), 0),
        ];
        for seq in 1..60 {
            history.push(with_seq(
                ChatMessage::text("assistant", "z".repeat(1_000)),
                seq,
            ));
        }
        let budget = context_token_budget(8_000, 0).unwrap();
        let fitted = fit_to_window(history.clone(), 8_000, 0);
        assert!(history_tokens(&fitted) <= budget);
        assert_eq!(content_to_text(&fitted[1].content), "the task");
        // A history that fits is left alone.
        assert_eq!(
            fit_to_window(history.clone(), 128_000, 0).len(),
            history.len()
        );
    }

    #[test]
    fn errors_about_the_context_window_are_recognised() {
        for error in [
            "This model's maximum context length is 128000 tokens. However, your messages resulted in 130211 tokens.",
            "prompt is too long: 201833 tokens > 200000 maximum",
            "OpenRouter: context_length_exceeded",
            "Input is too long for requested model.",
        ] {
            assert!(is_context_overflow(error), "{error}");
        }
        assert!(!is_context_overflow("429 Too Many Requests"));
        assert!(!is_context_overflow("invalid api key"));
    }

    #[test]
    fn the_context_meter_counts_the_tool_schemas_into_what_is_used() {
        let history = vec![
            ChatMessage::text("system", "s".repeat(400)),
            ChatMessage::text("user", "u".repeat(800)),
        ];
        let schemas = vec![json!({ "name": "x".repeat(396) })];
        let (used, budget, system, messages, in_schemas, _) =
            context_usage(&history, 128_000, &schemas, 1.0);
        assert_eq!(used, system + messages + in_schemas);
        assert_eq!(budget, 128_000 - 16_384);
        // Scaled by how far the provider's count was from the estimate.
        let (scaled, ..) = context_usage(&history, 128_000, &schemas, 1.5);
        assert_eq!(scaled, used * 3 / 2);
    }

    /// A model server that answers every chat request with `reply` as one
    /// streamed chunk, and hands the request bodies it got to the test.
    fn model_server(reply: &'static str) -> (String, std::sync::mpsc::Receiver<String>) {
        scripted_server(vec![said(reply)])
    }

    /// The stream of a reply that is `text`.
    fn said(text: &str) -> String {
        format!(
            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            json!({ "choices": [{ "delta": { "content": text } }] }),
            json!({ "choices": [], "usage": { "prompt_tokens": 900, "completion_tokens": 40 } }),
        )
    }

    /// The stream of a reply that calls `tool` with `arguments`.
    fn called(tool: &str, arguments: Value) -> String {
        format!(
            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0,
                "id": "call_1",
                "type": "function",
                "function": { "name": tool, "arguments": arguments.to_string() }
            }] } }] }),
            json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] }),
        )
    }

    /// A model server that answers its requests with `replies` in turn (the
    /// last one from then on), and hands the request bodies to the test.
    fn scripted_server(replies: Vec<String>) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};
        let mut replies = replies.into_iter().peekable();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let (requests, received) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                // Read the whole request: its head, then the body it announces.
                let mut request: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 8192];
                let body_start = loop {
                    let Ok(read) = stream.read(&mut chunk) else {
                        break None;
                    };
                    request.extend_from_slice(&chunk[..read]);
                    let head_end = request.windows(4).position(|bytes| bytes == b"\r\n\r\n");
                    if read == 0 || head_end.is_some() {
                        break head_end.map(|end| end + 4);
                    }
                };
                let Some(body_start) = body_start else {
                    continue;
                };
                let head = String::from_utf8_lossy(&request[..body_start]).to_lowercase();
                let length: usize = head
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|value| value.trim().parse().ok())
                    .unwrap_or(0);
                while request.len() < body_start + length {
                    match stream.read(&mut chunk) {
                        Ok(read) if read > 0 => request.extend_from_slice(&chunk[..read]),
                        _ => break,
                    }
                }
                let _ = requests.send(String::from_utf8_lossy(&request[body_start..]).to_string());

                let events = match replies.next() {
                    Some(events) if replies.peek().is_some() => events,
                    Some(last) => {
                        replies = vec![last.clone()].into_iter().peekable();
                        last
                    }
                    None => String::new(),
                };
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{events}",
                        events.len()
                    )
                    .as_bytes(),
                );
            }
        });
        (url, received)
    }

    /// A client whose `ollama:` models are served from `base_url`, without a key.
    fn local_client(base_url: &str) -> LlmClient {
        let mut settings = crate::config::ModelSettings::default();
        settings.providers.insert(
            "ollama".to_string(),
            crate::config::ProviderSettings {
                base_url: base_url.to_string(),
                ..Default::default()
            },
        );
        LlmClient {
            http: reqwest::Client::new(),
            settings,
            keys: crate::providers::ProviderKeys::with(&[]),
            anthropic_caps: Default::default(),
            direct_meta: Default::default(),
            quirks: Default::default(),
            in_flight: Default::default(),
        }
    }

    /// What a turn of the chat in `db` takes, with its model served from
    /// `base_url` and the project in `root`.
    fn turn(
        db: Db,
        session: &str,
        root: &Path,
        base_url: &str,
        hooks: Vec<crate::config::Hook>,
    ) -> (TurnDeps, TurnRequest) {
        let shadow = ShadowRepo::open(&root.join(".app-data"), "project", root).unwrap();
        let request = TurnRequest {
            model: "ollama:test".to_string(),
            reasoning_effort: None,
            provider: None,
            system_prompt: "sys".to_string(),
            session_id: session.to_string(),
            conversation_id: session.to_string(),
            project_id: "project".to_string(),
            depth: 0,
            project_root: root.to_path_buf(),
            extra_folders: Vec::new(),
            file_ignore: Default::default(),
            context_length: 64_000,
            auto_compact_threshold: 70,
            auto_compact_max_tokens: 0,
            max_tool_iterations: 10,
            auto_continue: false,
            fallback_pricing: None,
            base_commit: shadow.snapshot("start").unwrap(),
            resume: false,
            plan_only: false,
            read_only: false,
            mcp_progressive_disclosure: false,
            skills: Vec::new(),
            prompt_caching: false,
            subagent_model: "ollama:test".to_string(),
            compaction_model: "ollama:test".to_string(),
            completion_checks: Vec::new(),
            hooks: Hooks::for_project(&hooks, root),
            cancel: CancellationToken::new(),
        };
        let deps = TurnDeps {
            db: Arc::new(db),
            shadow: Arc::new(shadow),
            processes: Arc::new(ProcessRegistry::new()),
            files: Default::default(),
            broker: Arc::new(PermissionBroker::new()),
            questions: Arc::new(QuestionBroker::new()),
            model_choices: Arc::new(ModelChoiceBroker::new()),
            models: Default::default(),
            permissions: Arc::new(LivePermissions::new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Default::default(),
            )),
            client: local_client(base_url),
            http: reqwest::Client::new(),
            mcp: Arc::new(McpManager::empty()),
        };
        (deps, request)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn hooks_refuse_a_call_and_hold_the_agent_at_the_end_of_the_turn() {
        let (temp, db, session) = chat();
        let root = temp.path().canonicalize().unwrap().join("project");
        std::fs::create_dir_all(&root).unwrap();
        prompt(&db, &session, "publish the branch");
        let hook = |event: &str, command: &str| crate::config::Hook {
            event: event.to_string(),
            command: command.to_string(),
            ..Default::default()
        };
        let hooks = vec![
            hook(
                crate::hooks::BEFORE_TOOL,
                "grep -q forced && { echo 'No forced pushes here.' >&2; exit 2; }; exit 0",
            ),
            hook(
                crate::hooks::TURN_END,
                r#"grep -q '"stop_hook_active":false' && { echo 'de.json lacks chat.send'; exit 2; }; exit 0"#,
            ),
        ];
        let (base_url, requests) = scripted_server(vec![
            called("bash", json!({ "command": "touch forced.txt" })),
            said("Published."),
            said("Added the key."),
        ]);
        let (deps, request) = turn(db, &session, &root, &base_url, hooks);

        let result = run_turn(&deps, request, Arc::new(|_: RoutedEvent| {}))
            .await
            .unwrap();
        assert_eq!(result.error, None);
        assert_eq!(result.message.content, "Added the key.");

        // The command never ran, and the agent was told who refused it.
        assert!(!root.join("forced.txt").exists());
        let sent: Vec<String> = requests.try_iter().collect();
        assert_eq!(sent.len(), 3);
        assert!(sent[1].contains("A hook the user set up refused this call:\\nNo forced pushes here."));
        // Its first answer was held back by the hook for the end of the
        // turn, once: the second one ended the turn.
        assert!(!sent[1].contains("de.json lacks chat.send"));
        assert!(sent[2].contains(
            "[pumr] A hook the user set up for the end of a turn reports:\\nde.json lacks chat.send"
        ));
        let stored = deps.db.list_messages(&session).unwrap();
        let roles: Vec<&str> = stored.iter().map(|message| message.role.as_str()).collect();
        assert_eq!(
            roles,
            ["user", "assistant", "tool", "assistant", crate::db::NOTE_ROLE, "assistant"]
        );
        assert_eq!(stored[2].status.as_deref(), Some("denied"));
    }

    /// The project folder of the chat in `temp`, as `turn` takes it.
    fn project(temp: &tempfile::TempDir) -> PathBuf {
        let root = temp.path().canonicalize().unwrap().join("project");
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// The stored tool results of a chat: call id, status and text.
    fn tool_results(db: &Db, session: &str) -> Vec<(String, String, String)> {
        db.list_messages(session)
            .unwrap()
            .into_iter()
            .filter(|message| message.role == "tool")
            .map(|message| {
                (
                    message.tool_call_id.unwrap_or_default(),
                    message.status.unwrap_or_default(),
                    message.content,
                )
            })
            .collect()
    }

    #[tokio::test]
    async fn a_tool_the_mode_leaves_out_is_refused_when_the_model_calls_it_all_the_same() {
        // Planning, then read-only. The chat's earlier turns, in a coding
        // mode, show the model calls it is no longer offered.
        for (plan_only, read_only) in [(true, false), (false, true)] {
            let (temp, db, session) = chat();
            let root = project(&temp);
            std::fs::write(root.join("a.txt"), "before\n").unwrap();
            prompt(&db, &session, "rename it");
            let mut replies = vec![
                called(
                    "edit",
                    json!({ "path": "a.txt", "old_string": "before", "new_string": "after" }),
                ),
                called("write", json!({ "path": "new.txt", "content": "made\n" })),
            ];
            let mut refused = vec!["edit", "write"];
            if plan_only {
                replies.push(called("bash", json!({ "command": "ls" })));
                refused.push("bash");
            }
            replies.push(said("That takes another mode."));
            let (base_url, _requests) = scripted_server(replies);
            let (deps, mut request) = turn(db, &session, &root, &base_url, Vec::new());
            request.plan_only = plan_only;
            request.read_only = read_only;

            // What is offered and what is run are decided as one.
            let offered = build_tool_schemas(&deps, &request);
            let offered: Vec<&str> = offered
                .iter()
                .filter_map(|schema| schema.pointer("/function/name")?.as_str())
                .collect();
            let built_in = "read write edit bash bash_output task question";
            for name in built_in.split(' ') {
                let allowed = tool_allowed(&request, name);
                assert_eq!(offered.contains(&name), allowed, "{name}");
            }
            assert!(refused.iter().all(|name| !offered.contains(name)));
            // An MCP tool is offered in every mode, and so it runs in every mode.
            assert!(tool_allowed(&request, "mcp__files__write_file"));
            assert!(tool_allowed(&request, "mcp_invoke"));

            let result = run_turn(&deps, request, Arc::new(|_: RoutedEvent| {}))
                .await
                .unwrap();
            assert_eq!(result.message.content, "That takes another mode.");

            // Nothing was changed or run, and the model was told why.
            assert_eq!(
                std::fs::read_to_string(root.join("a.txt")).unwrap(),
                "before\n"
            );
            assert!(!root.join("new.txt").exists());
            let results = tool_results(&deps.db, &session);
            assert_eq!(results.len(), refused.len());
            for (name, (_, status, result)) in refused.iter().zip(&results) {
                assert_eq!(status, "error");
                let told = "tool is not available in this mode, so this call was not run.";
                assert_eq!(result, &format!("The {name} {told}"));
            }
        }
    }

    #[tokio::test]
    async fn a_subagent_can_neither_delegate_nor_ask_the_user() {
        let (temp, db, session) = chat();
        let root = project(&temp);
        let (deps, mut request) = turn(db, &session, &root, "http://127.0.0.1:9/v1", Vec::new());
        request.depth = MAX_SUBAGENT_DEPTH;
        // Were the question asked all the same, it would be skipped here
        // rather than waited on, and the test would fail.
        let cancel = request.cancel.clone();
        let sink: EventSink = Arc::new(move |event: RoutedEvent| {
            if matches!(event.event, StreamEvent::QuestionRequest { .. }) {
                cancel.cancel();
            }
        });

        let asked = call("question", r#"{"questions":[{"question":"Which name?"}]}"#);
        let outcome = run_call(&deps, &request, &asked, &sink).await;
        assert_eq!(outcome.status, "error");
        assert!(outcome.result.starts_with("The question tool is not"));
        let outcome = run_subagent(
            &deps,
            &request,
            json!({ "prompt": "look around" }),
            request.model.clone(),
            sink,
        )
        .await;
        assert_eq!(outcome.result, "Subagents cannot spawn further subagents.");
    }

    #[tokio::test]
    async fn stopping_the_turn_keeps_the_rest_of_a_batch_from_running() {
        let (temp, db, session) = chat();
        let root = project(&temp);
        let (deps, request) = turn(db, &session, &root, "http://127.0.0.1:9/v1", Vec::new());
        // The first call asks the user something; they press Stop instead.
        let cancel = request.cancel.clone();
        let sink: EventSink = Arc::new(move |event: RoutedEvent| {
            if matches!(event.event, StreamEvent::QuestionRequest { .. }) {
                cancel.cancel();
            }
        });
        let batch = [
            ToolCallRecord {
                id: "ask".to_string(),
                name: "question".to_string(),
                arguments: r#"{"questions":[{"question":"Which name?"}]}"#.to_string(),
            },
            ToolCallRecord {
                id: "make".to_string(),
                name: "write".to_string(),
                arguments: r#"{"path":"made.txt","content":"made\n"}"#.to_string(),
            },
        ];

        let stopped = execute_tool_calls(
            &deps,
            &request,
            &sink,
            &batch,
            &|_: StreamEvent| {},
            &mut TurnWatch::default(),
        )
        .await
        .unwrap();
        assert!(stopped);

        // The file was never written, and both calls have their outcome.
        assert!(!root.join("made.txt").exists());
        let results = tool_results(&deps.db, &session);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].0, "ask");
        assert_eq!(
            results[1],
            (
                "make".to_string(),
                "canceled".to_string(),
                "Tool call cancelled before it ran.".to_string()
            )
        );

        // A subagent is not started after it either.
        let outcome = run_subagent(
            &deps,
            &request,
            json!({ "prompt": "look around" }),
            request.model.clone(),
            sink,
        )
        .await;
        assert_eq!(outcome.status, "canceled");
    }

    #[tokio::test]
    async fn arguments_that_are_no_json_object_go_back_to_the_model_as_an_empty_one() {
        let (temp, db, session) = chat();
        let root = project(&temp);
        prompt(&db, &session, "write the parser");
        let cut_off = r#"{"path":"src/parser.rs","content":"fn pa"#;
        let calls = [
            ("whole", r#"{"path": "src/lexer.rs"}"#),
            // The output limit ended the reply in the middle of the call.
            ("cut", cut_off),
            // Some servers send this for a call without arguments.
            ("none", ""),
            // Run as the object inside (see `tools::parse_arguments`).
            ("twice", r#""{\"path\":\"src/a.rs\"}""#),
        ]
        .map(|(id, arguments)| ToolCallRecord {
            id: id.to_string(),
            name: "read".to_string(),
            arguments: arguments.to_string(),
        });
        let assistant = db
            .append_message(&session, NewMessage::assistant(Some("model"), None))
            .unwrap();
        db.update_assistant_message(&assistant.id, "", "", 0.0, 0, 0, 0, &calls, &[], 0)
            .unwrap();
        for call in &calls {
            db.append_message(
                &session,
                NewMessage::tool(&call.id, "read", "result", "ok", &[], 0),
            )
            .unwrap();
        }

        let (base_url, requests) = model_server("Done.");
        let (deps, request) = turn(db, &session, &root, &base_url, Vec::new());
        run_turn(&deps, request, Arc::new(|_: RoutedEvent| {}))
            .await
            .unwrap();

        let body: Value = serde_json::from_str(&requests.recv().unwrap()).unwrap();
        let sent: Vec<&str> = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|message| message["tool_calls"].as_array())
            .flatten()
            .filter_map(|call| call.pointer("/function/arguments")?.as_str())
            .collect();
        assert_eq!(
            sent,
            [
                r#"{"path": "src/lexer.rs"}"#,
                "{}",
                "{}",
                r#"{"path":"src/a.rs"}"#
            ]
        );
        // What is stored, and so what the chat shows, is what the model sent.
        let stored = deps.db.list_messages(&session).unwrap();
        assert_eq!(stored[1].tool_calls[1].arguments, cut_off);
    }

    #[tokio::test]
    async fn only_a_model_listed_as_taking_pictures_is_sent_the_ones_a_tool_read() {
        for vision in [false, true] {
            let (temp, db, session) = chat();
            let root = project(&temp);
            prompt(&db, &session, "why is the button cut off?");
            picture_step(&db, &session);
            let (base_url, requests) = model_server("It is clipped.");
            let (mut deps, request) = turn(db, &session, &root, &base_url, Vec::new());
            // A model that is not listed at all is taken not to take any.
            if vision {
                deps.models = Arc::new(vec![ModelInfo {
                    id: request.model.clone(),
                    name: "Test".to_string(),
                    description: String::new(),
                    context_length: 64_000,
                    prompt_price_per_m: 0.0,
                    completion_price_per_m: 0.0,
                    cache_read_price_per_m: 0.0,
                    supports_reasoning: false,
                    supports_vision: true,
                    supports_tools: true,
                    input_modalities: Vec::new(),
                    supported_parameters: Vec::new(),
                    created: 0,
                    source: "ollama".to_string(),
                }]);
            }
            run_turn(&deps, request, Arc::new(|_: RoutedEvent| {}))
                .await
                .unwrap();

            let sent = requests.recv().unwrap();
            assert_eq!(sent.contains("data:image/png;base64,AAAA"), vision);
            assert_eq!(
                sent.contains("left out, because the model in use does not take pictures"),
                !vision
            );
        }
    }

    #[tokio::test]
    async fn compacting_stores_a_summary_that_the_next_request_starts_from() {
        let (_temp, db, session) = chat();
        prompt(
            &db,
            &session,
            "find out why the parser drops the last token",
        );
        for index in 0..5 {
            step(
                &db,
                &session,
                &format!("call-{index}"),
                &format!("contents of file {index}\n{}", "code\n".repeat(2_000)),
            );
        }
        db.set_session_todos(
            &session,
            r#"[{"content":"Read the parser","status":"completed"},{"content":"Fix it","status":"in_progress"}]"#,
        )
        .unwrap();
        // Old output is already cleared for the model; the summary still reads it.
        assert!(clear_old_tool_output(&db, &session, 12_000).unwrap());

        let (base_url, requests) = model_server("## Goal\nFind the dropped token.");
        let client = local_client(&base_url);
        let cancel = CancellationToken::new();
        let compactor = Compactor {
            db: &db,
            client: &client,
            session_id: &session,
            model: "ollama:test",
            context_length: 64_000,
            fallback_pricing: None,
            cancel: &cancel,
        };

        let Compaction::Done { message, usage } = compact_now(&compactor).await.unwrap() else {
            panic!("expected a checkpoint");
        };
        assert_eq!(message.role, crate::db::COMPACTION_ROLE);
        assert_eq!((usage.prompt_tokens, usage.completion_tokens), (900, 40));
        assert_eq!(message.prompt_tokens, 900);

        // The summariser was sent the conversation, old tool output included.
        let sent = requests.recv().unwrap();
        assert!(sent.contains("find out why the parser drops the last token"));
        assert!(sent.contains("contents of file 0"));
        assert!(!sent.contains(CLEARED_OUTPUT));

        // The model's summary, then the task list and the request as written.
        assert_eq!(
            message.content,
            format!(
                "## Goal\nFind the dropped token.\n\n{TASKS_HEADING}\n- [x] Read the parser\n- [ ] Fix it (in progress)\n\n{LATEST_REQUEST_HEADING}\nfind out why the parser drops the last token"
            )
        );

        // The next request starts from it, with only the newest step in full.
        let after = history(&db, &session);
        assert_eq!(roles(&after), ["system", "user", "assistant", "tool"]);
        assert!(is_summary(&after[1]));
        assert!(content_to_text(&after[1].content).contains("Find the dropped token."));
        assert!(tool_outputs(&after)[0].starts_with("contents of file 4"));
        assert!(stored_tokens(&db, &session).unwrap() < 12_000);

        // With nothing new since, there is nothing to compact again.
        assert!(matches!(
            compact_now(&compactor).await.unwrap(),
            Compaction::Skipped
        ));
        // A second compaction later carries the request over from the first.
        for index in 5..8 {
            step(
                &db,
                &session,
                &format!("call-{index}"),
                &"more\n".repeat(2_000),
            );
        }
        let Compaction::Done { message, .. } = compact_now(&compactor).await.unwrap() else {
            panic!("expected a second checkpoint");
        };
        assert!(message
            .content
            .ends_with("find out why the parser drops the last token"));
        let resent = requests.recv().unwrap();
        assert!(resent.contains("(Summary of what came before)"));
        assert!(!resent.contains(LATEST_REQUEST_HEADING));
    }
}
