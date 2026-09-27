//! Direct access to Claude through the Anthropic Messages API with the user's
//! own key. The agent speaks OpenAI-style chat messages (the format OpenRouter
//! uses); this module converts them into Messages API requests and turns the
//! event stream back into the provider-neutral chunks.

use super::{
    cancelled_outcome, parse_retry_after, retryable_reqwest, retryable_status, take_line,
    wait_backoff, ChatChunk, ChatMessage, ChatOutcome, ChatUsage, ReasoningSetting,
    MAX_STREAM_RETRIES,
};
use crate::error::{AppError, Result};
use crate::models::{ModelInfo, ToolCallRecord};
use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const API_VERSION: &str = "2023-06-01";
/// Lets a request replay thinking blocks with `drop_block`, so an edited
/// history (trimming, compaction) degrades to "no earlier reasoning" instead of
/// failing the request.
const THINKING_BINDING_BETA: &str = "thinking-binding-controls-2026-08-01";
/// Output cap per request; streaming keeps long outputs clear of timeouts.
const MAX_OUTPUT_TOKENS: i64 = 64_000;
const FALLBACK_OUTPUT_TOKENS: i64 = 32_000;
const FALLBACK_CONTEXT_TOKENS: i64 = 200_000;
/// A 5-minute prompt-cache write costs 1.25x the base input price.
const CACHE_WRITE_MULTIPLIER: f64 = 1.25;
const EFFORT_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// What a model accepts, from the Models API `capabilities` tree.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelCaps {
    pub context_length: i64,
    pub max_output_tokens: i64,
    pub vision: bool,
    pub pdf: bool,
    /// `thinking: {type: "adaptive"}` (Claude 4.6 and later).
    pub adaptive_thinking: bool,
    /// `thinking: {type: "enabled", budget_tokens}` (older models).
    pub budget_thinking: bool,
    /// Supported `output_config.effort` levels, empty when effort is unsupported.
    pub effort_levels: Vec<String>,
}

pub type CapsCache = Arc<Mutex<HashMap<String, ModelCaps>>>;

#[derive(Clone)]
pub struct AnthropicClient {
    http: reqwest::Client,
    base_url: String,
    caps: CapsCache,
    /// Id of the provider served: Anthropic, or one with an
    /// Anthropic-compatible API (MiniMax, ...). Prefixes its model ids.
    provider: &'static str,
}

impl AnthropicClient {
    pub fn new(http: reqwest::Client, base_url: impl Into<String>, caps: CapsCache) -> Self {
        let base_url = base_url.into();
        let trimmed = base_url.trim().trim_end_matches('/');
        // Accept both the SDK convention (no version) and a pasted `/v1` URL.
        let trimmed = trimmed.strip_suffix("/v1").unwrap_or(trimmed);
        let base_url = if trimmed.is_empty() {
            DEFAULT_BASE_URL.to_string()
        } else {
            trimmed.to_string()
        };
        Self {
            http,
            base_url,
            caps,
            provider: super::catalog::ANTHROPIC,
        }
    }

    /// Serves another provider's Anthropic-compatible API.
    pub fn for_provider(mut self, provider: &'static str) -> Self {
        self.provider = provider;
        self
    }

    fn caps_key(&self, model: &str) -> String {
        format!("{}:{model}", self.provider)
    }

    fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        api_key: &str,
    ) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{}", self.base_url, path))
            .header("x-api-key", api_key)
            .header("anthropic-version", API_VERSION)
    }

    async fn get_json(&self, path: &str, api_key: &str) -> Result<Value> {
        let response = self
            .request(reqwest::Method::GET, path, api_key)
            .send()
            .await?;
        let status = response.status();
        let body = response.text().await?;
        if !status.is_success() {
            return Err(anthropic_error(status.as_u16(), &body));
        }
        serde_json::from_str(&body)
            .map_err(|err| AppError::msg(format!("invalid Anthropic response: {err}")))
    }

    /// Lists the models this key can use, as `anthropic:`-prefixed entries.
    pub async fn list_models(&self, api_key: &str) -> Result<Vec<ModelInfo>> {
        let mut raw_models: Vec<Value> = Vec::new();
        let mut after: Option<String> = None;
        // The endpoint pages; a handful of pages covers every Claude model.
        for _ in 0..10 {
            let path = match &after {
                Some(id) => format!("/v1/models?limit=1000&after_id={id}"),
                None => "/v1/models?limit=1000".to_string(),
            };
            let page = self.get_json(&path, api_key).await?;
            let data = page
                .get("data")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            raw_models.extend(data);
            let has_more = page.get("has_more").and_then(Value::as_bool) == Some(true);
            after = page
                .get("last_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            if !has_more || after.is_none() {
                break;
            }
        }

        let mut models = Vec::with_capacity(raw_models.len());
        let mut caps_cache = self.caps.lock().unwrap();
        for raw in &raw_models {
            let Some(id) = raw.get("id").and_then(Value::as_str) else {
                continue;
            };
            let caps = parse_caps(id, raw);
            caps_cache.insert(self.caps_key(id), caps.clone());
            models.push(model_info(self.provider, id, raw, &caps));
        }
        Ok(models)
    }

    /// Capabilities of `model`, from the listing cache or the Models API, with
    /// a conservative guess when neither is available.
    async fn caps(&self, api_key: &str, model: &str) -> ModelCaps {
        if let Some(caps) = self
            .caps
            .lock()
            .unwrap()
            .get(&self.caps_key(model))
            .cloned()
        {
            return caps;
        }
        let caps = match self.get_json(&format!("/v1/models/{model}"), api_key).await {
            Ok(raw) => parse_caps(model, &raw),
            Err(_) => fallback_caps(model),
        };
        self.caps
            .lock()
            .unwrap()
            .insert(self.caps_key(model), caps.clone());
        caps
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn stream_chat(
        &self,
        api_key: &str,
        model: &str,
        messages: Vec<ChatMessage>,
        reasoning: Option<ReasoningSetting>,
        tools: &[Value],
        prompt_caching: bool,
        price_hint: Option<super::Pricing>,
        cancel: CancellationToken,
        on_chunk: &mut (dyn FnMut(ChatChunk) + Send),
    ) -> Result<ChatOutcome> {
        let caps = tokio::select! {
            _ = cancel.cancelled() => return Ok(cancelled_outcome()),
            caps = self.caps(api_key, model) => caps,
        };
        let plan = RequestPlan::new(&caps, reasoning.as_ref());
        // Prices of models this table does not know (other providers' models
        // on an Anthropic-compatible API) come from their model list.
        let pricing = pricing(model).or(price_hint.map(|price| Pricing {
            input: price.prompt * 1_000_000.0,
            output: price.completion * 1_000_000.0,
            cache_read: price.cache_read * 1_000_000.0,
        }));

        // A request that replays thinking blocks can be refused when the
        // history no longer matches them (or a gateway rejects the controls);
        // it is then retried once without any earlier reasoning.
        let mut lenient = false;
        let mut attempt = 0usize;
        'attempt: loop {
            attempt += 1;
            let (body, uses_binding) =
                build_request(model, &messages, &plan, tools, prompt_caching, lenient);
            let mut request = self
                .request(reqwest::Method::POST, "/v1/messages", api_key)
                .json(&body);
            if uses_binding {
                request = request.header("anthropic-beta", THINKING_BINDING_BETA);
            }
            let response = tokio::select! {
                _ = cancel.cancelled() => return Ok(cancelled_outcome()),
                response = request.send() => response,
            };
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    if retryable_reqwest(&error) && attempt <= MAX_STREAM_RETRIES {
                        if wait_backoff(attempt, None, &cancel).await {
                            continue;
                        }
                        return Ok(cancelled_outcome());
                    }
                    return Err(error.into());
                }
            };

            let status = response.status();
            if !status.is_success() {
                let status_code = status.as_u16();
                let retry_after = parse_retry_after(response.headers());
                let body_text = tokio::select! {
                    _ = cancel.cancelled() => return Ok(cancelled_outcome()),
                    text = response.text() => text.unwrap_or_default(),
                };
                if status_code == 400
                    && !lenient
                    && plan.thinking.is_some()
                    && mentions_thinking(&body_text)
                {
                    lenient = true;
                    continue;
                }
                if retryable_status(status_code) && attempt <= MAX_STREAM_RETRIES {
                    if wait_backoff(attempt, retry_after, &cancel).await {
                        continue;
                    }
                    return Ok(cancelled_outcome());
                }
                return Err(anthropic_error(status_code, &body_text));
            }

            let mut stream_state = StreamState::new(pricing);
            let mut buffer: Vec<u8> = Vec::new();
            let mut cancelled = false;
            let mut stream = response.bytes_stream();

            loop {
                let next = tokio::select! {
                    _ = cancel.cancelled() => {
                        cancelled = true;
                        break;
                    }
                    chunk = stream.next() => chunk,
                };
                let Some(chunk) = next else { break };
                let bytes = match chunk {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        // A stream that already delivered content cannot be
                        // safely replayed, so only a clean failure is retried.
                        if !stream_state.emitted
                            && retryable_reqwest(&error)
                            && attempt <= MAX_STREAM_RETRIES
                        {
                            if wait_backoff(attempt, None, &cancel).await {
                                continue 'attempt;
                            }
                            return Ok(cancelled_outcome());
                        }
                        return Err(error.into());
                    }
                };
                buffer.extend_from_slice(&bytes);
                while let Some(line) = take_line(&mut buffer) {
                    let Some(data) = line.strip_prefix("data:") else {
                        continue;
                    };
                    let Ok(event) = serde_json::from_str::<Value>(data.trim()) else {
                        continue;
                    };
                    match stream_state.apply(&event, on_chunk) {
                        StreamStep::Continue => {}
                        StreamStep::Failed(error) => {
                            if !stream_state.emitted
                                && error.retryable
                                && attempt <= MAX_STREAM_RETRIES
                            {
                                if wait_backoff(attempt, None, &cancel).await {
                                    continue 'attempt;
                                }
                                return Ok(cancelled_outcome());
                            }
                            return Err(AppError::msg(format!(
                                "Anthropic error: {}",
                                error.message
                            )));
                        }
                    }
                }
            }

            if !cancelled {
                if let Some(message) = stop_reason_error(stream_state.stop_reason.as_deref()) {
                    return Err(AppError::msg(message));
                }
            }
            return Ok(stream_state.finish(cancelled));
        }
    }
}

