use super::{
    chat_completions, ChatChunk, ChatMessage, ChatOutcome, Pricing, PromptCache, ReasoningSetting,
};
use crate::error::{AppError, Result};
use crate::models::{EndpointInfo, ModelInfo, ProviderInfo};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Default)]
pub struct ProviderRouting {
    pub order: Vec<String>,
    pub allow_fallbacks: bool,
    /// OpenRouter routing preference: "price", "throughput" or "latency".
    pub sort: Option<String>,
}

fn reasoning_json(setting: &ReasoningSetting) -> Value {
    match setting {
        ReasoningSetting::Off => json!({ "enabled": false }),
        ReasoningSetting::Effort(effort) => json!({ "effort": effort }),
        ReasoningSetting::MaxTokens(tokens) => json!({ "max_tokens": tokens }),
    }
}

/// Sampling parameters a routing probe asks for. No endpoint offers all of
/// them, which is what lets OpenRouter turn the probe down before a provider
/// sees it.
const PROBE_PARAMETERS: [&str; 4] = ["top_a", "min_p", "logit_bias", "verbosity"];
/// The routing step a probe is meant to fail at. It comes after the steps that
/// apply the account's own rules.
const PROBE_STEP: &str = "Filter by Parameters";
/// Routing steps that drop endpoints for reasons other than the account's rules.
const NEUTRAL_STEPS: [&str; 2] = ["Initial Endpoints", "Filter by Regional Surcharge"];
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const PROBE_CONCURRENCY: usize = 6;

/// Where OpenRouter's own site loads provider data policies from. The feed is
/// not part of the documented API, so nothing may depend on it being there.
const DATA_POLICY_FEED: &str = "https://openrouter.ai/api/frontend/v1/all-providers";
const DATA_POLICY_TIMEOUT: Duration = Duration::from_secs(5);

/// What a provider does with prompts, as OpenRouter reads its terms.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct DataPolicy {
    pub training: Option<bool>,
    pub retains_prompts: Option<bool>,
}

/// Data policies by provider slug.
pub type DataPolicies = HashMap<String, DataPolicy>;

