use crate::error::{AppError, Result};
use crate::models::{EndpointInfo, ModelInfo, ProviderInfo};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

pub const DEFAULT_BASE_URL: &str = "https://openrouter.ai/api/v1";

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ChatMessage {
    pub fn text(role: &str, content: impl Into<String>) -> Self {
        Self {
            role: role.to_string(),
            content: Value::String(content.into()),
            tool_calls: None,
            tool_call_id: None,
        }
    }

    pub fn parts(role: &str, content: Value) -> Self {
        Self {
            role: role.to_string(),
            content,
            tool_calls: None,
            tool_call_id: None,
        }
    }

    pub fn assistant_tool_calls(content: String, tool_calls: Value) -> Self {
        Self {
            role: "assistant".to_string(),
            content: Value::String(content),
            tool_calls: Some(tool_calls),
            tool_call_id: None,
        }
    }

    pub fn tool_result(call_id: &str, content: impl Into<String>) -> Self {
        Self {
            role: "tool".to_string(),
            content: Value::String(content.into()),
            tool_calls: None,
            tool_call_id: Some(call_id.to_string()),
        }
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

#[derive(Debug, Clone, Default)]
pub struct ProviderRouting {
    pub order: Vec<String>,
    pub allow_fallbacks: bool,
    /// OpenRouter routing preference: "price", "throughput" or "latency".
    pub sort: Option<String>,
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

    fn to_json(&self) -> Value {
        match self {
            Self::Off => json!({ "enabled": false }),
            Self::Effort(effort) => json!({ "effort": effort }),
            Self::MaxTokens(tokens) => json!({ "max_tokens": tokens }),
        }
    }
}

pub struct ChatOutcome {
    pub usage: ChatUsage,
    pub cancelled: bool,
    pub tool_calls: Vec<crate::models::ToolCallRecord>,
}

/// Credit limits reported by `GET /key` for the API key in use. Both fields are
/// `None` when the key is unlimited and therefore has no budget to display.
#[derive(Debug, Clone, Default)]
pub struct KeyInfo {
    pub limit: Option<f64>,
    pub limit_remaining: Option<f64>,
}

#[derive(Clone)]
pub struct OpenRouterClient {
    http: reqwest::Client,
    base_url: String,
}

impl OpenRouterClient {
    pub fn new(http: reqwest::Client, base_url: impl Into<String>) -> Self {
        Self {
            http,
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        api_key: &str,
    ) -> reqwest::RequestBuilder {
        let mut request = self
            .http
            .request(method, format!("{}{}", self.base_url, path))
            .header("HTTP-Referer", "https://github.com/pumr")
            .header("X-Title", "pumr");
        if !api_key.trim().is_empty() {
            request = request.bearer_auth(api_key);
        }
        request
    }

    pub async fn list_models(&self, api_key: &str) -> Result<Vec<ModelInfo>> {
        let response = self
            .request(reqwest::Method::GET, "/models", api_key)
            .send()
            .await?;
        let status = response.status();
        let body = response.text().await?;
        if !status.is_success() {
            return Err(openrouter_error(status.as_u16(), &body));
        }
        let parsed: ModelsResponse = serde_json::from_str(&body)
            .map_err(|err| AppError::msg(format!("invalid model list: {err}")))?;
        let mut models: Vec<ModelInfo> = parsed
            .data
            .into_iter()
            .map(|raw| {
                let parameters = raw.supported_parameters.unwrap_or_default();
                let modalities = raw
                    .architecture
                    .and_then(|arch| arch.input_modalities)
                    .unwrap_or_default();
                ModelInfo {
                    id: raw.id,
                    name: raw.name.unwrap_or_default(),
                    description: raw.description.unwrap_or_default(),
                    context_length: raw.context_length.unwrap_or(0),
                    prompt_price_per_m: price_per_million(raw.pricing.as_ref(), "prompt"),
                    completion_price_per_m: price_per_million(raw.pricing.as_ref(), "completion"),
                    cache_read_price_per_m: price_per_million(
                        raw.pricing.as_ref(),
                        "input_cache_read",
                    ),
                    supports_reasoning: parameters.iter().any(|p| {
                        p == "reasoning" || p == "include_reasoning" || p == "reasoning_effort"
                    }),
                    supports_vision: modalities.iter().any(|m| m == "image"),
                    supports_tools: parameters.iter().any(|p| p == "tools"),
                    input_modalities: modalities,
                    supported_parameters: parameters,
                    created: raw.created.unwrap_or(0),
                }
            })
            .collect();
        models.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(models)
    }

    pub async fn list_endpoints(&self, api_key: &str, model_id: &str) -> Result<Vec<EndpointInfo>> {
        let path = format!("/models/{model_id}/endpoints");
        let response = self
            .request(reqwest::Method::GET, &path, api_key)
            .send()
            .await?;
        let status = response.status();
        let body = response.text().await?;
        if !status.is_success() {
            return Err(openrouter_error(status.as_u16(), &body));
        }
        let parsed: EndpointsResponse = serde_json::from_str(&body)
            .map_err(|err| AppError::msg(format!("invalid endpoint list: {err}")))?;
        let endpoints = parsed
            .data
            .endpoints
            .into_iter()
            .map(|raw| {
                let provider_name = raw
                    .provider_name
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string());
                let tag = raw.tag.clone().unwrap_or_default();
                let provider_slug = tag
                    .split('/')
                    .next()
                    .filter(|part| !part.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| slugify(&provider_name));
                EndpointInfo {
                    name: raw.name.clone().unwrap_or_else(|| provider_name.clone()),
                    slug: tag,
                    provider_name,
                    provider_slug,
                    context_length: raw.context_length.unwrap_or(0),
                    prompt_price_per_m: price_per_million(raw.pricing.as_ref(), "prompt"),
                    completion_price_per_m: price_per_million(raw.pricing.as_ref(), "completion"),
                    cache_read_price_per_m: price_per_million(
                        raw.pricing.as_ref(),
                        "input_cache_read",
                    ),
                    uptime_last_5m: metric_value(raw.uptime_last_5m.as_ref()),
                    uptime_last_30m: metric_value(raw.uptime_last_30m.as_ref()),
                    uptime_last_1d: metric_value(raw.uptime_last_1d.as_ref()),
                    throughput_last_30m: metric_value(raw.throughput_last_30m.as_ref())
                        .or_else(|| stat_value(raw.stats.as_ref(), "p50_throughput"))
                        .or_else(|| {
                            workload_metric(raw.perf_last_30m_by_workload.as_ref(), "throughput")
                        }),
                    latency_last_30m: metric_value(raw.latency_last_30m.as_ref())
                        .or_else(|| stat_value(raw.stats.as_ref(), "p50_latency"))
                        .or_else(|| {
                            workload_metric(raw.perf_last_30m_by_workload.as_ref(), "latency")
                        }),
                    max_completion_tokens: raw.max_completion_tokens,
                    quantization: raw.quantization,
                    supports_implicit_caching: raw.supports_implicit_caching.unwrap_or(false),
                    training: raw.data_policy.as_ref().and_then(|policy| policy.training),
                    retains_prompts: raw
                        .data_policy
                        .as_ref()
                        .and_then(|policy| policy.retains_prompts),
                }
            })
            .collect();
        Ok(endpoints)
    }

    pub async fn list_providers(&self, api_key: &str) -> Result<Vec<ProviderInfo>> {
        let response = self
            .request(reqwest::Method::GET, "/providers", api_key)
            .send()
            .await?;
        let status = response.status();
        let body = response.text().await?;
        if !status.is_success() {
            return Err(openrouter_error(status.as_u16(), &body));
        }
        let parsed: ProvidersResponse = serde_json::from_str(&body)
            .map_err(|err| AppError::msg(format!("invalid provider list: {err}")))?;
        let providers = parsed
            .data
            .into_iter()
            .map(|raw| ProviderInfo {
                icon_url: provider_icon_url(
                    raw.terms_of_service_url.as_deref(),
                    raw.privacy_policy_url.as_deref(),
                ),
                slug: raw.slug,
                name: raw.name,
                headquarters: raw.headquarters,
            })
            .collect();
        Ok(providers)
    }

    pub async fn get_key_info(&self, api_key: &str) -> Result<KeyInfo> {
        let response = self
            .request(reqwest::Method::GET, "/key", api_key)
            .send()
            .await?;
        let status = response.status();
        let body = response.text().await?;
        if !status.is_success() {
            return Err(openrouter_error(status.as_u16(), &body));
        }
        let parsed: KeyResponse = serde_json::from_str(&body)
            .map_err(|err| AppError::msg(format!("invalid key info: {err}")))?;
        Ok(KeyInfo {
            limit: parsed.data.limit,
            limit_remaining: parsed.data.limit_remaining,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn stream_chat(
        &self,
        api_key: &str,
        model: &str,
        messages: Vec<ChatMessage>,
        reasoning: Option<ReasoningSetting>,
        routing: Option<ProviderRouting>,
        fallback_pricing: Option<(f64, f64)>,
        tools: &[Value],
        prompt_caching: bool,
        cancel: CancellationToken,
        on_chunk: &mut (dyn FnMut(ChatChunk) + Send),
    ) -> Result<ChatOutcome> {
        let mut body = json!({
            "model": model,
            "messages": messages,
            "stream": true,
            "usage": { "include": true }
        });
        if !tools.is_empty() {
            body["tools"] = Value::Array(tools.to_vec());
            body["tool_choice"] = json!("auto");
        }
        if let Some(reasoning) = reasoning {
            body["reasoning"] = reasoning.to_json();
        }
        if let Some(routing) = routing {
            if !routing.order.is_empty() || routing.sort.is_some() {
                let mut provider = json!({
                    "allow_fallbacks": routing.allow_fallbacks
                });
                if !routing.order.is_empty() {
                    provider["order"] = json!(routing.order);
                }
                if let Some(sort) = routing.sort {
                    provider["sort"] = json!(sort);
                }
                body["provider"] = provider;
            }
        }

        apply_prompt_cache(&mut body, prompt_caching);

        let mut attempt = 0usize;
        'attempt: loop {
            attempt += 1;
            let response = tokio::select! {
                _ = cancel.cancelled() => return Ok(cancelled_outcome()),
                response = self
                    .request(reqwest::Method::POST, "/chat/completions", api_key)
                    .json(&body)
                    .send() => response,
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
                if retryable_status(status_code) && attempt <= MAX_STREAM_RETRIES {
                    if wait_backoff(attempt, retry_after, &cancel).await {
                        continue;
                    }
                    return Ok(cancelled_outcome());
                }
                return Err(openrouter_error(status_code, &body_text));
            }

            let mut usage = ChatUsage::default();
            let mut buffer = String::new();
            let mut cancelled = false;
            let mut emitted = false;
            let mut tool_calls: std::collections::BTreeMap<u64, crate::models::ToolCallRecord> =
                std::collections::BTreeMap::new();
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
                        if !emitted && retryable_reqwest(&error) && attempt <= MAX_STREAM_RETRIES {
                            if wait_backoff(attempt, None, &cancel).await {
                                continue 'attempt;
                            }
                            return Ok(cancelled_outcome());
                        }
                        return Err(error.into());
                    }
                };
                buffer.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(index) = buffer.find('\n') {
                    let line = buffer[..index].trim().to_string();
                    buffer.drain(..=index);
                    let Some(data) = line.strip_prefix("data:") else {
                        continue;
                    };
                    let data = data.trim();
                    if data.is_empty() {
                        continue;
                    }
                    if data == "[DONE]" {
                        continue;
                    }
                    let Ok(value) = serde_json::from_str::<Value>(data) else {
                        continue;
                    };
                    if let Some(error) = value.get("error") {
                        return Err(AppError::msg(describe_error(error)));
                    }
                    if let Some(delta) = value
                        .get("choices")
                        .and_then(Value::as_array)
                        .and_then(|choices| choices.first())
                        .and_then(|choice| choice.get("delta"))
                    {
                        if let Some(reasoning) = delta.get("reasoning").and_then(Value::as_str) {
                            if !reasoning.is_empty() {
                                emitted = true;
                                on_chunk(ChatChunk::Reasoning(reasoning.to_string()));
                            }
                        } else if let Some(details) =
                            delta.get("reasoning_details").and_then(Value::as_array)
                        {
                            for detail in details {
                                if let Some(text) = detail.get("text").and_then(Value::as_str) {
                                    if !text.is_empty() {
                                        emitted = true;
                                        on_chunk(ChatChunk::Reasoning(text.to_string()));
                                    }
                                }
                            }
                        }
                        if let Some(content) = delta.get("content").and_then(Value::as_str) {
                            if !content.is_empty() {
                                emitted = true;
                                on_chunk(ChatChunk::Delta(content.to_string()));
                            }
                        }
                        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                            for call in calls {
                                let index =
                                    call.get("index").and_then(Value::as_u64).unwrap_or(0);
                                let entry = tool_calls.entry(index).or_default();
                                if let Some(id) = call.get("id").and_then(Value::as_str) {
                                    if !id.is_empty() {
                                        entry.id = id.to_string();
                                    }
                                }
                                if let Some(function) = call.get("function") {
                                    if let Some(name) =
                                        function.get("name").and_then(Value::as_str)
                                    {
                                        if !name.is_empty() {
                                            entry.name = name.to_string();
                                        }
                                    }
                                    if let Some(arguments) =
                                        function.get("arguments").and_then(Value::as_str)
                                    {
                                        entry.arguments.push_str(arguments);
                                    }
                                }
                            }
                        }
                    }
                    if let Some(raw_usage) = value.get("usage") {
                        if !raw_usage.is_null() {
                            usage = parse_usage(raw_usage, fallback_pricing);
                            on_chunk(ChatChunk::Usage(usage.clone()));
                        }
                    }
                }
            }

            return Ok(ChatOutcome {
                usage,
                cancelled,
                tool_calls: tool_calls
                    .into_iter()
                    .map(|(index, mut call)| {
                        if call.id.is_empty() {
                            call.id = format!("call_{index}");
                        }
                        call
                    })
                    .collect(),
            });
        }
    }
}

