use crate::broker::{PermissionBroker, QuestionBroker};
use crate::config::Settings;
use crate::db::Db;
use crate::marketplace::MarketplaceService;
use crate::models::{EndpointInfo, EventSink, Message, ModelInfo, ProviderInfo, RoutedEvent};
use crate::permissions::{AutoApproveConfig, LivePermissions};
use crate::power::PowerManager;
use crate::processes::ProcessRegistry;
use crate::providers::openrouter::{KeyInfo, OpenRouterClient};
use std::collections::{HashMap, HashSet, VecDeque};
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
    cancels: Arc<CancelRegistry>,
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
            cancels: Arc::new(CancelRegistry::default()),
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

    /// Registers a cancellable operation (e.g. a handover summary) under `key`,
    /// cancelling the one it replaces. It stays registered until the returned
    /// registration is dropped.
    pub fn register_cancel(&self, key: &str) -> CancelRegistration {
        self.cancels.register(key, None)
    }

    /// Registers the chat turn of `session_id` like [`Self::register_cancel`]
    /// and makes it attachable: [`Self::attach_turn`] can re-route `events` to
    /// the channel of a webview that reloaded while the turn was running.
    pub fn register_turn(&self, session_id: &str, events: SwappableSink) -> CancelRegistration {
        self.cancels.register(session_id, Some(events))
    }

    pub fn cancel(&self, key: &str) {
        self.cancels.cancel(key);
        self.broker.deny_session(key);
        self.questions.skip_session(key);
    }

    /// Session ids of the chat turns that are still running.
    pub fn running_turns(&self) -> Vec<String> {
        self.cancels.running_turns()
    }

    /// Routes the running turn of `session_id` to `sink` and re-sends the
    /// prompts it is still waiting on, whose original events went to the old
    /// channel. A repeated delivery of the same `request_id` changes nothing.
    /// `None` when the session has no running turn.
    pub fn attach_turn(
        &self,
        session_id: &str,
        request_id: Option<&str>,
        sink: EventSink,
    ) -> Option<TurnHandle> {
        let (turn, attached) = self.cancels.attach(session_id, request_id, sink)?;
        if !attached {
            return Some(turn);
        }
        let sessions = self.turn_session_ids(session_id);
        let pending = self
            .broker
            .pending_requests()
            .into_iter()
            .chain(self.questions.pending_requests());
        for event in pending.filter(|event| sessions.contains(&event.session_id)) {
            turn.emit(event);
        }
        Some(turn)
    }

    /// The session a turn runs in plus the subagent sessions below it, which
    /// stream their events and prompts through the same sink.
    fn turn_session_ids(&self, session_id: &str) -> HashSet<String> {
        let mut ids = HashSet::from([session_id.to_string()]);
        let mut parents = vec![session_id.to_string()];
        while let Some(parent) = parents.pop() {
            for child in self.db.list_sub_sessions(&parent).unwrap_or_default() {
                if ids.insert(child.id.clone()) {
                    parents.push(child.id);
                }
            }
        }
        ids
    }
}

/// An [`EventSink`] whose destination can be replaced while a turn runs, so a
/// webview that reloaded mid-turn can route the turn's events to a new channel.
#[derive(Clone)]
pub struct SwappableSink {
    target: Arc<Mutex<EventSink>>,
}

impl SwappableSink {
    pub fn new(target: EventSink) -> Self {
        Self {
            target: Arc::new(Mutex::new(target)),
        }
    }

    /// Sends all further events to `target`.
    pub fn replace(&self, target: EventSink) {
        *self.target.lock().unwrap() = target;
    }

    pub fn emit(&self, event: RoutedEvent) {
        // Call the target outside the lock so sending never blocks a swap.
        let target = self.target.lock().unwrap().clone();
        (target)(event);
    }

    /// A sink for the agent loop that always forwards to the current target.
    pub fn sink(&self) -> EventSink {
        let this = self.clone();
        Arc::new(move |event| this.emit(event))
    }
}

/// A chat turn a webview can attach to.
#[derive(Clone)]
pub struct TurnHandle {
    events: SwappableSink,
    finished: CancellationToken,
}

