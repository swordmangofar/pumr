//! Streaming for APIs in OpenAI's Chat Completions format: OpenRouter and the
//! direct providers that speak it (OpenAI, Gemini, xAI, Mistral, DeepSeek,
//! Groq, local servers). Each client builds its own request body; this module
//! sends it, retries, and folds the event stream into chunks.

use super::{
    cancelled_outcome, parse_retry_after, retryable_reqwest, retryable_status, take_line,
    wait_backoff, ChatChunk, ChatOutcome, ChatUsage, Pricing, MAX_STREAM_RETRIES,
};
use crate::error::{AppError, Result};
use crate::models::ToolCallRecord;
use futures_util::StreamExt;
use serde_json::Value;
use std::collections::BTreeMap;
use tokio_util::sync::CancellationToken;

pub(crate) struct Request<'a> {
    /// Builds the HTTP request for a body (URL, auth, headers).
    pub send: &'a (dyn Fn(&Value) -> reqwest::RequestBuilder + Send + Sync),
    /// Provider name for error messages.
    pub label: &'a str,
    /// Prices a usage report when the provider does not say what it cost.
    pub pricing: Option<Pricing>,
    /// Top-level body fields a provider may reject. When a 400/422 names one,
    /// it is dropped and the request sent again.
    pub optional_fields: &'a [&'a str],
}

pub(crate) struct Streamed {
    pub outcome: ChatOutcome,
    /// Optional fields the provider rejected (see [`Request::optional_fields`]).
    pub dropped: Vec<String>,
}

pub(crate) async fn stream(
    request: Request<'_>,
    mut body: Value,
    cancel: CancellationToken,
    on_chunk: &mut (dyn FnMut(ChatChunk) + Send),
) -> Result<Streamed> {
    let mut dropped: Vec<String> = Vec::new();
    let cancelled = |dropped: Vec<String>| {
        Ok(Streamed {
            outcome: cancelled_outcome(),
            dropped,
        })
    };
    let mut attempt = 0usize;
    'attempt: loop {
        attempt += 1;
        let response = tokio::select! {
            _ = cancel.cancelled() => return cancelled(dropped),
            response = (request.send)(&body).send() => response,
        };
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                if retryable_reqwest(&error) && attempt <= MAX_STREAM_RETRIES {
                    if wait_backoff(attempt, None, &cancel).await {
                        continue;
                    }
                    return cancelled(dropped);
                }
                return Err(error.into());
            }
        };

        let status = response.status();
        if !status.is_success() {
            let status_code = status.as_u16();
            let retry_after = parse_retry_after(response.headers());
            let body_text = tokio::select! {
                _ = cancel.cancelled() => return cancelled(dropped),
                text = response.text() => text.unwrap_or_default(),
            };
            if matches!(status_code, 400 | 422) {
                if let Some(field) = rejected_field(&body, &body_text, request.optional_fields) {
                    if let Some(object) = body.as_object_mut() {
                        object.remove(&field);
                    }
                    dropped.push(field);
                    continue;
                }
            }
            if retryable_status(status_code) && attempt <= MAX_STREAM_RETRIES {
                if wait_backoff(attempt, retry_after, &cancel).await {
                    continue;
                }
                return cancelled(dropped);
            }
            return Err(provider_error(request.label, status_code, &body_text));
        }

        let mut state = StreamState::new(request.pricing);
        // Raw bytes: a multi-byte character can be split across network
        // chunks, so lines are only decoded once they are complete.
        let mut buffer: Vec<u8> = Vec::new();
        let mut was_cancelled = false;
        let mut stream = response.bytes_stream();

        loop {
            let next = tokio::select! {
                _ = cancel.cancelled() => {
                    was_cancelled = true;
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
                    if !state.emitted && retryable_reqwest(&error) && attempt <= MAX_STREAM_RETRIES
                    {
                        if wait_backoff(attempt, None, &cancel).await {
                            continue 'attempt;
                        }
                        return cancelled(dropped);
                    }
                    return Err(error.into());
                }
            };
            buffer.extend_from_slice(&bytes);
            while let Some(line) = take_line(&mut buffer) {
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                state.apply(&value, on_chunk)?;
            }
        }

        return Ok(Streamed {
            outcome: state.finish(was_cancelled),
            dropped,
        });
    }
}