/// How a request is shaped for one model and reasoning setting.
#[derive(Debug, Clone, PartialEq)]
struct RequestPlan {
    max_tokens: i64,
    thinking: Option<Thinking>,
    effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
enum Thinking {
    Adaptive,
    Budget(i64),
}

impl RequestPlan {
    fn new(caps: &ModelCaps, reasoning: Option<&ReasoningSetting>) -> Self {
        let max_tokens = if caps.max_output_tokens > 0 {
            caps.max_output_tokens.clamp(1_024, MAX_OUTPUT_TOKENS)
        } else {
            FALLBACK_OUTPUT_TOKENS
        };
        let supports = |level: &str| caps.effort_levels.iter().any(|entry| entry == level);
        let mut plan = Self {
            max_tokens,
            thinking: None,
            effort: None,
        };
        match reasoning {
            // Adaptive thinking decides by itself how much to think.
            None => {
                if caps.adaptive_thinking {
                    plan.thinking = Some(Thinking::Adaptive);
                }
            }
            // Leave thinking unset (off on models where that is possible) and
            // lower the effort: disabling it outright is rejected by some
            // models and makes others write tool calls as text.
            Some(ReasoningSetting::Off) => {
                if supports("low") {
                    plan.effort = Some("low".to_string());
                }
            }
            Some(ReasoningSetting::Effort(level)) => {
                let level = match level.as_str() {
                    "minimal" => "low",
                    other => other,
                };
                if caps.adaptive_thinking {
                    plan.thinking = Some(Thinking::Adaptive);
                    if supports(level) {
                        plan.effort = Some(level.to_string());
                    }
                } else if caps.budget_thinking {
                    let budget = match level {
                        "low" => 2_048,
                        "medium" => 8_192,
                        _ => 16_384,
                    };
                    plan.thinking = Some(Thinking::Budget(budget));
                }
            }
            Some(ReasoningSetting::MaxTokens(tokens)) => {
                if caps.budget_thinking {
                    plan.thinking = Some(Thinking::Budget(*tokens));
                } else if caps.adaptive_thinking {
                    plan.thinking = Some(Thinking::Adaptive);
                }
            }
        }
        if let Some(Thinking::Budget(budget)) = plan.thinking {
            // The budget must stay below max_tokens and at or above 1024.
            let budget = budget.clamp(1_024, (plan.max_tokens - 1_024).max(1_024));
            plan.max_tokens = plan.max_tokens.max(budget + 1_024);
            plan.thinking = Some(Thinking::Budget(budget));
        }
        plan
    }
}

/// Builds the Messages API body. `lenient` drops everything a history mismatch
/// can be refused for: replayed thinking, the binding controls and `display`.
/// Returns the body and whether it needs the thinking-binding beta header.
fn build_request(
    model: &str,
    messages: &[ChatMessage],
    plan: &RequestPlan,
    tools: &[Value],
    prompt_caching: bool,
    lenient: bool,
) -> (Value, bool) {
    let replay_thinking = plan.thinking.is_some() && !lenient;
    let (system, converted) = convert_messages(messages, replay_thinking);
    let has_thinking_blocks = converted.iter().any(|message| {
        message
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|blocks| blocks.iter().any(is_thinking_block))
    });