impl TurnHandle {
    pub fn emit(&self, event: RoutedEvent) {
        self.events.emit(event);
    }

    /// Completes once the turn has finished and unregistered itself.
    pub async fn finished(&self) {
        self.finished.cancelled().await;
    }
}

/// Cancellation tokens of everything the UI can stop, keyed by session id for
/// chat turns and by an operation key such as `handover:{session_id}` otherwise.
#[derive(Default)]
struct CancelRegistry {
    inner: Mutex<RegistryInner>,
}

#[derive(Default)]
struct RegistryInner {
    next_generation: u64,
    entries: HashMap<String, CancelEntry>,
}

struct CancelEntry {
    /// Tells this registration apart from a later one under the same key, so a
    /// replaced operation that exits late never unregisters its replacement.
    generation: u64,
    token: CancellationToken,
    /// Set for chat turns, which a reloaded webview can attach to.
    turn: Option<TurnHandle>,
    /// Request ids of the `attach_session` calls that re-routed the turn.
    attaches: HashSet<String>,
}

impl CancelRegistry {
    fn register(self: &Arc<Self>, key: &str, events: Option<SwappableSink>) -> CancelRegistration {
        let token = CancellationToken::new();
        let finished = CancellationToken::new();
        let mut inner = self.inner.lock().unwrap();
        inner.next_generation += 1;
        let generation = inner.next_generation;
        let entry = CancelEntry {
            generation,
            token: token.clone(),
            turn: events.map(|events| TurnHandle {
                events,
                finished: finished.clone(),
            }),
            attaches: HashSet::new(),
        };
        if let Some(previous) = inner.entries.insert(key.to_string(), entry) {
            previous.token.cancel();
        }
        CancelRegistration {
            registry: self.clone(),
            key: key.to_string(),
            generation,
            token,
            finished,
        }
    }

    fn unregister(&self, key: &str, generation: u64) {
        let mut inner = self.inner.lock().unwrap();
        if inner
            .entries
            .get(key)
            .is_some_and(|entry| entry.generation == generation)
        {
            inner.entries.remove(key);
        }
    }

    fn cancel(&self, key: &str) {
        if let Some(entry) = self.inner.lock().unwrap().entries.get(key) {
            entry.token.cancel();
        }
    }

    fn running_turns(&self) -> Vec<String> {
        let inner = self.inner.lock().unwrap();
        let mut ids: Vec<String> = inner
            .entries
            .iter()
            .filter(|(_, entry)| entry.turn.is_some())
            .map(|(key, _)| key.clone())
            .collect();
        ids.sort();
        ids
    }

    /// Routes the turn to `sink`, unless `request_id` already did: Tauri
    /// delivers an invoke again when its IPC request fails, and that repeat,
    /// from a page that has since reloaded, must not take the turn back from a
    /// newer page. Returns the turn and whether it was re-routed.
    fn attach(
        &self,
        session_id: &str,
        request_id: Option<&str>,
        sink: EventSink,
    ) -> Option<(TurnHandle, bool)> {
        let mut inner = self.inner.lock().unwrap();
        let entry = inner.entries.get_mut(session_id)?;
        let turn = entry.turn.clone()?;
        let repeat = request_id.is_some_and(|id| !entry.attaches.insert(id.to_string()));
        if !repeat {
            turn.events.replace(sink);
        }
        Some((turn, !repeat))
    }
}

/// Keeps an operation registered while it runs. Dropping it, on whichever path
/// the operation exits, unregisters the operation unless a newer one replaced
/// it under the same key, and wakes whoever waits for the turn to finish.
pub struct CancelRegistration {
    registry: Arc<CancelRegistry>,
    key: String,
    generation: u64,
    token: CancellationToken,
    finished: CancellationToken,
}

impl CancelRegistration {
    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }
}