/// How far a routing probe got in OpenRouter's router.
#[derive(Debug, PartialEq)]
enum ProbeVerdict {
    /// The account may use what was probed. `narrowed` is set when its rules
    /// removed some of the endpoints on the way.
    Allowed { narrowed: bool },
    /// The account's rules left no endpoint, with OpenRouter's explanation.
    Blocked(String),
    /// The answer says nothing about routing.
    Unknown,
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
                    source: super::catalog::OPENROUTER.to_string(),
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
        let probeable = !parsed.data.endpoints.is_empty()
            && parsed.data.endpoints.iter().all(RawEndpoint::rejects_probe);
        let mut endpoints: Vec<EndpointInfo> = parsed
            .data
            .endpoints
            .into_iter()
            .map(endpoint_info)
            .collect();
        if probeable && self.is_openrouter() && !api_key.trim().is_empty() {
            self.mark_blocked(api_key, model_id, &mut endpoints).await;
        }
        Ok(endpoints)
    }

    /// The data policy of every provider, by slug. `None` when the feed cannot
    /// be read; endpoints then carry no policy. The request needs no key.
    pub async fn list_data_policies(&self) -> Option<DataPolicies> {
        if !self.is_openrouter() {
            return None;
        }
        let response = self
            .http
            .get(DATA_POLICY_FEED)
            .timeout(DATA_POLICY_TIMEOUT)
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        parse_data_policies(&response.text().await.ok()?)
    }

    /// Whether requests go to OpenRouter itself. A gateway in front of it, or
    /// in place of it, may not turn a routing probe down.
    fn is_openrouter(&self) -> bool {
        let host = url_host(&self.base_url).unwrap_or_default();
        host == "openrouter.ai" || host.ends_with(".openrouter.ai")
    }

    /// Marks the endpoints the account behind `api_key` may not use: those its
    /// privacy settings, provider lists or guardrails rule out. The endpoint
    /// list is the same for every account, so the router is asked instead,
    /// with requests it turns down before any provider is called. One request
    /// settles the usual case of nothing being blocked.
    async fn mark_blocked(&self, api_key: &str, model_id: &str, endpoints: &mut [EndpointInfo]) {
        match self.probe(api_key, model_id, None).await {
            ProbeVerdict::Blocked(reason) => {
                for endpoint in endpoints.iter_mut() {
                    endpoint.blocked = true;
                    endpoint.blocked_reason = Some(reason.clone());
                }
            }
            ProbeVerdict::Allowed { narrowed: true } => {
                let tags: BTreeSet<String> = endpoints
                    .iter()
                    .map(|endpoint| endpoint.slug.clone())
                    .filter(|tag| !tag.is_empty())
                    .collect();
                let probes: Vec<_> = tags
                    .into_iter()
                    .map(|tag| self.blocked_reason(api_key, model_id, tag))
                    .collect();
                let reasons: HashMap<String, String> = futures_util::stream::iter(probes)
                    .buffer_unordered(PROBE_CONCURRENCY)
                    .filter_map(|blocked| async move { blocked })
                    .collect()
                    .await;
                for endpoint in endpoints.iter_mut() {
                    if let Some(reason) = reasons.get(&endpoint.slug) {
                        endpoint.blocked = true;
                        endpoint.blocked_reason = Some(reason.clone());
                    }
                }
            }
            ProbeVerdict::Allowed { narrowed: false } | ProbeVerdict::Unknown => {}
        }
    }

    /// The endpoint with this tag and why the account may not use it, if so.
    async fn blocked_reason(
        &self,
        api_key: &str,
        model_id: &str,
        tag: String,
    ) -> Option<(String, String)> {
        match self.probe(api_key, model_id, Some(&tag)).await {
            ProbeVerdict::Blocked(reason) => Some((tag, reason)),
            _ => None,
        }
    }

    /// Asks the router whether the account may use a model, or one endpoint of
    /// it when `only` names its tag. A failed request tells nothing.
    async fn probe(&self, api_key: &str, model_id: &str, only: Option<&str>) -> ProbeVerdict {
        let response = self
            .request(reqwest::Method::POST, "/chat/completions", api_key)
            .timeout(PROBE_TIMEOUT)
            .json(&probe_body(model_id, only))
            .send()
            .await;
        let Ok(response) = response else {
            return ProbeVerdict::Unknown;
        };
        if response.status().is_success() {
            return ProbeVerdict::Unknown;
        }
        match response.text().await {
            Ok(body) => probe_verdict(&body),
            Err(_) => ProbeVerdict::Unknown,
        }
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
        pricing: Option<Pricing>,
        tools: &[Value],
        cache: PromptCache<'_>,
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
            body["reasoning"] = reasoning_json(&reasoning);
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

        apply_prompt_cache(&mut body, cache);

        let send = |body: &Value| {
            self.request(reqwest::Method::POST, "/chat/completions", api_key)
                .json(body)
        };
        let request = chat_completions::Request {
            send: &send,
            label: "OpenRouter",
            pricing,
            optional_fields: &["cache_control", "session_id"],
        };
        Ok(chat_completions::stream(request, body, cancel, on_chunk)
            .await?
            .outcome)
    }
}

/// A chat request no endpoint can serve: it requires sampling parameters that
/// no endpoint offers together. OpenRouter applies the account's rules first
/// and names the step that left nothing, so the answer tells whether those
/// rules allow the model, or the one endpoint named by `only`. One token
/// bounds the cost should a provider answer after all.
fn probe_body(model: &str, only: Option<&str>) -> Value {
    let mut provider = json!({ "require_parameters": true });
    if let Some(tag) = only {
        provider["only"] = json!([tag]);
    }
    json!({
        "model": model,
        "messages": [{ "role": "user", "content": "." }],
        "max_tokens": 1,
        "top_a": 0.5,
        "min_p": 0.1,
        "logit_bias": { "1": 1 },
        "verbosity": "low",
        "provider": provider
    })
}

/// Reads the routing steps OpenRouter reports with a request it turned down.
fn probe_verdict(body: &str) -> ProbeVerdict {
    let Ok(parsed) = serde_json::from_str::<Value>(body) else {
        return ProbeVerdict::Unknown;
    };
    let error = &parsed["error"];
    let metadata = &error["metadata"];
    let Some(failed) = metadata["failed_routing_step"].as_str() else {
        return ProbeVerdict::Unknown;
    };
    if failed != PROBE_STEP {
        let reason = error["message"].as_str().unwrap_or(failed);
        return ProbeVerdict::Blocked(reason.to_string());
    }
    // Only steps that dropped endpoints are listed. An explicit `only` is such
    // a step too, so this is read for probes of the whole model alone.
    let narrowed = metadata["routing_funnel"].as_array().is_some_and(|steps| {
        steps
            .iter()
            .filter_map(|step| step["step"].as_str())
            .any(|step| !NEUTRAL_STEPS.contains(&step))
    });
    ProbeVerdict::Allowed { narrowed }
}

