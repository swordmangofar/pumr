use crate::broker::{PermissionBroker, QuestionBroker};
use crate::config::Settings;
use crate::db::Db;
use crate::marketplace::MarketplaceService;
use crate::models::{EndpointInfo, Message, ModelInfo, ProviderInfo};
use crate::permissions::{AutoApproveConfig, LivePermissions};
use crate::power::PowerManager;
use crate::processes::ProcessRegistry;
use crate::providers::openrouter::{KeyInfo, OpenRouterClient};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

/// How long a fetched API-key credit limit is reused before refreshing from
/// OpenRouter. The spend view refreshes on every turn, so this avoids a network
/// round-trip each time while staying reasonably current.
const KEY_INFO_TTL: Duration = Duration::from_secs(60);

/// How many finished `send_message` requests stay remembered, so a repeat
/// delivered after the original finished still gets the original's outcome.
const RECENT_SENDS: usize = 32;

/// The outcome of a `send_message` request, shared with repeated deliveries.
pub type SendOutcome = std::result::Result<Message, String>;

pub enum SendClaim {
    /// First delivery of a request: run it and publish the outcome.
    First(watch::Sender<Option<SendOutcome>>),
    /// A repeated delivery: wait for the original's outcome instead.
    Duplicate(watch::Receiver<Option<SendOutcome>>),
}

pub struct AppState {
    pub db: Arc<Db>,
    pub data_dir: PathBuf,
    pub settings_path: PathBuf,
    settings: Mutex<Settings>,
    pub http: reqwest::Client,
    pub processes: Arc<ProcessRegistry>,
    pub broker: Arc<PermissionBroker>,
    pub questions: Arc<QuestionBroker>,
    pub permissions: Arc<LivePermissions>,
    pub power: PowerManager,
    pub marketplace: MarketplaceService,
    cancels: Mutex<HashMap<String, CancellationToken>>,
    pub sends: SendLedger,
    models_cache: Mutex<Option<Vec<ModelInfo>>>,
    endpoints_cache: Mutex<HashMap<String, Vec<EndpointInfo>>>,
    providers_cache: Mutex<Option<Vec<ProviderInfo>>>,
    key_info_cache: Mutex<Option<(Instant, KeyInfo)>>,
}

