//! Hooks: commands of the user's that pumr runs at fixed moments of the
//! agent's work. A rule in `AGENTS.md` asks the model to do something; a hook
//! is done by the harness, whatever the model remembers.
//!
//! There are three moments. Before a tool call, a hook can refuse it. After a
//! tool call that succeeded, it can do something with the result (format the
//! edited file) and tell the agent what it found. When the agent wants to
//! finish, it can send it back to work.
//!
//! A hook is told what happens as JSON on its standard input, with the field
//! names Claude Code uses, and answers with its exit code: 0 lets things go
//! on, 2 hands what it printed to the agent (and, before a call, refuses the
//! call). Any other code means the hook itself failed, which stops nothing.
//!
//! Hooks come from pumr's own settings only, never from a file of the project:
//! a repository that was cloned must not get to run commands. They run as the
//! user wrote them, without the permission checks and the sandbox that
//! confine the agent's commands, and cost the agent no tokens unless one
//! speaks to it.

use crate::broker::PermissionBroker;
use crate::config::Hook;
use crate::models::PermissionAuditEntry;
use crate::permissions;
use crate::processes::kill_tree;
use crate::tools::{head_tail, ToolOutcome};
use globset::{GlobBuilder, GlobMatcher};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

pub const BEFORE_TOOL: &str = "beforeTool";
pub const AFTER_TOOL: &str = "afterTool";
pub const TURN_END: &str = "turnEnd";

/// How long a hook runs when it names no time of its own, and the longest it
/// may be given, in seconds.
const DEFAULT_TIMEOUT_SECONDS: u64 = 60;
const MAX_TIMEOUT_SECONDS: u64 = 600;
/// How much of what a hook printed is handed to the agent, in bytes.
const MAX_REPORT_BYTES: usize = 4_000;
/// How much of a hook's output is read at all, in bytes.
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

/// The hooks that apply to one project.
#[derive(Clone, Default)]
pub struct Hooks {
    entries: Arc<Vec<Hook>>,
}

/// What a hook run needs to know of the turn it runs in.
pub struct HookScene<'a> {
    pub project_root: &'a Path,
    pub session_id: &'a str,
    pub conversation_id: &'a str,
    pub cancel: &'a CancellationToken,
    /// Keeps the record of what hooks decided, next to the permission
    /// decisions in the debugger.
    pub broker: &'a PermissionBroker,
}

/// How a hook answered.
#[derive(Debug, PartialEq)]
enum Verdict {
    /// Exit code 0: go on.
    Pass,
    /// Exit code 2, with what it printed for the agent.
    Speak(String),
    /// It could not run, ran too long or failed; says how.
    Failed(String),
    /// The turn was stopped while it ran.
    Cancelled,
}

impl Hooks {
    /// The enabled hooks among `all` that run in the project at `project_root`.
    pub fn for_project(all: &[Hook], project_root: &Path) -> Self {
        // The folder as it is on disk, so a symlinked path names the same one.
        let folder = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let root = folder(project_root);
        let entries = all
            .iter()
            .filter(|hook| hook.enabled && !hook.command.trim().is_empty())
            .filter(|hook| {
                let project = hook.project.trim();
                project.is_empty() || folder(Path::new(project)) == root
            })
            .cloned()
            .collect();
        Self {
            entries: Arc::new(entries),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn matching<'a>(
        &'a self,
        event: &'a str,
        tool: &'a str,
        file: Option<&'a str>,
    ) -> impl Iterator<Item = &'a Hook> {
        self.entries.iter().filter(move |hook| {
            hook.event == event && matches_tool(&hook.tools, tool) && matches_file(&hook.files, file)
        })
    }

