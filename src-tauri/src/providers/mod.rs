//! Model providers. OpenRouter serves its whole catalog; the direct providers
//! in [`catalog`] serve their own models with the user's own key, under ids
//! prefixed with the provider (`openai:gpt-5`), so a stored model id alone
//! decides where a request goes.

pub mod anthropic;
pub mod catalog;
pub(crate) mod chat_completions;
pub mod compat;
pub mod models_dev;
pub mod openrouter;

use crate::config::ModelSettings;
use crate::error::{AppError, Result};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

use anthropic::{AnthropicClient, CapsCache};
use catalog::{ProviderDef, ProviderKind};
use compat::{CompatClient, MetaCache, Quirks};
use openrouter::{OpenRouterClient, ProviderRouting};

/// The API keys of the providers, read from the keychain when first needed.
#[derive(Clone, Default)]
pub struct ProviderKeys {
    cache: Arc<Mutex<HashMap<&'static str, Option<String>>>>,
}

impl ProviderKeys {
    #[cfg(test)]
    pub fn with(keys: &[(&'static str, &str)]) -> Self {
        let this = Self::default();
        {
            let mut cache = this.cache.lock().unwrap();
            for def in catalog::BUILTIN {
                cache.insert(def.id, None);
            }
            for (id, key) in keys {
                cache.insert(id, Some(key.to_string()));
            }
        }
        this
    }

    pub fn get(&self, def: &'static ProviderDef) -> Option<String> {
        let mut cache = self.cache.lock().unwrap();
        cache
            .entry(def.id)
            .or_insert_with(|| {
                crate::config::get_api_key(def.id)
                    .ok()
                    .flatten()
                    .filter(|key| !key.trim().is_empty())
            })
            .clone()
    }

    /// The key for `model`'s provider (empty for local servers), or an error
    /// that says which one to add.
    pub fn require(&self, model: &str) -> Result<String> {
        if let Some(prefix) = catalog::unknown_prefix(model) {
            return Err(AppError::msg(format!(
                "Unknown provider \"{prefix}\". Open Settings → Providers to reload the provider list."
            )));
        }
        let def = catalog::provider_of(model);
        if !def.needs_key() {
            return Ok(String::new());
        }
        self.get(def).ok_or_else(|| {
            AppError::msg(format!(
                "No {} API key configured. Add one in Settings.",
                def.name
            ))
        })
    }
}

/// Price per token; `cache_read` applies to prompt tokens served from cache.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Pricing {
    pub prompt: f64,
    pub completion: f64,
    pub cache_read: f64,
}

/// Sends a chat to whichever provider serves the model, with that provider's key.
#[derive(Clone)]
pub struct LlmClient {
    pub http: reqwest::Client,
    pub settings: ModelSettings,
    pub keys: ProviderKeys,
    pub anthropic_caps: CapsCache,
    pub direct_meta: MetaCache,
    pub quirks: Quirks,
    /// Requests of this client (and its clones) that wait on a provider now.
    pub in_flight: Arc<AtomicUsize>,
}

/// Counts a request as in flight until it is dropped.
struct InFlight(Arc<AtomicUsize>);

impl InFlight {
    fn new(count: &Arc<AtomicUsize>) -> Self {
        count.fetch_add(1, Ordering::SeqCst);
        Self(count.clone())
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl LlmClient {
    /// Whether a request is waiting on a provider: its connection is what a
    /// sleeping machine loses.
    pub fn is_streaming(&self) -> bool {
        self.in_flight.load(Ordering::SeqCst) > 0
    }

    pub fn openrouter(&self) -> OpenRouterClient {
        OpenRouterClient::new(
            self.http.clone(),
            self.settings.provider_base_url(catalog::openrouter()),
        )
    }

    /// A client for Anthropic or a provider with an Anthropic-compatible API.
    pub fn anthropic(&self, def: &'static ProviderDef) -> AnthropicClient {
        AnthropicClient::new(
            self.http.clone(),
            self.settings.provider_base_url(def),
            self.anthropic_caps.clone(),
        )
        .for_provider(def.id)
    }

    /// Whether a key may be stored for `def`. Keys of built-in providers are
    /// always looked up; for the long tail, only where pumr stored one, so
    /// listing providers does not query the keychain two hundred times.
    pub fn may_have_key(&self, def: &ProviderDef) -> bool {
        catalog::BUILTIN.iter().any(|builtin| builtin.id == def.id)
            || self
                .settings
                .providers
                .get(def.id)
                .is_some_and(|entry| entry.key_stored)
    }

    pub fn has_key(&self, def: &'static ProviderDef) -> bool {
        def.needs_key() && self.may_have_key(def) && self.keys.get(def).is_some()
    }

    /// Enabled and, unless local, with a key: its models are listed.
    pub fn connected(&self, def: &'static ProviderDef) -> bool {
        self.settings.provider_enabled(def) && (!def.needs_key() || self.has_key(def))
    }

    pub fn compat(&self, def: &'static ProviderDef) -> CompatClient {
        CompatClient::new(
            self.http.clone(),
            def,
            self.settings.provider_base_url(def),
            self.quirks.clone(),
        )
    }

    /// `fallback_pricing` prices OpenRouter usage that arrives without a cost;
    /// direct providers are priced from their model list.
    #[allow(clippy::too_many_arguments)]
    pub async fn stream_chat(
        &self,
        model: &str,
        messages: Vec<ChatMessage>,
        reasoning: Option<ReasoningSetting>,
        routing: Option<ProviderRouting>,
        fallback_pricing: Option<(f64, f64)>,
        tools: &[Value],
        cache: PromptCache<'_>,
        cancel: CancellationToken,
        on_chunk: &mut (dyn FnMut(ChatChunk) + Send),
    ) -> Result<ChatOutcome> {
        let api_key = self.keys.require(model)?;
        let (def, id) = catalog::split_model(model);
        let _in_flight = InFlight::new(&self.in_flight);
        match def.kind {
            ProviderKind::OpenRouter => {
                let pricing = fallback_pricing.map(|(prompt, completion)| Pricing {
                    prompt,
                    completion,
                    cache_read: 0.0,
                });
                self.openrouter()
                    .stream_chat(
                        &api_key, id, messages, reasoning, routing, pricing, tools, cache, cancel,
                        on_chunk,
                    )
                    .await
            }
            ProviderKind::Anthropic => {
                let price = self
                    .direct_meta
                    .lock()
                    .unwrap()
                    .get(model)
                    .map(|meta| meta.pricing);
                self.anthropic(def)
                    .stream_chat(
                        &api_key,
                        id,
                        messages,
                        reasoning,
                        tools,
                        cache.enabled,
                        price,
                        cancel,
                        on_chunk,
                    )
                    .await
            }
            ProviderKind::OpenAiCompatible => {
                let meta = self.direct_meta.lock().unwrap().get(model).copied();
                self.compat(def)
                    .stream_chat(
                        &api_key,
                        id,
                        messages,
                        reasoning,
                        tools,
                        meta,
                        cache.conversation.filter(|_| cache.enabled),
                        cancel,
                        on_chunk,
                    )
                    .await
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Position of the stored message this was built from; never sent. Lets
    /// the history put a pinned prompt back where it belongs.
    #[serde(skip)]
    pub seq: Option<i64>,
    /// The assistant turn exactly as a direct provider returned it (Anthropic
    /// content blocks, including signed thinking), replayed verbatim to that
    /// provider. Never sent to OpenRouter.
    #[serde(skip)]
    pub provider_content: Option<Value>,
}

impl ChatMessage {
    pub fn text(role: &str, content: impl Into<String>) -> Self {
        Self::parts(role, Value::String(content.into()))
    }

    pub fn parts(role: &str, content: Value) -> Self {
        Self {
            role: role.to_string(),
            content,
            tool_calls: None,
            tool_call_id: None,
            seq: None,
            provider_content: None,
        }
    }

    pub fn assistant_tool_calls(content: String, tool_calls: Value) -> Self {
        Self {
            tool_calls: Some(tool_calls),
            ..Self::text("assistant", content)
        }
    }

    pub fn tool_result(call_id: &str, content: impl Into<String>) -> Self {
        Self {
            tool_call_id: Some(call_id.to_string()),
            ..Self::text("tool", content)
        }
    }
}

/// How a request may use a provider's prompt cache.
#[derive(Debug, Clone, Copy, Default)]
pub struct PromptCache<'a> {
    /// Marks the prompt as cacheable for the providers that have to be told.
    pub enabled: bool,
    /// Names the conversation, so that its requests reach the machine that
    /// holds its cache. Only used when `enabled`.
    pub conversation: Option<&'a str>,
}

impl PromptCache<'_> {
    /// For a one-off request, which has no prefix worth caching.
    pub fn off() -> Self {
        Self::default()
    }
}

#[derive(Debug, Clone, Default)]
pub struct ChatUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    /// Prompt tokens served from the provider's cache (cache read).
    pub cached_tokens: i64,
    /// Prompt tokens written into the provider's cache this request. Providers
    /// that do not report it (or do not support caching) leave this at zero.
    pub cache_write_tokens: i64,
    pub cost: f64,
}

#[derive(Debug, Clone)]
pub enum ChatChunk {
    Delta(String),
    Reasoning(String),
    Usage(ChatUsage),
}

#[derive(Debug, Clone)]
pub enum ReasoningSetting {
    Off,
    Effort(String),
    #[allow(dead_code)]
    MaxTokens(i64),
}

impl ReasoningSetting {
    pub fn from_effort(effort: &str) -> Option<Self> {
        match effort {
            "off" | "none" | "disabled" => Some(Self::Off),
            "default" | "" => None,
            other => Some(Self::Effort(other.to_string())),
        }
    }
}

pub struct ChatOutcome {
    pub usage: ChatUsage,
    pub cancelled: bool,
    pub tool_calls: Vec<crate::models::ToolCallRecord>,
    /// See [`ChatMessage::provider_content`]; `None` for OpenRouter.
    pub provider_content: Option<Value>,
}

pub(crate) const MAX_STREAM_RETRIES: usize = 4;
const RETRY_BASE_MS: u64 = 800;
const RETRY_MAX_MS: u64 = 20_000;

pub(crate) fn cancelled_outcome() -> ChatOutcome {
    ChatOutcome {
        usage: ChatUsage::default(),
        cancelled: true,
        tool_calls: Vec::new(),
        provider_content: None,
    }
}

pub(crate) fn retryable_status(status: u16) -> bool {
    matches!(
        status,
        408 | 409 | 425 | 429 | 500 | 502 | 503 | 504 | 520 | 522 | 524 | 529
    )
}

pub(crate) fn retryable_reqwest(error: &reqwest::Error) -> bool {
    error.is_timeout() || error.is_connect() || error.is_request()
}

/// Parses a `Retry-After` header. Only the delay-in-seconds form is honoured;
/// the HTTP-date form falls back to the computed backoff.
pub(crate) fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

/// Exponential backoff with a small jitter, capped and cancel-aware. Returns
/// `true` when the wait completed and the caller should retry, `false` when the
/// cancellation token fired first.
pub(crate) async fn wait_backoff(
    attempt: usize,
    retry_after: Option<u64>,
    cancel: &CancellationToken,
) -> bool {
    let exponent = attempt.saturating_sub(1).min(6) as u32;
    let base = RETRY_BASE_MS
        .saturating_mul(1u64 << exponent)
        .min(RETRY_MAX_MS);
    let delay_ms = retry_after
        .map(|seconds| seconds.saturating_mul(1_000).min(RETRY_MAX_MS))
        .unwrap_or(base)
        .saturating_add(pseudo_jitter());
    tokio::select! {
        _ = cancel.cancelled() => false,
        _ = tokio::time::sleep(std::time::Duration::from_millis(delay_ms)) => true,
    }
}

fn pseudo_jitter() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| u64::from(elapsed.subsec_nanos() % 250))
        .unwrap_or(0)
}

/// Removes the first complete line from `buffer` and decodes it. `\n` never
/// occurs inside a multi-byte UTF-8 sequence, so a complete line never ends
/// in the middle of a character.
pub(crate) fn take_line(buffer: &mut Vec<u8>) -> Option<String> {
    let index = buffer.iter().position(|byte| *byte == b'\n')?;
    let line = String::from_utf8_lossy(&buffer[..index]).trim().to_string();
    buffer.drain(..=index);
    Some(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_line_keeps_characters_split_across_chunks() {
        let text = "data: {\"content\":\"grüße 👋\"}\n";
        let bytes = text.as_bytes();
        // Split inside the "ü" and inside the emoji.
        let first = text.find('ü').unwrap() + 1;
        let second = text.find('👋').unwrap() + 2;
        let mut buffer = Vec::new();
        buffer.extend_from_slice(&bytes[..first]);
        assert_eq!(take_line(&mut buffer), None);
        buffer.extend_from_slice(&bytes[first..second]);
        assert_eq!(take_line(&mut buffer), None);
        buffer.extend_from_slice(&bytes[second..]);
        assert_eq!(
            take_line(&mut buffer).as_deref(),
            Some("data: {\"content\":\"grüße 👋\"}")
        );
        assert!(buffer.is_empty());
    }

    #[test]
    fn missing_key_names_the_provider() {
        let keys = ProviderKeys::with(&[("openrouter", "sk-or")]);
        assert_eq!(keys.require("openai/gpt-5").unwrap(), "sk-or");
        let error = keys.require("anthropic:claude-opus-5").unwrap_err();
        assert!(error.to_string().contains("No Anthropic API key"));
        let error = keys.require("openai:gpt-5").unwrap_err();
        assert!(error.to_string().contains("No OpenAI API key"));
        // Local servers need none.
        assert_eq!(keys.require("ollama:llama3.1:8b").unwrap(), "");
    }
}