/// Tells OpenRouter what to cache of the prompt, and where. The system
/// message is marked as cacheable: OpenRouter forwards `cache_control` to
/// providers that cache on request and ignores it elsewhere, so the request
/// stays valid for every provider. Claude models also get the top-level
/// marker, which caches the conversation up to its newest message, so that
/// every step of a tool loop reads the previous one's prefix from the cache.
/// `session_id` keeps a conversation on the provider endpoint that holds its
/// cache, also for providers that cache on their own.
fn apply_prompt_cache(body: &mut Value, cache: PromptCache<'_>) {
    if !cache.enabled {
        return;
    }
    if let Some(conversation) = cache.conversation {
        body["session_id"] = json!(conversation);
    }
    let claude = body
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|model| model.starts_with("anthropic/"));
    if claude {
        body["cache_control"] = json!({ "type": "ephemeral" });
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

/// An endpoint as the picker shows it. What its provider does with prompts is
/// not part of the endpoint list and is filled in by `apply_data_policies`.
fn endpoint_info(raw: RawEndpoint) -> EndpointInfo {
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
        cache_read_price_per_m: price_per_million(raw.pricing.as_ref(), "input_cache_read"),
        uptime_last_5m: metric_value(raw.uptime_last_5m.as_ref()),
        uptime_last_30m: metric_value(raw.uptime_last_30m.as_ref()),
        uptime_last_1d: metric_value(raw.uptime_last_1d.as_ref()),
        throughput_last_30m: metric_value(raw.throughput_last_30m.as_ref())
            .or_else(|| stat_value(raw.stats.as_ref(), "p50_throughput"))
            .or_else(|| workload_metric(raw.perf_last_30m_by_workload.as_ref(), "throughput")),
        latency_last_30m: metric_value(raw.latency_last_30m.as_ref())
            .or_else(|| stat_value(raw.stats.as_ref(), "p50_latency"))
            .or_else(|| workload_metric(raw.perf_last_30m_by_workload.as_ref(), "latency")),
        max_completion_tokens: raw.max_completion_tokens,
        quantization: raw.quantization,
        supports_implicit_caching: raw.supports_implicit_caching.unwrap_or(false),
        training: None,
        retains_prompts: None,
        blocked: false,
        blocked_reason: None,
    }
}

/// Reads the provider feed leniently: a provider without a usable policy is
/// skipped, and a feed without any yields nothing.
fn parse_data_policies(body: &str) -> Option<DataPolicies> {
    let parsed: Value = serde_json::from_str(body).ok()?;
    let policies: DataPolicies = parsed
        .get("data")?
        .as_array()?
        .iter()
        .filter_map(|provider| {
            let slug = provider.get("slug")?.as_str()?;
            let raw = provider.get("dataPolicy")?;
            let policy = DataPolicy {
                training: raw.get("training").and_then(Value::as_bool),
                retains_prompts: raw.get("retainsPrompts").and_then(Value::as_bool),
            };
            (policy != DataPolicy::default()).then(|| (slug.to_string(), policy))
        })
        .collect();
    (!policies.is_empty()).then_some(policies)
}

/// Fills in what each endpoint's provider does with prompts. The policy is the
/// provider's, so an endpoint with terms of its own is not told apart.
pub fn apply_data_policies(endpoints: &mut [EndpointInfo], policies: &DataPolicies) {
    for endpoint in endpoints {
        if let Some(policy) = policies.get(&endpoint.provider_slug) {
            endpoint.training = policy.training;
            endpoint.retains_prompts = policy.retains_prompts;
        }
    }
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
    chat_completions::provider_error("OpenRouter", status, body)
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
    supported_parameters: Option<Vec<String>>,
    stats: Option<Value>,
}

impl RawEndpoint {
    /// Whether a routing probe is certain to be turned down by this endpoint:
    /// it lacks one of the parameters the probe requires.
    fn rejects_probe(&self) -> bool {
        self.supported_parameters.as_ref().is_some_and(|supported| {
            PROBE_PARAMETERS
                .iter()
                .any(|required| !supported.iter().any(|parameter| parameter == required))
        })
    }
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