/// The optional field a rejected request's error message names, if any.
fn rejected_field(body: &Value, error: &str, optional: &[&str]) -> Option<String> {
    let error = error.to_lowercase();
    optional
        .iter()
        .find(|field| body.get(**field).is_some() && error.contains(**field))
        .map(|field| field.to_string())
}

/// Folds Chat Completions stream chunks into text, reasoning, tool calls and usage.
pub(crate) struct StreamState {
    pricing: Option<Pricing>,
    usage: ChatUsage,
    tool_calls: BTreeMap<u64, ToolCallRecord>,
    pub emitted: bool,
}

impl StreamState {
    pub fn new(pricing: Option<Pricing>) -> Self {
        Self {
            pricing,
            usage: ChatUsage::default(),
            tool_calls: BTreeMap::new(),
            emitted: false,
        }
    }

    pub fn apply(
        &mut self,
        value: &Value,
        on_chunk: &mut (dyn FnMut(ChatChunk) + Send),
    ) -> Result<()> {
        if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
            return Err(AppError::msg(describe_error(error)));
        }
        if let Some(delta) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("delta"))
        {
            // OpenRouter and Groq say `reasoning`, DeepSeek and xAI
            // `reasoning_content`; some OpenRouter models only send details.
            // A server may send the one it does not use as `null`.
            let reasoning = delta
                .get("reasoning")
                .and_then(Value::as_str)
                .or_else(|| delta.get("reasoning_content").and_then(Value::as_str));
            if let Some(reasoning) = reasoning {
                self.emit(on_chunk, ChatChunk::Reasoning(reasoning.to_string()));
            } else if let Some(details) = delta.get("reasoning_details").and_then(Value::as_array) {
                for detail in details {
                    if let Some(text) = detail.get("text").and_then(Value::as_str) {
                        self.emit(on_chunk, ChatChunk::Reasoning(text.to_string()));
                    }
                }
            }
            if let Some(content) = delta.get("content").and_then(Value::as_str) {
                self.emit(on_chunk, ChatChunk::Delta(content.to_string()));
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    self.apply_tool_call(call);
                }
            }
        }
        if let Some(raw_usage) = value.get("usage").filter(|usage| !usage.is_null()) {
            self.usage = parse_usage(raw_usage, self.pricing);
            on_chunk(ChatChunk::Usage(self.usage.clone()));
        }
        Ok(())
    }

    fn emit(&mut self, on_chunk: &mut (dyn FnMut(ChatChunk) + Send), chunk: ChatChunk) {
        let empty = match &chunk {
            ChatChunk::Delta(text) | ChatChunk::Reasoning(text) => text.is_empty(),
            ChatChunk::Usage(_) => false,
        };
        if !empty {
            self.emitted = true;
            on_chunk(chunk);
        }
    }

    fn apply_tool_call(&mut self, call: &Value) {
        let id = call.get("id").and_then(Value::as_str).unwrap_or("");
        let index = match call.get("index").and_then(Value::as_u64) {
            Some(index) => index,
            // Gemini omits the index; a new id starts a new call.
            None => match self.tool_calls.iter().next_back() {
                Some((&last, entry)) if id.is_empty() || entry.id == id => last,
                Some((&last, _)) => last + 1,
                None => 0,
            },
        };
        self.emitted = true;
        let entry = self.tool_calls.entry(index).or_default();
        if !id.is_empty() {
            entry.id = id.to_string();
        }
        if let Some(function) = call.get("function") {
            if let Some(name) = function.get("name").and_then(Value::as_str) {
                if !name.is_empty() {
                    entry.name = name.to_string();
                }
            }
            match function.get("arguments") {
                Some(Value::String(arguments)) => entry.arguments.push_str(arguments),
                // Some servers send the finished object instead of a string.
                Some(arguments @ Value::Object(_)) => entry.arguments = arguments.to_string(),
                _ => {}
            }
        }
    }

    pub fn finish(self, cancelled: bool) -> ChatOutcome {
        ChatOutcome {
            usage: self.usage,
            cancelled,
            tool_calls: self
                .tool_calls
                .into_iter()
                .map(|(index, mut call)| {
                    if call.id.is_empty() {
                        call.id = format!("call_{index}");
                    }
                    call
                })
                .collect(),
            provider_content: None,
        }
    }
}

