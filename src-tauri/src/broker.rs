use crate::models::{
    EventSink, PermissionDecision, QuestionAnswer, QuestionItem, RoutedEvent, StreamEvent,
};
use crate::permissions::{CommandRisk, CommandScopeOption, CommandSegment};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
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
}

#[derive(Debug, Clone)]
pub struct PermissionPrompt {
    pub kind: String,
    /// Backend-only identity; neither field changes the streamed prompt contract.
    pub operation: PermissionOperation,
    pub cwd: Option<PathBuf>,
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
    session_id: String,
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
    pub session_id: String,
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
    by_signature: HashMap<PermissionSignature, String>,
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
                command: entry.signature.command.clone(),
                folder: entry.folder.clone(),
                suggested_rule: entry.suggested_rule.clone(),
                scope_options: entry.scope_options.clone(),
                session_id: entry.session_id.clone(),
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
        let signature = prompt.signature(session_id);
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
                            scope_options: prompt.scope_options.clone(),
                            session_id: session_id.to_string(),
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
                    segments: prompt.segments.clone(),
                    risk: prompt.risk.clone(),
                    scope_options: prompt.scope_options.clone(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn command_prompt() -> PermissionPrompt {
        PermissionPrompt {
            kind: "command".to_string(),
            operation: PermissionOperation::Execute,
            cwd: Some(std::env::current_dir().unwrap()),
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

        broker.resolve(
            &requests[0].0,
            PermissionDecision {
                allowed: true,
                rule: None,
                folder: None,
            },
        );
        assert!(first.await.allowed);
        if !shared {
            assert!(futures_util::poll!(second.as_mut()).is_pending());
            broker.resolve(&requests[1].0, deny());
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
}