    fn request(model: &str) -> Value {
        json!({
            "model": model,
            "messages": [
                { "role": "system", "content": "You are pumr." },
                { "role": "user", "content": "Hi" }
            ]
        })
    }

    #[test]
    fn prompt_caching_marks_the_system_message_and_names_the_conversation() {
        let cache = PromptCache {
            enabled: true,
            conversation: Some("chat-1"),
        };
        let mut body = request("deepseek/deepseek-chat");
        apply_prompt_cache(&mut body, cache);
        assert_eq!(
            body["messages"][0]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
        assert_eq!(body["session_id"], "chat-1");
        // Only Claude models take the marker that caches the conversation.
        assert!(body.get("cache_control").is_none());
        assert_eq!(body["messages"][1]["content"], "Hi");

        let mut body = request("anthropic/claude-sonnet-4.5");
        apply_prompt_cache(&mut body, cache);
        assert_eq!(body["cache_control"]["type"], "ephemeral");

        let mut body = request("anthropic/claude-sonnet-4.5");
        apply_prompt_cache(&mut body, PromptCache::off());
        assert_eq!(body, request("anthropic/claude-sonnet-4.5"));
    }

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
    fn probe_verdict_reads_the_routing_steps() {
        // The account allows every endpoint: only the regional copy was dropped.
        let open = r#"{"error":{"message":"No endpoints found that can handle the requested parameters.","code":404,"metadata":{"routing_funnel":[{"step":"Initial Endpoints","endpoint_count":22},{"step":"Filter by Regional Surcharge","endpoint_count":21}],"failed_routing_step":"Filter by Parameters"}}}"#;
        assert_eq!(
            probe_verdict(open),
            ProbeVerdict::Allowed { narrowed: false }
        );

        // Its data policy removed one of two endpoints.
        let narrowed = r#"{"error":{"message":"No endpoints found that can handle the requested parameters.","code":404,"metadata":{"routing_funnel":[{"step":"Initial Endpoints","endpoint_count":2},{"step":"Filter by Data Policy","endpoint_count":1}],"failed_routing_step":"Filter by Parameters"}}}"#;
        assert_eq!(
            probe_verdict(narrowed),
            ProbeVerdict::Allowed { narrowed: true }
        );

        // Its data policy removed the endpoint that was asked for.
        let blocked = r#"{"error":{"message":"No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy","code":404,"metadata":{"routing_funnel":[{"step":"Initial Endpoints","endpoint_count":2},{"step":"Filter by Allowed Providers","endpoint_count":1,"reason":"not in your request's provider.only preference"}],"failed_routing_step":"Filter by Data Policy"}}}"#;
        assert_eq!(
            probe_verdict(blocked),
            ProbeVerdict::Blocked(
                "No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy"
                    .to_string()
            )
        );

        // Errors that are not about routing, and answers, tell nothing.
        let unauthorized = r#"{"error":{"message":"No auth credentials found","code":401}}"#;
        assert_eq!(probe_verdict(unauthorized), ProbeVerdict::Unknown);
        assert_eq!(probe_verdict(r#"{"choices":[]}"#), ProbeVerdict::Unknown);
        assert_eq!(probe_verdict("<html>"), ProbeVerdict::Unknown);
    }

    #[test]
    fn probes_only_endpoints_that_turn_them_down() {
        let body = r#"{"data":{"endpoints":[
            {"name":"A","supported_parameters":["max_tokens","top_a","min_p","logit_bias","verbosity"]},
            {"name":"B","supported_parameters":["max_tokens","top_a","min_p","logit_bias"]},
            {"name":"C"}
        ]}}"#;
        let parsed: EndpointsResponse = serde_json::from_str(body).expect("parse");
        let rejects: Vec<bool> = parsed
            .data
            .endpoints
            .iter()
            .map(RawEndpoint::rejects_probe)
            .collect();
        // A offers every probe parameter and would answer; C does not say.
        assert_eq!(rejects, [false, true, false]);

        let probe = probe_body("openai/gpt-oss-120b", Some("deepinfra/turbo"));
        assert_eq!(probe["provider"]["require_parameters"], true);
        assert_eq!(probe["provider"]["only"], json!(["deepinfra/turbo"]));
        assert_eq!(probe["max_tokens"], 1);
        for parameter in PROBE_PARAMETERS {
            assert!(probe.get(parameter).is_some(), "{parameter} is not sent");
        }
        assert!(probe_body("openai/gpt-oss-120b", None)["provider"]
            .get("only")
            .is_none());
    }

