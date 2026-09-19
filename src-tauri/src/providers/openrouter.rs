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
    pub cached_tokens: i64,
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

        let response = self
            .request(reqwest::Method::POST, "/chat/completions", api_key)
            .json(&body)
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(openrouter_error(status.as_u16(), &body));
        }

        let mut usage = ChatUsage::default();
        let mut buffer = String::new();
        let mut cancelled = false;
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
            let bytes = chunk?;
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
                    let message = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown provider error");
                    return Err(AppError::msg(message.to_string()));
                }
                if let Some(delta) = value
                    .get("choices")
                    .and_then(Value::as_array)
                    .and_then(|choices| choices.first())
                    .and_then(|choice| choice.get("delta"))
                {
                    if let Some(reasoning) = delta.get("reasoning").and_then(Value::as_str) {
                        if !reasoning.is_empty() {
                            on_chunk(ChatChunk::Reasoning(reasoning.to_string()));
                        }
                    } else if let Some(details) =
                        delta.get("reasoning_details").and_then(Value::as_array)
                    {
                        for detail in details {
                            if let Some(text) = detail.get("text").and_then(Value::as_str) {
                                if !text.is_empty() {
                                    on_chunk(ChatChunk::Reasoning(text.to_string()));
                                }
                            }
                        }
                    }
                    if let Some(content) = delta.get("content").and_then(Value::as_str) {
                        if !content.is_empty() {
                            on_chunk(ChatChunk::Delta(content.to_string()));
                        }
                    }
                    if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                        for call in calls {
                            let index = call.get("index").and_then(Value::as_u64).unwrap_or(0);
                            let entry = tool_calls.entry(index).or_default();
                            if let Some(id) = call.get("id").and_then(Value::as_str) {
                                if !id.is_empty() {
                                    entry.id = id.to_string();
                                }
                            }
                            if let Some(function) = call.get("function") {
                                if let Some(name) = function.get("name").and_then(Value::as_str) {
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

        Ok(ChatOutcome {
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
        })
    }
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

fn openrouter_error(status: u16, body: &str) -> AppError {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
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
