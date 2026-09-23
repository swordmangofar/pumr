use crate::models::{
    EventSink, PermissionDecision, QuestionAnswer, QuestionItem, RoutedEvent, StreamEvent,
};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct PermissionPrompt {
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub command: Option<String>,
    pub path: Option<String>,
    pub folder: Option<String>,
    pub url: Option<String>,
    pub suggested_rule: Option<String>,
}

impl PermissionPrompt {
    /// Identical pending prompts (same command/path/folder) share one decision so
    /// parallel subagents never ask the user the same question twice.
    fn signature(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}",
            self.kind,
            self.command.as_deref().unwrap_or(""),
            self.path.as_deref().unwrap_or(""),
            self.folder.as_deref().unwrap_or(""),
            self.url.as_deref().unwrap_or(""),
        )
    }
}

struct PendingPermission {
    signature: String,
    sender: watch::Sender<Option<PermissionDecision>>,
    /// Copy of what the backend actually asked, so `resolve_permission` can
    /// persist only the values this prompt proposed rather than trusting the
    /// renderer.
    kind: String,
    folder: Option<String>,
    suggested_rule: Option<String>,
}

/// The backend-owned fields of a pending prompt, used to validate a renderer's
/// decision before persisting an allow rule or folder.
#[derive(Debug, Clone)]
pub struct PendingPrompt {
    pub kind: String,
    pub folder: Option<String>,
    pub suggested_rule: Option<String>,
}

fn deny() -> PermissionDecision {
    PermissionDecision {
        allowed: false,
        rule: None,
        folder: None,
    }
}

pub struct PermissionBroker {
    inner: Mutex<BrokerInner>,
}

#[derive(Default)]
struct BrokerInner {
    pending: HashMap<String, PendingPermission>,
    by_signature: HashMap<String, String>,
}

impl PermissionBroker {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(BrokerInner::default()),
        }
    }

    pub fn resolve(&self, request_id: &str, decision: PermissionDecision) {
        // The waiter that created the prompt removes the entry after waking up.
        // Sending without removing lets late duplicates reuse the same answer.
        if let Some(entry) = self.inner.lock().unwrap().pending.get(request_id) {
            entry.sender.send_replace(Some(decision));
        }
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
            .map(|entry| PendingPrompt {
                kind: entry.kind.clone(),
                folder: entry.folder.clone(),
                suggested_rule: entry.suggested_rule.clone(),
            })
    }

    pub fn deny_all(&self) {
        let inner = self.inner.lock().unwrap();
        for entry in inner.pending.values() {
            entry.sender.send_replace(Some(deny()));
        }
    }

    pub async fn ask(
        &self,
        prompt: PermissionPrompt,
        cancel: &CancellationToken,
        session_id: &str,
        emit: &EventSink,
    ) -> PermissionDecision {
        let signature = prompt.signature();
        let (is_new, request_id, mut receiver) = {
            let mut inner = self.inner.lock().unwrap();
            match inner.by_signature.get(&signature).cloned() {
                Some(existing) if inner.pending.contains_key(&existing) => {
                    let receiver = inner
                        .pending
                        .get(&existing)
                        .map(|entry| entry.sender.subscribe())
                        .unwrap();
                    (false, existing, receiver)
                }
                _ => {
                    let request_id = Uuid::new_v4().to_string();
                    let (sender, receiver) = watch::channel(None);
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
                        },
                    );
                    (true, request_id, receiver)
                }
            }
        };

        if is_new {
            (emit)(RoutedEvent {
                session_id: session_id.to_string(),
                event: StreamEvent::PermissionRequest {
                    request_id: request_id.clone(),
                    prompt_kind: prompt.kind.clone(),
                    title: prompt.title.clone(),
                    detail: prompt.detail.clone(),
                    command: prompt.command.clone(),
                    path: prompt.path.clone(),
                    folder: prompt.folder.clone(),
                    url: prompt.url.clone(),
                    suggested_rule: prompt.suggested_rule.clone(),
                },
            });
        }

        let decision = loop {
            if let Some(value) = receiver.borrow().clone() {
                break value;
            }
            tokio::select! {
                result = receiver.changed() => {
                    if result.is_err() {
                        break deny();
                    }
                }
                _ = cancel.cancelled() => break deny(),
                _ = tokio::time::sleep(Duration::from_secs(600)) => break deny(),
            }
        };

        if is_new {
            (emit)(RoutedEvent {
                session_id: session_id.to_string(),
                event: StreamEvent::PermissionResolved {
                    request_id: request_id.clone(),
                    allowed: decision.allowed,
                },
            });
            let mut inner = self.inner.lock().unwrap();
            if let Some(entry) = inner.pending.remove(&request_id) {
                inner.by_signature.remove(&entry.signature);
            }
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
    pending: Mutex<HashMap<String, oneshot::Sender<Option<Vec<QuestionAnswer>>>>>,
}

impl QuestionBroker {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn resolve(&self, request_id: &str, answers: Option<Vec<QuestionAnswer>>) {
        if let Some(sender) = self.pending.lock().unwrap().remove(request_id) {
            let _ = sender.send(answers);
        }
    }

    pub fn skip_all(&self) {
        let mut pending = self.pending.lock().unwrap();
        for (_, sender) in pending.drain() {
            let _ = sender.send(None);
        }
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
        self.pending
            .lock()
            .unwrap()
            .insert(request_id.clone(), sender);

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