const MAX_STREAM_RETRIES: usize = 4;
const RETRY_BASE_MS: u64 = 800;
const RETRY_MAX_MS: u64 = 20_000;

fn cancelled_outcome() -> ChatOutcome {
    ChatOutcome {
        usage: ChatUsage::default(),
        cancelled: true,
        tool_calls: Vec::new(),
    }
}

fn retryable_status(status: u16) -> bool {
    matches!(
        status,
        408 | 409 | 425 | 429 | 500 | 502 | 503 | 504 | 520 | 522 | 524
    )
}

fn retryable_reqwest(error: &reqwest::Error) -> bool {
    error.is_timeout() || error.is_connect() || error.is_request()
}

/// Parses a `Retry-After` header. Only the delay-in-seconds form is honoured;
/// the HTTP-date form falls back to the computed backoff.
fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

/// Exponential backoff with a small jitter, capped and cancel-aware. Returns
/// `true` when the wait completed and the caller should retry, `false` when the
/// cancellation token fired first.
async fn wait_backoff(
    attempt: usize,
    retry_after: Option<u64>,
    cancel: &CancellationToken,
) -> bool {
    let exponent = attempt.saturating_sub(1).min(6) as u32;
    let base = RETRY_BASE_MS.saturating_mul(1u64 << exponent).min(RETRY_MAX_MS);
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

/// Marks the stable prefix (the system message) as cacheable. OpenRouter
/// forwards `cache_control` to providers that support prompt caching and
/// ignores it elsewhere, so the request stays valid for every provider.
fn apply_prompt_cache(body: &mut Value, enabled: bool) {
    if !enabled {
        return;
    }
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    let Some(system) = messages.first_mut() else {
        return;
    };
    if system.get("role").and_then(Value::as_str) != Some("system") {
        return;
    }
    let Some(text) = system.get("content").and_then(Value::as_str) else {
        return;
    };
    let text = text.to_string();
    system["content"] = json!([
        { "type": "text", "text": text, "cache_control": { "type": "ephemeral" } }
    ]);
}

fn parse_usage(value: &Value, fallback_pricing: Option<(f64, f64)>) -> ChatUsage {
    let prompt_tokens = value
        .get("prompt_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let completion_tokens = value
        .get("completion_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let cached_tokens = value
        .get("prompt_tokens_details")
        .and_then(|details| details.get("cached_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let cache_write_tokens = value
        .get("prompt_tokens_details")
        .and_then(|details| {
            details
                .get("cache_write_tokens")
                .or_else(|| details.get("cache_creation_input_tokens"))
        })
        .and_then(Value::as_i64)
        .or_else(|| {
            value
                .get("cache_creation_input_tokens")
                .and_then(Value::as_i64)
        })
        .unwrap_or(0);
    let mut cost = value.get("cost").and_then(Value::as_f64).unwrap_or(0.0);
    if cost == 0.0 {
        if let Some((prompt_price, completion_price)) = fallback_pricing {
            let cached = cached_tokens.min(prompt_tokens);
            cost = (prompt_tokens - cached) as f64 * prompt_price
                + completion_tokens as f64 * completion_price;
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

fn price_per_million(pricing: Option<&Value>, key: &str) -> f64 {
    pricing
        .and_then(|value| value.get(key))
        .and_then(value_as_f64)
        .unwrap_or(0.0)
        * 1_000_000.0
}

fn value_as_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse::<f64>().ok(),
        _ => None,
    }
}

// OpenRouter returns some endpoint metrics either as a plain number or, for
// authenticated requests, as an object of percentile stats (e.g. `p50`).
fn metric_value(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    if let Some(number) = value_as_f64(value) {
        return Some(number);
    }
    let object = value.as_object()?;
    for key in ["p50", "median", "value", "mean", "avg"] {
        if let Some(number) = object.get(key).and_then(value_as_f64) {
            return Some(number);
        }
    }
    object.values().find_map(value_as_f64)
}

fn stat_value(stats: Option<&Value>, key: &str) -> Option<f64> {
    stats
        .and_then(|value| value.get(key))
        .and_then(value_as_f64)
}

// `perf_last_30m_by_workload` is keyed by workload kind (text_generation,
// image_generation, ...). Text generation is the one that reports token
// throughput, so prefer it and otherwise fall back to the first numeric value.
fn workload_metric(workloads: Option<&Value>, metric: &str) -> Option<f64> {
    let workloads = workloads?.as_object()?;
    let preferred = workloads
        .get("text_generation")
        .and_then(|workload| workload.get(metric))
        .and_then(|value| metric_value(Some(value)));
    preferred.or_else(|| {
        workloads
            .values()
            .filter_map(|workload| workload.get(metric))
            .find_map(|value| metric_value(Some(value)))
    })
}

fn slugify(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn url_host(url: &str) -> Option<&str> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let host = rest.split('/').next()?;
    let host = host.strip_prefix("www.").unwrap_or(host);
    (!host.is_empty()).then_some(host)
}

// OpenRouter shows provider icons via Google's favicon service, keyed by the
// provider's website hostname. We derive that from its terms/privacy URLs.
fn provider_icon_url(terms: Option<&str>, privacy: Option<&str>) -> Option<String> {
    let host = terms
        .and_then(url_host)
        .or_else(|| privacy.and_then(url_host))?;
    Some(format!(
        "https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://{host}&size=128"
    ))
}

fn describe_error(error: &Value) -> String {
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

fn openrouter_error(status: u16, body: &str) -> AppError {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| value.get("error").map(describe_error))
        .unwrap_or_else(|| body.chars().take(500).collect());
    AppError::msg(format!("OpenRouter error ({status}): {message}"))
}

#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<RawModel>,
}

#[derive(Deserialize)]
struct RawModel {
    id: String,
    name: Option<String>,
    description: Option<String>,
    context_length: Option<i64>,
    created: Option<i64>,
    pricing: Option<Value>,
    architecture: Option<RawArchitecture>,
    supported_parameters: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct RawArchitecture {
    input_modalities: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct EndpointsResponse {
    data: RawEndpoints,
}

#[derive(Deserialize)]
struct RawEndpoints {
    endpoints: Vec<RawEndpoint>,
}

#[derive(Deserialize)]
struct RawEndpoint {
    name: Option<String>,
    tag: Option<String>,
    provider_name: Option<String>,
    context_length: Option<i64>,
    pricing: Option<Value>,
    uptime_last_5m: Option<Value>,
    uptime_last_30m: Option<Value>,
    uptime_last_1d: Option<Value>,
    throughput_last_30m: Option<Value>,
    latency_last_30m: Option<Value>,
    perf_last_30m_by_workload: Option<Value>,
    max_completion_tokens: Option<i64>,
    quantization: Option<String>,
    supports_implicit_caching: Option<bool>,
    #[serde(default, alias = "dataPolicy")]
    data_policy: Option<RawDataPolicy>,
    stats: Option<Value>,
}

#[derive(Deserialize)]
struct RawDataPolicy {
    #[serde(default)]
    training: Option<bool>,
    #[serde(default, alias = "retainsPrompts")]
    retains_prompts: Option<bool>,
}

#[derive(Deserialize)]
struct ProvidersResponse {
    data: Vec<RawProvider>,
}

#[derive(Deserialize)]
struct RawProvider {
    slug: String,
    name: String,
    headquarters: Option<String>,
    privacy_policy_url: Option<String>,
    terms_of_service_url: Option<String>,
}

#[derive(Deserialize)]
struct KeyResponse {
    data: RawKey,
}

#[derive(Deserialize)]
struct RawKey {
    limit: Option<f64>,
    limit_remaining: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_metrics_accept_objects() {
        let body = r#"{"data":{"endpoints":[{"name":"X","uptime_last_30m":{"p50":99.5},"throughput_last_30m":{"p50":12.5},"latency_last_30m":{"p50":250.0}}]}}"#;
        let parsed: EndpointsResponse = serde_json::from_str(body).expect("parse");
        let endpoint = &parsed.data.endpoints[0];
        assert_eq!(metric_value(endpoint.uptime_last_30m.as_ref()), Some(99.5));
        assert_eq!(
            metric_value(endpoint.throughput_last_30m.as_ref()),
            Some(12.5)
        );
        assert_eq!(
            metric_value(endpoint.latency_last_30m.as_ref()),
            Some(250.0)
        );
    }

    #[test]
    fn provider_icon_url_uses_policy_host() {
        let icon =
            provider_icon_url(Some("https://www.relace.ai/terms-of-use"), None).expect("icon url");
        assert!(icon.contains("url=https://relace.ai"));
        assert_eq!(url_host("https://openai.com/terms"), Some("openai.com"));
        assert_eq!(slugify("Amazon Bedrock"), "amazon-bedrock");
    }

    #[test]
    fn throughput_prefers_text_generation_workload() {
        let workloads = serde_json::json!({
            "image_generation": { "throughput": { "p50": 3.0 } },
            "text_generation": { "throughput": { "p50": 42.0 }, "latency": { "p50": 120.0 } }
        });
        assert_eq!(workload_metric(Some(&workloads), "throughput"), Some(42.0));
        assert_eq!(workload_metric(Some(&workloads), "latency"), Some(120.0));
        assert_eq!(workload_metric(None, "throughput"), None);
    }

    #[test]
    fn key_info_parses_limits() {
        let body = r#"{"data":{"label":"k","limit":100.0,"limit_remaining":75.5,"usage":24.5}}"#;
        let parsed: KeyResponse = serde_json::from_str(body).expect("parse");
        assert_eq!(parsed.data.limit, Some(100.0));
        assert_eq!(parsed.data.limit_remaining, Some(75.5));
    }

    #[test]
    fn key_info_allows_unlimited() {
        let body = r#"{"data":{"limit":null,"limit_remaining":null}}"#;
        let parsed: KeyResponse = serde_json::from_str(body).expect("parse");
        assert_eq!(parsed.data.limit, None);
        assert_eq!(parsed.data.limit_remaining, None);
    }

    #[test]
    fn provider_error_surfaces_metadata() {
        let body = r#"{"error":{"code":400,"message":"Provider returned error","metadata":{"error_type":"context_length_exceeded","provider_name":"OpenAI","raw":"maximum context length is 128000 tokens"}}}"#;
        let error = openrouter_error(400, body).to_string();
        assert!(error.contains("Provider returned error"));
        assert!(error.contains("error_type: context_length_exceeded"));
        assert!(error.contains("provider: OpenAI"));
        assert!(error.contains("maximum context length is 128000 tokens"));
    }

    #[test]
    fn provider_error_falls_back_to_body() {
        let error = openrouter_error(500, "upstream exploded").to_string();
        assert!(error.contains("upstream exploded"));
    }

    #[tokio::test]
    #[ignore = "requires network access to openrouter.ai"]
    async fn live_models_and_endpoints_parse() {
        let client = OpenRouterClient::new(reqwest::Client::new(), DEFAULT_BASE_URL);
        let models = client.list_models("").await.expect("model list");
        assert!(models.len() > 100, "expected a large model catalog");

        let model = models
            .iter()
            .find(|model| model.id == "anthropic/claude-sonnet-4")
            .expect("known model present");
        assert!(model.prompt_price_per_m > 0.0);
        assert!(model.supports_reasoning);
        assert!(model.supports_vision);

        let endpoints = client
            .list_endpoints("", "anthropic/claude-sonnet-4")
            .await
            .expect("endpoint list");
        assert!(!endpoints.is_empty());
        assert!(endpoints.iter().any(|endpoint| !endpoint.slug.is_empty()));
        assert!(endpoints
            .iter()
            .any(|endpoint| endpoint.prompt_price_per_m > 0.0));
    }
}
