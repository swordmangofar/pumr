//! Loads the provider catalog from models.dev (the open catalog opencode
//! uses): which providers exist, where their APIs are, and what their models
//! cost and can do. Cached on disk and refreshed daily; without it only the
//! built-in providers are available.

use super::catalog::{self, Catalog, EffortStyle, KnownModel, ProviderDef, ProviderKind};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

const URL: &str = "https://models.dev/api.json";
const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const RETRY_AFTER: Duration = Duration::from_secs(10 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

/// Providers the catalog lists with a dedicated SDK but that also serve an
/// OpenAI-compatible API, at this base URL.
const COMPATIBLE_URLS: &[(&str, &str)] = &[
    ("togetherai", "https://api.together.xyz/v1"),
    ("cerebras", "https://api.cerebras.ai/v1"),
    ("deepinfra", "https://api.deepinfra.com/v1/openai"),
    ("perplexity", "https://api.perplexity.ai"),
    ("cohere", "https://api.cohere.ai/compatibility/v1"),
    ("vercel", "https://ai-gateway.vercel.sh/v1"),
    ("v0", "https://api.v0.dev/v1"),
    ("venice", "https://api.venice.ai/api/v1"),
];

/// Listed but not usable with a plain API key: OAuth sign-in, or an API that
/// only speaks OpenAI's Responses format.
const SKIPPED: &[&str] = &["github-copilot", "perplexity-agent"];

/// Offered before the long tail when adding a provider.
const POPULAR: &[&str] = &[
    "togetherai",
    "fireworks-ai",
    "deepinfra",
    "cerebras",
    "huggingface",
    "nvidia",
    "perplexity",
    "cohere",
    "moonshotai",
    "zai",
    "zhipuai",
    "minimax",
    "alibaba",
    "vercel",
    "opencode",
    "ollama-cloud",
    "novita-ai",
    "siliconflow",
    "nebius",
    "venice",
    "chutes",
    "baseten",
    "llama",
    "digitalocean",
    "poe",
];

/// Builds the catalog from a models.dev `api.json` document.
pub fn parse(document: &Value) -> Catalog {
    let Some(entries) = document.as_object() else {
        return Catalog::builtin();
    };
    let mut extra = Vec::new();
    let mut known = HashMap::new();
    for (id, entry) in entries {
        known.insert(id.clone(), known_models(entry));
        if catalog::BUILTIN.iter().any(|def| def.id == id) {
            continue;
        }
        if let Some(def) = provider(id, entry) {
            extra.push(def);
        }
    }
    // Popular ones first, in the listed order, then alphabetically.
    extra.sort_by_key(|def| {
        (
            POPULAR
                .iter()
                .position(|id| *id == def.id)
                .unwrap_or(POPULAR.len()),
            def.name.to_lowercase(),
        )
    });
    Catalog::new(extra, known)
}

/// A provider pumr can use with a key, or `None` for those it cannot
/// (other auth, per-account URLs, local servers, unknown SDKs).
fn provider(id: &str, entry: &Value) -> Option<ProviderDef> {
    if SKIPPED.contains(&id) || id.contains([':', '/']) {
        return None;
    }
    let text = |key: &str| entry.get(key).and_then(Value::as_str).unwrap_or("");
    let npm = text("npm");
    let override_url = COMPATIBLE_URLS
        .iter()
        .find(|(provider, _)| *provider == id)
        .map(|(_, url)| *url);
    let kind = match npm {
        _ if override_url.is_some() => ProviderKind::OpenAiCompatible,
        "@ai-sdk/openai-compatible" | "@ai-sdk/openai" | "@openrouter/ai-sdk-provider" => {
            ProviderKind::OpenAiCompatible
        }
        "@ai-sdk/anthropic" => ProviderKind::Anthropic,
        _ => return None,
    };
    let url = override_url.unwrap_or(text("api")).trim();
    let parsed = reqwest::Url::parse(url).ok()?;
    // `${ACCOUNT_ID}`-style URLs need per-account setup; local servers are
    // covered by the built-in Ollama and LM Studio.
    if url.contains("${") || parsed.scheme() != "https" {
        return None;
    }
    let name = text("name");
    Some(ProviderDef {
        id: catalog::leak(id),
        name: catalog::leak(if name.is_empty() { id } else { name }),
        kind,
        default_base_url: catalog::leak(url.trim_end_matches('/')),
        local: false,
        key_placeholder: "",
        keys_url: catalog::leak(text("doc")),
        catalog_vendor: None,
        effort: match kind {
            ProviderKind::OpenAiCompatible => EffortStyle::ReasoningEffort { off: None },
            _ => EffortStyle::Unsupported,
        },
        exclude: &[],
        popular: POPULAR.contains(&id),
    })
}

fn known_models(entry: &Value) -> HashMap<String, KnownModel> {
    let Some(models) = entry.get("models").and_then(Value::as_object) else {
        return HashMap::new();
    };
    models
        .iter()
        .map(|(id, model)| {
            let number = |pointer: &str| model.pointer(pointer).and_then(Value::as_f64);
            let flag = |key: &str| model.get(key).and_then(Value::as_bool).unwrap_or(false);
            let inputs: Vec<&str> = model
                .pointer("/modalities/input")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let created = model
                .get("release_date")
                .and_then(Value::as_str)
                .and_then(|date| chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|date| date.and_utc().timestamp())
                .unwrap_or(0);
            let known = KnownModel {
                name: model
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_string(),
                context_length: number("/limit/context").unwrap_or(0.0) as i64,
                reasoning: flag("reasoning"),
                tools: flag("tool_call"),
                vision: inputs.contains(&"image"),
                pdf: inputs.contains(&"pdf"),
                prompt_price_per_m: number("/cost/input").unwrap_or(0.0),
                completion_price_per_m: number("/cost/output").unwrap_or(0.0),
                cache_read_price_per_m: number("/cost/cache_read"),
                created,
            };
            (id.clone(), known)
        })
        .collect()
}

/// Keeps the installed catalog current. The cached copy is installed at once,
/// and one older than a day is refreshed in the background, so no command
/// waits for models.dev; only a first run without any copy waits for the
/// download. Cheap to call often.
pub struct Loader {
    url: String,
    state: Arc<tokio::sync::Mutex<LoaderState>>,
}

#[derive(Default)]
struct LoaderState {
    /// A catalog from models.dev (cached or downloaded) is installed.
    installed: bool,
    /// When to look at the cache's age again; `None` before the first look.
    next_check: Option<Instant>,
    refreshing: bool,
}

impl Default for Loader {
    fn default() -> Self {
        Self::with_url(URL)
    }
}

impl Loader {
    fn with_url(url: &str) -> Self {
        Self {
            url: url.to_string(),
            state: Arc::default(),
        }
    }

    pub async fn ensure(&self, http: &reqwest::Client, data_dir: &Path) {
        let mut state = self.state.lock().await;
        let path = cache_path(data_dir);
        if !state.installed {
            if let Some(document) = std::fs::read(&path)
                .ok()
                .and_then(|body| serde_json::from_slice::<Value>(&body).ok())
            {
                catalog::install(parse(&document));
                state.installed = true;
            }
        }
        if state.refreshing || state.next_check.is_some_and(|at| Instant::now() < at) {
            return;
        }
        let age = std::fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok());
        if let Some(age) = age.filter(|age| *age < MAX_AGE).filter(|_| state.installed) {
            state.next_check = Some(Instant::now() + (MAX_AGE - age));
            return;
        }
        if !state.installed && state.next_check.is_none() {
            // The first look without any copy waits: the providers beyond the
            // built-in ones only exist once the catalog is in.
            let refreshed = refresh(http, &self.url, &path).await;
            state.installed = refreshed;
            state.next_check = Some(next_check(refreshed));
            return;
        }
        // Whatever is installed serves until the download is in.
        state.refreshing = true;
        let (shared, http, url) = (self.state.clone(), http.clone(), self.url.clone());
        tokio::spawn(async move {
            let refreshed = refresh(&http, &url, &path).await;
            let mut state = shared.lock().await;
            state.refreshing = false;
            state.installed |= refreshed;
            state.next_check = Some(next_check(refreshed));
        });
    }
}

