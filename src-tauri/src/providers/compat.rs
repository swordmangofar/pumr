//! Direct providers that speak OpenAI's Chat Completions API: OpenAI itself,
//! Google Gemini (its OpenAI endpoint), xAI, Mistral, DeepSeek, Groq and local
//! servers such as Ollama and LM Studio. Their model lists carry little more
//! than ids, so prices, context windows and capabilities come from the
//! OpenRouter catalog, which lists the same models under `<vendor>/<id>`.

use super::catalog::{EffortStyle, KnownModel, ProviderDef};
use super::{chat_completions, ChatChunk, ChatMessage, ChatOutcome, Pricing, ReasoningSetting};
use crate::error::{AppError, Result};
use crate::models::ModelInfo;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

/// What a direct model costs and can do, keyed by its full (prefixed) id.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DirectMeta {
    pub pricing: Pricing,
    pub reasoning: bool,
}

pub type MetaCache = Arc<Mutex<HashMap<String, DirectMeta>>>;

/// Request fields a model turned out not to accept (`model|field`), so they
/// are not sent (and rejected) again.
pub type Quirks = Arc<Mutex<HashSet<String>>>;

/// Body fields some compatible servers reject; dropped and retried then.
const OPTIONAL_FIELDS: &[&str] = &["stream_options", "reasoning_effort"];

/// Model id fragments that never mean a chat model.
const NOT_CHAT: &[&str] = &[
    "embed",
    "tts",
    "whisper",
    "transcribe",
    "dall-e",
    "image",
    "imagen",
    "veo",
    "sora",
    "audio",
    "realtime",
    "moderation",
    "davinci",
    "babbage",
    "aqa",
    "rerank",
    "guard",
    "ocr",
];

#[derive(Clone)]
pub struct CompatClient {
    http: reqwest::Client,
    def: &'static ProviderDef,
    base_url: String,
    quirks: Quirks,
}

/// A model as the provider lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct ListedModel {
    pub id: String,
    pub context_length: Option<i64>,
    /// `false` when the provider says the model cannot chat (Mistral).
    pub chat: bool,
}

impl CompatClient {
    pub fn new(
        http: reqwest::Client,
        def: &'static ProviderDef,
        base_url: impl Into<String>,
        quirks: Quirks,
    ) -> Self {
        Self {
            http,
            def,
            base_url: base_url.into().trim().trim_end_matches('/').to_string(),
            quirks,
        }
    }

    fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        api_key: &str,
    ) -> reqwest::RequestBuilder {
        let request = self
            .http
            .request(method, format!("{}{}", self.base_url, path));
        if api_key.trim().is_empty() {
            request
        } else {
            request.bearer_auth(api_key)
        }
    }

    pub async fn list_models(&self, api_key: &str) -> Result<Vec<ListedModel>> {
        let response = self
            .request(reqwest::Method::GET, "/models", api_key)
            .send()
            .await
            .map_err(|error| {
                if self.def.local && error.is_connect() {
                    AppError::msg(format!(
                        "{} is not running at {}.",
                        self.def.name, self.base_url
                    ))
                } else {
                    error.into()
                }
            })?;
        let status = response.status();
        let body = response.text().await?;
        if !status.is_success() {
            return Err(chat_completions::provider_error(
                self.def.name,
                status.as_u16(),
                &body,
            ));
        }
        let parsed: Value = serde_json::from_str(&body)
            .map_err(|err| AppError::msg(format!("invalid model list: {err}")))?;
        Ok(parse_model_list(&parsed))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn stream_chat(
        &self,
        api_key: &str,
        model: &str,
        messages: Vec<ChatMessage>,
        reasoning: Option<ReasoningSetting>,
        tools: &[Value],
        meta: Option<DirectMeta>,
        cancel: CancellationToken,
        on_chunk: &mut (dyn FnMut(ChatChunk) + Send),
    ) -> Result<ChatOutcome> {
        let effort = reasoning_effort(self.def, reasoning.as_ref(), meta);
        let body = self.request_body(model, &messages, tools, effort);
        let send = |body: &Value| {
            self.request(reqwest::Method::POST, "/chat/completions", api_key)
                .json(body)
        };
        let request = chat_completions::Request {
            send: &send,
            label: self.def.name,
            pricing: meta.map(|meta| meta.pricing),
            optional_fields: OPTIONAL_FIELDS,
        };
        let streamed = chat_completions::stream(request, body, cancel, on_chunk).await?;
        if !streamed.dropped.is_empty() {
            let mut quirks = self.quirks.lock().unwrap();
            for field in streamed.dropped {
                quirks.insert(self.quirk_key(model, &quirk(&field, effort)));
            }
        }
        Ok(streamed.outcome)
    }

    fn quirk_key(&self, model: &str, quirk: &str) -> String {
        format!("{}:{model}|{quirk}", self.def.id)
    }

    fn request_body(
        &self,
        model: &str,
        messages: &[ChatMessage],
        tools: &[Value],
        effort: Option<&str>,
    ) -> Value {
        let accepts = |field: &str| {
            !self
                .quirks
                .lock()
                .unwrap()
                .contains(&self.quirk_key(model, field))
        };
        let mut body = json!({
            "model": model,
            "messages": convert_messages(messages),
            "stream": true,
        });
        if accepts("stream_options") {
            body["stream_options"] = json!({ "include_usage": true });
        }
        if !tools.is_empty() {
            body["tools"] = Value::Array(tools.to_vec());
        }
        if let Some(effort) =
            effort.filter(|effort| accepts(&quirk("reasoning_effort", Some(effort))))
        {
            body["reasoning_effort"] = json!(effort);
        }
        body
    }
}

