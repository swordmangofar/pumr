use crate::broker::{PermissionBroker, QuestionBroker};
use crate::config::Settings;
use crate::db::Db;
use crate::models::{EndpointInfo, ModelInfo, ProviderInfo};
use crate::permissions::LivePermissions;
use crate::power::PowerManager;
use crate::processes::ProcessRegistry;
use crate::providers::openrouter::OpenRouterClient;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

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
    cancels: Mutex<HashMap<String, CancellationToken>>,
    models_cache: Mutex<Option<Vec<ModelInfo>>>,
    endpoints_cache: Mutex<HashMap<String, Vec<EndpointInfo>>>,
    providers_cache: Mutex<Option<Vec<ProviderInfo>>>,
}

impl AppState {
    pub fn new(db: Db, data_dir: PathBuf, settings_path: PathBuf, settings: Settings) -> Self {
        let http = reqwest::Client::builder()
            .user_agent("pumr/0.1")
            .build()
            .expect("failed to build http client");
        let power = PowerManager::new(settings.keep_awake);
        let permissions = Arc::new(LivePermissions::new(
            settings.command_rules.clone(),
            settings.extra_folders.clone(),
        ));
        Self {
            db: Arc::new(db),
            data_dir,
            settings_path,
            settings: Mutex::new(settings),
            http,
            processes: Arc::new(ProcessRegistry::new()),
            broker: Arc::new(PermissionBroker::new()),
            questions: Arc::new(QuestionBroker::new()),
            permissions,
            power,
            cancels: Mutex::new(HashMap::new()),
            models_cache: Mutex::new(None),
            endpoints_cache: Mutex::new(HashMap::new()),
            providers_cache: Mutex::new(None),
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    pub fn set_settings(&self, settings: Settings) {
        self.permissions.replace(
            settings.command_rules.clone(),
            settings.extra_folders.clone(),
        );
        *self.settings.lock().unwrap() = settings;
    }

    pub fn provider(&self) -> OpenRouterClient {
        let settings = self.settings();
        OpenRouterClient::new(self.http.clone(), settings.openrouter_base_url)
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
        self.broker.deny_all();
        self.questions.skip_all();
    }

    pub fn clear_cancel(&self, key: &str) {
        self.cancels.lock().unwrap().remove(key);
    }
}