    let mut body = json!({
        "model": model,
        "max_tokens": plan.max_tokens,
        "messages": converted,
        "stream": true,
    });
    if !system.is_empty() {
        let mut blocks: Vec<Value> = system
            .into_iter()
            .map(|text| json!({ "type": "text", "text": text }))
            .collect();
        if prompt_caching {
            if let Some(last) = blocks.last_mut() {
                last["cache_control"] = json!({ "type": "ephemeral" });
            }
        }
        body["system"] = Value::Array(blocks);
    }
    if prompt_caching {
        // Caches the conversation up to the newest message, so every step of
        // a tool loop reads the previous one's prefix from the cache.
        body["cache_control"] = json!({ "type": "ephemeral" });
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools.iter().filter_map(convert_tool).collect());
    }

    let mut uses_binding = false;
    match plan.thinking {
        Some(Thinking::Adaptive) => {
            let mut thinking = json!({ "type": "adaptive" });
            if !lenient {
                // Newer models return empty thinking text unless asked for a
                // summary, which would leave the reasoning panel blank.
                thinking["display"] = json!("summarized");
            }
            if has_thinking_blocks {
                thinking["block_binding"] = json!({ "prefix_mismatch_behavior": "drop_block" });
                uses_binding = true;
            }
            body["thinking"] = thinking;
        }
        Some(Thinking::Budget(budget)) => {
            let mut thinking = json!({ "type": "enabled", "budget_tokens": budget });
            if has_thinking_blocks {
                thinking["block_binding"] = json!({ "prefix_mismatch_behavior": "drop_block" });
                uses_binding = true;
            }
            body["thinking"] = thinking;
        }
        None => {}
    }
    if let Some(effort) = &plan.effort {
        body["output_config"] = json!({ "effort": effort });
    }
    (body, uses_binding)
}

fn is_thinking_block(block: &Value) -> bool {
    matches!(
        block.get("type").and_then(Value::as_str),
        Some("thinking" | "redacted_thinking")
    )
}

fn mentions_thinking(body: &str) -> bool {
    let lower = body.to_lowercase();
    ["thinking", "signature", "block_binding", "anthropic-beta"]
        .iter()
        .any(|needle| lower.contains(needle))
}

/// OpenAI-style function schema → Messages API tool.
fn convert_tool(tool: &Value) -> Option<Value> {
    let function = tool.get("function").unwrap_or(tool);
    let name = function.get("name").and_then(Value::as_str)?;
    let mut schema = function
        .get("parameters")
        .cloned()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
    if schema.get("type").is_none() {
        schema["type"] = json!("object");
    }
    let mut converted = json!({
        "name": name,
        "input_schema": schema,
        // Stream large inputs (file contents) as they are generated; the
        // tools validate their own arguments.
        "eager_input_streaming": true,
    });
    if let Some(description) = function.get("description").and_then(Value::as_str) {
        converted["description"] = json!(description);
    }
    Some(converted)
}

/// Converts the chat history into the top-level system prompt and Messages API
/// turns: tool results become `tool_result` blocks in a user turn, consecutive
/// turns of one role are merged, and the conversation starts and ends with the
/// user as the API requires.
fn convert_messages(messages: &[ChatMessage], replay_thinking: bool) -> (Vec<String>, Vec<Value>) {
    let mut system: Vec<String> = Vec::new();
    let mut turns: Vec<(String, Vec<Value>)> = Vec::new();
    let mut push = |role: &str, blocks: Vec<Value>| {
        if blocks.is_empty() {
            return;
        }
        match turns.last_mut() {
            Some((last_role, last_blocks)) if last_role == role => last_blocks.extend(blocks),
            _ => turns.push((role.to_string(), blocks)),
        }
    };
    let mut ids = ToolIds::default();

    for message in messages {
        match message.role.as_str() {
            "system" => {
                let text = content_text(&message.content);
                if !text.trim().is_empty() {
                    system.push(text);
                }
            }
            "user" => push("user", user_blocks(&message.content)),
            "assistant" => push(
                "assistant",
                assistant_blocks(message, replay_thinking, &mut ids),
            ),
            "tool" => {
                let Some(call_id) = message.tool_call_id.as_deref() else {
                    continue;
                };
                let text = content_text(&message.content);
                let text = if text.trim().is_empty() {
                    "(no output)".to_string()
                } else {
                    text
                };
                push(
                    "user",
                    vec![json!({
                        "type": "tool_result",
                        "tool_use_id": ids.result(call_id),
                        "content": text,
                    })],
                );
            }
            _ => {}
        }
    }

    if turns.first().is_some_and(|(role, _)| role == "assistant") {
        turns.insert(
            0,
            (
                "user".to_string(),
                vec![json!({ "type": "text", "text": "(Earlier messages were trimmed.)" })],
            ),
        );
    }
    // Current models reject a trailing assistant turn (prefill).
    if turns.last().is_none_or(|(role, _)| role == "assistant") {
        turns.push((
            "user".to_string(),
            vec![json!({ "type": "text", "text": "Continue." })],
        ));
    }

    let converted = turns
        .into_iter()
        .map(|(role, content)| json!({ "role": role, "content": content }))
        .collect();
    (system, converted)
}

fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn user_blocks(content: &Value) -> Vec<Value> {
    match content {
        Value::String(text) if !text.is_empty() => vec![json!({ "type": "text", "text": text })],
        Value::Array(parts) => parts.iter().filter_map(user_part).collect(),
        _ => Vec::new(),
    }
}

/// One OpenAI-style content part (text, `image_url`, `file`) as a content block.
fn user_part(part: &Value) -> Option<Value> {
    match part.get("type").and_then(Value::as_str)? {
        "text" => {
            let text = part.get("text").and_then(Value::as_str)?;
            (!text.is_empty()).then(|| json!({ "type": "text", "text": text }))
        }
        "image_url" => {
            let url = part.pointer("/image_url/url").and_then(Value::as_str)?;
            let source = match parse_data_url(url) {
                Some((media_type, data)) => {
                    json!({ "type": "base64", "media_type": media_type, "data": data })
                }
                None => json!({ "type": "url", "url": url }),
            };
            Some(json!({ "type": "image", "source": source }))
        }
        "file" => {
            let data_url = part.pointer("/file/file_data").and_then(Value::as_str)?;
            let (media_type, data) = parse_data_url(data_url)?;
            let mut block = json!({
                "type": "document",
                "source": { "type": "base64", "media_type": media_type, "data": data }
            });
            if let Some(name) = part.pointer("/file/filename").and_then(Value::as_str) {
                block["title"] = json!(name);
            }
            Some(block)
        }
        _ => None,
    }
}

fn parse_data_url(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("data:")?;
    let (header, data) = rest.split_once(',')?;
    let media_type = header.strip_suffix(";base64")?;
    Some((media_type, data))
}

/// Tool-use ids the Messages API accepts: only `[A-Za-z0-9_-]`, and unique in
/// a request. Calls made through another provider can carry other ids
/// (`functions.read:0`) or repeat one (`call_0`, when that provider sent
/// none), so each assistant turn's calls are given such an id here and the
/// tool results that follow the turn are matched to them. Ids Anthropic
/// returned itself pass through unchanged.
#[derive(Default)]
struct ToolIds {
    used: HashSet<String>,
    /// The ids of the latest assistant turn's calls, by their stored id.
    turn: HashMap<String, String>,
}