/// What a rejected field is remembered as. For `reasoning_effort` that is the
/// level sent: a model that rejects one (`minimal`) still takes the others.
fn quirk(field: &str, effort: Option<&str>) -> String {
    match (field, effort) {
        ("reasoning_effort", Some(effort)) => format!("reasoning_effort={effort}"),
        _ => field.to_string(),
    }
}

/// The history in Chat Completions form. An assistant turn that only calls
/// tools gets `null` content, which strict servers require instead of `""`.
fn convert_messages(messages: &[ChatMessage]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| {
            let mut value = serde_json::to_value(message).unwrap_or(Value::Null);
            if message.tool_calls.is_some() && message.content.as_str() == Some("") {
                value["content"] = Value::Null;
            }
            value
        })
        .collect()
}

fn reasoning_effort(
    def: &ProviderDef,
    reasoning: Option<&ReasoningSetting>,
    meta: Option<DirectMeta>,
) -> Option<&'static str> {
    let EffortStyle::ReasoningEffort { off } = def.effort else {
        return None;
    };
    // Unknown models get a try; a rejection is remembered.
    if meta.is_some_and(|meta| !meta.reasoning) {
        return None;
    }
    match reasoning? {
        ReasoningSetting::Off => off,
        ReasoningSetting::Effort(level) => Some(match level.as_str() {
            "minimal" => off.unwrap_or("low"),
            "low" => "low",
            "medium" => "medium",
            _ => "high",
        }),
        ReasoningSetting::MaxTokens(_) => None,
    }
}

