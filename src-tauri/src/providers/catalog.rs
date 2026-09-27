//! The providers pumr can talk to. OpenRouter serves one large catalog under
//! plain ids (`anthropic/claude-opus-5`); every other provider is used
//! directly with its own key and its model ids carry a `<provider>:` prefix
//! (`openai:gpt-5`, `ollama:llama3.1:8b`), so a stored model id alone says
//! where a request goes.
//!
//! A handful of providers are built in (with their quirks); the rest come from
//! models.dev, the open catalog opencode uses, and are installed at runtime
//! (see [`install`]).

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    OpenRouter,
    /// The Anthropic Messages API.
    Anthropic,
    /// Any API that speaks OpenAI's Chat Completions format.
    OpenAiCompatible,
}

/// How a provider takes a reasoning effort, if at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffortStyle {
    /// Never send one.
    Unsupported,
    /// OpenAI's `reasoning_effort` (`low`/`medium`/`high`), with the value
    /// that turns reasoning off where the provider has one.
    ReasoningEffort { off: Option<&'static str> },
}

#[derive(Debug, PartialEq)]
pub struct ProviderDef {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: ProviderKind,
    pub default_base_url: &'static str,
    /// Local servers (Ollama, LM Studio) need no key and are opt-in.
    pub local: bool,
    pub key_placeholder: &'static str,
    /// Where the user creates a key.
    pub keys_url: &'static str,
    /// Vendor prefix of this provider's models in the OpenRouter catalog,
    /// which supplies prices, context windows and capabilities.
    pub catalog_vendor: Option<&'static str>,
    pub effort: EffortStyle,
    /// Id fragments of models the provider lists but that cannot chat over
    /// Chat Completions (on top of the generic exclusions).
    pub exclude: &'static [&'static str],
    /// Listed before the long tail when adding a provider.
    pub popular: bool,
}

impl ProviderDef {
    pub fn needs_key(&self) -> bool {
        !self.local
    }

    /// Prefix of this provider's model ids; OpenRouter models have none.
    pub fn model_prefix(&self) -> String {
        match self.kind {
            ProviderKind::OpenRouter => String::new(),
            _ => format!("{}:", self.id),
        }
    }
}

pub const OPENROUTER: &str = "openrouter";
pub const ANTHROPIC: &str = "anthropic";

/// Providers with hand-written support; always present, even offline.
pub static BUILTIN: &[ProviderDef] = &[
    ProviderDef {
        id: OPENROUTER,
        name: "OpenRouter",
        kind: ProviderKind::OpenRouter,
        default_base_url: "https://openrouter.ai/api/v1",
        local: false,
        key_placeholder: "sk-or-v1-...",
        keys_url: "https://openrouter.ai/keys",
        catalog_vendor: None,
        effort: EffortStyle::Unsupported,
        exclude: &[],
        popular: true,
    },
    ProviderDef {
        id: ANTHROPIC,
        name: "Anthropic",
        kind: ProviderKind::Anthropic,
        default_base_url: "https://api.anthropic.com",
        local: false,
        key_placeholder: "sk-ant-...",
        keys_url: "https://console.anthropic.com/settings/keys",
        catalog_vendor: Some("anthropic"),
        effort: EffortStyle::Unsupported,
        exclude: &[],
        popular: true,
    },
    ProviderDef {
        id: "openai",
        name: "OpenAI",
        kind: ProviderKind::OpenAiCompatible,
        default_base_url: "https://api.openai.com/v1",
        local: false,
        key_placeholder: "sk-...",
        keys_url: "https://platform.openai.com/api-keys",
        catalog_vendor: Some("openai"),
        effort: EffortStyle::ReasoningEffort {
            off: Some("minimal"),
        },
        // Only served by the Responses API, or not chat models at all.
        exclude: &[
            "-pro",
            "codex",
            "deep-research",
            "computer-use",
            "search",
            "instruct",
            "chatgpt-",
        ],
        popular: true,
    },
    ProviderDef {
        id: "google",
        name: "Google Gemini",
        kind: ProviderKind::OpenAiCompatible,
        default_base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        local: false,
        key_placeholder: "AIza...",
        keys_url: "https://aistudio.google.com/apikey",
        catalog_vendor: Some("google"),
        effort: EffortStyle::ReasoningEffort { off: Some("none") },
        exclude: &["gemma", "learnlm", "live", "native-audio", "robotics"],
        popular: true,
    },
    ProviderDef {
        id: "xai",
        name: "xAI",
        kind: ProviderKind::OpenAiCompatible,
        default_base_url: "https://api.x.ai/v1",
        local: false,
        key_placeholder: "xai-...",
        keys_url: "https://console.x.ai",
        catalog_vendor: Some("x-ai"),
        effort: EffortStyle::ReasoningEffort { off: None },
        exclude: &[],
        popular: true,
    },
    ProviderDef {
        id: "mistral",
        name: "Mistral",
        kind: ProviderKind::OpenAiCompatible,
        default_base_url: "https://api.mistral.ai/v1",
        local: false,
        key_placeholder: "",
        keys_url: "https://console.mistral.ai/api-keys",
        catalog_vendor: Some("mistralai"),
        effort: EffortStyle::Unsupported,
        exclude: &[],
        popular: true,
    },
    ProviderDef {
        id: "deepseek",
        name: "DeepSeek",
        kind: ProviderKind::OpenAiCompatible,
        default_base_url: "https://api.deepseek.com/v1",
        local: false,
        key_placeholder: "sk-...",
        keys_url: "https://platform.deepseek.com/api_keys",
        catalog_vendor: Some("deepseek"),
        effort: EffortStyle::Unsupported,
        exclude: &[],
        popular: true,
    },
    ProviderDef {
        id: "groq",
        name: "Groq",
        kind: ProviderKind::OpenAiCompatible,
        default_base_url: "https://api.groq.com/openai/v1",
        local: false,
        key_placeholder: "gsk_...",
        keys_url: "https://console.groq.com/keys",
        catalog_vendor: None,
        effort: EffortStyle::ReasoningEffort { off: None },
        exclude: &["playai", "prompt-guard"],
        popular: true,
    },
    ProviderDef {
        id: "ollama",
        name: "Ollama",
        kind: ProviderKind::OpenAiCompatible,
        default_base_url: "http://localhost:11434/v1",
        local: true,
        key_placeholder: "",
        keys_url: "https://ollama.com/download",
        catalog_vendor: None,
        effort: EffortStyle::Unsupported,
        exclude: &[],
        popular: true,
    },
    ProviderDef {
        id: "lmstudio",
        name: "LM Studio",
        kind: ProviderKind::OpenAiCompatible,
        default_base_url: "http://localhost:1234/v1",
        local: true,
        key_placeholder: "",
        keys_url: "https://lmstudio.ai",
        catalog_vendor: None,
        effort: EffortStyle::Unsupported,
        exclude: &[],
        popular: true,
    },
];