impl ToolIds {
    fn start_turn(&mut self) {
        self.turn.clear();
    }

    /// The id to send for a call of the current assistant turn.
    fn call(&mut self, stored: &str) -> String {
        if let Some(id) = self.turn.get(stored) {
            return id.clone();
        }
        let base = valid_tool_id(stored);
        let mut id = base.clone();
        let mut suffix = 2;
        while !self.used.insert(id.clone()) {
            id = format!("{base}_{suffix}");
            suffix += 1;
        }
        self.turn.insert(stored.to_string(), id.clone());
        id
    }

    /// The id a tool result names its call by.
    fn result(&self, stored: &str) -> String {
        self.turn
            .get(stored)
            .cloned()
            .unwrap_or_else(|| valid_tool_id(stored))
    }
}

fn valid_tool_id(id: &str) -> String {
    let id: String = id
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '-' => character,
            _ => '_',
        })
        .collect();
    if id.is_empty() {
        "toolu".to_string()
    } else {
        id
    }
}

/// The assistant turn as Messages API blocks. A turn this provider produced is
/// replayed as it was returned, so its signed thinking stays valid; tool calls
/// the history dropped (unanswered ones) are dropped from it too.
fn assistant_blocks(message: &ChatMessage, replay_thinking: bool, ids: &mut ToolIds) -> Vec<Value> {
    ids.start_turn();
    let calls: Vec<&Value> = message
        .tool_calls
        .as_ref()
        .and_then(Value::as_array)
        .map(|calls| calls.iter().collect())
        .unwrap_or_default();
    let call_ids: HashSet<&str> = calls
        .iter()
        .filter_map(|call| call.get("id").and_then(Value::as_str))
        .collect();

    let mut blocks: Vec<Value> = Vec::new();
    let mut replayed_calls: HashSet<String> = HashSet::new();
    if let Some(native) = message.provider_content.as_ref().and_then(Value::as_array) {
        for block in native {
            match block.get("type").and_then(Value::as_str) {
                Some("thinking" | "redacted_thinking") => {
                    if replay_thinking {
                        blocks.push(block.clone());
                    }
                }
                Some("tool_use") => {
                    let id = block.get("id").and_then(Value::as_str).unwrap_or("");
                    if call_ids.contains(id) {
                        replayed_calls.insert(id.to_string());
                        let mut block = block.clone();
                        block["id"] = json!(ids.call(id));
                        blocks.push(block);
                    }
                }
                Some("text")
                    if block
                        .get("text")
                        .and_then(Value::as_str)
                        .is_some_and(|text| !text.is_empty()) =>
                {
                    blocks.push(block.clone());
                }
                _ => {}
            }
        }
    } else {
        let text = content_text(&message.content);
        if !text.trim().is_empty() {
            blocks.push(json!({ "type": "text", "text": text }));
        }
    }

    for call in calls {
        let Some(id) = call.get("id").and_then(Value::as_str) else {
            continue;
        };
        if replayed_calls.contains(id) {
            continue;
        }
        let name = call
            .pointer("/function/name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let arguments = call
            .pointer("/function/arguments")
            .and_then(Value::as_str)
            .unwrap_or("");
        blocks.push(json!({
            "type": "tool_use",
            "id": ids.call(id),
            "name": name,
            "input": parse_tool_input(arguments),
        }));
    }

    // A turn left with nothing but reasoning is not a valid message.
    if blocks.iter().all(is_thinking_block) {
        return Vec::new();
    }
    blocks
}

fn parse_tool_input(arguments: &str) -> Value {
    serde_json::from_str::<Value>(arguments)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()))
}

struct StreamError {
    message: String,
    retryable: bool,
}

enum StreamStep {
    Continue,
    Failed(StreamError),
}

#[derive(Default)]
struct Block {
    kind: String,
    start: Value,
    text: String,
    thinking: String,
    signature: String,
    input_json: String,
}

/// Folds Messages API stream events into text, reasoning, tool calls and usage.
struct StreamState {
    blocks: BTreeMap<u64, Block>,
    input_tokens: i64,
    cache_write_tokens: i64,
    cache_read_tokens: i64,
    output_tokens: i64,
    stop_reason: Option<String>,
    pricing: Option<Pricing>,
    emitted: bool,
    reasoned: bool,
}

impl StreamState {
    fn new(pricing: Option<Pricing>) -> Self {
        Self {
            blocks: BTreeMap::new(),
            input_tokens: 0,
            cache_write_tokens: 0,
            cache_read_tokens: 0,
            output_tokens: 0,
            stop_reason: None,
            pricing,
            emitted: false,
            reasoned: false,
        }
    }