pub(crate) fn parse_usage(value: &Value, pricing: Option<Pricing>) -> ChatUsage {
    let int = |value: Option<&Value>| value.and_then(Value::as_i64);
    let details = value.get("prompt_tokens_details");
    let prompt_tokens = int(value.get("prompt_tokens")).unwrap_or(0);
    let completion_tokens = int(value.get("completion_tokens")).unwrap_or(0);
    let cached_tokens = int(details.and_then(|details| details.get("cached_tokens")))
        // DeepSeek reports its cache hits separately.
        .or_else(|| int(value.get("prompt_cache_hit_tokens")))
        .unwrap_or(0);
    let cache_write_tokens = int(details.and_then(|details| {
        details
            .get("cache_write_tokens")
            .or_else(|| details.get("cache_creation_input_tokens"))
    }))
    .or_else(|| int(value.get("cache_creation_input_tokens")))
    .unwrap_or(0);
    let mut cost = value.get("cost").and_then(Value::as_f64).unwrap_or(0.0);
    if cost == 0.0 {
        if let Some(price) = pricing {
            let cached = cached_tokens.min(prompt_tokens);
            cost = (prompt_tokens - cached) as f64 * price.prompt
                + cached as f64 * price.cache_read
                + completion_tokens as f64 * price.completion;
        }
    }
    ChatUsage {
        prompt_tokens,
        completion_tokens,
        cached_tokens,
        cache_write_tokens,
        cost,
    }
}

pub(crate) fn describe_error(error: &Value) -> String {
    if let Some(text) = error.as_str() {
        return text.to_string();
    }
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("unknown provider error");
    let metadata = error.get("metadata");
    let mut detail = message.to_string();
    if let Some(error_type) = metadata
        .and_then(|metadata| metadata.get("error_type"))
        .and_then(Value::as_str)
    {
        detail.push_str(&format!(" [error_type: {error_type}]"));
    }
    if let Some(provider) = metadata
        .and_then(|metadata| metadata.get("provider_name"))
        .and_then(Value::as_str)
    {
        detail.push_str(&format!(" [provider: {provider}]"));
    }
    if let Some(raw) = metadata
        .and_then(|metadata| metadata.get("raw"))
        .and_then(Value::as_str)
    {
        detail.push_str(&format!(": {raw}"));
    } else if let Some(provider_code) = metadata
        .and_then(|metadata| metadata.get("provider_code"))
        .and_then(Value::as_str)
    {
        detail.push_str(&format!(" [provider_code: {provider_code}]"));
    }
    detail
}

