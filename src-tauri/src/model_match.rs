//! Finds the model a user named in a prompt ("deepseek flash") among the
//! models of the connected providers, for the `task` tool's `model` argument.
//!
//! Providers are searched one at a time, the chat's own first, so a model
//! several providers serve runs where the chat runs. The first provider with a
//! model that fits every word of the name decides; when several of its models
//! fit, the user picks.

use crate::models::ModelInfo;
use std::cmp::Reverse;

/// Most models offered when a name fits several.
const MAX_CANDIDATES: usize = 6;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelMatch {
    /// Exactly one model fits.
    One(String),
    /// Several models fit, the closest first.
    Several(Vec<String>),
    /// No model comes close.
    None,
}

/// `name` as the key it is remembered under: its words, lowercased.
pub fn key(name: &str) -> String {
    words(name).join(" ")
}

pub fn resolve(name: &str, models: &[ModelInfo], chat_provider: &str) -> ModelMatch {
    let name = name.trim();
    if let Some(model) = models
        .iter()
        .find(|model| model.id.eq_ignore_ascii_case(name))
    {
        return ModelMatch::One(model.id.clone());
    }
    let tokens = words(name);
    if tokens.is_empty() {
        return ModelMatch::None;
    }
    let ranked: Vec<Ranked> = models
        .iter()
        .map(|model| Ranked::new(model, &tokens))
        .collect();

    for provider in provider_order(models, chat_provider) {
        let mut full: Vec<&Ranked> = ranked
            .iter()
            .filter(|entry| entry.model.source == provider && entry.matched == tokens.len())
            .collect();
        if full.is_empty() {
            continue;
        }
        // "gpt 5" means `gpt-5`, although it also fits `gpt-5-mini`.
        let mut named = full.iter().filter(|entry| entry.named);
        if let (Some(only), None) = (named.next(), named.next()) {
            return ModelMatch::One(only.model.id.clone());
        }
        if full.len() == 1 {
            return ModelMatch::One(full[0].model.id.clone());
        }
        full.sort_by_key(|entry| entry.order());
        return ModelMatch::Several(ids(&full));
    }

    // No model fits every word: offer the ones that fit the most, those of the
    // chat's provider first. Such a guess is never used without asking.
    let most = ranked.iter().map(|entry| entry.strong).max().unwrap_or(0);
    if most == 0 {
        return ModelMatch::None;
    }
    let mut close: Vec<&Ranked> = ranked.iter().filter(|entry| entry.strong == most).collect();
    close.sort_by_key(|entry| (entry.model.source != chat_provider, entry.order()));
    ModelMatch::Several(ids(&close))
}

fn ids(entries: &[&Ranked]) -> Vec<String> {
    entries
        .iter()
        .take(MAX_CANDIDATES)
        .map(|entry| entry.model.id.clone())
        .collect()
}

/// The chat's provider, then the others in the order their models are listed.
fn provider_order<'a>(models: &'a [ModelInfo], chat_provider: &'a str) -> Vec<&'a str> {
    let mut order = vec![chat_provider];
    for model in models {
        if !order.contains(&model.source.as_str()) {
            order.push(model.source.as_str());
        }
    }
    order
}

/// How well one model fits the words of a name.
struct Ranked<'a> {
    model: &'a ModelInfo,
    /// Words of the name found in the model.
    matched: usize,
    /// Of those, the ones found as a word or the start of one.
    strong: usize,
    score: u32,
    /// The name spells out the whole model, not only a part of it.
    named: bool,
    /// Words of the model's id the name leaves out.
    extra: usize,
}