    fn apply(&mut self, event: &Value, on_chunk: &mut (dyn FnMut(ChatChunk) + Send)) -> StreamStep {
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "message_start" => {
                if let Some(usage) = event.pointer("/message/usage") {
                    self.read_usage(usage);
                }
            }
            "content_block_start" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                let start = event.get("content_block").cloned().unwrap_or(Value::Null);
                let kind = start
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if kind == "thinking" && self.reasoned {
                    // Keep separate thinking blocks apart in the reasoning panel.
                    on_chunk(ChatChunk::Reasoning("\n\n".to_string()));
                }
                let mut block = Block {
                    kind,
                    start,
                    ..Block::default()
                };
                if let Some(text) = block.start.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        block.text.push_str(text);
                        self.emitted = true;
                        on_chunk(ChatChunk::Delta(text.to_string()));
                    }
                }
                self.blocks.insert(index, block);
            }
            "content_block_delta" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                let Some(delta) = event.get("delta") else {
                    return StreamStep::Continue;
                };
                let block = self.blocks.entry(index).or_default();
                match delta.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text_delta" => {
                        if let Some(text) = delta.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                block.text.push_str(text);
                                self.emitted = true;
                                on_chunk(ChatChunk::Delta(text.to_string()));
                            }
                        }
                    }
                    "thinking_delta" => {
                        if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                            if !text.is_empty() {
                                block.thinking.push_str(text);
                                self.emitted = true;
                                self.reasoned = true;
                                on_chunk(ChatChunk::Reasoning(text.to_string()));
                            }
                        }
                    }
                    "signature_delta" => {
                        if let Some(signature) = delta.get("signature").and_then(Value::as_str) {
                            block.signature.push_str(signature);
                        }
                    }
                    "input_json_delta" => {
                        if let Some(json) = delta.get("partial_json").and_then(Value::as_str) {
                            block.input_json.push_str(json);
                            self.emitted = true;
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(reason) = event.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    self.stop_reason = Some(reason.to_string());
                }
                if let Some(usage) = event.get("usage") {
                    self.read_usage(usage);
                    on_chunk(ChatChunk::Usage(self.usage()));
                }
            }
            "error" => {
                let kind = event
                    .pointer("/error/type")
                    .and_then(Value::as_str)
                    .unwrap_or("error");
                let message = event
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error");
                return StreamStep::Failed(StreamError {
                    message: format!("{message} [{kind}]"),
                    retryable: matches!(
                        kind,
                        "overloaded_error" | "api_error" | "rate_limit_error" | "timeout_error"
                    ),
                });
            }
            _ => {}
        }
        StreamStep::Continue
    }

    /// Usage fields are cumulative; later events only carry the ones that changed.
    fn read_usage(&mut self, usage: &Value) {
        let field = |key: &str| usage.get(key).and_then(Value::as_i64);
        if let Some(value) = field("input_tokens") {
            self.input_tokens = value;
        }
        if let Some(value) = field("cache_creation_input_tokens") {
            self.cache_write_tokens = value;
        }
        if let Some(value) = field("cache_read_input_tokens") {
            self.cache_read_tokens = value;
        }
        if let Some(value) = field("output_tokens") {
            self.output_tokens = value;
        }
    }

    fn usage(&self) -> ChatUsage {
        // `input_tokens` excludes cached tokens; the rest of the app counts the
        // whole prompt and the cached part of it.
        let cost = self
            .pricing
            .map(|price| {
                (self.input_tokens as f64 * price.input
                    + self.cache_write_tokens as f64 * price.input * CACHE_WRITE_MULTIPLIER
                    + self.cache_read_tokens as f64 * price.cache_read
                    + self.output_tokens as f64 * price.output)
                    / 1_000_000.0
            })
            .unwrap_or(0.0);
        ChatUsage {
            prompt_tokens: self.input_tokens + self.cache_write_tokens + self.cache_read_tokens,
            completion_tokens: self.output_tokens,
            cached_tokens: self.cache_read_tokens,
            cache_write_tokens: self.cache_write_tokens,
            cost,
        }
    }

    fn finish(self, cancelled: bool) -> ChatOutcome {
        let usage = self.usage();
        let mut tool_calls: Vec<ToolCallRecord> = Vec::new();
        let mut content: Vec<Value> = Vec::new();
        for (index, block) in self.blocks {
            match block.kind.as_str() {
                "text" => {
                    if !block.text.is_empty() {
                        content.push(json!({ "type": "text", "text": block.text }));
                    }
                }
                "thinking" => {
                    // Without its signature a thinking block cannot be replayed.
                    if !block.signature.is_empty() {
                        content.push(json!({
                            "type": "thinking",
                            "thinking": block.thinking,
                            "signature": block.signature,
                        }));
                    }
                }
                "redacted_thinking" => content.push(block.start),
                "tool_use" => {
                    let id = block
                        .start
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("toolu_{index}"));
                    let name = block
                        .start
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let arguments = if block.input_json.trim().is_empty() {
                        "{}".to_string()
                    } else {
                        block.input_json
                    };
                    content.push(json!({
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": parse_tool_input(&arguments),
                    }));
                    tool_calls.push(ToolCallRecord {
                        id,
                        name,
                        arguments,
                    });
                }
                _ => {}
            }
        }
        ChatOutcome {
            usage,
            cancelled,
            tool_calls,
            // A cut-off turn has unsigned reasoning, so it is not kept.
            provider_content: (!cancelled && !content.is_empty()).then_some(Value::Array(content)),
        }
    }
}

/// Stop reasons that mean the answer is missing or cut short.
fn stop_reason_error(reason: Option<&str>) -> Option<&'static str> {
    match reason? {
        "refusal" => Some("Claude declined to continue with this request (refusal)."),
        "model_context_window_exceeded" => {
            Some("The conversation no longer fits into the model's context window.")
        }
        _ => None,
    }
}