/// A failed download is tried again soon instead of in a day.
fn next_check(refreshed: bool) -> Instant {
    Instant::now() + if refreshed { MAX_AGE } else { RETRY_AFTER }
}

/// Downloads the catalog, caches and installs it. `false` when that failed.
async fn refresh(http: &reqwest::Client, url: &str, path: &Path) -> bool {
    let body = match fetch(http, url).await {
        Ok(body) => body,
        Err(error) => {
            eprintln!("could not load models.dev: {error}");
            return false;
        }
    };
    if let Err(error) = std::fs::write(path, &body) {
        eprintln!("could not cache models.dev: {error}");
    }
    match serde_json::from_slice::<Value>(&body) {
        Ok(document) => {
            catalog::install(parse(&document));
            true
        }
        Err(_) => false,
    }
}

fn cache_path(data_dir: &Path) -> PathBuf {
    data_dir.join("models-dev.json")
}

async fn fetch(http: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let response = http
        .get(url)
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let body = response.bytes().await.map_err(|error| error.to_string())?;
    // Only keep a document that parses, so a bad response cannot replace a
    // good cache.
    serde_json::from_slice::<Value>(&body).map_err(|error| error.to_string())?;
    Ok(body.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn document() -> Value {
        json!({
            "openai": { "id": "openai", "npm": "@ai-sdk/openai", "name": "OpenAI", "models": {
                "gpt-5": { "name": "GPT-5", "reasoning": true, "tool_call": true,
                           "modalities": { "input": ["text", "image"] },
                           "limit": { "context": 400000 },
                           "cost": { "input": 1.25, "output": 10, "cache_read": 0.125 },
                           "release_date": "2025-08-07" }
            } },
            "togetherai": { "npm": "@ai-sdk/togetherai", "name": "Together AI",
                            "doc": "https://docs.together.ai", "models": {} },
            "minimax": { "npm": "@ai-sdk/anthropic", "name": "MiniMax",
                         "api": "https://api.minimax.io/anthropic/v1", "models": {} },
            "wandb": { "npm": "@ai-sdk/openai-compatible", "name": "CoreWeave",
                       "api": "https://api.inference.wandb.ai/v1", "models": {} },
            "databricks": { "npm": "@ai-sdk/openai-compatible", "name": "Databricks",
                            "api": "https://${DATABRICKS_HOST}/v1", "models": {} },
            "atomic-chat": { "npm": "@ai-sdk/openai-compatible", "name": "Atomic Chat",
                             "api": "http://127.0.0.1:1337/v1", "models": {} },
            "amazon-bedrock": { "npm": "@ai-sdk/amazon-bedrock", "name": "Amazon Bedrock", "models": {} },
            "github-copilot": { "npm": "@ai-sdk/openai-compatible", "name": "GitHub Copilot",
                                "api": "https://api.githubcopilot.com", "models": {} }
        })
    }

    #[test]
    fn usable_providers_are_added_after_the_built_in_ones() {
        let catalog = parse(&document());
        let extra: Vec<&str> = catalog.providers()[catalog::BUILTIN.len()..]
            .iter()
            .map(|def| def.id)
            .collect();
        // Popular first, then by name; the rest cannot be used with a key.
        assert_eq!(extra, ["togetherai", "minimax", "wandb"]);

        let together = catalog.provider("togetherai").unwrap();
        assert_eq!(together.default_base_url, "https://api.together.xyz/v1");
        assert_eq!(together.keys_url, "https://docs.together.ai");
        assert!(together.popular);
        let minimax = catalog.provider("minimax").unwrap();
        assert_eq!(minimax.kind, ProviderKind::Anthropic);
        assert!(!catalog.provider("wandb").unwrap().popular);
    }

    #[test]
    fn models_carry_prices_and_capabilities() {
        let catalog = parse(&document());
        let gpt5 = &catalog.known_models("openai").unwrap()["gpt-5"];
        assert_eq!(gpt5.name, "GPT-5");
        assert_eq!(gpt5.context_length, 400_000);
        assert!(gpt5.reasoning && gpt5.tools && gpt5.vision && !gpt5.pdf);
        assert_eq!(gpt5.cache_read_price_per_m, Some(0.125));
        assert!(gpt5.created > 1_700_000_000);
    }

    #[test]
    fn a_broken_document_leaves_the_built_in_providers() {
        assert_eq!(parse(&json!([])).providers().len(), catalog::BUILTIN.len());
    }

    /// Answers every request with `body`, or never answers when it is `None`.
    fn server(body: Option<Vec<u8>>) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/api.json", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let Some(body) = &body else {
                    // Keep the connection open without a word.
                    std::mem::forget(stream);
                    continue;
                };
                let _ = stream.read(&mut [0u8; 4096]);
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body);
            }
        });
        url
    }

    #[tokio::test]
    async fn a_stale_copy_serves_while_the_catalog_downloads() {
        let dir = tempfile::tempdir().unwrap();
        let path = cache_path(dir.path());
        std::fs::write(&path, serde_json::to_vec(&document()).unwrap()).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::now() - 2 * MAX_AGE)
            .unwrap();
        let loader = Loader::with_url(&server(None));
        let http = reqwest::Client::new();

        for _ in 0..2 {
            tokio::time::timeout(Duration::from_secs(2), loader.ensure(&http, dir.path()))
                .await
                .expect("no call waits for models.dev while a copy is cached");
        }
        assert!(catalog::provider("togetherai").is_some());
        assert!(loader.state.lock().await.refreshing);
    }

    #[tokio::test]
    async fn a_first_run_downloads_and_caches_the_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let body = serde_json::to_vec(&document()).unwrap();
        let loader = Loader::with_url(&server(Some(body.clone())));

        loader.ensure(&reqwest::Client::new(), dir.path()).await;

        assert!(loader.state.lock().await.installed);
        assert_eq!(std::fs::read(cache_path(dir.path())).unwrap(), body);
        assert!(catalog::provider("minimax").is_some());
    }

    /// Parses a downloaded catalog: `MODELS_DEV_JSON=api.json cargo test ... -- --ignored`.
    #[test]
    #[ignore = "needs a models.dev api.json in MODELS_DEV_JSON"]
    fn real_catalog_parses() {
        let path = std::env::var("MODELS_DEV_JSON").expect("MODELS_DEV_JSON");
        let document: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let catalog = parse(&document);
        for def in catalog.providers() {
            println!(
                "{:<28} {:<34} {:?} popular={} {}",
                def.id, def.name, def.kind, def.popular, def.default_base_url
            );
        }
        println!("{} providers", catalog.providers().len());
        assert!(catalog.providers().len() > 100);
    }
}
