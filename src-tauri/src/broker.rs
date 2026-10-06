use crate::model_match::{self, ModelMatch};
use crate::models::{
    EventSink, McpToolGrant, ModelInfo, PermissionAuditEntry, PermissionDecision, QuestionAnswer,
    QuestionItem, RoutedEvent, StreamEvent,
};
use crate::permissions::{CommandRisk, CommandScopeOption, CommandSegment, LivePermissions};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PermissionOperation {
    Read,
    Write,
    Access,
    Execute,
    Fetch,
    McpTool,
    McpStart,
    /// Running a command outside the sandbox. No rule or grant answers this
    /// prompt in the user's place.
    Unsandboxed,
}

#[derive(Debug, Clone)]
pub struct PermissionPrompt {
    pub kind: String,
    /// Backend-only identity; neither field changes the streamed prompt contract.
    pub operation: PermissionOperation,
    pub cwd: Option<PathBuf>,
    /// Project root the prompt was issued from. Backend-only: used to
    /// re-evaluate queued prompts against freshly granted rules and folders
    /// (opencode-style auto-resolution), never streamed to the renderer.
    pub project_root: PathBuf,
    pub title: String,
    pub detail: String,
    pub command: Option<String>,
    pub path: Option<String>,
    pub folder: Option<String>,
    pub url: Option<String>,
    pub suggested_rule: Option<String>,
    /// Per-segment breakdown of a compound command, empty for other prompts.
    pub segments: Vec<CommandSegment>,
    /// Severity and impact of a command prompt; `None` for other prompt kinds.
    pub risk: Option<CommandRisk>,
    /// Allow/deny scopes the user can pick for a command prompt.
    pub scope_options: Vec<CommandScopeOption>,
    /// Outside-project directories the user can whitelist from a command prompt.
    pub folders: Vec<String>,
    /// Websites a command contacts that the user can allow from its prompt.
    pub hosts: Vec<String>,
    /// The conversation (root session) an "allow in this chat" grant belongs to.
    /// Distinct from the routing `session_id`, which may be a subagent.
    pub grant_session_id: String,
    /// What a "don't ask again" on an MCP tool prompt remembers: the tool and
    /// its exact server. `None` for every other prompt.
    pub mcp_tool: Option<McpToolGrant>,
    /// Folders whose sensitive files the user can release from this prompt.
    pub secret_folders: Vec<String>,
    /// The assistant's own one-sentence explanation of why it needs this,
    /// taken from the tool call's `reason` argument. Untrusted model text:
    /// shown as the assistant's claim, never used for the decision.
    pub justification: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PermissionSignature {
    session_id: String,
    kind: String,
    operation: PermissionOperation,
    cwd: Option<PathBuf>,
    command: Option<String>,
    path: Option<String>,
    folder: Option<String>,
    url: Option<String>,
}

impl PermissionPrompt {
    /// Only equivalent operations within the same session share a decision.
    fn signature(&self, session_id: &str) -> PermissionSignature {
        PermissionSignature {
            session_id: session_id.to_string(),
            kind: self.kind.clone(),
            operation: self.operation,
            cwd: self.cwd.clone(),
            command: self.command.clone(),
            path: self.path.clone(),
            folder: self.folder.clone(),
            url: self.url.clone(),
        }
    }
}

struct PendingPermission {
    signature: PermissionSignature,
    sender: watch::Sender<Option<PermissionDecision>>,
    /// Copy of what the backend actually asked, so `resolve_permission` can
    /// persist only the values this prompt proposed rather than trusting the
    /// renderer.
    kind: String,
    folder: Option<String>,
    suggested_rule: Option<String>,
    scope_options: Vec<CommandScopeOption>,
    folders: Vec<String>,
    hosts: Vec<String>,
    mcp_tool: Option<McpToolGrant>,
    secret_folders: Vec<String>,
    session_id: String,
    grant_session_id: String,
    project_root: PathBuf,
    /// The `PermissionRequest` event that announced the prompt, so it can be
    /// sent again to a webview that reloaded before the user answered.
    request: StreamEvent,
    /// Creation order, so re-sent prompts keep the order they were asked in.
    seq: u64,
}

/// The backend-owned fields of a pending prompt, used to validate a renderer's
/// decision before persisting an allow/deny rule or folder.
#[derive(Debug, Clone)]
pub struct PendingPrompt {
    pub kind: String,
    pub command: Option<String>,
    pub folder: Option<String>,
    pub suggested_rule: Option<String>,
    pub scope_options: Vec<CommandScopeOption>,
    /// Outside-project directories the backend proposed for whitelisting.
    pub folders: Vec<String>,
    /// Websites the backend proposed for allowing from a command prompt.
    pub hosts: Vec<String>,
    /// The MCP tool the prompt asked about, which a remembering allow saves.
    pub mcp_tool: Option<McpToolGrant>,
    /// Folders with sensitive files the backend proposed for release.
    pub secret_folders: Vec<String>,
    /// The URL a website prompt asked about, so an edited website rule can be
    /// checked against the host it must still cover.
    pub url: Option<String>,
    /// Routing session id of the prompt (may be a subagent); kept for callers
    /// and tests that distinguish the asking session from the chat.
    #[allow(dead_code)]
    pub session_id: String,
    /// The conversation to store an "allow in this chat" grant under.
    pub grant_session_id: String,
}

/// A denial the user did not make; `by` says what decided it.
fn deny_by(by: &str) -> PermissionDecision {
    PermissionDecision {
        allowed: false,
        rule: None,
        folder: None,
        decided_by: by.to_string(),
        decision: None,
    }
}

fn allow_by(by: &str) -> PermissionDecision {
    PermissionDecision {
        allowed: true,
        rule: None,
        folder: None,
        decided_by: by.to_string(),
        decision: None,
    }
}

/// Records `decision` unless the prompt already has one.
fn decide_once(
    sender: &watch::Sender<Option<PermissionDecision>>,
    decision: PermissionDecision,
) -> bool {
    sender.send_if_modified(|current| {
        if current.is_some() {
            return false;
        }
        *current = Some(decision);
        true
    })
}

/// Receives every permission decision for the audit log.
pub type AuditSink = Arc<dyn Fn(PermissionAuditEntry) + Send + Sync>;

/// A queued prompt's backend-owned state, snapshotted so it can be
/// re-evaluated against the live permissions without holding the broker lock.
struct PendingSnapshot {
    request_id: String,
    kind: String,
    operation: PermissionOperation,
    command: Option<String>,
    cwd: Option<PathBuf>,
    path: Option<String>,
    url: Option<String>,
    mcp_tool: Option<McpToolGrant>,
    project_root: PathBuf,
    grant_session_id: String,
}

impl PendingSnapshot {
    /// Re-checks the prompt against the live permissions after a grant.
    /// `Some(true)` auto-allows, `Some(false)` auto-denies (a fresh deny rule
    /// now covers it), `None` leaves the prompt for the user. Mirrors
    /// opencode's reply flow, where an "always" grant auto-approves every
    /// pending request it covers.
    fn evaluate(&self, permissions: &LivePermissions) -> Option<bool> {
        match self.kind.as_str() {
            // A call of an MCP tool the user has just allowed for the chat or
            // for good. Nothing denies an MCP tool, so it never auto-denies.
            "command" if self.operation == PermissionOperation::McpTool => {
                let grant = self.mcp_tool.as_ref()?;
                permissions
                    .mcp_tool_grant_scope(&self.grant_session_id, grant)
                    .map(|_| true)
            }
            // Only real shell commands can be re-evaluated; MCP prompts carry a
            // JSON preview, not a command line.
            "command" if self.operation == PermissionOperation::Execute => {
                let command = self.command.as_deref()?.trim().to_string();
                if command.is_empty() {
                    return None;
                }
                let cwd = self.cwd.clone()?;
                // No snapshot is at hand here, so a deleting command that
                // asked stays with the user.
                match permissions.evaluate_command(
                    &command,
                    &self.project_root,
                    &cwd,
                    &self.grant_session_id,
                    None,
                    &mut Vec::new(),
                ) {
                    crate::permissions::CommandDecision::Allow => Some(true),
                    crate::permissions::CommandDecision::Deny { .. } => Some(false),
                    crate::permissions::CommandDecision::Ask { .. } => None,
                }
            }
            // Folder prompts become obsolete once the folder (or a parent of
            // it) was granted. Sensitive-file prompts ("file") never
            // auto-resolve: no grant covers them.
            "folder" => {
                let path = self.path.as_deref()?;
                let absolute = crate::permissions::resolve_path(&self.project_root, path);
                let extra = permissions.folders_for(&self.grant_session_id);
                if crate::permissions::path_is_inside(&absolute, &self.project_root, &extra)
                    && !crate::permissions::symlink_escapes(&absolute, &self.project_root, &extra)
                {
                    Some(true)
                } else {
                    None
                }
            }
            kind if kind.starts_with("web") => {
                let host = reqwest::Url::parse(self.url.as_deref()?)
                    .ok()
                    .and_then(|parsed| parsed.host_str().map(str::to_string))?;
                match crate::permissions::evaluate_website(
                    &host,
                    &permissions.allowed_websites(),
                    &permissions.denied_websites(),
                ) {
                    crate::permissions::WebsiteDecision::Allow => Some(true),
                    crate::permissions::WebsiteDecision::Deny { .. } => Some(false),
                    crate::permissions::WebsiteDecision::Ask { .. } => None,
                }
            }
            _ => None,
        }
    }
}

pub struct PermissionBroker {
    inner: Mutex<BrokerInner>,
    audit: Mutex<Option<AuditSink>>,
}

#[derive(Default)]
struct BrokerInner {
    pending: HashMap<String, PendingPermission>,
    by_signature: HashMap<PermissionSignature, String>,
    next_seq: u64,
}

impl PermissionBroker {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(BrokerInner::default()),
            audit: Mutex::new(None),
        }
    }

    /// Where decisions are recorded; without a sink nothing is logged.
    pub fn set_audit_sink(&self, sink: AuditSink) {
        *self.audit.lock().unwrap() = Some(sink);
    }

    /// Records a permission decision in the audit log. Prompted decisions are
    /// recorded by [`Self::ask`]; tools call this for decisions made without a
    /// prompt (allowed by a rule or an automatic approval, denied by a rule).
    pub fn audit(&self, entry: PermissionAuditEntry) {
        let sink = self.audit.lock().unwrap().clone();
        if let Some(sink) = sink {
            sink(entry);
        }
    }

    /// Answers a queued prompt. The first decision wins: a prompt stays listed
    /// until its waiter wakes up, and in that window an automatic re-check or a
    /// deny cascade must not overwrite what the user (or an earlier grant)
    /// already decided. Returns whether this decision was the one applied.
    pub fn resolve(&self, request_id: &str, decision: PermissionDecision) -> bool {
        // The waiter that created the prompt removes the entry after waking up.
        // Sending without removing lets late duplicates reuse the same answer.
        let inner = self.inner.lock().unwrap();
        let Some(entry) = inner.pending.get(request_id) else {
            return false;
        };
        decide_once(&entry.sender, decision)
    }

    /// Returns the backend-owned details of a still-pending prompt. `None` when
    /// the id is unknown or already resolved, which callers use to reject
    /// decisions that do not correspond to a real prompt.
    pub fn pending_prompt(&self, request_id: &str) -> Option<PendingPrompt> {
        self.inner
            .lock()
            .unwrap()
            .pending
            .get(request_id)
            .filter(|entry| entry.sender.borrow().is_none())
            .map(|entry| PendingPrompt {
                kind: entry.kind.clone(),
                command: entry.signature.command.clone(),
                folder: entry.folder.clone(),
                suggested_rule: entry.suggested_rule.clone(),
                scope_options: entry.scope_options.clone(),
                folders: entry.folders.clone(),
                hosts: entry.hosts.clone(),
                mcp_tool: entry.mcp_tool.clone(),
                secret_folders: entry.secret_folders.clone(),
                url: entry.signature.url.clone(),
                session_id: entry.session_id.clone(),
                grant_session_id: entry.grant_session_id.clone(),
            })
    }

    /// Prompts still waiting on the user, oldest first, as the events that
    /// announced them. Prompts that already have a decision are left out.
    pub fn pending_requests(&self) -> Vec<RoutedEvent> {
        let inner = self.inner.lock().unwrap();
        let mut entries: Vec<&PendingPermission> = inner
            .pending
            .values()
            .filter(|entry| entry.sender.borrow().is_none())
            .collect();
        entries.sort_by_key(|entry| entry.seq);
        entries
            .into_iter()
            .map(|entry| RoutedEvent {
                session_id: entry.session_id.clone(),
                event: entry.request.clone(),
            })
            .collect()
    }

    /// Denies the queued prompts of a stopped chat: its own and its subagents'
    /// (which carry the chat as their grant session). Prompts of other chats
    /// stay pending; stopping one chat must not answer another chat's prompts.
    pub fn deny_session(&self, session_id: &str) {
        let inner = self.inner.lock().unwrap();
        for entry in inner.pending.values() {
            if entry.grant_session_id == session_id || entry.session_id == session_id {
                decide_once(&entry.sender, deny_by("stopped"));
            }
        }
    }

    /// Re-evaluates every queued prompt of a chat against the live permissions
    /// and resolves the ones a fresh grant now covers. Returns the request ids
    /// that were resolved without user interaction.
    pub fn auto_resolve(
        &self,
        grant_session_id: &str,
        permissions: &LivePermissions,
    ) -> Vec<String> {
        let snapshots: Vec<PendingSnapshot> = {
            let inner = self.inner.lock().unwrap();
            inner
                .pending
                .iter()
                .filter(|(_, entry)| {
                    entry.grant_session_id == grant_session_id && entry.sender.borrow().is_none()
                })
                .map(|(request_id, entry)| PendingSnapshot {
                    request_id: request_id.clone(),
                    kind: entry.kind.clone(),
                    operation: entry.signature.operation,
                    command: entry.signature.command.clone(),
                    cwd: entry.signature.cwd.clone(),
                    path: entry.signature.path.clone(),
                    url: entry.signature.url.clone(),
                    mcp_tool: entry.mcp_tool.clone(),
                    project_root: entry.project_root.clone(),
                    grant_session_id: entry.grant_session_id.clone(),
                })
                .collect()
        };
        let mut resolved = Vec::new();
        for snapshot in snapshots {
            let decision = match snapshot.evaluate(permissions) {
                Some(true) => allow_by("grant"),
                Some(false) => deny_by("grant"),
                None => continue,
            };
            if self.resolve(&snapshot.request_id, decision) {
                resolved.push(snapshot.request_id);
            }
        }
        resolved
    }

    /// Denies every other queued prompt of a chat. opencode's reject cascade:
    /// one rejection stops the session's whole pending batch instead of making
    /// the user deny each prompt individually.
    pub fn deny_chat(&self, grant_session_id: &str, except_request_id: &str) {
        let request_ids: Vec<String> = {
            let inner = self.inner.lock().unwrap();
            inner
                .pending
                .iter()
                .filter(|(request_id, entry)| {
                    entry.grant_session_id == grant_session_id
                        && request_id.as_str() != except_request_id
                })
                .map(|(request_id, _)| request_id.clone())
                .collect()
        };
        for request_id in request_ids {
            self.resolve(&request_id, deny_by("cascade"));
        }
    }

    pub async fn ask(
        &self,
        prompt: PermissionPrompt,
        cancel: &CancellationToken,
        session_id: &str,
        emit: &EventSink,
    ) -> PermissionDecision {
        let signature = prompt.signature(session_id);
        let (request, request_id, mut receiver) = {
            let mut inner = self.inner.lock().unwrap();
            match inner.by_signature.get(&signature).cloned() {
                Some(existing) if inner.pending.contains_key(&existing) => {
                    let receiver = inner
                        .pending
                        .get(&existing)
                        .map(|entry| entry.sender.subscribe())
                        .unwrap();
                    (None, existing, receiver)
                }
                _ => {
                    let request_id = Uuid::new_v4().to_string();
                    let (sender, receiver) = watch::channel(None);
                    let request = StreamEvent::PermissionRequest {
                        request_id: request_id.clone(),
                        prompt_kind: prompt.kind.clone(),
                        title: prompt.title.clone(),
                        detail: prompt.detail.clone(),
                        command: prompt.command.clone(),
                        path: prompt.path.clone(),
                        folder: prompt.folder.clone(),
                        url: prompt.url.clone(),
                        suggested_rule: prompt.suggested_rule.clone(),
                        segments: prompt.segments.clone(),
                        risk: prompt.risk.clone(),
                        scope_options: prompt.scope_options.clone(),
                        folders: prompt.folders.clone(),
                        hosts: prompt.hosts.clone(),
                        mcp_tool: prompt.mcp_tool.clone(),
                        secret_folders: prompt.secret_folders.clone(),
                        justification: prompt.justification.clone(),
                    };
                    inner.next_seq += 1;
                    let seq = inner.next_seq;
                    inner
                        .by_signature
                        .insert(signature.clone(), request_id.clone());
                    inner.pending.insert(
                        request_id.clone(),
                        PendingPermission {
                            signature,
                            sender,
                            kind: prompt.kind.clone(),
                            folder: prompt.folder.clone(),
                            suggested_rule: prompt.suggested_rule.clone(),
                            scope_options: prompt.scope_options.clone(),
                            folders: prompt.folders.clone(),
                            hosts: prompt.hosts.clone(),
                            mcp_tool: prompt.mcp_tool.clone(),
                            secret_folders: prompt.secret_folders.clone(),
                            session_id: session_id.to_string(),
                            grant_session_id: prompt.grant_session_id.clone(),
                            project_root: prompt.project_root.clone(),
                            request: request.clone(),
                            seq,
                        },
                    );
                    (Some(request), request_id, receiver)
                }
            }
        };
        let is_new = request.is_some();

        if let Some(request) = request {
            (emit)(RoutedEvent {
                session_id: session_id.to_string(),
                event: request,
            });
        }

        let decision = loop {
            if let Some(value) = receiver.borrow().clone() {
                break value;
            }
            tokio::select! {
                result = receiver.changed() => {
                    if result.is_err() {
                        break deny_by("cancelled");
                    }
                }
                _ = cancel.cancelled() => break deny_by("cancelled"),
                _ = tokio::time::sleep(Duration::from_secs(600)) => break deny_by("timeout"),
            }
        };

        if is_new {
            self.audit(PermissionAuditEntry {
                id: 0,
                created_at: 0,
                session_id: session_id.to_string(),
                conversation_id: prompt.grant_session_id.clone(),
                kind: prompt.kind.clone(),
                subject: prompt
                    .command
                    .clone()
                    .or_else(|| prompt.url.clone())
                    .or_else(|| prompt.path.clone())
                    .or_else(|| prompt.folder.clone())
                    .unwrap_or_else(|| prompt.title.clone()),
                allowed: decision.allowed,
                decided_by: if decision.decided_by.is_empty() {
                    "user".to_string()
                } else {
                    decision.decided_by.clone()
                },
                decision: decision.decision.clone(),
                reason: prompt.detail.clone(),
                rule: decision.rule.clone(),
            });
            // Unlist the prompt before announcing the decision, so a webview
            // re-attaching in between is never sent a prompt already resolved.
            {
                let mut inner = self.inner.lock().unwrap();
                if let Some(entry) = inner.pending.remove(&request_id) {
                    inner.by_signature.remove(&entry.signature);
                }
            }
            (emit)(RoutedEvent {
                session_id: session_id.to_string(),
                event: StreamEvent::PermissionResolved {
                    request_id: request_id.clone(),
                    allowed: decision.allowed,
                },
            });
        }
        decision
    }
}

