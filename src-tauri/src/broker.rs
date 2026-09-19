use crate::models::{EventSink, PermissionDecision, RoutedEvent, StreamEvent};
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::oneshot;
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

pub struct PermissionBroker {
    pending: Mutex<HashMap<String, oneshot::Sender<PermissionDecision>>>,
}

impl PermissionBroker {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn resolve(&self, request_id: &str, decision: PermissionDecision) {
        if let Some(sender) = self.pending.lock().unwrap().remove(request_id) {
            let _ = sender.send(decision);
        }
    }

    pub fn deny_all(&self) {
        let mut pending = self.pending.lock().unwrap();
        for (_, sender) in pending.drain() {
            let _ = sender.send(PermissionDecision {
                allowed: false,
                rule: None,
                folder: None,
            });
        }
    }

    pub async fn ask(
        &self,
        prompt: PermissionPrompt,
        cancel: &CancellationToken,
        session_id: &str,
        emit: &EventSink,
    ) -> PermissionDecision {
        let request_id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .unwrap()
            .insert(request_id.clone(), sender);

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

        let decision = tokio::select! {
            result = receiver => result.unwrap_or(PermissionDecision {
                allowed: false,
                rule: None,
                folder: None,
            }),
            _ = cancel.cancelled() => PermissionDecision {
                allowed: false,
                rule: None,
                folder: None,
            },
            _ = tokio::time::sleep(std::time::Duration::from_secs(600)) => PermissionDecision {
                allowed: false,
                rule: None,
                folder: None,
            },
        };

        self.pending.lock().unwrap().remove(&request_id);
        (emit)(RoutedEvent {
            session_id: session_id.to_string(),
            event: StreamEvent::PermissionResolved {
                request_id,
                allowed: decision.allowed,
            },
        });
        decision
    }
}

impl Default for PermissionBroker {
    fn default() -> Self {
        Self::new()
    }
}