impl AppState {
    pub fn new(db: Db, data_dir: PathBuf, settings_path: PathBuf, settings: Settings) -> Self {
        let http = reqwest::Client::builder()
            .user_agent("pumr/0.1")
            .build()
            .expect("failed to build http client");
        let power = PowerManager::new(settings.interface.keep_awake);
        let marketplace = MarketplaceService::new(http.clone(), data_dir.join("marketplaces"));
        let permissions = Arc::new(LivePermissions::new(
            settings.permissions.command_rules.clone(),
            settings.permissions.denied_command_rules.clone(),
            settings.permissions.extra_folders.clone(),
            settings.permissions.allowed_websites.clone(),
            settings.permissions.denied_websites.clone(),
            auto_approve(&settings),
        ));
        let db = Arc::new(db);
        let broker = Arc::new(PermissionBroker::new());
        let audit_db = db.clone();
        broker.set_audit_sink(Arc::new(move |entry| {
            if let Err(error) = audit_db.record_permission_audit(&entry) {
                eprintln!("failed to record permission decision: {error}");
            }
        }));
        Self {
            db,
            data_dir,
            settings_path,
            settings: Mutex::new(settings),
            http,
            processes: Arc::new(ProcessRegistry::new()),
            broker,
            questions: Arc::new(QuestionBroker::new()),
            permissions,
            power,
            marketplace,
            cancels: Mutex::new(HashMap::new()),
            sends: SendLedger::default(),
            models_cache: Mutex::new(None),
            endpoints_cache: Mutex::new(HashMap::new()),
            providers_cache: Mutex::new(None),
            key_info_cache: Mutex::new(None),
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    pub fn set_settings(&self, settings: Settings) {
        self.permissions.replace(
            settings.permissions.command_rules.clone(),
            settings.permissions.denied_command_rules.clone(),
            settings.permissions.extra_folders.clone(),
            settings.permissions.allowed_websites.clone(),
            settings.permissions.denied_websites.clone(),
            auto_approve(&settings),
        );
        *self.settings.lock().unwrap() = settings;
    }

    pub fn provider(&self) -> OpenRouterClient {
        let settings = self.settings();
        OpenRouterClient::new(self.http.clone(), settings.model.openrouter_base_url)
    }

    pub fn cached_models(&self) -> Option<Vec<ModelInfo>> {
        self.models_cache.lock().unwrap().clone()
    }

    pub fn cache_models(&self, models: Vec<ModelInfo>) {
        *self.models_cache.lock().unwrap() = Some(models);
    }

    pub fn cached_endpoints(&self, model_id: &str) -> Option<Vec<EndpointInfo>> {
        self.endpoints_cache.lock().unwrap().get(model_id).cloned()
    }

    pub fn cache_endpoints(&self, model_id: &str, endpoints: Vec<EndpointInfo>) {
        self.endpoints_cache
            .lock()
            .unwrap()
            .insert(model_id.to_string(), endpoints);
    }

    pub fn cached_providers(&self) -> Option<Vec<ProviderInfo>> {
        self.providers_cache.lock().unwrap().clone()
    }

    pub fn cache_providers(&self, providers: Vec<ProviderInfo>) {
        *self.providers_cache.lock().unwrap() = Some(providers);
    }

    /// Credit limits for the configured OpenRouter key, cached briefly. Returns
    /// `None` when no key is configured or the lookup fails, in which case the
    /// spend view simply shows no budget.
    pub async fn key_info(&self) -> Option<KeyInfo> {
        if let Some((fetched_at, info)) = self.key_info_cache.lock().unwrap().clone() {
            if fetched_at.elapsed() < KEY_INFO_TTL {
                return Some(info);
            }
        }
        let api_key = crate::config::get_api_key(crate::config::OPENROUTER_PROVIDER)
            .ok()
            .flatten()?;
        if api_key.trim().is_empty() {
            return None;
        }
        let info = self.provider().get_key_info(&api_key).await.ok()?;
        *self.key_info_cache.lock().unwrap() = Some((Instant::now(), info.clone()));
        Some(info)
    }

    pub fn register_cancel(&self, key: &str) -> CancellationToken {
        let token = CancellationToken::new();
        let mut cancels = self.cancels.lock().unwrap();
        if let Some(previous) = cancels.insert(key.to_string(), token.clone()) {
            previous.cancel();
        }
        token
    }

    pub fn cancel(&self, key: &str) {
        if let Some(token) = self.cancels.lock().unwrap().get(key) {
            token.cancel();
        }
        self.broker.deny_session(key);
        self.questions.skip_session(key);
    }

    pub fn clear_cancel(&self, key: &str) {
        self.cancels.lock().unwrap().remove(key);
    }
}

/// `send_message` requests by the renderer's request id. Tauri delivers an
/// invoke a second time over `postMessage` when its IPC fetch fails, which a
/// webview reload mid-turn causes; the repeat must not start a second turn,
/// because that cancels the first one and its pending permission prompts.
#[derive(Default)]
pub struct SendLedger {
    sends: Mutex<VecDeque<(String, watch::Receiver<Option<SendOutcome>>)>>,
}

impl SendLedger {
    /// Registers a request, or finds the earlier delivery of it.
    pub fn claim(&self, request_id: &str) -> SendClaim {
        let mut sends = self.sends.lock().unwrap();
        if let Some((_, outcome)) = sends.iter().find(|(id, _)| id == request_id) {
            return SendClaim::Duplicate(outcome.clone());
        }
        // Forget the oldest finished request; running ones must stay findable.
        if sends.len() >= RECENT_SENDS {
            let finished = sends.iter().position(|(_, outcome)| {
                outcome.borrow().is_some() || outcome.has_changed().is_err()
            });
            if let Some(index) = finished {
                sends.remove(index);
            }
        }
        let (sender, receiver) = watch::channel(None);
        sends.push_back((request_id.to_string(), receiver));
        SendClaim::First(sender)
    }
}

fn auto_approve(settings: &Settings) -> AutoApproveConfig {
    AutoApproveConfig {
        read_only: settings.permissions.auto_approve_read_only,
        package_scripts: settings.permissions.auto_approve_package_scripts,
        project_executables: settings.permissions.auto_approve_project_executables,
        project_commands: settings.permissions.auto_approve_project_commands,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_repeated_send_waits_for_the_original_outcome() {
        let ledger = SendLedger::default();
        let SendClaim::First(original) = ledger.claim("request") else {
            panic!("the first delivery must run");
        };
        let SendClaim::Duplicate(mut repeat) = ledger.claim("request") else {
            panic!("a repeated delivery must not run again");
        };
        assert!(matches!(ledger.claim("other"), SendClaim::First(_)));
        assert!(repeat.borrow().is_none());

        original.send_replace(Some(Err("failed".to_string())));
        let outcome = repeat.wait_for(Option::is_some).await.unwrap().clone();
        assert!(matches!(outcome, Some(Err(error)) if error == "failed"));
    }

    #[test]
    fn running_sends_stay_remembered_past_the_limit() {
        let ledger = SendLedger::default();
        let running: Vec<SendClaim> = (0..=RECENT_SENDS)
            .map(|index| ledger.claim(&index.to_string()))
            .collect();
        assert!(matches!(ledger.claim("0"), SendClaim::Duplicate(_)));

        // Finished requests make room for new ones, oldest first.
        drop(running);
        ledger.claim("next");
        assert!(matches!(ledger.claim("0"), SendClaim::First(_)));
    }
}