    /// Runs the hooks before a tool call. `Some` refuses the call, with what
    /// the hook said about it.
    pub async fn before_tool(
        &self,
        scene: &HookScene<'_>,
        tool: &str,
        arguments: &Value,
    ) -> Option<String> {
        let file = named_file(scene.project_root, arguments);
        let relative = file.as_deref().map(|path| relative(scene.project_root, path));
        for hook in self.matching(BEFORE_TOOL, tool, relative.as_deref()) {
            let payload = json!({
                "hook_event_name": "PreToolUse",
                "session_id": scene.session_id,
                "cwd": scene.project_root,
                "tool_name": tool,
                "tool_input": tool_input(arguments, file.as_deref()),
            });
            match run(hook, scene, &payload, Some(tool), file.as_deref()).await {
                Verdict::Speak(reason) => {
                    record(scene, hook, false, format!("refused the {tool} call"));
                    return Some(reason);
                }
                Verdict::Failed(reason) => record(scene, hook, true, reason),
                Verdict::Pass | Verdict::Cancelled => {}
            }
        }
        None
    }

    /// Runs the hooks after a tool call that succeeded. Returns what they have
    /// to say to the agent about it.
    pub async fn after_tool(
        &self,
        scene: &HookScene<'_>,
        tool: &str,
        arguments: &Value,
        outcome: &ToolOutcome,
    ) -> Option<String> {
        if outcome.status != "ok" {
            return None;
        }
        let file = named_file(scene.project_root, arguments);
        let relative = file.as_deref().map(|path| relative(scene.project_root, path));
        // A formatter rewrites the file the agent has just written. It is
        // told, since what it knows of the file no longer holds.
        let edited = file
            .as_deref()
            .filter(|_| matches!(tool, "write" | "edit"));
        let before = edited.and_then(|path| std::fs::read(path).ok());

        let mut reports: Vec<String> = Vec::new();
        let mut ran = false;
        for hook in self.matching(AFTER_TOOL, tool, relative.as_deref()) {
            ran = true;
            let payload = json!({
                "hook_event_name": "PostToolUse",
                "session_id": scene.session_id,
                "cwd": scene.project_root,
                "tool_name": tool,
                "tool_input": tool_input(arguments, file.as_deref()),
                "tool_response": { "status": outcome.status, "result": outcome.result },
            });
            match run(hook, scene, &payload, Some(tool), file.as_deref()).await {
                Verdict::Speak(report) => reports.push(report),
                Verdict::Failed(reason) => record(scene, hook, true, reason),
                Verdict::Pass | Verdict::Cancelled => {}
            }
        }
        if ran && before.is_some() && edited.and_then(|path| std::fs::read(path).ok()) != before {
            reports.push(format!(
                "A hook changed {} after this call (a formatter, for example). Read it again before you edit it further.",
                relative.as_deref().unwrap_or("the file")
            ));
        }
        (!reports.is_empty()).then(|| reports.join("\n\n"))
    }

    /// Runs the hooks for the end of a turn, with the agent's `answer`.
    /// Returns what they have to say to the agent before it may finish;
    /// `again` tells them that they were heard once in this turn already.
    pub async fn turn_end(
        &self,
        scene: &HookScene<'_>,
        answer: &str,
        again: bool,
    ) -> Option<String> {
        let mut reports: Vec<String> = Vec::new();
        for hook in self.entries.iter().filter(|hook| hook.event == TURN_END) {
            let payload = json!({
                "hook_event_name": "Stop",
                "session_id": scene.session_id,
                "cwd": scene.project_root,
                "stop_hook_active": again,
                "last_assistant_message": answer,
            });
            match run(hook, scene, &payload, None, None).await {
                Verdict::Speak(report) => {
                    record(scene, hook, false, "sent the agent back to work".to_string());
                    reports.push(report);
                }
                Verdict::Failed(reason) => record(scene, hook, true, reason),
                Verdict::Pass | Verdict::Cancelled => {}
            }
        }
        (!reports.is_empty()).then(|| reports.join("\n\n"))
    }
}

/// Notes in the permission record what a hook decided or how it failed. A
/// hook that ran and let things go on leaves no entry.
fn record(scene: &HookScene<'_>, hook: &Hook, allowed: bool, reason: String) {
    scene.broker.audit(PermissionAuditEntry {
        id: 0,
        created_at: 0,
        session_id: scene.session_id.to_string(),
        conversation_id: scene.conversation_id.to_string(),
        kind: "hook".to_string(),
        subject: hook.command.clone(),
        allowed,
        decided_by: "hook".to_string(),
        decision: None,
        reason,
        rule: None,
    });
}