    #[test]
    fn probes_go_to_openrouter_only() {
        let client = |base: &str| OpenRouterClient::new(reqwest::Client::new(), base);
        assert!(client("https://openrouter.ai/api/v1").is_openrouter());
        assert!(client("https://eu.openrouter.ai/api/v1/").is_openrouter());
        assert!(!client("http://localhost:8080/v1").is_openrouter());
        assert!(!client("https://notopenrouter.ai/api/v1").is_openrouter());
    }

    #[test]
    fn data_policies_are_read_per_provider_and_joined_on_the_slug() {
        let body = r#"{"data":[
            {"slug":"deeptrain","dataPolicy":{"training":true,"retainsPrompts":true}},
            {"slug":"quiet","dataPolicy":{"training":false,"retainsPrompts":false,"retentionDays":3}},
            {"slug":"partial","dataPolicy":{"training":"yes","retainsPrompts":true}},
            {"slug":"bare"},
            {"dataPolicy":{"training":true}},
            "noise"
        ]}"#;
        let policies = parse_data_policies(body).expect("policies");
        assert_eq!(policies.len(), 3);
        assert_eq!(policies["deeptrain"].training, Some(true));
        assert_eq!(policies["quiet"].training, Some(false));
        assert_eq!(policies["partial"].training, None);
        assert_eq!(policies["partial"].retains_prompts, Some(true));

        let body = r#"{"data":{"endpoints":[
            {"provider_name":"DeepTrain","tag":"deeptrain/fp8"},
            {"provider_name":"Quiet","tag":"quiet"},
            {"provider_name":"Other","tag":"other"}
        ]}}"#;
        let parsed: EndpointsResponse = serde_json::from_str(body).expect("endpoints");
        let mut endpoints: Vec<EndpointInfo> = parsed
            .data
            .endpoints
            .into_iter()
            .map(endpoint_info)
            .collect();
        apply_data_policies(&mut endpoints, &policies);
        let training: Vec<_> = endpoints.iter().map(|endpoint| endpoint.training).collect();
        assert_eq!(training, [Some(true), Some(false), None]);
        assert_eq!(endpoints[0].retains_prompts, Some(true));
    }

    #[test]
    fn a_data_policy_feed_of_another_shape_yields_nothing() {
        for body in [
            "",
            "<html>moved</html>",
            r#"{"error":{"message":"Not Found"}}"#,
            r#"{"data":{"providers":[]}}"#,
            r#"{"data":[]}"#,
            r#"{"data":[{"slug":"a","data_policy":{"training":true}}]}"#,
            r#"{"data":[{"slug":"a","dataPolicy":{"trains":true}}]}"#,
        ] {
            assert_eq!(parse_data_policies(body), None, "{body}");
        }
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

    #[tokio::test]
    #[ignore = "requires network access to openrouter.ai"]
    async fn live_models_and_endpoints_parse() {
        let client = OpenRouterClient::new(
            reqwest::Client::new(),
            crate::providers::catalog::openrouter().default_base_url,
        );
        let models = client.list_models("").await.expect("model list");
        assert!(models.len() > 100, "expected a large model catalog");

        let model = models
            .iter()
            .find(|model| model.id == "anthropic/claude-sonnet-4")
            .expect("known model present");
        assert!(model.prompt_price_per_m > 0.0);
        assert!(model.supports_reasoning);
        assert!(model.supports_vision);

        let mut endpoints = client
            .list_endpoints("", "anthropic/claude-sonnet-4")
            .await
            .expect("endpoint list");
        assert!(!endpoints.is_empty());
        assert!(endpoints.iter().any(|endpoint| !endpoint.slug.is_empty()));
        assert!(endpoints
            .iter()
            .any(|endpoint| endpoint.prompt_price_per_m > 0.0));

        let policies = client.list_data_policies().await.expect("data policies");
        apply_data_policies(&mut endpoints, &policies);
        assert!(endpoints.iter().all(|endpoint| endpoint.training.is_some()));
    }
}