fn anthropic_error(status: u16, body: &str) -> AppError {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let message = parsed
        .as_ref()
        .and_then(|value| value.pointer("/error/message"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| body.chars().take(500).collect());
    let kind = parsed
        .as_ref()
        .and_then(|value| value.pointer("/error/type"))
        .and_then(Value::as_str);
    match kind {
        Some(kind) => AppError::msg(format!("Anthropic error ({status}): {message} [{kind}]")),
        None => AppError::msg(format!("Anthropic error ({status}): {message}")),
    }
}

fn parse_caps(id: &str, raw: &Value) -> ModelCaps {
    let Some(capabilities) = raw.get("capabilities").filter(|value| value.is_object()) else {
        let mut caps = fallback_caps(id);
        if let Some(context) = raw.get("max_input_tokens").and_then(Value::as_i64) {
            caps.context_length = context;
        }
        if let Some(output) = raw.get("max_tokens").and_then(Value::as_i64) {
            caps.max_output_tokens = output;
        }
        return caps;
    };
    let supported = |path: &str| {
        capabilities
            .pointer(&format!("{path}/supported"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    let vision = supported("/image_input");
    let effort_levels = if supported("/effort") {
        EFFORT_LEVELS
            .iter()
            .filter(|level| supported(&format!("/effort/{level}")))
            .map(|level| level.to_string())
            .collect()
    } else {
        Vec::new()
    };
    ModelCaps {
        context_length: raw
            .get("max_input_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(FALLBACK_CONTEXT_TOKENS),
        max_output_tokens: raw.get("max_tokens").and_then(Value::as_i64).unwrap_or(0),
        vision,
        pdf: capabilities
            .pointer("/pdf_input/supported")
            .and_then(Value::as_bool)
            .unwrap_or(vision),
        adaptive_thinking: supported("/thinking/types/adaptive"),
        budget_thinking: supported("/thinking/types/enabled"),
        effort_levels,
    }
}

/// A guess for models the Models API did not describe (e.g. behind a gateway):
/// current families think adaptively, older ones take a thinking budget.
fn fallback_caps(id: &str) -> ModelCaps {
    let adaptive = [
        "claude-fable",
        "claude-mythos",
        "claude-opus-5",
        "claude-sonnet-5",
    ]
    .iter()
    .any(|prefix| id.starts_with(prefix))
        || [
            "claude-opus-4-6",
            "claude-opus-4-7",
            "claude-opus-4-8",
            "claude-sonnet-4-6",
        ]
        .iter()
        .any(|prefix| id.starts_with(prefix));
    ModelCaps {
        context_length: FALLBACK_CONTEXT_TOKENS,
        max_output_tokens: 0,
        vision: true,
        pdf: true,
        adaptive_thinking: adaptive,
        budget_thinking: !adaptive,
        effort_levels: if adaptive {
            vec!["low".to_string(), "medium".to_string(), "high".to_string()]
        } else {
            Vec::new()
        },
    }
}

fn model_info(provider: &str, id: &str, raw: &Value, caps: &ModelCaps) -> ModelInfo {
    let price = pricing(id);
    let mut modalities = vec!["text".to_string()];
    if caps.vision {
        modalities.push("image".to_string());
    }
    if caps.pdf {
        modalities.push("file".to_string());
    }
    let reasoning = caps.adaptive_thinking || caps.budget_thinking;
    let mut parameters = vec!["tools".to_string(), "max_tokens".to_string()];
    if reasoning {
        parameters.push("reasoning".to_string());
    }
    ModelInfo {
        id: format!("{provider}:{id}"),
        name: raw
            .get("display_name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .unwrap_or(id)
            .to_string(),
        description: String::new(),
        context_length: caps.context_length,
        prompt_price_per_m: price.map(|price| price.input).unwrap_or(0.0),
        completion_price_per_m: price.map(|price| price.output).unwrap_or(0.0),
        cache_read_price_per_m: price.map(|price| price.cache_read).unwrap_or(0.0),
        supports_reasoning: reasoning,
        supports_vision: caps.vision,
        supports_tools: true,
        input_modalities: modalities,
        supported_parameters: parameters,
        created: raw
            .get("created_at")
            .and_then(Value::as_str)
            .and_then(|date| chrono::DateTime::parse_from_rfc3339(date).ok())
            .map(|date| date.timestamp())
            .unwrap_or(0),
        source: provider.to_string(),
    }
}

/// USD per million tokens.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Pricing {
    input: f64,
    output: f64,
    cache_read: f64,
}

/// Anthropic list prices by model family; the Models API does not report them.
/// More specific prefixes come first.
const PRICES: &[(&str, f64, f64, f64)] = &[
    ("claude-fable-5-1", 10.0, 50.0, 0.25),
    ("claude-mythos-5-1", 10.0, 50.0, 0.25),
    ("claude-fable-5", 10.0, 50.0, 1.0),
    ("claude-mythos-5", 10.0, 50.0, 1.0),
    ("claude-opus-5-5", 4.0, 20.0, 0.2),
    ("claude-opus-5", 5.0, 25.0, 0.5),
    ("claude-opus-4-8", 5.0, 25.0, 0.5),
    ("claude-opus-4-7", 5.0, 25.0, 0.5),
    ("claude-opus-4-6", 5.0, 25.0, 0.5),
    ("claude-opus-4-5", 5.0, 25.0, 0.5),
    ("claude-opus-4", 15.0, 75.0, 1.5),
    ("claude-sonnet-5", 2.0, 10.0, 0.2),
    ("claude-sonnet-4", 3.0, 15.0, 0.3),
    ("claude-haiku-4-5", 1.0, 5.0, 0.1),
    ("claude-3-haiku", 0.25, 1.25, 0.03),
];

fn pricing(model: &str) -> Option<Pricing> {
    PRICES
        .iter()
        .find(|(prefix, ..)| model.starts_with(prefix))
        .map(|&(_, input, output, cache_read)| Pricing {
            input,
            output,
            cache_read,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(adaptive: bool, effort: &[&str]) -> ModelCaps {
        ModelCaps {
            context_length: 1_000_000,
            max_output_tokens: 128_000,
            vision: true,
            pdf: true,
            adaptive_thinking: adaptive,
            budget_thinking: !adaptive,
            effort_levels: effort.iter().map(|level| level.to_string()).collect(),
        }
    }

    fn collect(events: &[Value]) -> (StreamState, Vec<ChatChunk>) {
        let mut chunks = Vec::new();
        let mut state = StreamState::new(pricing("claude-opus-5"));
        for event in events {
            if let StreamStep::Failed(error) = state.apply(event, &mut |chunk| chunks.push(chunk)) {
                panic!("stream failed: {}", error.message);
            }
        }
        (state, chunks)
    }

    #[test]
    fn models_listing_maps_capabilities_and_prices() {
        let raw = json!({
            "id": "claude-opus-5",
            "display_name": "Claude Opus 5",
            "created_at": "2026-05-01T00:00:00Z",
            "max_input_tokens": 1_000_000,
            "max_tokens": 128_000,
            "capabilities": {
                "image_input": { "supported": true },
                "thinking": { "supported": true, "types": {
                    "enabled": { "supported": false },
                    "adaptive": { "supported": true }
                } },
                "effort": { "supported": true,
                    "low": { "supported": true }, "medium": { "supported": true },
                    "high": { "supported": true }, "xhigh": { "supported": true },
                    "max": { "supported": true } }
            }
        });
        let caps = parse_caps("claude-opus-5", &raw);
        assert!(caps.adaptive_thinking && !caps.budget_thinking);
        assert_eq!(caps.effort_levels.len(), 5);
        assert!(caps.pdf, "PDF support follows vision when not reported");

        let info = model_info("anthropic", "claude-opus-5", &raw, &caps);
        assert_eq!(info.id, "anthropic:claude-opus-5");
        assert_eq!(info.name, "Claude Opus 5");
        assert_eq!(info.context_length, 1_000_000);
        assert_eq!(info.prompt_price_per_m, 5.0);
        assert_eq!(info.source, "anthropic");
        assert!(info.supports_reasoning && info.supports_vision && info.supports_tools);
        assert!(info.created > 0);
    }

    #[test]
    fn pricing_prefers_the_most_specific_family() {
        assert_eq!(pricing("claude-opus-5-5").unwrap().input, 4.0);
        assert_eq!(pricing("claude-opus-5").unwrap().input, 5.0);
        assert_eq!(pricing("claude-opus-4-1-20250805").unwrap().input, 15.0);
        assert_eq!(pricing("claude-fable-5-1").unwrap().cache_read, 0.25);
        assert_eq!(pricing("claude-haiku-4-5-20251001").unwrap().output, 5.0);
        assert!(pricing("some-future-model").is_none());
    }

    #[test]
    fn reasoning_maps_to_adaptive_thinking_and_effort() {
        let opus = caps(true, &["low", "medium", "high", "xhigh", "max"]);
        let high = RequestPlan::new(&opus, Some(&ReasoningSetting::Effort("high".into())));
        assert_eq!(high.thinking, Some(Thinking::Adaptive));
        assert_eq!(high.effort.as_deref(), Some("high"));
        assert_eq!(high.max_tokens, MAX_OUTPUT_TOKENS);

        let off = RequestPlan::new(&opus, Some(&ReasoningSetting::Off));
        assert_eq!(off.thinking, None);
        assert_eq!(off.effort.as_deref(), Some("low"));

        let default = RequestPlan::new(&opus, None);
        assert_eq!(default.thinking, Some(Thinking::Adaptive));
        assert_eq!(default.effort, None);
    }

    #[test]
    fn older_models_get_a_thinking_budget_below_max_tokens() {
        let mut haiku = caps(false, &[]);
        haiku.max_output_tokens = 64_000;
        let plan = RequestPlan::new(&haiku, Some(&ReasoningSetting::Effort("medium".into())));
        assert_eq!(plan.thinking, Some(Thinking::Budget(8_192)));
        assert_eq!(plan.effort, None);
        assert!(plan.max_tokens > 8_192);

        let off = RequestPlan::new(&haiku, Some(&ReasoningSetting::Off));
        assert_eq!(off.thinking, None);
        assert_eq!(off.effort, None);
    }

    #[test]
    fn history_converts_to_messages_api_turns() {
        let mut calls = ChatMessage::assistant_tool_calls(
            "Let me look.".to_string(),
            json!([
                { "id": "toolu_1", "type": "function",
                  "function": { "name": "read", "arguments": "{\"path\":\"a.rs\"}" } },
                { "id": "toolu_2", "type": "function",
                  "function": { "name": "ls", "arguments": "" } }
            ]),
        );
        calls.seq = Some(2);
        let messages = vec![
            ChatMessage::text("system", "Be helpful."),
            ChatMessage::parts(
                "user",
                json!([
                    { "type": "text", "text": "What is in here?" },
                    { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
                    { "type": "file", "file": { "filename": "spec.pdf", "file_data": "data:application/pdf;base64,BBBB" } }
                ]),
            ),
            calls,
            ChatMessage::tool_result("toolu_1", "fn main() {}"),
            ChatMessage::tool_result("toolu_2", ""),
            ChatMessage::text("user", "Thanks"),
        ];
        let (system, turns) = convert_messages(&messages, true);
        assert_eq!(system, vec!["Be helpful.".to_string()]);
        assert_eq!(
            turns.len(),
            3,
            "tool results and the next prompt share a user turn"
        );

        let first = turns[0]["content"].as_array().unwrap();
        assert_eq!(first[1]["type"], "image");
        assert_eq!(first[1]["source"]["media_type"], "image/png");
        assert_eq!(first[1]["source"]["data"], "AAAA");
        assert_eq!(first[2]["type"], "document");
        assert_eq!(first[2]["title"], "spec.pdf");

        let assistant = turns[1]["content"].as_array().unwrap();
        assert_eq!(
            assistant[0],
            json!({ "type": "text", "text": "Let me look." })
        );
        assert_eq!(assistant[1]["input"], json!({ "path": "a.rs" }));
        assert_eq!(
            assistant[2]["input"],
            json!({}),
            "empty arguments become {{}}"
        );

        let results = turns[2]["content"].as_array().unwrap();
        assert_eq!(results[0]["type"], "tool_result");
        assert_eq!(results[0]["tool_use_id"], "toolu_1");
        assert_eq!(results[1]["content"], "(no output)");
        assert_eq!(results[2], json!({ "type": "text", "text": "Thanks" }));
    }

    #[test]
    fn stored_turns_replay_verbatim_minus_dropped_calls() {
        let mut message = ChatMessage::assistant_tool_calls(
            "Reading.".to_string(),
            json!([{ "id": "toolu_1", "type": "function",
                     "function": { "name": "read", "arguments": "{}" } }]),
        );
        message.provider_content = Some(json!([
            { "type": "thinking", "thinking": "plan", "signature": "sig" },
            { "type": "text", "text": "Reading." },
            { "type": "tool_use", "id": "toolu_1", "name": "read", "input": { "path": "x" } },
            { "type": "tool_use", "id": "toolu_2", "name": "ls", "input": {} }
        ]));
        let blocks = assistant_blocks(&message, true, &mut ToolIds::default());
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0]["signature"], "sig");
        assert_eq!(blocks[2]["id"], "toolu_1");
        assert_eq!(blocks[2]["input"], json!({ "path": "x" }));

        let without_thinking = assistant_blocks(&message, false, &mut ToolIds::default());
        assert_eq!(without_thinking.len(), 2);
        assert_eq!(without_thinking[0]["type"], "text");
    }

    #[test]
    fn tool_ids_from_other_providers_become_valid_and_unique() {
        let call = |id: &str| {
            ChatMessage::assistant_tool_calls(
                String::new(),
                json!([{ "id": id, "type": "function",
                         "function": { "name": "read", "arguments": "{}" } }]),
            )
        };
        let mut messages = vec![ChatMessage::text("user", "Go")];
        for id in ["functions.read:0", "call_0", "call_0", "toolu_01Ab-_9"] {
            messages.push(call(id));
            messages.push(ChatMessage::tool_result(id, "done"));
        }
        let (_, turns) = convert_messages(&messages, false);
        let ids = |role: &str, kind: &str, key: &str| -> Vec<String> {
            turns
                .iter()
                .filter(|turn| turn["role"] == role)
                .flat_map(|turn| turn["content"].as_array().unwrap().clone())
                .filter(|block| block["type"] == kind)
                .map(|block| block[key].as_str().unwrap().to_string())
                .collect()
        };
        let uses = ids("assistant", "tool_use", "id");
        assert_eq!(
            uses,
            ["functions_read_0", "call_0", "call_0_2", "toolu_01Ab-_9"]
        );
        assert_eq!(ids("user", "tool_result", "tool_use_id"), uses);
    }

    #[test]
    fn conversation_starts_and_ends_with_the_user() {
        let messages = vec![
            ChatMessage::text("system", "sys"),
            ChatMessage::text("assistant", "Earlier answer"),
        ];
        let (_, turns) = convert_messages(&messages, false);
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[0]["role"], "user");
        assert_eq!(turns[1]["role"], "assistant");
        assert_eq!(turns[2]["role"], "user");
    }

    #[test]
    fn request_body_sets_caching_thinking_and_tools() {
        let mut assistant = ChatMessage::text("assistant", "Done.");
        assistant.provider_content = Some(json!([
            { "type": "thinking", "thinking": "t", "signature": "s" },
            { "type": "text", "text": "Done." }
        ]));
        let messages = vec![
            ChatMessage::text("system", "sys"),
            ChatMessage::text("user", "Hi"),
            assistant,
            ChatMessage::text("user", "Again"),
        ];
        let tools = vec![json!({
            "type": "function",
            "function": { "name": "read", "description": "Read a file",
                          "parameters": { "type": "object", "properties": {} } }
        })];
        let plan = RequestPlan::new(
            &caps(true, &["low", "medium", "high"]),
            Some(&ReasoningSetting::Effort("medium".into())),
        );

        let (body, binding) = build_request("claude-opus-5", &messages, &plan, &tools, true, false);
        assert!(binding);
        assert_eq!(body["model"], "claude-opus-5");
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(body["cache_control"]["type"], "ephemeral");
        assert_eq!(body["thinking"]["type"], "adaptive");
        assert_eq!(body["thinking"]["display"], "summarized");
        assert_eq!(
            body["thinking"]["block_binding"]["prefix_mismatch_behavior"],
            "drop_block"
        );
        assert_eq!(body["output_config"]["effort"], "medium");
        assert_eq!(body["tools"][0]["name"], "read");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        assert_eq!(body["messages"][1]["content"][0]["type"], "thinking");

        let (lenient, binding) =
            build_request("claude-opus-5", &messages, &plan, &tools, false, true);
        assert!(!binding);
        assert!(lenient.get("cache_control").is_none());
        assert!(lenient["thinking"].get("display").is_none());
        assert!(lenient["thinking"].get("block_binding").is_none());
        assert_eq!(lenient["messages"][1]["content"][0]["type"], "text");
    }

    #[test]
    fn stream_events_fold_into_text_reasoning_tools_and_usage() {
        let events = [
            json!({ "type": "message_start", "message": { "usage": {
                "input_tokens": 100, "cache_creation_input_tokens": 1_000,
                "cache_read_input_tokens": 9_000, "output_tokens": 1 } } }),
            json!({ "type": "content_block_start", "index": 0,
                    "content_block": { "type": "thinking", "thinking": "", "signature": "" } }),
            json!({ "type": "content_block_delta", "index": 0,
                    "delta": { "type": "thinking_delta", "thinking": "Need the file." } }),
            json!({ "type": "content_block_delta", "index": 0,
                    "delta": { "type": "signature_delta", "signature": "abc" } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "content_block_start", "index": 1,
                    "content_block": { "type": "text", "text": "" } }),
            json!({ "type": "content_block_delta", "index": 1,
                    "delta": { "type": "text_delta", "text": "Reading it." } }),
            json!({ "type": "content_block_start", "index": 2, "content_block": {
                    "type": "tool_use", "id": "toolu_9", "name": "read", "input": {} } }),
            json!({ "type": "content_block_delta", "index": 2,
                    "delta": { "type": "input_json_delta", "partial_json": "{\"path\":" } }),
            json!({ "type": "content_block_delta", "index": 2,
                    "delta": { "type": "input_json_delta", "partial_json": "\"a.rs\"}" } }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" },
                    "usage": { "output_tokens": 50 } }),
            json!({ "type": "message_stop" }),
        ];
        let (state, chunks) = collect(&events);
        assert_eq!(state.stop_reason.as_deref(), Some("tool_use"));
        assert!(matches!(&chunks[0], ChatChunk::Reasoning(text) if text == "Need the file."));
        assert!(matches!(&chunks[1], ChatChunk::Delta(text) if text == "Reading it."));

        let outcome = state.finish(false);
        assert_eq!(outcome.usage.prompt_tokens, 10_100);
        assert_eq!(outcome.usage.cached_tokens, 9_000);
        assert_eq!(outcome.usage.cache_write_tokens, 1_000);
        assert_eq!(outcome.usage.completion_tokens, 50);
        // 100 * 5 + 1000 * 6.25 + 9000 * 0.5 + 50 * 25, per million.
        assert!((outcome.usage.cost - 0.0125).abs() < 1e-9);

        assert_eq!(outcome.tool_calls.len(), 1);
        assert_eq!(outcome.tool_calls[0].id, "toolu_9");
        assert_eq!(outcome.tool_calls[0].arguments, "{\"path\":\"a.rs\"}");

        let content = outcome.provider_content.expect("content kept for replay");
        assert_eq!(content[0]["signature"], "abc");
        assert_eq!(content[2]["input"], json!({ "path": "a.rs" }));
    }

    #[test]
    fn cancelled_streams_are_not_replayed() {
        let events = [
            json!({ "type": "content_block_start", "index": 0,
                    "content_block": { "type": "text", "text": "" } }),
            json!({ "type": "content_block_delta", "index": 0,
                    "delta": { "type": "text_delta", "text": "Partial" } }),
        ];
        let (state, _) = collect(&events);
        assert!(state.finish(true).provider_content.is_none());
    }

    #[test]
    fn stream_errors_and_refusals_surface() {
        let mut state = StreamState::new(None);
        let step = state.apply(
            &json!({ "type": "error", "error": { "type": "overloaded_error", "message": "Overloaded" } }),
            &mut |_| {},
        );
        assert!(matches!(
            step,
            StreamStep::Failed(StreamError {
                retryable: true,
                ..
            })
        ));
        assert!(stop_reason_error(Some("refusal")).is_some());
        assert!(stop_reason_error(Some("end_turn")).is_none());
        assert!(mentions_thinking(
            r#"{"error":{"message":"messages.1.content.0: Invalid `signature` in `thinking` block"}}"#
        ));
    }

    #[test]
    fn api_errors_read_the_error_object() {
        let error = anthropic_error(
            401,
            r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#,
        )
        .to_string();
        assert!(error.contains("401"));
        assert!(error.contains("invalid x-api-key"));
        assert!(error.contains("authentication_error"));
    }

    #[test]
    fn base_url_accepts_a_trailing_version() {
        let cache = CapsCache::default();
        let client = AnthropicClient::new(
            reqwest::Client::new(),
            "https://proxy.local/v1/",
            cache.clone(),
        );
        assert_eq!(client.base_url, "https://proxy.local");
        let client = AnthropicClient::new(reqwest::Client::new(), "", cache);
        assert_eq!(client.base_url, DEFAULT_BASE_URL);
    }

    /// Runs a two-step tool loop against the real API, replaying the first
    /// turn (with its signed thinking) like the agent does. The model can be
    /// changed with `ANTHROPIC_TEST_MODEL`.
    #[tokio::test]
    #[ignore = "requires ANTHROPIC_API_KEY and network access to api.anthropic.com"]
    async fn live_tool_loop_replays_the_first_turn() {
        let key = std::env::var("ANTHROPIC_API_KEY").expect("ANTHROPIC_API_KEY");
        let model =
            std::env::var("ANTHROPIC_TEST_MODEL").unwrap_or_else(|_| "claude-opus-5".to_string());
        let client = AnthropicClient::new(
            reqwest::Client::new(),
            DEFAULT_BASE_URL,
            CapsCache::default(),
        );
        let models = client.list_models(&key).await.expect("model list");
        assert!(models
            .iter()
            .any(|entry| entry.id == format!("anthropic:{model}")));

        let tools = vec![json!({
            "type": "function",
            "function": {
                "name": "read",
                "description": "Read a file from the project.",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string" } },
                    "required": ["path"]
                }
            }
        })];
        let mut history = vec![
            ChatMessage::text(
                "system",
                "You are a coding agent. Use the read tool to read files.",
            ),
            ChatMessage::text("user", "Read notes.txt and tell me its first word."),
        ];
        let reasoning = || Some(ReasoningSetting::Effort("medium".to_string()));

        let first = client
            .stream_chat(
                &key,
                &model,
                history.clone(),
                reasoning(),
                &tools,
                true,
                None,
                CancellationToken::new(),
                &mut |_| {},
            )
            .await
            .expect("first turn");
        assert!(!first.tool_calls.is_empty(), "the model should call read");

        let calls: Vec<Value> = first
            .tool_calls
            .iter()
            .map(|call| {
                json!({ "id": call.id, "type": "function",
                        "function": { "name": call.name, "arguments": call.arguments } })
            })
            .collect();
        let mut assistant = ChatMessage::assistant_tool_calls(String::new(), Value::Array(calls));
        assistant.provider_content = first.provider_content.clone();
        history.push(assistant);
        for call in &first.tool_calls {
            history.push(ChatMessage::tool_result(&call.id, "Pumas are fast."));
        }

        let mut reply = String::new();
        let second = client
            .stream_chat(
                &key,
                &model,
                history,
                reasoning(),
                &tools,
                true,
                None,
                CancellationToken::new(),
                &mut |chunk| {
                    if let ChatChunk::Delta(text) = chunk {
                        reply.push_str(&text);
                    }
                },
            )
            .await
            .expect("second turn");
        assert!(reply.contains("Pumas"), "unexpected reply: {reply}");
        assert!(second.usage.prompt_tokens > 0);
        assert!(second.usage.cost > 0.0);
    }
}