/// The file a call names with `path`, as an absolute path.
fn named_file(project_root: &Path, arguments: &Value) -> Option<PathBuf> {
    let path = arguments.get("path").and_then(Value::as_str)?.trim();
    (!path.is_empty()).then(|| permissions::resolve_path(project_root, path))
}

/// `path` as a hook's file pattern sees it: relative to the project when it
/// lies inside, with forward slashes.
fn relative(project_root: &Path, path: &Path) -> String {
    path.strip_prefix(project_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// The call's arguments as the hook reads them. Scripts written for Claude
/// Code look for the file under `file_path`, so it is there too.
fn tool_input(arguments: &Value, file: Option<&Path>) -> Value {
    let mut input = arguments.clone();
    if let (Some(input), Some(file)) = (input.as_object_mut(), file) {
        input
            .entry("file_path")
            .or_insert_with(|| json!(file.to_string_lossy()));
    }
    input
}

/// The patterns of a hook's `tools` or `files` setting: separated by commas,
/// bars or spaces, except inside the braces of one pattern (`*.{ts,tsx}`).
fn patterns(setting: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut depth = 0usize;
    for character in setting.chars() {
        match character {
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            ',' | '|' | ' ' | '\t' | '\n' if depth == 0 => {
                if !current.is_empty() {
                    found.push(std::mem::take(&mut current));
                }
                continue;
            }
            _ => {}
        }
        current.push(character);
    }
    if !current.is_empty() {
        found.push(current);
    }
    found
}

fn matcher(pattern: &str, case_insensitive: bool) -> Option<GlobMatcher> {
    GlobBuilder::new(pattern)
        .case_insensitive(case_insensitive)
        .build()
        .ok()
        .map(|glob| glob.compile_matcher())
}

/// Whether a hook's `tools` setting covers `tool`. Empty covers every tool;
/// names may be written as Claude Code writes them (`Edit|Write`).
fn matches_tool(setting: &str, tool: &str) -> bool {
    let names = patterns(setting);
    names.is_empty()
        || names
            .iter()
            .filter_map(|name| matcher(name, true))
            .any(|glob| glob.is_match(tool))
}

/// Whether a hook's `files` setting covers the file a call names. Empty
/// covers every call; otherwise a call that names no file is not covered. A
/// pattern without a slash is matched against the file's name alone.
fn matches_file(setting: &str, file: Option<&str>) -> bool {
    let wanted = patterns(setting);
    if wanted.is_empty() {
        return true;
    }
    let Some(file) = file else {
        return false;
    };
    let name = file.rsplit('/').next().unwrap_or(file);
    wanted.iter().any(|pattern| {
        let subject = if pattern.contains('/') { file } else { name };
        matcher(pattern, false).is_some_and(|glob| glob.is_match(subject))
    })
}

/// Reads what a hook prints, up to a bound, and keeps draining after it so
/// the hook never blocks on a full pipe.
async fn collect(stream: Option<impl AsyncReadExt + Unpin>) -> String {
    let Some(mut stream) = stream else {
        return String::new();
    };
    let mut kept: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    while let Ok(read) = stream.read(&mut chunk).await {
        if read == 0 {
            break;
        }
        let room = MAX_OUTPUT_BYTES.saturating_sub(kept.len());
        kept.extend_from_slice(&chunk[..read.min(room)]);
    }
    String::from_utf8_lossy(&kept).into_owned()
}

/// Runs one hook and reads its answer.
async fn run(
    hook: &Hook,
    scene: &HookScene<'_>,
    payload: &Value,
    tool: Option<&str>,
    file: Option<&Path>,
) -> Verdict {
    let mut process = if cfg!(windows) {
        let mut process = Command::new("cmd");
        process.arg("/C").arg(&hook.command);
        process
    } else {
        let mut process = Command::new("/bin/sh");
        process.arg("-c").arg(&hook.command);
        process
    };
    process
        .current_dir(scene.project_root)
        .envs(crate::shell_env::command_environment())
        .env("PUMR_PROJECT_DIR", scene.project_root)
        .env("PUMR_TOOL", tool.unwrap_or(""))
        .env("PUMR_FILE", file.map(Path::as_os_str).unwrap_or_default())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Its own process group, so stopping it stops what it started too.
    #[cfg(unix)]
    process.process_group(0);

    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => return Verdict::Failed(format!("could not be started: {error}")),
    };
    let pid = child.id();
    // Written from a task of its own: a hook that never reads its input must
    // not hold up the one that waits for it.
    if let Some(mut input) = child.stdin.take() {
        let text = payload.to_string();
        tokio::spawn(async move {
            let _ = input.write_all(text.as_bytes()).await;
            let _ = input.shutdown().await;
        });
    }
    let printed = tokio::spawn(collect(child.stdout.take()));
    let errors = tokio::spawn(collect(child.stderr.take()));

    let seconds = match hook.timeout_seconds {
        0 => DEFAULT_TIMEOUT_SECONDS,
        seconds => seconds.min(MAX_TIMEOUT_SECONDS),
    };
    let status = tokio::select! {
        status = child.wait() => status,
        _ = tokio::time::sleep(Duration::from_secs(seconds)) => {
            kill_tree(&mut child, pid);
            return Verdict::Failed(format!("was stopped after {seconds} seconds"));
        }
        _ = scene.cancel.cancelled() => {
            kill_tree(&mut child, pid);
            return Verdict::Cancelled;
        }
    };
    // What it left running in the background may keep the pipes open.
    let drained = Duration::from_millis(500);
    let read = |task| async move {
        tokio::time::timeout(drained, task)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default()
    };
    let (printed, errors): (String, String) = (read(printed).await, read(errors).await);

    match status.map(|status| status.code()) {
        Ok(Some(0)) => Verdict::Pass,
        Ok(Some(2)) => {
            // Claude Code's hooks answer on standard error; one that prints
            // its findings the ordinary way is heard as well.
            let said = [errors.trim(), printed.trim()]
                .into_iter()
                .find(|text| !text.is_empty())
                .unwrap_or("(the hook gave no reason)");
            Verdict::Speak(head_tail(said, MAX_REPORT_BYTES))
        }
        Ok(code) => {
            let said = [errors.trim(), printed.trim()]
                .into_iter()
                .find(|text| !text.is_empty())
                .unwrap_or("");
            let code = code.map_or("a signal".to_string(), |code| format!("exit code {code}"));
            Verdict::Failed(head_tail(
                format!("failed with {code}. {said}").trim(),
                MAX_REPORT_BYTES,
            ))
        }
        Err(error) => Verdict::Failed(format!("could not be waited for: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hook(event: &str, command: &str) -> Hook {
        Hook {
            id: "hook".to_string(),
            event: event.to_string(),
            command: command.to_string(),
            ..Hook::default()
        }
    }

    struct Stage {
        directory: tempfile::TempDir,
        broker: PermissionBroker,
        cancel: CancellationToken,
        recorded: Arc<std::sync::Mutex<Vec<PermissionAuditEntry>>>,
    }

    impl Stage {
        fn new() -> Self {
            let broker = PermissionBroker::new();
            let recorded: Arc<std::sync::Mutex<Vec<PermissionAuditEntry>>> = Arc::default();
            let sink = recorded.clone();
            broker.set_audit_sink(Arc::new(move |entry| sink.lock().unwrap().push(entry)));
            Self {
                directory: tempfile::tempdir().unwrap(),
                broker,
                cancel: CancellationToken::new(),
                recorded,
            }
        }

        fn root(&self) -> &Path {
            self.directory.path()
        }

        fn scene(&self) -> HookScene<'_> {
            HookScene {
                project_root: self.root(),
                session_id: "session",
                conversation_id: "chat",
                cancel: &self.cancel,
                broker: &self.broker,
            }
        }

        fn hooks(&self, hooks: &[Hook]) -> Hooks {
            Hooks::for_project(hooks, self.root())
        }

        fn reasons(&self) -> Vec<String> {
            self.recorded
                .lock()
                .unwrap()
                .iter()
                .map(|entry| entry.reason.clone())
                .collect()
        }
    }

    #[test]
    fn a_hook_names_its_tools_and_files_with_patterns() {
        assert!(matches_tool("", "bash"));
        assert!(matches_tool("Edit|Write", "edit"));
        assert!(matches_tool("edit, write", "write"));
        assert!(!matches_tool("edit|write", "bash"));
        assert!(matches_tool("github__*", "github__create_issue"));

        assert!(matches_file("", None));
        assert!(matches_file("*.ts", Some("src/app/main.ts")));
        assert!(matches_file("*.{ts,tsx}, *.css", Some("src/app/view.tsx")));
        assert!(matches_file("src/**/*.rs", Some("src/git/hunks.rs")));
        assert!(!matches_file("src/**/*.rs", Some("tests/hunks.rs")));
        assert!(!matches_file("*.ts", Some("src/main.rs")));
        // A hook for certain files does not run for a call that names none.
        assert!(!matches_file("*.ts", None));
    }

    #[test]
    fn only_the_enabled_hooks_of_the_project_apply() {
        let stage = Stage::new();
        let mut off = hook(BEFORE_TOOL, "true");
        off.enabled = false;
        let mut elsewhere = hook(BEFORE_TOOL, "true");
        elsewhere.project = "/some/other/project".to_string();
        let mut here = hook(BEFORE_TOOL, "true");
        here.project = stage.root().display().to_string();
        let empty = hook(BEFORE_TOOL, "  ");

        assert!(stage.hooks(&[off, elsewhere, empty]).is_empty());
        assert_eq!(stage.hooks(&[here, hook(TURN_END, "true")]).entries.len(), 2);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_hook_refuses_a_call_with_exit_code_2() {
        let stage = Stage::new();
        let mut guard = hook(
            BEFORE_TOOL,
            r#"grep -q 'push --force' && { echo 'No force pushes here.' >&2; exit 2; }; exit 0"#,
        );
        guard.tools = "bash".to_string();
        let hooks = stage.hooks(&[guard]);

        let refused = hooks
            .before_tool(
                &stage.scene(),
                "bash",
                &json!({ "command": "git push --force" }),
            )
            .await;
        assert_eq!(refused.as_deref(), Some("No force pushes here."));
        assert_eq!(stage.reasons(), ["refused the bash call"]);

        // Any other command passes, and so does every other tool.
        let scene = stage.scene();
        let passes = |tool: &'static str, arguments: Value| {
            let hooks = &hooks;
            let scene = &scene;
            async move { hooks.before_tool(scene, tool, &arguments).await }
        };
        assert_eq!(passes("bash", json!({ "command": "git push" })).await, None);
        assert_eq!(
            passes("write", json!({ "path": "push --force", "content": "" })).await,
            None
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_hook_is_told_the_call_as_claude_code_tells_it() {
        let stage = Stage::new();
        let mut spy = hook(
            AFTER_TOOL,
            r#"cat > "$PUMR_PROJECT_DIR/seen.json"; echo "$PUMR_TOOL $PUMR_FILE" > seen.txt"#,
        );
        spy.files = "*.ts".to_string();
        let hooks = stage.hooks(&[spy]);
        let outcome = ToolOutcome::ok("Edited.".to_string());

        let said = hooks
            .after_tool(
                &stage.scene(),
                "edit",
                &json!({ "path": "src/main.ts", "old_string": "a", "new_string": "b" }),
                &outcome,
            )
            .await;
        assert_eq!(said, None);

        let file = stage.root().join("src/main.ts");
        let seen: Value =
            serde_json::from_str(&std::fs::read_to_string(stage.root().join("seen.json")).unwrap())
                .unwrap();
        assert_eq!(seen["hook_event_name"], "PostToolUse");
        assert_eq!(seen["tool_name"], "edit");
        assert_eq!(seen["tool_input"]["path"], "src/main.ts");
        assert_eq!(seen["tool_input"]["file_path"], json!(file.to_string_lossy()));
        assert_eq!(seen["tool_response"]["status"], "ok");
        assert_eq!(seen["session_id"], "session");
        assert_eq!(
            std::fs::read_to_string(stage.root().join("seen.txt")).unwrap(),
            format!("edit {}\n", file.display())
        );

        // It runs neither for other files nor for a call that failed.
        std::fs::remove_file(stage.root().join("seen.json")).unwrap();
        let scene = stage.scene();
        hooks
            .after_tool(&scene, "edit", &json!({ "path": "src/main.rs" }), &outcome)
            .await;
        let failed = ToolOutcome::error("No match.");
        hooks
            .after_tool(&scene, "edit", &json!({ "path": "src/main.ts" }), &failed)
            .await;
        assert!(!stage.root().join("seen.json").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_agent_is_told_when_a_hook_rewrites_the_file_it_edited() {
        let stage = Stage::new();
        std::fs::write(stage.root().join("main.ts"), "let a=1").unwrap();
        let formatter = hook(AFTER_TOOL, r#"printf 'let a = 1;\n' > "$PUMR_FILE""#);
        let lint = hook(AFTER_TOOL, "echo 'main.ts: a is never used' >&2; exit 2");
        let hooks = stage.hooks(&[formatter, lint]);

        let said = hooks
            .after_tool(
                &stage.scene(),
                "edit",
                &json!({ "path": "main.ts" }),
                &ToolOutcome::ok("Edited.".to_string()),
            )
            .await
            .unwrap();
        assert_eq!(
            said,
            "main.ts: a is never used\n\nA hook changed main.ts after this call (a formatter, for example). Read it again before you edit it further."
        );
        // What a hook finds is the agent's to read, not a decision to record.
        assert!(stage.reasons().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_hook_at_the_end_of_a_turn_can_send_the_agent_back() {
        let stage = Stage::new();
        let check = hook(
            TURN_END,
            r#"grep -q '"stop_hook_active":false' && { echo 'de.json lacks chat.send'; exit 2; }; exit 0"#,
        );
        let hooks = stage.hooks(&[check, hook(BEFORE_TOOL, "exit 2")]);

        let first = hooks.turn_end(&stage.scene(), "Done.", false).await;
        assert_eq!(first.as_deref(), Some("de.json lacks chat.send"));
        assert_eq!(stage.reasons(), ["sent the agent back to work"]);
        // Told that it was heard already, this one lets the turn end.
        assert_eq!(hooks.turn_end(&stage.scene(), "Fixed.", true).await, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_hook_that_fails_stops_nothing_and_is_recorded() {
        let stage = Stage::new();
        let mut slow = hook(BEFORE_TOOL, "sleep 30");
        slow.timeout_seconds = 1;
        let hooks = stage.hooks(&[
            hook(BEFORE_TOOL, "echo 'prettier: command not found' >&2; exit 127"),
            slow,
        ]);

        let refused = hooks
            .before_tool(&stage.scene(), "bash", &json!({ "command": "ls" }))
            .await;
        assert_eq!(refused, None);
        assert_eq!(
            stage.reasons(),
            [
                "failed with exit code 127. prettier: command not found",
                "was stopped after 1 seconds"
            ]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_the_turn_stops_a_running_hook() {
        let stage = Stage::new();
        let hooks = stage.hooks(&[hook(BEFORE_TOOL, "sleep 30")]);
        let cancel = stage.cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cancel.cancel();
        });

        let started = std::time::Instant::now();
        let refused = hooks
            .before_tool(&stage.scene(), "bash", &json!({ "command": "ls" }))
            .await;
        assert_eq!(refused, None);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(stage.reasons().is_empty());
    }
}