fn parse_model_list(value: &Value) -> Vec<ListedModel> {
    let entries = value
        .get("data")
        .or_else(|| value.get("models"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    entries
        .iter()
        .filter_map(|entry| {
            let id = entry
                .get("id")
                .or_else(|| entry.get("name"))
                .and_then(Value::as_str)?;
            // Gemini's OpenAI endpoint lists `models/<id>`.
            let id = id.strip_prefix("models/").unwrap_or(id).to_string();
            let context_length = ["context_window", "context_length", "max_context_length"]
                .iter()
                .find_map(|key| entry.get(*key).and_then(Value::as_i64));
            let chat = entry
                .pointer("/capabilities/completion_chat")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            Some(ListedModel {
                id,
                context_length,
                chat,
            })
        })
        .collect()
}

/// The models models.dev lists for a provider, as if the provider had listed
/// them; for providers without a working `/models` endpoint.
pub fn listed_from_known(known: &HashMap<String, KnownModel>) -> Vec<ListedModel> {
    known
        .iter()
        .map(|(id, model)| ListedModel {
            id: id.clone(),
            context_length: (model.context_length > 0).then_some(model.context_length),
            chat: true,
        })
        .collect()
}

/// A models.dev entry in the shape of a model-picker entry.
fn known_info(model: &KnownModel) -> ModelInfo {
    let mut modalities = vec!["text".to_string()];
    if model.vision {
        modalities.push("image".to_string());
    }
    if model.pdf {
        modalities.push("file".to_string());
    }
    let mut parameters = Vec::new();
    if model.tools {
        parameters.push("tools".to_string());
    }
    if model.reasoning {
        parameters.push("reasoning".to_string());
    }
    ModelInfo {
        id: String::new(),
        name: model.name.clone(),
        description: String::new(),
        context_length: model.context_length,
        prompt_price_per_m: model.prompt_price_per_m,
        completion_price_per_m: model.completion_price_per_m,
        cache_read_price_per_m: model.cache_read_price_per_m.unwrap_or(0.0),
        supports_reasoning: model.reasoning,
        supports_vision: model.vision,
        supports_tools: model.tools,
        input_modalities: modalities,
        supported_parameters: parameters,
        created: model.created,
        source: String::new(),
    }
}

/// Turns a provider's model list into model-picker entries. Prices and
/// capabilities come from models.dev's entry for the provider's own model id
/// (`known`), else from the OpenRouter catalog where it lists the model.
/// Returns the entries and what the chat requests need to know about them.
pub fn build_models(
    def: &'static ProviderDef,
    listed: &[ListedModel],
    catalog: &[ModelInfo],
    known: Option<&HashMap<String, KnownModel>>,
) -> (Vec<ModelInfo>, HashMap<String, DirectMeta>) {
    let by_id: HashMap<&str, &ModelInfo> = catalog
        .iter()
        .map(|model| (model.id.as_str(), model))
        .collect();
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    let mut meta = HashMap::new();
    for entry in listed {
        let lower = entry.id.to_lowercase();
        if !entry.chat
            || NOT_CHAT.iter().any(|part| lower.contains(part))
            || def.exclude.iter().any(|part| lower.contains(part))
            || !seen.insert(entry.id.clone())
        {
            continue;
        }
        let exact = known.and_then(|known| known.get(&entry.id)).map(known_info);
        let known = exact
            .as_ref()
            .or_else(|| catalog_entry(def, &entry.id, &by_id));
        let id = format!("{}{}", def.model_prefix(), entry.id);
        let info = match known {
            Some(known) => ModelInfo {
                id: id.clone(),
                name: display_name(&known.name),
                description: known.description.clone(),
                context_length: entry.context_length.unwrap_or(known.context_length),
                prompt_price_per_m: known.prompt_price_per_m,
                completion_price_per_m: known.completion_price_per_m,
                cache_read_price_per_m: known.cache_read_price_per_m,
                supports_reasoning: known.supports_reasoning,
                supports_vision: known.supports_vision,
                supports_tools: known.supports_tools,
                input_modalities: known.input_modalities.clone(),
                supported_parameters: known.supported_parameters.clone(),
                created: known.created,
                source: def.id.to_string(),
            },
            None => ModelInfo {
                id: id.clone(),
                name: entry.id.clone(),
                description: String::new(),
                context_length: entry.context_length.unwrap_or(0),
                prompt_price_per_m: 0.0,
                completion_price_per_m: 0.0,
                cache_read_price_per_m: 0.0,
                supports_reasoning: false,
                supports_vision: false,
                supports_tools: true,
                input_modalities: vec!["text".to_string()],
                supported_parameters: vec!["tools".to_string()],
                created: 0,
                source: def.id.to_string(),
            },
        };
        // Priced only when the catalog knows the model; local ones are free.
        meta.insert(
            id,
            DirectMeta {
                pricing: pricing_of(&info),
                reasoning: known.is_none_or(|known| known.supports_reasoning),
            },
        );
        models.push(info);
    }
    models.sort_by(|a, b| {
        b.created
            .cmp(&a.created)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    (models, meta)
}

/// Completes a provider's own, fully described model list (Anthropic's has
/// no prices): an unpriced entry takes models.dev's prices for its id. Returns
/// the entries and what the chat requests need to know about them.
pub fn complete_models(
    def: &ProviderDef,
    mut models: Vec<ModelInfo>,
    known: Option<&HashMap<String, KnownModel>>,
) -> (Vec<ModelInfo>, HashMap<String, DirectMeta>) {
    let prefix = def.model_prefix();
    let mut meta = HashMap::new();
    for info in &mut models {
        let unpriced = info.prompt_price_per_m == 0.0 && info.completion_price_per_m == 0.0;
        let id = info.id.strip_prefix(&prefix).unwrap_or(&info.id);
        if let Some(model) = known.and_then(|known| known.get(id)).filter(|_| unpriced) {
            info.prompt_price_per_m = model.prompt_price_per_m;
            info.completion_price_per_m = model.completion_price_per_m;
            info.cache_read_price_per_m = model.cache_read_price_per_m.unwrap_or(0.0);
        }
        meta.insert(
            info.id.clone(),
            DirectMeta {
                pricing: pricing_of(info),
                reasoning: info.supports_reasoning,
            },
        );
    }
    (models, meta)
}

/// A model's prices per token; without a cache price, cached tokens cost
/// what uncached ones do.
fn pricing_of(info: &ModelInfo) -> Pricing {
    let cache_read = if info.cache_read_price_per_m > 0.0 {
        info.cache_read_price_per_m
    } else {
        info.prompt_price_per_m
    };
    Pricing {
        prompt: info.prompt_price_per_m / 1_000_000.0,
        completion: info.completion_price_per_m / 1_000_000.0,
        cache_read: cache_read / 1_000_000.0,
    }
}

/// The OpenRouter entry for a provider's model id, trying the id as listed,
/// without a date or `-latest` suffix, and (for hosts of open models) as a
/// full `vendor/model` id.
fn catalog_entry<'a>(
    def: &ProviderDef,
    id: &str,
    catalog: &HashMap<&str, &'a ModelInfo>,
) -> Option<&'a ModelInfo> {
    let mut candidates = vec![id.to_string()];
    let base = id.strip_suffix("-latest").unwrap_or(id);
    candidates.push(base.to_string());
    candidates.push(strip_version_suffix(base).to_string());
    candidates.iter().find_map(|candidate| {
        let full = match def.catalog_vendor {
            Some(vendor) => format!("{vendor}/{candidate}"),
            None => candidate.clone(),
        };
        catalog.get(full.as_str()).copied()
    })
}

/// Drops a trailing release date (`-2024-08-06`, `-20250514`, `-0709`).
fn strip_version_suffix(id: &str) -> &str {
    let bytes = id.as_bytes();
    let dashed_date = bytes.len() > 11
        && bytes[bytes.len() - 11] == b'-'
        && bytes[bytes.len() - 6] == b'-'
        && bytes[bytes.len() - 3] == b'-'
        && id[id.len() - 10..]
            .chars()
            .filter(char::is_ascii_digit)
            .count()
            == 8;
    if dashed_date {
        return &id[..id.len() - 11];
    }
    match id.rsplit_once('-') {
        Some((head, tail))
            if matches!(tail.len(), 4 | 8) && tail.chars().all(|c| c.is_ascii_digit()) =>
        {
            head
        }
        _ => id,
    }
}

/// OpenRouter names models `Vendor: Name`; the provider is shown separately.
fn display_name(name: &str) -> String {
    name.split_once(": ")
        .map(|(_, rest)| rest)
        .unwrap_or(name)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::catalog::provider;

    fn catalog_model(id: &str, name: &str, reasoning: bool) -> ModelInfo {
        ModelInfo {
            id: id.to_string(),
            name: name.to_string(),
            description: String::new(),
            context_length: 400_000,
            prompt_price_per_m: 1.25,
            completion_price_per_m: 10.0,
            cache_read_price_per_m: 0.125,
            supports_reasoning: reasoning,
            supports_vision: true,
            supports_tools: true,
            input_modalities: vec!["text".into(), "image".into()],
            supported_parameters: vec!["tools".into()],
            created: 10,
            source: "openrouter".into(),
        }
    }

    fn listed(id: &str) -> ListedModel {
        ListedModel {
            id: id.to_string(),
            context_length: None,
            chat: true,
        }
    }

    #[test]
    fn openai_models_are_filtered_and_enriched() {
        let openai = provider("openai").unwrap();
        let catalog = vec![
            catalog_model("openai/gpt-5", "OpenAI: GPT-5", true),
            catalog_model("openai/gpt-4o", "OpenAI: GPT-4o", false),
        ];
        let raw = [
            "gpt-5",
            "gpt-4o-2024-08-06",
            "text-embedding-3-large",
            "gpt-5-pro",
            "whisper-1",
            "gpt-image-1",
            "my-fine-tune",
        ];
        let listed: Vec<ListedModel> = raw.iter().map(|id| listed(id)).collect();
        let (models, meta) = build_models(openai, &listed, &catalog, None);
        let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "openai:gpt-4o-2024-08-06",
                "openai:gpt-5",
                "openai:my-fine-tune"
            ]
        );
        let gpt5 = &models[1];
        assert_eq!(gpt5.name, "GPT-5");
        assert_eq!(gpt5.source, "openai");
        assert_eq!(gpt5.prompt_price_per_m, 1.25);
        assert!(meta["openai:gpt-5"].reasoning);
        assert!(!meta["openai:gpt-4o-2024-08-06"].reasoning);
        assert_eq!(meta["openai:gpt-5"].pricing.cache_read, 0.125 / 1_000_000.0);
        // Unknown models are kept, unpriced, and may try reasoning.
        assert_eq!(models[2].prompt_price_per_m, 0.0);
        assert!(meta["openai:my-fine-tune"].reasoning);
    }

    #[test]
    fn gemini_and_mistral_lists_parse() {
        let gemini = parse_model_list(&json!({ "data": [
            { "id": "models/gemini-2.5-pro", "object": "model" }
        ] }));
        assert_eq!(gemini[0].id, "gemini-2.5-pro");
        let mistral = parse_model_list(&json!({ "data": [
            { "id": "mistral-large-latest", "max_context_length": 131072,
              "capabilities": { "completion_chat": true } },
            { "id": "mistral-embed", "capabilities": { "completion_chat": false } }
        ] }));
        assert_eq!(mistral[0].context_length, Some(131_072));
        assert!(!mistral[1].chat);

        let catalog = vec![catalog_model(
            "mistralai/mistral-large",
            "Mistral: Large",
            false,
        )];
        let (models, _) = build_models(provider("mistral").unwrap(), &mistral, &catalog, None);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].name, "Large");
        assert_eq!(models[0].context_length, 131_072);
    }

    #[test]
    fn models_dev_data_wins_over_the_openrouter_match() {
        let openai = provider("openai").unwrap();
        let catalog = vec![catalog_model("openai/gpt-5", "OpenAI: GPT-5", true)];
        let known = HashMap::from([(
            "gpt-5".to_string(),
            KnownModel {
                name: "GPT-5 (models.dev)".into(),
                context_length: 272_000,
                reasoning: true,
                tools: true,
                vision: true,
                pdf: true,
                prompt_price_per_m: 1.0,
                completion_price_per_m: 8.0,
                cache_read_price_per_m: None,
                created: 5,
            },
        )]);
        let (models, meta) = build_models(openai, &[listed("gpt-5")], &catalog, Some(&known));
        assert_eq!(models[0].name, "GPT-5 (models.dev)");
        assert_eq!(models[0].context_length, 272_000);
        assert!(models[0].input_modalities.contains(&"file".to_string()));
        // No cache price listed: cached tokens cost what uncached ones do.
        assert_eq!(meta["openai:gpt-5"].pricing.cache_read, 1.0 / 1_000_000.0);

        let listed = listed_from_known(&known);
        assert_eq!(listed[0].id, "gpt-5");
        assert_eq!(listed[0].context_length, Some(272_000));
    }

    #[test]
    fn complete_lists_take_missing_prices_from_models_dev() {
        let anthropic = provider("anthropic").unwrap();
        let entry = |id: &str, price: f64| ModelInfo {
            id: format!("anthropic:{id}"),
            prompt_price_per_m: price,
            completion_price_per_m: price * 5.0,
            cache_read_price_per_m: price / 10.0,
            ..catalog_model(id, id, true)
        };
        let known = HashMap::from([(
            "claude-new".to_string(),
            KnownModel {
                name: "Claude New".into(),
                context_length: 200_000,
                reasoning: true,
                tools: true,
                vision: true,
                pdf: true,
                prompt_price_per_m: 3.0,
                completion_price_per_m: 15.0,
                cache_read_price_per_m: Some(0.3),
                created: 0,
            },
        )]);
        let listed = vec![entry("claude-new", 0.0), entry("claude-opus-5", 5.0)];

        let (models, meta) = complete_models(anthropic, listed, Some(&known));

        assert_eq!(models[0].prompt_price_per_m, 3.0);
        assert_eq!(models[0].completion_price_per_m, 15.0);
        assert_eq!(meta["anthropic:claude-new"].pricing.cache_read, 0.3 / 1e6);
        // A price the list already has is kept.
        assert_eq!(models[1].prompt_price_per_m, 5.0);
        assert_eq!(meta["anthropic:claude-opus-5"].pricing.prompt, 5.0 / 1e6);
    }

    #[test]
    fn version_suffixes_are_stripped() {
        assert_eq!(strip_version_suffix("gpt-4o-2024-08-06"), "gpt-4o");
        assert_eq!(
            strip_version_suffix("claude-sonnet-4-20250514"),
            "claude-sonnet-4"
        );
        assert_eq!(strip_version_suffix("grok-4-0709"), "grok-4");
        assert_eq!(strip_version_suffix("gpt-5"), "gpt-5");
        assert_eq!(strip_version_suffix("llama-3.3-70b"), "llama-3.3-70b");
    }

    #[test]
    fn open_model_hosts_match_full_catalog_ids() {
        let groq = provider("groq").unwrap();
        let catalog = vec![catalog_model(
            "openai/gpt-oss-120b",
            "OpenAI: gpt-oss-120b",
            true,
        )];
        let (models, _) = build_models(
            groq,
            &[
                listed("openai/gpt-oss-120b"),
                listed("llama-3.3-70b-versatile"),
            ],
            &catalog,
            None,
        );
        assert_eq!(models[0].id, "groq:openai/gpt-oss-120b");
        assert_eq!(models[0].prompt_price_per_m, 1.25);
        assert_eq!(models[1].prompt_price_per_m, 0.0);
    }

    #[test]
    fn effort_follows_the_provider_and_model() {
        let openai = provider("openai").unwrap();
        let thinks = Some(DirectMeta {
            pricing: Pricing::default(),
            reasoning: true,
        });
        let plain = Some(DirectMeta {
            pricing: Pricing::default(),
            reasoning: false,
        });
        let high = ReasoningSetting::Effort("high".into());
        assert_eq!(reasoning_effort(openai, Some(&high), thinks), Some("high"));
        assert_eq!(
            reasoning_effort(openai, Some(&ReasoningSetting::Off), thinks),
            Some("minimal")
        );
        assert_eq!(reasoning_effort(openai, Some(&high), plain), None);
        assert_eq!(reasoning_effort(openai, None, thinks), None);
        let google = provider("google").unwrap();
        assert_eq!(
            reasoning_effort(google, Some(&ReasoningSetting::Off), thinks),
            Some("none")
        );
        let deepseek = provider("deepseek").unwrap();
        assert_eq!(reasoning_effort(deepseek, Some(&high), thinks), None);
    }

    #[test]
    fn request_body_skips_fields_a_model_rejected() {
        let client = CompatClient::new(
            reqwest::Client::new(),
            provider("xai").unwrap(),
            "https://api.x.ai/v1/",
            Quirks::default(),
        );
        assert_eq!(client.base_url, "https://api.x.ai/v1");
        let messages = vec![
            ChatMessage::text("user", "Hi"),
            ChatMessage::assistant_tool_calls(
                String::new(),
                json!([{ "id": "c", "type": "function",
                         "function": { "name": "ls", "arguments": "{}" } }]),
            ),
        ];
        let body = client.request_body("grok-4", &messages, &[], Some("high"));
        assert_eq!(body["reasoning_effort"], "high");
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert!(body["messages"][1]["content"].is_null());
        assert!(body.get("tools").is_none());

        client
            .quirks
            .lock()
            .unwrap()
            .insert(client.quirk_key("grok-4", &quirk("reasoning_effort", Some("high"))));
        let body = client.request_body("grok-4", &messages, &[], Some("high"));
        assert!(body.get("reasoning_effort").is_none());
        // Only the rejected level is left out; the model still takes others.
        let body = client.request_body("grok-4", &messages, &[], Some("low"));
        assert_eq!(body["reasoning_effort"], "low");
    }
}