impl Default for PermissionBroker {
    fn default() -> Self {
        Self::new()
    }
}

/// Mirrors [`PermissionBroker`] for interactive questions. A tool call parks
/// here until the user submits answers (or skips), the turn is cancelled, or the
/// prompt times out.
pub struct QuestionBroker {
    /// Open questions by request id.
    pending: Mutex<HashMap<String, PendingQuestion>>,
    next_seq: AtomicU64,
}

struct PendingQuestion {
    /// Delivers the answers; `None` skips the question.
    sender: oneshot::Sender<Option<Vec<QuestionAnswer>>>,
    /// The session that asked.
    session_id: String,
    /// Kept so the question can be sent again to a webview that reloaded
    /// before the user answered.
    questions: Vec<QuestionItem>,
    seq: u64,
}

impl QuestionBroker {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            next_seq: AtomicU64::new(0),
        }
    }

    pub fn resolve(&self, request_id: &str, answers: Option<Vec<QuestionAnswer>>) {
        if let Some(entry) = self.pending.lock().unwrap().remove(request_id) {
            let _ = entry.sender.send(answers);
        }
    }

    /// Skips the open questions of a stopped session. Other chats keep theirs;
    /// a subagent's questions end through the cancel token it shares with its
    /// chat.
    pub fn skip_session(&self, session_id: &str) {
        let mut pending = self.pending.lock().unwrap();
        let asked: Vec<String> = pending
            .iter()
            .filter(|(_, entry)| entry.session_id == session_id)
            .map(|(request_id, _)| request_id.clone())
            .collect();
        for request_id in asked {
            if let Some(entry) = pending.remove(&request_id) {
                let _ = entry.sender.send(None);
            }
        }
    }

    /// Questions still waiting on the user, oldest first, as the events that
    /// announced them.
    pub fn pending_requests(&self) -> Vec<RoutedEvent> {
        let pending = self.pending.lock().unwrap();
        let mut entries: Vec<(&String, &PendingQuestion)> = pending.iter().collect();
        entries.sort_by_key(|(_, entry)| entry.seq);
        entries
            .into_iter()
            .map(|(request_id, entry)| RoutedEvent {
                session_id: entry.session_id.clone(),
                event: StreamEvent::QuestionRequest {
                    request_id: request_id.clone(),
                    questions: entry.questions.clone(),
                },
            })
            .collect()
    }

    pub async fn ask(
        &self,
        questions: Vec<QuestionItem>,
        cancel: &CancellationToken,
        session_id: &str,
        emit: &EventSink,
    ) -> Option<Vec<QuestionAnswer>> {
        let request_id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(
            request_id.clone(),
            PendingQuestion {
                sender,
                session_id: session_id.to_string(),
                questions: questions.clone(),
                seq: self.next_seq.fetch_add(1, Ordering::Relaxed),
            },
        );

        (emit)(RoutedEvent {
            session_id: session_id.to_string(),
            event: StreamEvent::QuestionRequest {
                request_id: request_id.clone(),
                questions,
            },
        });

        let answers = tokio::select! {
            result = receiver => result.unwrap_or(None),
            _ = cancel.cancelled() => None,
            _ = tokio::time::sleep(Duration::from_secs(600)) => None,
        };

        self.pending.lock().unwrap().remove(&request_id);
        (emit)(RoutedEvent {
            session_id: session_id.to_string(),
            event: StreamEvent::QuestionResolved {
                request_id,
                answers: answers.clone(),
            },
        });
        answers
    }
}