/// What models.dev says about a model a provider serves.
#[derive(Debug, Clone, PartialEq)]
pub struct KnownModel {
    pub name: String,
    pub context_length: i64,
    pub reasoning: bool,
    pub tools: bool,
    pub vision: bool,
    pub pdf: bool,
    /// USD per million tokens.
    pub prompt_price_per_m: f64,
    pub completion_price_per_m: f64,
    pub cache_read_price_per_m: Option<f64>,
    /// Release date as a Unix timestamp (seconds), 0 when unknown.
    pub created: i64,
}

/// The providers in use: the built-in ones plus those loaded from models.dev,
/// with models.dev's per-provider model data.
#[derive(Debug, Default)]
pub struct Catalog {
    providers: Vec<&'static ProviderDef>,
    known: HashMap<String, HashMap<String, KnownModel>>,
}

impl Catalog {
    pub fn builtin() -> Self {
        Self {
            providers: BUILTIN.iter().collect(),
            known: HashMap::new(),
        }
    }

    /// The built-in providers followed by `extra` (ids already built in are
    /// skipped), with known models by provider id.
    pub fn new(
        extra: Vec<ProviderDef>,
        known: HashMap<String, HashMap<String, KnownModel>>,
    ) -> Self {
        let mut catalog = Self::builtin();
        for def in extra {
            if catalog
                .providers
                .iter()
                .all(|existing| existing.id != def.id)
            {
                catalog.providers.push(intern(def));
            }
        }
        catalog.known = known;
        catalog
    }

    pub fn providers(&self) -> &[&'static ProviderDef] {
        &self.providers
    }

    pub fn provider(&self, id: &str) -> Option<&'static ProviderDef> {
        self.providers.iter().copied().find(|def| def.id == id)
    }

    pub fn known_models(&self, provider: &str) -> Option<&HashMap<String, KnownModel>> {
        self.known.get(provider)
    }

    pub fn split_model<'a>(&self, model: &'a str) -> (&'static ProviderDef, &'a str) {
        if let Some((prefix, rest)) = model.split_once(':') {
            // OpenRouter ids have a vendor path before any colon (`openai/x:free`).
            if !prefix.contains('/') {
                if let Some(def) = self.provider(prefix) {
                    if def.kind != ProviderKind::OpenRouter {
                        return (def, rest);
                    }
                }
            }
        }
        (openrouter(), model)
    }
}