impl<'a> Ranked<'a> {
    fn new(model: &'a ModelInfo, tokens: &[String]) -> Self {
        let own_id = words(own_id(model));
        let own_name = words(own_name(model));
        let mut haystack = words(&model.id);
        haystack.extend(words(&model.name));
        haystack.push(model.source.to_lowercase());
        // Without separators, so "gpt5" finds `gpt-5`.
        let compact: String = haystack.concat();

        let scores: Vec<u32> = tokens
            .iter()
            .map(|token| {
                if haystack.contains(token) {
                    3
                } else if token.len() >= 2 && haystack.iter().any(|word| word.starts_with(token)) {
                    2
                } else if token.len() >= 3 && compact.contains(token) {
                    1
                } else {
                    0
                }
            })
            .collect();
        let left_out = |own: &[String]| {
            own.iter()
                .filter(|word| !is_date(word) && !tokens.contains(word))
                .count()
        };
        let spelled_out = |own: &[String]| !own.is_empty() && left_out(own) == 0;
        Self {
            model,
            matched: scores.iter().filter(|score| **score > 0).count(),
            strong: scores.iter().filter(|score| **score > 1).count(),
            score: scores.iter().sum(),
            named: scores.iter().all(|score| *score == 3)
                && (spelled_out(&own_id) || spelled_out(&own_name)),
            extra: left_out(&own_id),
        }
    }

    /// Sorts the closest fit first, then the newest model.
    fn order(&self) -> (Reverse<bool>, Reverse<u32>, usize, Reverse<i64>, &'a str) {
        (
            Reverse(self.named),
            Reverse(self.score),
            self.extra,
            Reverse(self.model.created),
            self.model.id.as_str(),
        )
    }
}

/// The model's id without its provider or vendor: `deepseek-chat` for both
/// `deepseek:deepseek-chat` and OpenRouter's `deepseek/deepseek-chat`.
fn own_id(model: &ModelInfo) -> &str {
    let id = model
        .id
        .strip_prefix(model.source.as_str())
        .and_then(|rest| rest.strip_prefix(':'))
        .unwrap_or(&model.id);
    id.rsplit('/').next().unwrap_or(id)
}

/// The display name without the vendor OpenRouter puts in front of it
/// ("DeepSeek: DeepSeek V3").
fn own_name(model: &ModelInfo) -> &str {
    model
        .name
        .split_once(": ")
        .map_or(model.name.as_str(), |(_, name)| name)
}

/// A snapshot date in a model id (`claude-sonnet-4-5-20250929`), which nobody
/// says when naming the model.
fn is_date(word: &str) -> bool {
    word.len() >= 6 && word.chars().all(|c| c.is_ascii_digit())
}

fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str, name: &str, source: &str) -> ModelInfo {
        ModelInfo {
            id: id.to_string(),
            name: name.to_string(),
            description: String::new(),
            context_length: 0,
            prompt_price_per_m: 0.0,
            completion_price_per_m: 0.0,
            cache_read_price_per_m: 0.0,
            supports_reasoning: false,
            supports_vision: false,
            supports_tools: true,
            input_modalities: Vec::new(),
            supported_parameters: Vec::new(),
            created: 0,
            source: source.to_string(),
        }
    }

    /// Direct providers first, then OpenRouter, as `list_models` returns them.
    fn models() -> Vec<ModelInfo> {
        vec![
            model(
                "anthropic:claude-sonnet-4-5-20250929",
                "Claude Sonnet 4.5",
                "anthropic",
            ),
            model("deepseek:deepseek-chat", "DeepSeek Chat", "deepseek"),
            model(
                "deepseek:deepseek-reasoner",
                "DeepSeek Reasoner",
                "deepseek",
            ),
            model(
                "anthropic/claude-sonnet-4.5",
                "Anthropic: Claude Sonnet 4.5",
                "openrouter",
            ),
            model(
                "deepseek/deepseek-chat",
                "DeepSeek: DeepSeek Chat",
                "openrouter",
            ),
            model(
                "deepseek/deepseek-chat:free",
                "DeepSeek: DeepSeek Chat (free)",
                "openrouter",
            ),
            model(
                "google/gemini-2.5-flash",
                "Google: Gemini 2.5 Flash",
                "openrouter",
            ),
            model(
                "google/gemini-2.5-flash-lite",
                "Google: Gemini 2.5 Flash Lite",
                "openrouter",
            ),
            model("openai/gpt-5", "OpenAI: GPT-5", "openrouter"),
            model("openai/gpt-5-mini", "OpenAI: GPT-5 Mini", "openrouter"),
        ]
    }

    fn one(id: &str) -> ModelMatch {
        ModelMatch::One(id.to_string())
    }

    fn several(ids: &[&str]) -> ModelMatch {
        ModelMatch::Several(ids.iter().map(|id| id.to_string()).collect())
    }

    #[test]
    fn an_exact_id_is_taken_from_any_provider() {
        assert_eq!(
            resolve("DeepSeek:deepseek-chat", &models(), "openrouter"),
            one("deepseek:deepseek-chat"),
        );
    }

    #[test]
    fn a_model_several_providers_serve_runs_on_the_chats_provider() {
        assert_eq!(
            resolve("deepseek chat", &models(), "openrouter"),
            one("deepseek/deepseek-chat"),
        );
        assert_eq!(
            resolve("deepseek chat", &models(), "deepseek"),
            one("deepseek:deepseek-chat"),
        );
        assert_eq!(
            resolve("claude sonnet 4.5", &models(), "anthropic"),
            one("anthropic:claude-sonnet-4-5-20250929"),
        );
    }

    #[test]
    fn other_providers_are_searched_when_the_chats_has_no_such_model() {
        // Anthropic serves no DeepSeek model; the next provider listed does.
        assert_eq!(
            resolve("deepseek chat", &models(), "anthropic"),
            one("deepseek:deepseek-chat"),
        );
        // Only OpenRouter has Gemini.
        assert_eq!(
            resolve("gemini flash lite", &models(), "deepseek"),
            one("google/gemini-2.5-flash-lite"),
        );
    }

    #[test]
    fn a_name_that_spells_out_one_model_does_not_ask() {
        assert_eq!(resolve("gpt 5", &models(), "openrouter"), one("openai/gpt-5"));
        assert_eq!(
            resolve("GPT-5 mini", &models(), "openrouter"),
            one("openai/gpt-5-mini"),
        );
    }

    #[test]
    fn a_name_that_fits_several_models_offers_only_those() {
        assert_eq!(
            resolve("gemini flash", &models(), "openrouter"),
            several(&["google/gemini-2.5-flash", "google/gemini-2.5-flash-lite"]),
        );
        // Within the chat's provider only: OpenRouter's DeepSeek models stay out.
        assert_eq!(
            resolve("deepseek", &models(), "deepseek"),
            several(&["deepseek:deepseek-chat", "deepseek:deepseek-reasoner"]),
        );
    }

    #[test]
    fn a_name_no_model_fits_completely_offers_the_closest_and_never_decides() {
        // No DeepSeek model is called "flash": both halves of the name are offered.
        let ModelMatch::Several(candidates) = resolve("deepseek flash", &models(), "openrouter")
        else {
            panic!("expected candidates");
        };
        assert!(candidates.len() <= MAX_CANDIDATES);
        assert!(candidates.contains(&"google/gemini-2.5-flash".to_string()));
        assert!(candidates.contains(&"deepseek/deepseek-chat".to_string()));
        // The chat's provider comes first.
        let position = |id: &str| candidates.iter().position(|entry| entry == id);
        assert!(position("deepseek/deepseek-chat") < position("deepseek:deepseek-chat"));
    }

    #[test]
    fn an_unknown_name_matches_nothing() {
        assert_eq!(resolve("llama", &models(), "openrouter"), ModelMatch::None);
        assert_eq!(resolve("  ", &models(), "openrouter"), ModelMatch::None);
        assert_eq!(resolve("gpt 5", &[], "openrouter"), ModelMatch::None);
    }

    #[test]
    fn names_are_remembered_by_their_words() {
        assert_eq!(key(" DeepSeek-Flash "), "deepseek flash");
        assert_eq!(key("deepseek flash"), key("DeepSeek  flash"));
    }
}