impl Default for QuestionBroker {
    fn default() -> Self {
        Self::new()
    }
}

/// Mirrors [`QuestionBroker`] for the model of a subagent. When the name the
/// agent passed to `task` fits several models, the turn parks here until the
/// user picks one (or skips), it is cancelled, or the prompt times out. A pick
/// is remembered for the chat, so the same name asks once.
pub struct ModelChoiceBroker {
    /// Open prompts by request id.
    pending: Mutex<HashMap<String, PendingModelChoice>>,
    /// Picked model ids by chat and by the name that was asked about.
    remembered: Mutex<HashMap<(String, String), String>>,
    next_seq: AtomicU64,
}

struct PendingModelChoice {
    /// Delivers the picked model id; `None` skips the prompt.
    sender: oneshot::Sender<Option<String>>,
    /// The session that asked.
    session_id: String,
    /// Kept so the prompt can be sent again to a webview that reloaded before
    /// the user answered.
    query: String,
    candidates: Vec<String>,
    seq: u64,
}

impl ModelChoiceBroker {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            remembered: Mutex::new(HashMap::new()),
            next_seq: AtomicU64::new(0),
        }
    }

    pub fn resolve(&self, request_id: &str, model: Option<String>) {
        if let Some(entry) = self.pending.lock().unwrap().remove(request_id) {
            let _ = entry.sender.send(model);
        }
    }

    /// Skips the open prompts of a stopped session.
    pub fn skip_session(&self, session_id: &str) {
        let mut pending = self.pending.lock().unwrap();
        let asked: Vec<String> = pending
            .iter()
            .filter(|(_, entry)| entry.session_id == session_id)
            .map(|(request_id, _)| request_id.clone())
            .collect();
        for request_id in asked {
            if let Some(entry) = pending.remove(&request_id) {
                let _ = entry.sender.send(None);
            }
        }
    }

    /// Prompts still waiting on the user, oldest first, as the events that
    /// announced them.
    pub fn pending_requests(&self) -> Vec<RoutedEvent> {
        let pending = self.pending.lock().unwrap();
        let mut entries: Vec<(&String, &PendingModelChoice)> = pending.iter().collect();
        entries.sort_by_key(|(_, entry)| entry.seq);
        entries
            .into_iter()
            .map(|(request_id, entry)| RoutedEvent {
                session_id: entry.session_id.clone(),
                event: StreamEvent::ModelChoiceRequest {
                    request_id: request_id.clone(),
                    query: entry.query.clone(),
                    candidates: entry.candidates.clone(),
                },
            })
            .collect()
    }

    /// The model the user picked for `key` (see `model_match::key`) in this chat.
    pub fn remembered(&self, conversation_id: &str, key: &str) -> Option<String> {
        self.remembered
            .lock()
            .unwrap()
            .get(&(conversation_id.to_string(), key.to_string()))
            .cloned()
    }

    pub fn remember(&self, conversation_id: &str, key: &str, model: &str) {
        self.remembered.lock().unwrap().insert(
            (conversation_id.to_string(), key.to_string()),
            model.to_string(),
        );
    }

    /// Drops the picks of chats that are deleted or archived.
    pub fn forget(&self, conversation_ids: &[String]) {
        self.remembered
            .lock()
            .unwrap()
            .retain(|(conversation_id, _), _| !conversation_ids.contains(conversation_id));
    }

    /// The model `name` stands for in the chat `conversation_id`, which runs
    /// on `chat_provider` (see [`model_match`]). A name that fits several of
    /// `models` asks the user, once per chat; `Err` tells the agent why no
    /// model was settled.
    #[allow(clippy::too_many_arguments)]
    pub async fn settle(
        &self,
        name: &str,
        models: &[ModelInfo],
        chat_provider: &str,
        conversation_id: &str,
        session_id: &str,
        cancel: &CancellationToken,
        emit: &EventSink,
    ) -> Result<String, String> {
        let known = |model: &str| models.iter().any(|entry| entry.id == model);
        let key = model_match::key(name);
        if let Some(model) = self
            .remembered(conversation_id, &key)
            .filter(|model| known(model))
        {
            return Ok(model);
        }
        if models.is_empty() {
            return Err(format!(
                "pumr has not loaded the model list yet, so \"{name}\" could not be matched and the subagent was not started. Tell the user."
            ));
        }
        let candidates = match model_match::resolve(name, models, chat_provider) {
            ModelMatch::One(model) => return Ok(model),
            ModelMatch::Several(candidates) => candidates,
            ModelMatch::None => {
                return Err(format!(
                    "No model of the connected providers matches \"{name}\", so the subagent was not started. Do not pick another model yourself; tell the user and ask which model to use."
                ))
            }
        };
        match self.ask(name, candidates, cancel, session_id, emit).await {
            Some(model) if known(&model) => {
                self.remember(conversation_id, &key, &model);
                Ok(model)
            }
            Some(model) => Err(format!(
                "The model \"{model}\" the user picked is not available, so the subagent was not started. Tell the user."
            )),
            None => Err(format!(
                "The user did not pick a model for \"{name}\", so the subagent was not started. Do not retry with a model you guess; ask the user how to continue."
            )),
        }
    }

    /// Asks which of `candidates` (model ids, the closest first) the user
    /// meant by `query`. The answer may be any model, not only a candidate.
    pub async fn ask(
        &self,
        query: &str,
        candidates: Vec<String>,
        cancel: &CancellationToken,
        session_id: &str,
        emit: &EventSink,
    ) -> Option<String> {
        let request_id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(
            request_id.clone(),
            PendingModelChoice {
                sender,
                session_id: session_id.to_string(),
                query: query.to_string(),
                candidates: candidates.clone(),
                seq: self.next_seq.fetch_add(1, Ordering::Relaxed),
            },
        );

        (emit)(RoutedEvent {
            session_id: session_id.to_string(),
            event: StreamEvent::ModelChoiceRequest {
                request_id: request_id.clone(),
                query: query.to_string(),
                candidates,
            },
        });

        let model = tokio::select! {
            result = receiver => result.unwrap_or(None),
            _ = cancel.cancelled() => None,
            _ = tokio::time::sleep(Duration::from_secs(600)) => None,
        };

        self.pending.lock().unwrap().remove(&request_id);
        (emit)(RoutedEvent {
            session_id: session_id.to_string(),
            event: StreamEvent::ModelChoiceResolved {
                request_id,
                model: model.clone(),
            },
        });
        model
    }
}