/// An HTTP error from a Chat Completions API, with the provider's message.
pub(crate) fn provider_error(label: &str, status: u16, body: &str) -> AppError {
    let parsed = serde_json::from_str::<Value>(body).ok();
    // Most APIs wrap errors in `error`; some return a list of them (Gemini)
    // or a bare `message`/`detail` (Mistral).
    let error = parsed.as_ref().and_then(|value| {
        value
            .get("error")
            .or_else(|| value.as_array().and_then(|list| list.first()?.get("error")))
    });
    let message = match error {
        Some(Value::String(text)) => text.clone(),
        Some(error) => describe_error(error),
        None => parsed
            .as_ref()
            .and_then(|value| value.get("message").or_else(|| value.get("detail")))
            .map(|value| match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
            .unwrap_or_else(|| body.chars().take(500).collect()),
    };
    AppError::msg(format!("{label} error ({status}): {message}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(events: &[Value]) -> (ChatOutcome, Vec<ChatChunk>) {
        let mut chunks = Vec::new();
        let mut state = StreamState::new(Some(Pricing {
            prompt: 1e-6,
            completion: 4e-6,
            cache_read: 0.25e-6,
        }));
        for event in events {
            state
                .apply(event, &mut |chunk| chunks.push(chunk))
                .expect("event applies");
        }
        (state.finish(false), chunks)
    }

    #[test]
    fn reasoning_content_text_and_tool_calls_fold_together() {
        let (outcome, chunks) = run(&[
            json!({ "choices": [{ "delta": { "reasoning_content": "Think." } }] }),
            json!({ "choices": [{ "delta": { "content": "Reading." } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [
                { "index": 0, "id": "call_a", "function": { "name": "read", "arguments": "{\"pa" } }
            ] } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [
                { "index": 0, "function": { "arguments": "th\":\"a\"}" } }
            ] } }] }),
            json!({ "choices": [], "usage": {
                "prompt_tokens": 1000, "completion_tokens": 100,
                "prompt_tokens_details": { "cached_tokens": 800 } } }),
        ]);
        assert!(matches!(&chunks[0], ChatChunk::Reasoning(text) if text == "Think."));
        assert!(matches!(&chunks[1], ChatChunk::Delta(text) if text == "Reading."));
        assert_eq!(outcome.tool_calls.len(), 1);
        assert_eq!(outcome.tool_calls[0].arguments, "{\"path\":\"a\"}");
        assert_eq!(outcome.usage.cached_tokens, 800);
        // 200 uncached * 1 + 800 cached * 0.25 + 100 * 4, per million.
        assert!((outcome.usage.cost - 0.0008).abs() < 1e-12);
    }

    #[test]
    fn calls_without_an_index_are_told_apart_by_id() {
        let (outcome, _) = run(&[json!({ "choices": [{ "delta": { "tool_calls": [
                { "id": "a", "function": { "name": "read", "arguments": "{}" } },
                { "id": "b", "function": { "name": "ls", "arguments": { "path": "." } } }
            ] } }] })]);
        assert_eq!(outcome.tool_calls.len(), 2);
        assert_eq!(outcome.tool_calls[1].name, "ls");
        assert_eq!(outcome.tool_calls[1].arguments, "{\"path\":\".\"}");
    }

    #[test]
    fn null_fields_count_as_absent() {
        let (_, chunks) = run(&[
            json!({ "error": null, "choices": [{ "delta": {
                "reasoning": null, "reasoning_content": "Hmm." } }] }),
            json!({ "choices": [{ "delta": { "content": "Hi" } }], "usage": null }),
        ]);
        assert!(matches!(&chunks[0], ChatChunk::Reasoning(text) if text == "Hmm."));
        assert!(matches!(&chunks[1], ChatChunk::Delta(text) if text == "Hi"));
        assert_eq!(chunks.len(), 2);
    }

    #[test]
    fn a_plain_text_stream_error_keeps_its_message() {
        let mut state = StreamState::new(None);
        let error = state
            .apply(&json!({ "error": "model not found" }), &mut |_| {})
            .unwrap_err();
        assert_eq!(error.to_string(), "model not found");
    }

    #[test]
    fn deepseek_cache_hits_count_as_cached() {
        let usage = parse_usage(
            &json!({ "prompt_tokens": 10, "completion_tokens": 1, "prompt_cache_hit_tokens": 6 }),
            None,
        );
        assert_eq!(usage.cached_tokens, 6);
        assert_eq!(usage.cost, 0.0);
    }

    #[test]
    fn a_rejected_optional_field_is_named() {
        let body = json!({ "model": "m", "reasoning_effort": "high", "stream_options": {} });
        let error =
            r#"{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}"#;
        let optional = ["stream_options", "reasoning_effort"];
        assert_eq!(
            rejected_field(&body, error, &optional).as_deref(),
            Some("reasoning_effort")
        );
        assert_eq!(rejected_field(&json!({}), error, &optional), None);
    }

    #[test]
    fn errors_read_every_common_shape() {
        let openai = provider_error(
            "OpenAI",
            401,
            r#"{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}"#,
        );
        assert!(openai
            .to_string()
            .contains("OpenAI error (401): Incorrect API key"));
        let gemini = provider_error(
            "Google Gemini",
            400,
            r#"[{"error":{"code":400,"message":"API key not valid"}}]"#,
        );
        assert!(gemini.to_string().contains("API key not valid"));
        let mistral = provider_error("Mistral", 401, r#"{"message":"Unauthorized"}"#);
        assert!(mistral.to_string().contains("Unauthorized"));
        let plain = provider_error("X", 500, "upstream exploded");
        assert!(plain.to_string().contains("upstream exploded"));
    }

    #[test]
    fn openrouter_errors_keep_their_metadata() {
        let body = r#"{"error":{"code":400,"message":"Provider returned error","metadata":{"error_type":"context_length_exceeded","provider_name":"OpenAI","raw":"maximum context length is 128000 tokens"}}}"#;
        let error = provider_error("OpenRouter", 400, body).to_string();
        assert!(error.contains("Provider returned error"));
        assert!(error.contains("error_type: context_length_exceeded"));
        assert!(error.contains("provider: OpenAI"));
        assert!(error.contains("maximum context length is 128000 tokens"));
    }
}