impl Drop for CancelRegistration {
    fn drop(&mut self) {
        self.registry.unregister(&self.key, self.generation);
        self.finished.cancel();
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
    use crate::broker::{PermissionOperation, PermissionPrompt};
    use crate::models::{PermissionDecision, QuestionItem, StreamEvent};
    use std::path::Path;

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

    type Captured = Arc<Mutex<Vec<RoutedEvent>>>;

    fn capture() -> (EventSink, Captured) {
        let events: Captured = Arc::new(Mutex::new(Vec::new()));
        let sink: EventSink = {
            let events = events.clone();
            Arc::new(move |event| events.lock().unwrap().push(event))
        };
        (sink, events)
    }

    fn delta(session_id: &str) -> RoutedEvent {
        RoutedEvent {
            session_id: session_id.to_string(),
            event: StreamEvent::Delta {
                text: "token".to_string(),
            },
        }
    }

    /// `(session id, request id)` of every prompt request in `events`.
    fn requests(events: &Captured) -> Vec<(String, String)> {
        events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|routed| match &routed.event {
                StreamEvent::PermissionRequest { request_id, .. }
                | StreamEvent::QuestionRequest { request_id, .. } => {
                    Some((routed.session_id.clone(), request_id.clone()))
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn replaced_turn_exiting_late_keeps_its_replacement_registered() {
        let registry = Arc::new(CancelRegistry::default());
        let (sink, _) = capture();
        let first = registry.register("chat", Some(SwappableSink::new(sink.clone())));
        let second = registry.register("chat", Some(SwappableSink::new(sink)));
        assert!(first.token().is_cancelled());

        // The replaced turn only notices its cancellation now and exits.
        drop(first);
        assert_eq!(registry.running_turns(), vec!["chat".to_string()]);
        registry.cancel("chat");
        assert!(second.token().is_cancelled());

        drop(second);
        assert!(registry.running_turns().is_empty());
    }

    #[test]
    fn only_chat_turns_are_listed_and_attachable() {
        let registry = Arc::new(CancelRegistry::default());
        let _handover = registry.register("handover:chat", None);
        let (sink, _) = capture();
        assert!(registry.running_turns().is_empty());
        assert!(registry.attach("handover:chat", None, sink.clone()).is_none());
        assert!(registry.attach("chat", None, sink).is_none());
    }

    #[tokio::test]
    async fn dropping_the_registration_finishes_the_turn() {
        let registry = Arc::new(CancelRegistry::default());
        let (sink, _) = capture();
        let registration = registry.register("chat", Some(SwappableSink::new(sink.clone())));
        let (turn, _) = registry.attach("chat", None, sink).unwrap();
        let finished = turn.finished();
        tokio::pin!(finished);
        assert!(futures_util::poll!(finished.as_mut()).is_pending());

        // E.g. an early `?` return before the turn ever ran.
        drop(registration);
        finished.await;
        assert!(registry.running_turns().is_empty());
    }

    #[test]
    fn swappable_sink_follows_the_latest_target() {
        let (first, first_events) = capture();
        let (second, second_events) = capture();
        let events = SwappableSink::new(first);
        let sink = events.sink();
        let cloned = sink.clone();

        (sink)(delta("chat"));
        events.replace(second);
        (sink)(delta("chat"));
        (cloned)(delta("subagent"));

        assert_eq!(first_events.lock().unwrap().len(), 1);
        assert_eq!(second_events.lock().unwrap().len(), 2);
    }

    #[test]
    fn a_repeated_attach_cannot_take_the_turn_back() {
        let registry = Arc::new(CancelRegistry::default());
        let (original, _) = capture();
        let _registration = registry.register("chat", Some(SwappableSink::new(original)));
        let (first_page, first_events) = capture();
        let (second_page, second_events) = capture();
        assert!(registry.attach("chat", Some("first"), first_page.clone()).unwrap().1);
        assert!(registry.attach("chat", Some("second"), second_page).unwrap().1);

        // The first page reloaded while attached, so Tauri delivers its attach
        // again: the turn must keep streaming to the second page.
        let (turn, attached) = registry.attach("chat", Some("first"), first_page).unwrap();
        assert!(!attached);
        turn.emit(delta("chat"));
        assert!(first_events.lock().unwrap().is_empty());
        assert_eq!(second_events.lock().unwrap().len(), 1);
    }

    fn app_state(dir: &Path) -> AppState {
        let db = Db::open(&dir.join("pumr.sqlite")).unwrap();
        db.migrate().unwrap();
        AppState::new(
            db,
            dir.to_path_buf(),
            dir.join("settings.json"),
            Settings::default(),
        )
    }

    fn command_prompt(dir: &Path, grant_session_id: &str) -> PermissionPrompt {
        PermissionPrompt {
            kind: "command".to_string(),
            operation: PermissionOperation::Execute,
            cwd: Some(dir.to_path_buf()),
            project_root: dir.to_path_buf(),
            title: "Run command?".to_string(),
            detail: "Approval required".to_string(),
            command: Some("npm install".to_string()),
            path: None,
            folder: None,
            url: None,
            suggested_rule: None,
            segments: Vec::new(),
            risk: None,
            scope_options: Vec::new(),
            folders: Vec::new(),
            hosts: Vec::new(),
            justification: None,
            grant_session_id: grant_session_id.to_string(),
        }
    }

    fn questions() -> Vec<QuestionItem> {
        vec![QuestionItem {
            header: "Target".to_string(),
            question: "Which crate?".to_string(),
            options: Vec::new(),
            multi_select: false,
        }]
    }

    #[tokio::test]
    async fn attaching_resends_the_prompts_of_the_turn_and_its_subagents() {
        let temp = tempfile::tempdir().unwrap();
        let state = app_state(temp.path());
        let project = state
            .db
            .upsert_project(&temp.path().display().to_string())
            .unwrap();
        let chat = state
            .db
            .create_session(&project.id, "chat", None, None, None, None, None)
            .unwrap();
        let subagent = state
            .db
            .create_sub_session(&project.id, &chat.id, "subagent", None, None, None, None)
            .unwrap();
        let other = state
            .db
            .create_session(&project.id, "other", None, None, None, None, None)
            .unwrap();

        let (old_channel, old_events) = capture();
        let events = SwappableSink::new(old_channel);
        let sink = events.sink();
        let registration = state.register_turn(&chat.id, events);
        let cancel = registration.token();
        let (other_channel, _) = capture();
        let other_cancel = CancellationToken::new();

        let permission =
            state
                .broker
                .ask(command_prompt(temp.path(), &chat.id), &cancel, &subagent.id, &sink);
        let question = state.questions.ask(questions(), &cancel, &chat.id, &sink);
        let unrelated = state
            .questions
            .ask(questions(), &other_cancel, &other.id, &other_channel);
        tokio::pin!(permission, question, unrelated);
        assert!(futures_util::poll!(permission.as_mut()).is_pending());
        assert!(futures_util::poll!(question.as_mut()).is_pending());
        assert!(futures_util::poll!(unrelated.as_mut()).is_pending());
        let asked = requests(&old_events);
        assert_eq!(asked.len(), 2);

        // The page owning the old channel reloads and attaches a new one: it
        // gets this turn's open prompts again, but not the other chat's.
        let (new_channel, new_events) = capture();
        let turn = state
            .attach_turn(&chat.id, Some("attach"), new_channel)
            .unwrap();
        assert_eq!(requests(&new_events), asked);
        (sink)(delta(&chat.id));
        assert!(matches!(
            new_events.lock().unwrap().last().unwrap().event,
            StreamEvent::Delta { .. }
        ));

        state.broker.resolve(
            &asked[0].1,
            PermissionDecision {
                allowed: true,
                rule: None,
                folder: None,
                decided_by: "user".to_string(),
                decision: Some("allow_once".to_string()),
            },
        );
        assert!(permission.await.allowed);
        state.questions.resolve(&asked[1].1, None);
        assert!(question.await.is_none());
        assert!(new_events.lock().unwrap().iter().any(|routed| matches!(
            &routed.event,
            StreamEvent::PermissionResolved { request_id, .. } if *request_id == asked[0].1
        )));

        let finished = turn.finished();
        tokio::pin!(finished);
        assert!(futures_util::poll!(finished.as_mut()).is_pending());
        drop(registration);
        finished.await;
        assert!(state.running_turns().is_empty());
        assert!(state.attach_turn(&chat.id, None, capture().0).is_none());
        other_cancel.cancel();
        assert!(unrelated.await.is_none());
    }
}