impl Default for ModelChoiceBroker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::CommandRule;
    use crate::permissions::AutoApproveConfig;
    use std::path::Path;
    use std::sync::Arc;

    fn command_prompt() -> PermissionPrompt {
        PermissionPrompt {
            kind: "command".to_string(),
            operation: PermissionOperation::Execute,
            cwd: Some(std::env::current_dir().unwrap()),
            project_root: std::env::current_dir().unwrap(),
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
            grant_session_id: "chat".to_string(),
            mcp_tool: None,
            secret_folders: Vec::new(),
            justification: None,
        }
    }

    async fn assert_prompt_sharing(
        first: PermissionPrompt,
        first_session: &str,
        second: PermissionPrompt,
        second_session: &str,
        shared: bool,
    ) {
        let broker = PermissionBroker::new();
        let cancel = CancellationToken::new();
        let events = Arc::new(Mutex::new(Vec::new()));
        let emit: EventSink = {
            let events = events.clone();
            Arc::new(move |event| events.lock().unwrap().push(event))
        };
        let first_command = first.command.clone();
        let second_command = second.command.clone();
        let first = broker.ask(first, &cancel, first_session, &emit);
        let second = broker.ask(second, &cancel, second_session, &emit);
        tokio::pin!(first, second);
        // Poll both requests into the broker before resolving either, without sleeps.
        assert!(futures_util::poll!(first.as_mut()).is_pending());
        assert!(futures_util::poll!(second.as_mut()).is_pending());

        let requests: Vec<_> = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match &event.event {
                StreamEvent::PermissionRequest { request_id, .. } => {
                    Some((request_id.clone(), event.session_id.clone()))
                }
                _ => None,
            })
            .collect();
        assert_eq!(requests.len(), if shared { 1 } else { 2 });
        assert_eq!(requests[0].1, first_session);
        assert_eq!(
            broker.pending_prompt(&requests[0].0).unwrap().command,
            first_command,
        );
        if !shared {
            assert_ne!(requests[0].0, requests[1].0);
            assert_eq!(requests[1].1, second_session);
            assert_eq!(
                broker.pending_prompt(&requests[1].0).unwrap().session_id,
                second_session
            );
            assert_eq!(
                broker.pending_prompt(&requests[1].0).unwrap().command,
                second_command,
            );
        }

        broker.resolve(&requests[0].0, allow_by("user"));
        assert!(first.await.allowed);
        if !shared {
            assert!(futures_util::poll!(second.as_mut()).is_pending());
            broker.resolve(&requests[1].0, deny_by("user"));
        }
        assert_eq!(second.await.allowed, shared);
        let resolved = events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| matches!(event.event, StreamEvent::PermissionResolved { .. }))
            .count();
        assert_eq!(resolved, requests.len());
        assert!(broker.inner.lock().unwrap().pending.is_empty());
        assert!(broker.inner.lock().unwrap().by_signature.is_empty());
    }

    #[tokio::test]
    async fn same_command_in_different_sessions_has_independent_requests() {
        assert_prompt_sharing(
            command_prompt(),
            "chat",
            command_prompt(),
            "subagent",
            false,
        )
        .await;
        assert_prompt_sharing(
            command_prompt(),
            "subagent-a",
            command_prompt(),
            "subagent-b",
            false,
        )
        .await;
    }

    #[tokio::test]
    async fn same_command_in_different_working_directories_has_independent_requests() {
        let first = command_prompt();
        let mut second = first.clone();
        second.cwd = Some(first.cwd.as_ref().unwrap().join("other-project"));
        assert_prompt_sharing(first, "chat", second, "chat", false).await;
    }

    #[tokio::test]
    async fn sensitive_file_read_and_write_have_independent_requests() {
        let mut read = command_prompt();
        read.kind = "file".to_string();
        read.operation = PermissionOperation::Read;
        read.command = None;
        read.path = Some(
            read.cwd
                .as_ref()
                .unwrap()
                .join(".env")
                .display()
                .to_string(),
        );
        let mut write = read.clone();
        write.operation = PermissionOperation::Write;
        assert_prompt_sharing(read, "chat", write, "chat", false).await;
    }

    #[tokio::test]
    async fn equivalent_same_session_requests_share_one_decision() {
        assert_prompt_sharing(command_prompt(), "chat", command_prompt(), "chat", true).await;
    }

    #[tokio::test]
    async fn pending_prompt_exposes_the_grant_conversation() {
        let broker = PermissionBroker::new();
        let cancel = CancellationToken::new();
        let emit: EventSink = Arc::new(|_| {});
        let mut prompt = command_prompt();
        prompt.grant_session_id = "root-chat".to_string();
        // The asking session is a subagent; grants belong to the root chat.
        let future = broker.ask(prompt, &cancel, "subagent", &emit);
        tokio::pin!(future);
        assert!(futures_util::poll!(future.as_mut()).is_pending());

        let request_id = broker
            .inner
            .lock()
            .unwrap()
            .by_signature
            .values()
            .next()
            .cloned()
            .unwrap();
        let pending = broker.pending_prompt(&request_id).unwrap();
        assert_eq!(pending.session_id, "subagent");
        assert_eq!(pending.grant_session_id, "root-chat");

        broker.resolve(&request_id, deny_by("user"));
        future.await;
    }

    #[tokio::test]
    async fn delimiters_in_resource_fields_cannot_collide() {
        let mut first = command_prompt();
        first.command = Some("a|b".to_string());
        first.path = Some("c".to_string());
        let mut second = first.clone();
        second.command = Some("a".to_string());
        second.path = Some("b|c".to_string());
        assert_prompt_sharing(first, "chat", second, "chat", false).await;
    }

    #[tokio::test]
    async fn missing_and_empty_resources_are_distinct() {
        let first = command_prompt();
        let mut second = first.clone();
        second.path = Some(String::new());
        assert_prompt_sharing(first, "chat", second, "chat", false).await;
    }

    #[tokio::test]
    async fn shell_and_mcp_operations_have_independent_requests() {
        for (first_operation, second_operation) in [
            (PermissionOperation::Execute, PermissionOperation::McpTool),
            (PermissionOperation::Execute, PermissionOperation::McpStart),
            (PermissionOperation::McpTool, PermissionOperation::McpStart),
        ] {
            let mut first = command_prompt();
            first.operation = first_operation;
            let mut second = first.clone();
            second.operation = second_operation;
            assert_prompt_sharing(first, "chat", second, "chat", false).await;
        }
    }

    fn folder_prompt(root: &Path, path: &Path, grant_session_id: &str) -> PermissionPrompt {
        PermissionPrompt {
            kind: "folder".to_string(),
            operation: PermissionOperation::Read,
            cwd: Some(root.to_path_buf()),
            project_root: root.to_path_buf(),
            title: "Access file outside the project?".to_string(),
            detail: "Approval required".to_string(),
            command: None,
            path: Some(path.display().to_string()),
            folder: path.parent().map(|parent| parent.display().to_string()),
            url: None,
            suggested_rule: None,
            segments: Vec::new(),
            risk: None,
            scope_options: Vec::new(),
            folders: Vec::new(),
            hosts: Vec::new(),
            grant_session_id: grant_session_id.to_string(),
            mcp_tool: None,
            secret_folders: Vec::new(),
            justification: None,
        }
    }

    fn live_permissions(extra_folders: Vec<String>) -> LivePermissions {
        LivePermissions::new(
            Vec::new(),
            Vec::new(),
            extra_folders,
            Vec::new(),
            Vec::new(),
            AutoApproveConfig::default(),
        )
    }

    fn outside_test_dir(tag: &str) -> PathBuf {
        let unique = format!(
            "pumr-broker-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let dir = std::env::temp_dir()
            .canonicalize()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join(unique);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn auto_resolve_allows_queued_folder_prompts_covered_by_a_grant() {
        let root = std::env::current_dir().unwrap();
        let outside = outside_test_dir("folders");
        let broker = PermissionBroker::new();
        let cancel = CancellationToken::new();
        let emit: EventSink = Arc::new(|_| {});
        // Two different files in the same outside folder queue two prompts.
        let first = broker.ask(
            folder_prompt(&root, &outside.join("a.txt"), "chat"),
            &cancel,
            "chat",
            &emit,
        );
        let second = broker.ask(
            folder_prompt(&root, &outside.join("b.txt"), "chat"),
            &cancel,
            "chat",
            &emit,
        );
        tokio::pin!(first, second);
        assert!(futures_util::poll!(first.as_mut()).is_pending());
        assert!(futures_util::poll!(second.as_mut()).is_pending());

        // Granting the folder (session or permanent) resolves both at once.
        let permissions = live_permissions(vec![outside.display().to_string()]);
        let mut resolved = broker.auto_resolve("chat", &permissions);
        resolved.sort();
        assert_eq!(resolved.len(), 2);
        assert!(first.await.allowed);
        assert!(second.await.allowed);
        assert!(broker.inner.lock().unwrap().pending.is_empty());
        std::fs::remove_dir_all(&outside).ok();
    }

    #[tokio::test]
    async fn auto_resolve_only_touches_the_granted_chat() {
        let root = std::env::current_dir().unwrap();
        let outside = outside_test_dir("chats");
        let broker = PermissionBroker::new();
        let cancel = CancellationToken::new();
        let emit: EventSink = Arc::new(|_| {});
        let first = broker.ask(
            folder_prompt(&root, &outside.join("a.txt"), "chat-a"),
            &cancel,
            "chat-a",
            &emit,
        );
        let second = broker.ask(
            folder_prompt(&root, &outside.join("b.txt"), "chat-b"),
            &cancel,
            "chat-b",
            &emit,
        );
        tokio::pin!(first, second);
        assert!(futures_util::poll!(first.as_mut()).is_pending());
        assert!(futures_util::poll!(second.as_mut()).is_pending());

        let permissions = live_permissions(vec![outside.display().to_string()]);
        assert_eq!(broker.auto_resolve("chat-a", &permissions).len(), 1);
        assert!(first.await.allowed);
        assert!(futures_util::poll!(second.as_mut()).is_pending());

        broker.deny_session("chat-b");
        assert!(!second.await.allowed);
        std::fs::remove_dir_all(&outside).ok();
    }

    #[tokio::test]
    async fn auto_resolve_applies_new_command_rules_to_queued_prompts() {
        let root = std::env::current_dir().unwrap();
        let broker = PermissionBroker::new();
        let cancel = CancellationToken::new();
        let emit: EventSink = Arc::new(|_| {});
        let mut prompt = command_prompt();
        prompt.command = Some("git commit -m test".to_string());
        let future = broker.ask(prompt, &cancel, "chat", &emit);
        tokio::pin!(future);
        assert!(futures_util::poll!(future.as_mut()).is_pending());

        // Without a rule the command still needs a user decision.
        let permissions = live_permissions(Vec::new());
        assert!(broker.auto_resolve("chat", &permissions).is_empty());
        assert!(futures_util::poll!(future.as_mut()).is_pending());

        // A fresh "allow in this chat" rule covers the queued prompt.
        permissions.add_session_command_rule("chat", &CommandRule::Glob("git *".into()));
        assert_eq!(broker.auto_resolve("chat", &permissions).len(), 1);
        assert!(future.await.allowed);
        let _ = root;
    }

    #[tokio::test]
    async fn a_remembered_mcp_tool_resolves_its_queued_calls_only() {
        let grant = |tool: &str| McpToolGrant {
            server: "codegraph".to_string(),
            tool: tool.to_string(),
            source: "opencode.json".to_string(),
            fingerprint: "aaaa".to_string(),
        };
        let call = |tool: &str, query: &str| {
            let mut prompt = command_prompt();
            prompt.operation = PermissionOperation::McpTool;
            prompt.command = Some(format!(r#"{{"tool":"{tool}","query":"{query}"}}"#));
            prompt.mcp_tool = Some(grant(tool));
            prompt
        };
        let broker = PermissionBroker::new();
        let cancel = CancellationToken::new();
        let events = Arc::new(Mutex::new(Vec::new()));
        let emit: EventSink = {
            let events = events.clone();
            Arc::new(move |event| events.lock().unwrap().push(event))
        };
        // Two calls of one tool with other arguments, and a call of another.
        let first = broker.ask(call("explore", "a"), &cancel, "chat", &emit);
        let second = broker.ask(call("explore", "b"), &cancel, "chat", &emit);
        let other = broker.ask(call("node", "a"), &cancel, "chat", &emit);
        tokio::pin!(first, second, other);
        assert!(futures_util::poll!(first.as_mut()).is_pending());
        assert!(futures_util::poll!(second.as_mut()).is_pending());
        assert!(futures_util::poll!(other.as_mut()).is_pending());

        // The prompt tells the renderer which tool it would remember, and
        // keeps it for the decision.
        let announced: Vec<(String, Option<McpToolGrant>)> = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match &event.event {
                StreamEvent::PermissionRequest {
                    request_id,
                    mcp_tool,
                    ..
                } => Some((request_id.clone(), mcp_tool.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(announced.len(), 3);
        assert_eq!(announced[0].1, Some(grant("explore")));
        assert_eq!(
            broker.pending_prompt(&announced[0].0).unwrap().mcp_tool,
            Some(grant("explore"))
        );

        // Nothing remembered yet: every call waits for the user.
        let permissions = live_permissions(Vec::new());
        assert!(broker.auto_resolve("chat", &permissions).is_empty());

        // "Don't ask again in this chat" for the tool covers its other queued
        // call, whatever the arguments, and leaves the other tool to the user.
        permissions.add_session_mcp_tool_grant("chat", &grant("explore"));
        assert!(broker.auto_resolve("other-chat", &permissions).is_empty());
        assert_eq!(broker.auto_resolve("chat", &permissions).len(), 2);
        let decision = first.await;
        assert!(decision.allowed);
        assert_eq!(decision.decided_by, "grant");
        assert!(second.await.allowed);
        assert!(futures_util::poll!(other.as_mut()).is_pending());
    }

    #[tokio::test]
    async fn auto_resolve_denies_queued_commands_covered_by_a_new_deny_rule() {
        let broker = PermissionBroker::new();
        let cancel = CancellationToken::new();
        let emit: EventSink = Arc::new(|_| {});
        let mut prompt = command_prompt();
        prompt.command = Some("git commit -m test".to_string());
        let future = broker.ask(prompt, &cancel, "chat", &emit);
        tokio::pin!(future);
        assert!(futures_util::poll!(future.as_mut()).is_pending());

        let permissions = LivePermissions::new(
            Vec::new(),
            vec![CommandRule::Glob("git *".into())],
            Vec::new(),
            Vec::new(),
            Vec::new(),
            AutoApproveConfig::default(),
        );
        assert_eq!(broker.auto_resolve("chat", &permissions).len(), 1);
        assert!(!future.await.allowed);
    }

    #[tokio::test]
    async fn auto_resolve_never_allows_sensitive_file_prompts() {
        let root = std::env::current_dir().unwrap();
        let broker = PermissionBroker::new();
        let cancel = CancellationToken::new();
        let emit: EventSink = Arc::new(|_| {});
        // A folder grant covering the path must not approve a sensitive-file
        // ("file") prompt: no grant ever covers those.
        let mut prompt = folder_prompt(&root, &root.join(".env"), "chat");
        prompt.kind = "file".to_string();
        let future = broker.ask(prompt, &cancel, "chat", &emit);
        tokio::pin!(future);
        assert!(futures_util::poll!(future.as_mut()).is_pending());

        let permissions = live_permissions(vec![root.display().to_string()]);
        assert!(broker.auto_resolve("chat", &permissions).is_empty());
        assert!(futures_util::poll!(future.as_mut()).is_pending());

        broker.deny_session("chat");
        assert!(!future.await.allowed);
    }

    #[tokio::test]
    async fn deny_chat_cascades_to_the_chats_other_queued_prompts() {
        let broker = PermissionBroker::new();
        let cancel = CancellationToken::new();
        let emit: EventSink = Arc::new(|_| {});
        let first = broker.ask(command_prompt(), &cancel, "chat", &emit);
        tokio::pin!(first);
        assert!(futures_util::poll!(first.as_mut()).is_pending());
        // The only pending request at this point, so the id is unambiguous.
        let first_id = broker
            .inner
            .lock()
            .unwrap()
            .by_signature
            .values()
            .next()
            .cloned()
            .unwrap();

        let mut second_prompt = command_prompt();
        second_prompt.command = Some("npm publish".to_string());
        let second = broker.ask(second_prompt, &cancel, "chat", &emit);
        tokio::pin!(second);
        assert!(futures_util::poll!(second.as_mut()).is_pending());

        // Denying one prompt denies everything else queued for the chat.
        broker.deny_chat("chat", &first_id);
        assert!(futures_util::poll!(first.as_mut()).is_pending());
        assert!(!second.await.allowed);

        broker.resolve(&first_id, deny_by("user"));
        assert!(!first.await.allowed);
    }

    #[tokio::test]
    async fn a_decision_is_not_overwritten_before_its_waiter_wakes_up() {
        let root = std::env::current_dir().unwrap();
        let outside = outside_test_dir("first-wins");
        let broker = PermissionBroker::new();
        let recorded: Arc<Mutex<Vec<PermissionAuditEntry>>> = Arc::default();
        let sink = recorded.clone();
        broker.set_audit_sink(Arc::new(move |entry| sink.lock().unwrap().push(entry)));
        let cancel = CancellationToken::new();
        let emit: EventSink = Arc::new(|_| {});
        let first = broker.ask(
            folder_prompt(&root, &outside.join("a.txt"), "chat"),
            &cancel,
            "chat",
            &emit,
        );
        let second = broker.ask(
            folder_prompt(&root, &outside.join("b.txt"), "chat"),
            &cancel,
            "chat",
            &emit,
        );
        tokio::pin!(first, second);
        assert!(futures_util::poll!(first.as_mut()).is_pending());
        assert!(futures_util::poll!(second.as_mut()).is_pending());
        let mut ids: Vec<(u64, String)> = broker
            .inner
            .lock()
            .unwrap()
            .pending
            .iter()
            .map(|(id, entry)| (entry.seq, id.clone()))
            .collect();
        ids.sort();
        let (first_id, second_id) = (ids[0].1.clone(), ids[1].1.clone());

        // The user allows the first prompt and grants its folder; before its
        // waiter runs, the grant's re-check sees it still queued.
        let user = PermissionDecision {
            allowed: true,
            rule: None,
            folder: Some(outside.display().to_string()),
            decided_by: "user".into(),
            decision: Some("allow_session".into()),
        };
        assert!(broker.resolve(&first_id, user));
        assert!(broker.pending_prompt(&first_id).is_none());
        let permissions = live_permissions(vec![outside.display().to_string()]);
        assert_eq!(
            broker.auto_resolve("chat", &permissions),
            vec![second_id.clone()]
        );
        // A later cascade cannot turn either answer into a denial.
        broker.deny_chat("chat", "another");
        assert!(!broker.resolve(&second_id, deny_by("user")));

        assert!(first.await.allowed);
        assert!(second.await.allowed);
        let entries = recorded.lock().unwrap().clone();
        let by: Vec<&str> = entries
            .iter()
            .map(|entry| entry.decided_by.as_str())
            .collect();
        assert_eq!(by, ["user", "grant"]);
        assert_eq!(entries[0].decision.as_deref(), Some("allow_session"));
        std::fs::remove_dir_all(&outside).ok();
    }

    #[tokio::test]
    async fn stopping_a_chat_leaves_other_chats_prompts_pending() {
        let broker = PermissionBroker::new();
        let cancel = CancellationToken::new();
        let emit: EventSink = Arc::new(|_| {});
        let mut other_prompt = command_prompt();
        other_prompt.grant_session_id = "other".to_string();
        let stopped = broker.ask(command_prompt(), &cancel, "sub", &emit);
        let other = broker.ask(other_prompt, &cancel, "other", &emit);
        tokio::pin!(stopped, other);
        assert!(futures_util::poll!(stopped.as_mut()).is_pending());
        assert!(futures_util::poll!(other.as_mut()).is_pending());

        broker.deny_session("chat");
        let decision = stopped.await;
        assert!(!decision.allowed);
        assert_eq!(decision.decided_by, "stopped");
        assert!(futures_util::poll!(other.as_mut()).is_pending());
    }

    #[tokio::test]
    async fn stopping_a_session_leaves_other_sessions_questions_open() {
        let questions = QuestionBroker::new();
        let cancel = CancellationToken::new();
        let emit: EventSink = Arc::new(|_| {});
        let stopped = questions.ask(Vec::new(), &cancel, "chat", &emit);
        let other = questions.ask(Vec::new(), &cancel, "other", &emit);
        tokio::pin!(stopped, other);
        assert!(futures_util::poll!(stopped.as_mut()).is_pending());
        assert!(futures_util::poll!(other.as_mut()).is_pending());

        questions.skip_session("chat");
        assert!(stopped.await.is_none());
        assert!(futures_util::poll!(other.as_mut()).is_pending());
    }

    #[tokio::test]
    async fn every_prompt_outcome_is_recorded_with_who_decided() {
        let broker = PermissionBroker::new();
        let recorded: Arc<Mutex<Vec<PermissionAuditEntry>>> = Arc::default();
        let sink = recorded.clone();
        broker.set_audit_sink(Arc::new(move |entry| sink.lock().unwrap().push(entry)));
        let cancel = CancellationToken::new();
        let emit: EventSink = Arc::new(|_| {});

        let first = broker.ask(command_prompt(), &cancel, "sub", &emit);
        tokio::pin!(first);
        assert!(futures_util::poll!(first.as_mut()).is_pending());
        let first_id = broker
            .inner
            .lock()
            .unwrap()
            .by_signature
            .values()
            .next()
            .cloned()
            .unwrap();
        broker.resolve(
            &first_id,
            PermissionDecision {
                allowed: true,
                rule: Some("npm *".into()),
                folder: None,
                decided_by: "user".into(),
                decision: Some("allow_always".into()),
            },
        );
        assert!(first.await.allowed);

        let mut second_prompt = command_prompt();
        second_prompt.command = Some("npm publish".into());
        let second = broker.ask(second_prompt, &cancel, "sub", &emit);
        tokio::pin!(second);
        assert!(futures_util::poll!(second.as_mut()).is_pending());
        // Stopping the chat also denies its subagent's prompt.
        broker.deny_session("chat");
        assert!(!second.await.allowed);

        let entries = recorded.lock().unwrap().clone();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].subject, "npm install");
        assert_eq!(entries[0].session_id, "sub");
        assert_eq!(entries[0].conversation_id, "chat");
        assert!(entries[0].allowed);
        assert_eq!(entries[0].decided_by, "user");
        assert_eq!(entries[0].decision.as_deref(), Some("allow_always"));
        assert_eq!(entries[0].rule.as_deref(), Some("npm *"));
        assert_eq!(entries[0].reason, "Approval required");
        assert_eq!(entries[1].subject, "npm publish");
        assert!(!entries[1].allowed);
        assert_eq!(entries[1].decided_by, "stopped");
    }

    fn permission_request_id(event: &RoutedEvent) -> String {
        match &event.event {
            StreamEvent::PermissionRequest { request_id, .. } => request_id.clone(),
            other => panic!("expected a permission request, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn pending_prompts_keep_their_full_payload_until_decided() {
        use crate::permissions::{CommandRiskLevel, CommandScopeKind};

        let broker = PermissionBroker::new();
        let cancel = CancellationToken::new();
        let events = Arc::new(Mutex::new(Vec::new()));
        let emit: EventSink = {
            let events = events.clone();
            Arc::new(move |event| events.lock().unwrap().push(event))
        };
        let scope = CommandScopeOption {
            kind: CommandScopeKind::Program,
            rule: CommandRule::Glob("npm *".to_string()),
        };
        let mut detailed = command_prompt();
        detailed.suggested_rule = Some("npm *".to_string());
        detailed.segments = vec![CommandSegment {
            text: "npm install".to_string(),
            allowed: false,
            suggested_rule: Some("npm *".to_string()),
            scope_options: vec![scope.clone()],
            reason: Some("Installs packages".to_string()),
            folders: vec!["/opt/cache".to_string()],
            hosts: vec!["registry.npmjs.org".to_string()],
        }];
        detailed.risk = Some(CommandRisk {
            level: CommandRiskLevel::Medium,
            detail: "Installs packages".to_string(),
        });
        detailed.scope_options = vec![scope];
        detailed.folders = vec!["/opt/cache".to_string()];
        detailed.hosts = vec!["registry.npmjs.org".to_string()];
        let mut other = command_prompt();
        other.command = Some("cargo build".to_string());
        let first = broker.ask(detailed, &cancel, "chat", &emit);
        let second = broker.ask(other, &cancel, "subagent", &emit);
        tokio::pin!(first, second);
        assert!(futures_util::poll!(first.as_mut()).is_pending());
        assert!(futures_util::poll!(second.as_mut()).is_pending());

        // A replayed prompt is exactly what was streamed, oldest first.
        let pending = broker.pending_requests();
        assert_eq!(
            serde_json::to_value(&pending).unwrap(),
            serde_json::to_value(&*events.lock().unwrap()).unwrap(),
        );
        assert_eq!(pending[0].session_id, "chat");
        assert_eq!(pending[1].session_id, "subagent");

        // A decided prompt is unlisted before its waiter even wakes up.
        broker.resolve(&permission_request_id(&pending[0]), allow_by("user"));
        let remaining = broker.pending_requests();
        assert_eq!(remaining.len(), 1);
        assert_eq!(
            permission_request_id(&remaining[0]),
            permission_request_id(&pending[1]),
        );
        assert!(first.await.allowed);
        cancel.cancel();
        assert!(!second.await.allowed);
        assert!(broker.pending_requests().is_empty());
    }

    #[tokio::test]
    async fn pending_questions_are_listed_until_answered() {
        let broker = QuestionBroker::new();
        let cancel = CancellationToken::new();
        let emit: EventSink = Arc::new(|_| {});
        let questions = vec![QuestionItem {
            header: "Target".to_string(),
            question: "Which crate?".to_string(),
            options: Vec::new(),
            multi_select: false,
        }];
        let ask = broker.ask(questions, &cancel, "chat", &emit);
        tokio::pin!(ask);
        assert!(futures_util::poll!(ask.as_mut()).is_pending());

        let pending = broker.pending_requests();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].session_id, "chat");
        let StreamEvent::QuestionRequest {
            request_id,
            questions,
        } = &pending[0].event
        else {
            panic!("expected a question request");
        };
        assert_eq!(questions[0].question, "Which crate?");

        broker.resolve(request_id, None);
        assert!(broker.pending_requests().is_empty());
        assert!(ask.await.is_none());
    }

    #[tokio::test]
    async fn a_model_choice_waits_for_the_pick_and_is_remembered_per_chat() {
        let broker = ModelChoiceBroker::new();
        let cancel = CancellationToken::new();
        let emit: EventSink = Arc::new(|_| {});
        let candidates = vec!["a/flash".to_string(), "a/flash-lite".to_string()];
        let ask = broker.ask("flash", candidates.clone(), &cancel, "chat", &emit);
        tokio::pin!(ask);
        assert!(futures_util::poll!(ask.as_mut()).is_pending());

        let pending = broker.pending_requests();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].session_id, "chat");
        let StreamEvent::ModelChoiceRequest {
            request_id,
            query,
            candidates: offered,
        } = &pending[0].event
        else {
            panic!("expected a model choice request");
        };
        assert_eq!(query, "flash");
        assert_eq!(offered, &candidates);

        broker.resolve(request_id, Some("a/flash-lite".to_string()));
        assert_eq!(ask.await.as_deref(), Some("a/flash-lite"));
        assert!(broker.pending_requests().is_empty());

        broker.remember("chat", "flash", "a/flash-lite");
        assert_eq!(
            broker.remembered("chat", "flash").as_deref(),
            Some("a/flash-lite")
        );
        assert!(broker.remembered("other", "flash").is_none());
        broker.forget(&["chat".to_string()]);
        assert!(broker.remembered("chat", "flash").is_none());
    }

    fn listed(id: &str, name: &str) -> ModelInfo {
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
            source: "openrouter".to_string(),
        }
    }

    /// Request ids of the model choices announced through the returned sink.
    fn model_choice_sink() -> (EventSink, Arc<Mutex<Vec<String>>>) {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let sink: EventSink = {
            let asked = asked.clone();
            Arc::new(move |routed| {
                if let StreamEvent::ModelChoiceRequest { request_id, .. } = routed.event {
                    asked.lock().unwrap().push(request_id);
                }
            })
        };
        (sink, asked)
    }

    #[tokio::test]
    async fn a_named_model_asks_once_per_chat_when_it_fits_several() {
        let broker = ModelChoiceBroker::new();
        let cancel = CancellationToken::new();
        let (emit, asked) = model_choice_sink();
        let models = vec![
            listed("google/gemini-flash", "Google: Gemini Flash"),
            listed("google/gemini-flash-lite", "Google: Gemini Flash Lite"),
            listed("openai/gpt-5", "OpenAI: GPT-5"),
        ];
        let settle = |name: &'static str, chat: &'static str| {
            broker.settle(name, &models, "openrouter", chat, chat, &cancel, &emit)
        };

        // One model fits: nothing is asked.
        assert_eq!(settle("gpt 5", "chat").await.as_deref(), Ok("openai/gpt-5"));
        assert!(asked.lock().unwrap().is_empty());

        // Two fit: the user picks, here a model outside the candidates.
        let first = settle("flash", "chat");
        tokio::pin!(first);
        assert!(futures_util::poll!(first.as_mut()).is_pending());
        let request_id = asked.lock().unwrap()[0].clone();
        broker.resolve(&request_id, Some("openai/gpt-5".to_string()));
        assert_eq!(first.await.as_deref(), Ok("openai/gpt-5"));

        // The same name in the same chat reuses the pick; another chat asks.
        assert_eq!(settle("Flash", "chat").await.as_deref(), Ok("openai/gpt-5"));
        assert_eq!(asked.lock().unwrap().len(), 1);
        let other = settle("flash", "other");
        tokio::pin!(other);
        assert!(futures_util::poll!(other.as_mut()).is_pending());
        assert_eq!(asked.lock().unwrap().len(), 2);

        // Skipping settles nothing and remembers nothing.
        let request_id = asked.lock().unwrap()[1].clone();
        broker.resolve(&request_id, None);
        assert!(other.await.is_err());
        assert!(broker.remembered("other", "flash").is_none());
    }

    #[tokio::test]
    async fn a_named_model_that_is_unknown_or_unlisted_settles_nothing() {
        let broker = ModelChoiceBroker::new();
        let cancel = CancellationToken::new();
        let (emit, asked) = model_choice_sink();
        let models = vec![
            listed("google/gemini-flash", "Google: Gemini Flash"),
            listed("google/gemini-flash-lite", "Google: Gemini Flash Lite"),
        ];

        let unknown = broker
            .settle("llama", &models, "openrouter", "chat", "chat", &cancel, &emit)
            .await;
        assert!(unknown.unwrap_err().contains("No model"));
        let unloaded = broker
            .settle("flash", &[], "openrouter", "chat", "chat", &cancel, &emit)
            .await;
        assert!(unloaded.unwrap_err().contains("not loaded"));
        assert!(asked.lock().unwrap().is_empty());

        // A pick that is not a listed model is refused, not run.
        let picked = broker.settle("flash", &models, "openrouter", "chat", "chat", &cancel, &emit);
        tokio::pin!(picked);
        assert!(futures_util::poll!(picked.as_mut()).is_pending());
        let request_id = asked.lock().unwrap()[0].clone();
        broker.resolve(&request_id, Some("made/up".to_string()));
        assert!(picked.await.unwrap_err().contains("not available"));
        assert!(broker.remembered("chat", "flash").is_none());
    }

    #[tokio::test]
    async fn stopping_a_session_skips_its_model_choice() {
        let broker = ModelChoiceBroker::new();
        let cancel = CancellationToken::new();
        let emit: EventSink = Arc::new(|_| {});
        let ask = broker.ask("flash", vec!["a/flash".to_string()], &cancel, "chat", &emit);
        tokio::pin!(ask);
        assert!(futures_util::poll!(ask.as_mut()).is_pending());

        broker.skip_session("other");
        assert_eq!(broker.pending_requests().len(), 1);
        broker.skip_session("chat");
        assert!(ask.await.is_none());
    }
}