static CURRENT: LazyLock<RwLock<Arc<Catalog>>> =
    LazyLock::new(|| RwLock::new(Arc::new(Catalog::builtin())));

/// Definitions of loaded providers live for the whole run; a reload that
/// brings an unchanged provider reuses its definition instead of a new one.
static INTERNED: LazyLock<Mutex<HashMap<String, &'static ProviderDef>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn intern(def: ProviderDef) -> &'static ProviderDef {
    let mut interned = INTERNED.lock().unwrap();
    if let Some(existing) = interned.get(def.id) {
        if **existing == def {
            return existing;
        }
    }
    let leaked: &'static ProviderDef = Box::leak(Box::new(def));
    interned.insert(leaked.id.to_string(), leaked);
    leaked
}

/// Leaks `text` for a provider definition (see [`intern`]).
pub fn leak(text: &str) -> &'static str {
    Box::leak(text.to_string().into_boxed_str())
}

pub fn current() -> Arc<Catalog> {
    CURRENT.read().unwrap().clone()
}

/// Replaces the catalog, e.g. after models.dev was loaded.
pub fn install(catalog: Catalog) {
    *CURRENT.write().unwrap() = Arc::new(catalog);
}

pub fn providers() -> Vec<&'static ProviderDef> {
    current().providers().to_vec()
}

pub fn provider(id: &str) -> Option<&'static ProviderDef> {
    current().provider(id)
}

pub fn openrouter() -> &'static ProviderDef {
    &BUILTIN[0]
}

/// The provider serving `model` and the id that provider knows it by.
pub fn split_model(model: &str) -> (&'static ProviderDef, &str) {
    let catalog = current();
    let (def, _) = catalog.split_model(model);
    let id = if def.kind == ProviderKind::OpenRouter {
        model
    } else {
        &model[def.id.len() + 1..]
    };
    (def, id)
}

pub fn provider_of(model: &str) -> &'static ProviderDef {
    split_model(model).0
}

/// The `<provider>:` prefix of `model` when no known provider has that id,
/// e.g. a model saved while the models.dev catalog was loaded, now offline.
pub fn unknown_prefix(model: &str) -> Option<&str> {
    let (prefix, _) = model.split_once(':')?;
    (!prefix.contains('/') && provider(prefix).is_none()).then_some(prefix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_ids_name_their_provider() {
        let (def, id) = split_model("anthropic:claude-opus-5");
        assert_eq!((def.id, id), ("anthropic", "claude-opus-5"));
        let (def, id) = split_model("ollama:llama3.1:8b");
        assert_eq!((def.id, id), ("ollama", "llama3.1:8b"));
        let (def, id) = split_model("openai/gpt-5:free");
        assert_eq!((def.id, id), ("openrouter", "openai/gpt-5:free"));
        assert_eq!(provider_of("anthropic/claude-opus-5").id, "openrouter");
        assert_eq!(provider_of("unknown:model").id, "openrouter");
        assert_eq!(provider_of("openrouter:x").id, "openrouter");
    }

    #[test]
    fn catalog_ids_are_unique_and_openrouter_is_first() {
        assert_eq!(openrouter().id, OPENROUTER);
        let mut ids: Vec<&str> = BUILTIN.iter().map(|def| def.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), BUILTIN.len());
        assert!(BUILTIN.iter().all(|def| !def.id.contains(['/', ':'])));
    }

    fn extra(id: &'static str) -> ProviderDef {
        ProviderDef {
            id,
            name: "Extra",
            kind: ProviderKind::OpenAiCompatible,
            default_base_url: "https://extra.example/v1",
            local: false,
            key_placeholder: "",
            keys_url: "",
            catalog_vendor: None,
            effort: EffortStyle::Unsupported,
            exclude: &[],
            popular: false,
        }
    }

    #[test]
    fn loaded_providers_join_the_built_in_ones() {
        let catalog = Catalog::new(vec![extra("togetherai"), extra("openai")], HashMap::new());
        assert_eq!(catalog.providers().len(), BUILTIN.len() + 1);
        let (def, id) = catalog.split_model("togetherai:meta-llama/Llama-3.3-70B");
        assert_eq!((def.id, id), ("togetherai", "meta-llama/Llama-3.3-70B"));
        // A built-in id is never replaced.
        assert_eq!(catalog.provider("openai").unwrap().name, "OpenAI");
        // Reloading the same provider reuses its definition.
        let again = Catalog::new(vec![extra("togetherai")], HashMap::new());
        assert!(std::ptr::eq(
            catalog.provider("togetherai").unwrap(),
            again.provider("togetherai").unwrap()
        ));
    }
}
