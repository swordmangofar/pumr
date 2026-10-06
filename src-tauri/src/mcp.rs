//! Minimal Model Context Protocol client.
//!
//! Supports the two transports pumr can reasonably manage itself: local
//! `stdio` servers (spawned as child processes) and remote streamable-HTTP
//! servers. Only the subset needed to expose tools to the agent loop is
//! implemented: `initialize`, `tools/list` and `tools/call`, plus the answers
//! a local server may ask of its client (`roots/list` and `ping`).

use crate::error::{AppError, Result};
use crate::models::{McpToolGrant, McpToolInfo};
use crate::processes::kill_tree;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex};
use tokio_util::sync::{CancellationToken, DropGuard};

const PROTOCOL_VERSION: &str = "2024-11-05";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// How far apart the end of a server's output and the exit of its process may
/// lie. Whichever is noticed first waits this long for the other, so that an
/// answer written just before the exit still arrives and the error can name
/// the exit status.
const EXIT_GRACE: Duration = Duration::from_millis(500);
/// How much of a server's error output is kept for the error that reports its
/// end: the user and the model both read it.
const STDERR_TAIL_LINES: usize = 5;
const STDERR_LINE_CHARS: usize = 300;

/// The version users know pumr by. The crate's own version is not kept in
/// step with it.
static APP_VERSION: LazyLock<String> = LazyLock::new(|| {
    serde_json::from_str::<Value>(include_str!("../tauri.conf.json"))
        .ok()
        .and_then(|config| config.get("version")?.as_str().map(str::to_string))
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
});

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpServerConfig {
    pub name: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub url: Option<String>,
    pub source: String,
}

impl McpServerConfig {
    /// A digest of the whole configuration: it changes with the command, an
    /// argument, a variable, the URL or the file the server is defined in.
    /// What a remembered tool approval is tied to, without copying variables
    /// (which may hold secrets) to where the approval is stored.
    pub fn fingerprint(&self) -> String {
        use sha2::{Digest, Sha256};
        let identity = json!([
            self.name,
            self.command,
            self.args,
            self.env,
            self.url,
            self.source
        ]);
        Sha256::digest(identity.to_string().as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

struct StdioState {
    stdin: Arc<Mutex<ChildStdin>>,
    link: Arc<StdioLink>,
    process: Arc<ServerProcess>,
    /// Ends the task that reads the server and watches its process.
    _stop: DropGuard,
}

impl Drop for StdioState {
    fn drop(&mut self) {
        // Here and not in the task that watches the process: that one only
        // runs when the runtime gets to it.
        self.process.stop();
    }
}

/// A stdio server's process. It is shared, so that it can be stopped from
/// wherever the server is given up: by its client when that is dropped, and
/// by `McpSessions::shutdown` when the app exits.
struct ServerProcess {
    held: std::sync::Mutex<HeldProcess>,
}

struct HeldProcess {
    child: Child,
    /// The id of the process and, on Unix, of the process group it leads.
    /// `None` once it has been signalled for the last time.
    pid: Option<u32>,
}

impl ServerProcess {
    fn new(child: Child) -> Arc<Self> {
        let pid = child.id();
        Arc::new(Self {
            held: std::sync::Mutex::new(HeldProcess { child, pid }),
        })
    }

    /// Stops the server with everything it started. Behind `npx`, `uvx`,
    /// `sh -c` or `docker run` the server is not the process pumr started but
    /// one that process started, which killing its parent alone leaves
    /// running.
    fn stop(&self) {
        Self::stop_held(&mut self.held.lock().unwrap());
    }

    fn stop_held(held: &mut HeldProcess) {
        let pid = held.pid.take();
        kill_tree(&mut held.child, pid);
    }

    /// Waits for the server's process to end. The process is only held while
    /// it is asked, so that it can be stopped at any time.
    async fn exited(&self) -> std::io::Result<ExitStatus> {
        std::future::poll_fn(|context| {
            let mut held = self.held.lock().unwrap();
            let ended = {
                let wait = std::pin::pin!(held.child.wait());
                std::future::Future::poll(wait, context)
            };
            // The process is collected, so the system may give its id to
            // another one. What it started is stopped now, under the same
            // lock, and the id is not signalled again. Windows keeps an id
            // to itself while `child` holds the process, so there the id
            // stays good until `stop`.
            #[cfg(unix)]
            if ended.is_ready() {
                Self::stop_held(&mut held);
            }
            ended
        })
        .await
    }
}

impl Drop for ServerProcess {
    fn drop(&mut self) {
        // Whoever gives a server up stops it. This is for a process that
        // never got as far as having a client.
        if let Ok(held) = self.held.get_mut() {
            Self::stop_held(held);
        }
    }
}

/// The processes of the stdio servers started for one `McpSessions`, so that
/// its `shutdown` reaches every one of them: also those of a turn that still
/// runs with a manager no longer kept, and those still being connected to.
#[derive(Default)]
struct RunningServers {
    processes: std::sync::Mutex<Vec<std::sync::Weak<ServerProcess>>>,
}

impl RunningServers {
    fn add(&self, process: &Arc<ServerProcess>) {
        let mut processes = self.processes.lock().unwrap();
        processes.retain(|process| process.strong_count() > 0);
        processes.push(Arc::downgrade(process));
    }

    fn stop_all(&self) {
        let processes: Vec<Arc<ServerProcess>> = {
            let processes = self.processes.lock().unwrap();
            processes
                .iter()
                .filter_map(|process| process.upgrade())
                .collect()
        };
        for process in processes {
            process.stop();
        }
    }
}

/// What a client shares with the tasks that read its stdio server.
struct StdioLink {
    requests: std::sync::Mutex<Requests>,
    /// The last lines the server wrote to its error output.
    stderr: std::sync::Mutex<VecDeque<String>>,
    /// The project the server works on, given to it as its only root.
    root: Option<PathBuf>,
}

#[derive(Default)]
struct Requests {
    waiting: HashMap<i64, oneshot::Sender<Value>>,
    /// Why the server answers nothing anymore, once it has stopped.
    ended: Option<String>,
}

impl StdioLink {
    fn keep_stderr(&self, line: &str) {
        let line = line.trim_end();
        if line.is_empty() {
            return;
        }
        let mut tail = self.stderr.lock().unwrap();
        if tail.len() == STDERR_TAIL_LINES {
            tail.pop_front();
        }
        tail.push_back(line.chars().take(STDERR_LINE_CHARS).collect());
    }

    /// Fails every waiting request and all later ones: the server is gone.
    fn end(&self, status: Option<ExitStatus>) {
        let mut reason = match status {
            Some(status) => status.to_string(),
            None => "it closed its output".to_string(),
        };
        let tail = self.stderr.lock().unwrap();
        if !tail.is_empty() {
            let lines: Vec<&str> = tail.iter().map(String::as_str).collect();
            reason.push_str(&format!(". Last error output: {}", lines.join(" | ")));
        }
        drop(tail);
        let mut requests = self.requests.lock().unwrap();
        requests.ended.get_or_insert(reason);
        // Dropping the senders wakes the requests waiting on them.
        requests.waiting.clear();
    }

    /// Hands a line of the server's output to whoever waits for it.
    fn receive(&self, line: &str, stdin: &Arc<Mutex<ChildStdin>>) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        // Requests and notifications from the server carry a `method`; its
        // ids are its own and can collide with ours.
        if let Some(method) = value.get("method").and_then(Value::as_str) {
            // Only a request has an id and waits for an answer.
            let Some(id) = value.get("id").filter(|id| !id.is_null()) else {
                return;
            };
            let mut reply = json!({ "jsonrpc": "2.0", "id": id });
            match self.answer(method) {
                Some(result) => reply["result"] = result,
                None => reply["error"] = json!({ "code": -32601, "message": "Method not found" }),
            }
            // Written on its own, so that reading never waits on a write.
            let stdin = stdin.clone();
            tokio::spawn(async move {
                write_line(&stdin, &reply).await.ok();
            });
            return;
        }
        if let Some(id) = value.get("id").and_then(Value::as_i64) {
            let sender = self.requests.lock().unwrap().waiting.remove(&id);
            if let Some(sender) = sender {
                let _ = sender.send(value);
            }
        }
    }

    /// The result of a request the server makes of its client, `None` for one
    /// pumr does not support.
    fn answer(&self, method: &str) -> Option<Value> {
        match method {
            "ping" => Some(json!({})),
            "roots/list" => {
                let roots: Vec<Value> = self
                    .root
                    .as_deref()
                    .and_then(root_entry)
                    .into_iter()
                    .collect();
                Some(json!({ "roots": roots }))
            }
            _ => None,
        }
    }
}

/// A project folder as an MCP root: its `file://` URI and its name.
fn root_entry(root: &Path) -> Option<Value> {
    let uri = reqwest::Url::from_file_path(root).ok()?;
    let name = root.file_name()?.to_string_lossy();
    Some(json!({ "uri": uri.as_str(), "name": name }))
}

async fn write_line(stdin: &Mutex<ChildStdin>, message: &Value) -> std::io::Result<()> {
    let mut line = message.to_string();
    line.push('\n');
    let mut stdin = stdin.lock().await;
    stdin.write_all(line.as_bytes()).await?;
    stdin.flush().await
}

/// What a stdio server writes, line by line. A line that is not UTF-8 (a
/// localised console message, a Latin-1 path) is no error here, as it is for
/// `Lines`, where it ended the reading and with it the connection: it is
/// decoded as far as it goes and is then a line like any other.
struct OutputLines<R> {
    reader: BufReader<R>,
    /// What has been read of a line whose end has not come yet.
    partial: Vec<u8>,
}

impl<R: tokio::io::AsyncRead + Unpin> OutputLines<R> {
    fn new(output: R) -> Self {
        Self {
            reader: BufReader::new(output),
            partial: Vec::new(),
        }
    }

    /// The next line, `None` at the end of the output. May be dropped while
    /// it waits, as in a `select!`: what it has read is kept for the next
    /// call.
    async fn next_line(&mut self) -> std::io::Result<Option<String>> {
        let read = self.reader.read_until(b'\n', &mut self.partial).await?;
        if read == 0 && self.partial.is_empty() {
            return Ok(None);
        }
        let line = String::from_utf8_lossy(&self.partial).into_owned();
        self.partial.clear();
        Ok(Some(line))
    }
}

/// Reads a stdio server's answers and watches its process until the client is
/// dropped. A server that exits or closes its output fails its requests at
/// once, instead of letting each run into its timeout.
async fn supervise(
    process: Arc<ServerProcess>,
    stdout: ChildStdout,
    stderr: Option<tokio::task::JoinHandle<()>>,
    stdin: Arc<Mutex<ChildStdin>>,
    link: Arc<StdioLink>,
    stop: CancellationToken,
    server: String,
) {
    let mut lines = OutputLines::new(stdout);
    let mut status = None;
    let mut output_open = true;
    loop {
        tokio::select! {
            // The client is gone, and stopped the server as it went.
            _ = stop.cancelled() => return,
            line = lines.next_line() => match line {
                Ok(Some(line)) => link.receive(&line, &stdin),
                _ => {
                    output_open = false;
                    break;
                }
            },
            exited = process.exited() => {
                status = exited.ok();
                break;
            }
        }
    }
    // The other half normally follows within moments. A process that lives on
    // without output, or output held open by a process the server started,
    // must not keep the requests waiting.
    let rest = async {
        if output_open {
            while let Ok(Some(line)) = lines.next_line().await {
                link.receive(&line, &stdin);
            }
        } else {
            status = process.exited().await.ok();
        }
        if let Some(stderr) = stderr {
            let _ = stderr.await;
        }
    };
    let _ = tokio::time::timeout(EXIT_GRACE, rest).await;
    link.end(status);
    match status {
        Some(status) => log::warn!("MCP server '{server}' exited ({status})"),
        None => log::warn!("MCP server '{server}' closed its output"),
    }
    // A server that only closed its output keeps its pipes until the client
    // goes, which stops it.
    stop.cancelled().await;
}

fn read_stderr(stderr: ChildStderr, link: Arc<StdioLink>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut lines = OutputLines::new(stderr);
        while let Ok(Some(line)) = lines.next_line().await {
            log::debug!("mcp stderr: {}", line.trim_end());
            link.keep_stderr(&line);
        }
    })
}

/// The batch file a server's command stands for on Windows, if it is one.
///
/// Windows starts a program that is named without an extension only when it
/// is an `.exe`. `npx` and the other launchers npm installs are batch files
/// (`npx.cmd`), so the most common server configuration could not be started.
/// The name is looked up as the command prompt would: in the folders of
/// `path` and with the extensions of `pathext`, both as the server's process
/// is given them.
///
/// `None` leaves the command to be started as it is: a path, a name with an
/// extension, a name an `.exe` is found for (it goes first, as it always
/// did), or one nothing is found for. Folders that are not absolute are
/// passed over: they would be looked for in the project the server runs in.
#[cfg(any(windows, test))]
fn windows_batch_file(
    command: &str,
    path: &str,
    pathext: &str,
    is_file: &dyn Fn(&str) -> bool,
) -> Option<String> {
    if command.is_empty() || command.contains(['/', '\\', ':', '.']) {
        return None;
    }
    let absolute = |folder: &&str| {
        let bytes = folder.as_bytes();
        folder.starts_with("\\\\")
            || (bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && matches!(bytes[2], b'\\' | b'/'))
    };
    let folders: Vec<&str> = path
        .split(';')
        .map(|folder| folder.trim().trim_matches('"'))
        .filter(absolute)
        .map(|folder| folder.trim_end_matches(['\\', '/']))
        .collect();
    let file = |folder: &str, extension: &str| format!("{folder}\\{command}{extension}");
    if folders.iter().any(|folder| is_file(&file(folder, ".exe"))) {
        return None;
    }
    let extensions: Vec<&str> = pathext
        .split(';')
        .map(str::trim)
        .filter(|extension| {
            extension.eq_ignore_ascii_case(".cmd") || extension.eq_ignore_ascii_case(".bat")
        })
        .collect();
    folders.iter().find_map(|folder| {
        extensions
            .iter()
            .map(|extension| file(folder, extension))
            .find(|candidate| is_file(candidate))
    })
}

/// What follows `cmd.exe` on its command line to have it run a batch file
/// with `args`, to be handed to it as it is.
///
/// The command prompt reads its line by rules of its own: a `"` ends a quoted
/// argument and a `%` brings in a variable, in the prompt and again in the
/// batch file, so that an argument holding one could run something else. No
/// quoting keeps those harmless in every batch file. Such an argument is
/// refused, as is a control character, and the rest are quoted unless they
/// hold nothing but what is known to mean nothing to the prompt. The error
/// names the argument by its place: its text may be a secret.
#[cfg(any(windows, test))]
fn batch_command_line(script: &str, args: &[String]) -> std::result::Result<String, String> {
    let refused = |text: &str| text.contains(['"', '%']) || text.chars().any(char::is_control);
    if refused(script) {
        return Err(
            "the path of its batch file cannot be passed to the command prompt safely".to_string(),
        );
    }
    let mut line = format!("\"{script}\"");
    for (index, argument) in args.iter().enumerate() {
        if refused(argument) {
            return Err(format!(
                "argument {} holds a quote, a percent sign or a control character, which cannot be passed to a batch file safely",
                index + 1
            ));
        }
        line.push(' ');
        let plain = !argument.is_empty()
            && !argument.ends_with('\\')
            && argument.chars().all(|character| {
                !character.is_ascii()
                    || character.is_ascii_alphanumeric()
                    || r"#$*+-./:?@\_".contains(character)
            });
        if plain {
            line.push_str(argument);
            continue;
        }
        line.push('"');
        line.push_str(argument);
        // A backslash right before the closing quote would make the quote
        // part of the argument for the program the batch file starts.
        let backslashes = argument.len() - argument.trim_end_matches('\\').len();
        line.push_str(&"\\".repeat(backslashes));
        line.push('"');
    }
    // The prompt takes the outer pair of quotes off and runs what is inside.
    // Without delayed expansion (`/v:OFF`) a `!` is only a character, and
    // `/d` keeps the user's autorun commands out.
    Ok(format!("/e:ON /v:OFF /d /c \"{line}\""))
}

/// The command that starts a local server on Windows: as it is given, or
/// through the command prompt when it names a batch file.
#[cfg(windows)]
fn windows_command(command: &str, config: &McpServerConfig) -> Result<Command> {
    // As the server's process is given them: its own variables go first.
    let variable = |name: &str| {
        config
            .env
            .iter()
            .rev()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.clone())
            .or_else(|| std::env::var(name).ok())
    };
    let path = variable("PATH").unwrap_or_default();
    let pathext = variable("PATHEXT").unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
    let is_file = |file: &str| Path::new(file).is_file();
    let Some(script) = windows_batch_file(command, &path, &pathext, &is_file) else {
        let mut process = Command::new(command);
        process.args(&config.args);
        return Ok(process);
    };
    let line = batch_command_line(&script, &config.args).map_err(|reason| {
        AppError::msg(format!(
            "Could not start MCP server '{}': {reason}",
            config.name
        ))
    })?;
    let prompt = std::env::var("COMSPEC")
        .ok()
        .filter(|prompt| !prompt.trim().is_empty())
        .unwrap_or_else(|| "cmd.exe".to_string());
    let mut process = Command::new(prompt);
    process.raw_arg(line);
    Ok(process)
}

enum Transport {
    Stdio(StdioState),
    Http {
        client: reqwest::Client,
        url: String,
        session: Mutex<Option<String>>,
    },
}

pub struct McpClient {
    pub config: McpServerConfig,
    transport: Transport,
    next_id: AtomicI64,
}

impl McpClient {
    /// Connects to a server that no `McpSessions` keeps.
    #[cfg(test)]
    pub async fn connect(config: McpServerConfig, root: Option<&Path>) -> Result<Arc<McpClient>> {
        Self::connect_listed(config, root, None).await
    }

    /// Connects to a server. A local one is started in `root`, the project it
    /// is to work on: servers find their project by their working directory
    /// or by asking for the client's roots, and pumr's own working directory
    /// is `/` or the home folder when it was opened from a launcher. Its
    /// process is entered in `running` as soon as it is started.
    async fn connect_listed(
        config: McpServerConfig,
        root: Option<&Path>,
        running: Option<&RunningServers>,
    ) -> Result<Arc<McpClient>> {
        let root = root.filter(|root| root.is_dir());
        let transport = if let Some(url) = config.url.clone() {
            Transport::Http {
                client: reqwest::Client::builder()
                    .user_agent("pumr/0.1")
                    // Like the stdio transport: a server that stops answering
                    // must not hold the turn forever.
                    .connect_timeout(Duration::from_secs(15))
                    .timeout(REQUEST_TIMEOUT)
                    .build()
                    .map_err(|error| {
                        AppError::msg(format!("HTTP client error: {}", error.without_url()))
                    })?,
                url,
                session: Mutex::new(None),
            }
        } else if let Some(command) = config.command.clone() {
            #[cfg(not(windows))]
            let mut process = Command::new(&command);
            #[cfg(not(windows))]
            process.args(&config.args);
            #[cfg(windows)]
            let mut process = windows_command(&command, &config)?;
            // Do not leak the parent's environment (API keys, tokens, CI
            // secrets) to third-party servers. Pass only what is needed to run
            // a program plus the server's own configured variables.
            process.env_clear();
            #[cfg(unix)]
            {
                for key in ["PATH", "HOME", "LANG", "LC_ALL", "TERM"] {
                    if let Ok(value) = std::env::var(key) {
                        process.env(key, value);
                    }
                }
            }
            #[cfg(windows)]
            {
                for key in [
                    "PATH",
                    "SystemRoot",
                    "USERPROFILE",
                    "TEMP",
                    "TMP",
                    "APPDATA",
                    "LOCALAPPDATA",
                    "COMSPEC",
                    "PATHEXT",
                ] {
                    if let Ok(value) = std::env::var(key) {
                        process.env(key, value);
                    }
                }
            }
            for (key, value) in &config.env {
                process.env(key, value);
            }
            if let Some(root) = root {
                process.current_dir(root);
            }
            process
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            // Its own process group, so stopping the server also stops what
            // it started (see `kill_tree`).
            #[cfg(unix)]
            process.process_group(0);
            let mut child = process.spawn().map_err(|error| {
                AppError::msg(format!(
                    "Could not start MCP server '{}': {error}",
                    config.name
                ))
            })?;
            let stdin = child.stdin.take();
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            let server = ServerProcess::new(child);
            if let Some(running) = running {
                running.add(&server);
            }
            let stdin = stdin.ok_or_else(|| {
                AppError::msg(format!("MCP server '{}' has no stdin", config.name))
            })?;
            let stdout = stdout.ok_or_else(|| {
                AppError::msg(format!("MCP server '{}' has no stdout", config.name))
            })?;
            let stdin = Arc::new(Mutex::new(stdin));
            let link = Arc::new(StdioLink {
                requests: Default::default(),
                stderr: Default::default(),
                root: root.map(Path::to_path_buf),
            });
            let stderr = stderr.map(|stderr| read_stderr(stderr, link.clone()));
            let stop = CancellationToken::new();
            tokio::spawn(supervise(
                server.clone(),
                stdout,
                stderr,
                stdin.clone(),
                link.clone(),
                stop.clone(),
                config.name.clone(),
            ));
            Transport::Stdio(StdioState {
                stdin,
                link,
                process: server,
                _stop: stop.drop_guard(),
            })
        } else {
            return Err(AppError::msg(format!(
                "MCP server '{}' has neither a command nor a URL",
                config.name
            )));
        };

        let client = Arc::new(McpClient {
            config,
            transport,
            next_id: AtomicI64::new(1),
        });
        client.initialize().await?;
        Ok(client)
    }

    /// False once a spawned server has exited or closed its output; remote
    /// servers are assumed up, and a session one of them has lost is opened
    /// anew by the request that finds it gone (see `renew_session`).
    fn is_alive(&self) -> bool {
        match &self.transport {
            Transport::Stdio(state) => state.link.requests.lock().unwrap().ended.is_none(),
            Transport::Http { .. } => true,
        }
    }

    async fn initialize(&self) -> Result<()> {
        self.request("initialize", self.initialize_params()).await?;
        self.notify("notifications/initialized", json!({})).await;
        Ok(())
    }

    fn initialize_params(&self) -> Value {
        // Only a local server is told the project folder, and only it can ask:
        // a remote one has no use for a path on this machine.
        let capabilities = match &self.transport {
            Transport::Stdio(state) if state.link.root.is_some() => {
                json!({ "roots": { "listChanged": false } })
            }
            _ => json!({}),
        };
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": capabilities,
            "clientInfo": { "name": "pumr", "version": APP_VERSION.as_str() }
        })
    }

    pub async fn list_tools(&self) -> Result<Vec<McpToolInfo>> {
        let result = self.request("tools/list", json!({})).await?;
        let tools = result
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(tools
            .iter()
            .filter_map(|tool| {
                let name = tool.get("name").and_then(Value::as_str)?.to_string();
                Some(McpToolInfo {
                    exposed_name: exposed_name(&self.config.name, &name),
                    server: self.config.name.clone(),
                    description: tool
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    input_schema: tool
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                    read_only: tool
                        .pointer("/annotations/readOnlyHint")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    name,
                })
            })
            .collect())
    }

    pub async fn call_tool(&self, tool: &str, arguments: Value) -> Result<(String, bool)> {
        let result = self
            .request(
                "tools/call",
                json!({ "name": tool, "arguments": arguments }),
            )
            .await?;
        let is_error = result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut text = String::new();
        if let Some(content) = result.get("content").and_then(Value::as_array) {
            for item in content {
                match item.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(value) = item.get("text").and_then(Value::as_str) {
                            text.push_str(value);
                            text.push('\n');
                        }
                    }
                    Some("image") => text.push_str("[image content]\n"),
                    Some("resource") => {
                        if let Some(uri) = item
                            .get("resource")
                            .and_then(|resource| resource.get("uri"))
                            .and_then(Value::as_str)
                        {
                            text.push_str(&format!("[resource: {uri}]\n"));
                        }
                    }
                    _ => {}
                }
            }
        }
        if text.trim().is_empty() {
            text = result.to_string();
        }
        Ok((text.trim_end().to_string(), is_error))
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        match &self.transport {
            Transport::Stdio(state) => {
                let stopped = |reason: &str| {
                    AppError::msg(format!(
                        "MCP server '{}' stopped during {method}: {reason}",
                        self.config.name
                    ))
                };
                let (sender, receiver) = oneshot::channel();
                {
                    let mut requests = state.link.requests.lock().unwrap();
                    if let Some(reason) = &requests.ended {
                        return Err(stopped(reason));
                    }
                    requests.waiting.insert(id, sender);
                }
                // A write fails when the server is already gone. Its end is
                // noticed within moments and wakes the wait below, so the
                // error can say how the server ended.
                let written = write_line(&state.stdin, &message).await;
                let wait = if written.is_ok() {
                    REQUEST_TIMEOUT
                } else {
                    EXIT_GRACE * 2
                };
                let response = tokio::time::timeout(wait, receiver).await;
                let ended = {
                    let mut requests = state.link.requests.lock().unwrap();
                    // Nobody will answer this id any more.
                    requests.waiting.remove(&id);
                    requests.ended.clone()
                };
                match (response, written) {
                    (Ok(Ok(response)), _) => unwrap_response(response, method),
                    (_, written) => Err(match (ended, written) {
                        (Some(reason), _) => stopped(&reason),
                        (None, Err(error)) => AppError::msg(format!(
                            "Could not write to MCP server '{}': {error}",
                            self.config.name
                        )),
                        (None, Ok(())) => AppError::msg(format!(
                            "MCP server '{}' timed out on {method}",
                            self.config.name
                        )),
                    }),
                }
            }
            Transport::Http {
                client,
                url,
                session,
            } => {
                let sent_in = session.lock().await.clone();
                let mut reply = self.post(client, url, sent_in.as_deref(), &message).await?;
                // Once, and the request once more: a server that still has no
                // such session after that is reported as it answers.
                if session_expired(reply.status, sent_in.is_some(), method) {
                    let renewed = self.renew_session(client, url, session, sent_in).await?;
                    reply = self.post(client, url, renewed.as_deref(), &message).await?;
                }
                if let Some(opened) = &reply.session {
                    *session.lock().await = Some(opened.clone());
                }
                self.read_reply(&reply, id, method)
            }
        }
    }

    /// Posts one message to a remote server, within `session` if it has
    /// opened one. A notification is sent like a request: servers that keep
    /// sessions refuse one that does not name its session.
    async fn post(
        &self,
        client: &reqwest::Client,
        url: &str,
        session: Option<&str>,
        message: &Value,
    ) -> Result<HttpReply> {
        let mut request = client
            .post(url)
            .header("Accept", "application/json, text/event-stream")
            .json(message);
        if let Some(session) = session {
            request = request.header("Mcp-Session-Id", session);
        }
        // Both errors go to the model and into the stored chat, so neither
        // names the URL: it can hold a key (`/mcp?apiKey=…`).
        let response = request.send().await.map_err(|error| {
            AppError::msg(format!(
                "Could not reach MCP server '{}': {}",
                self.config.name,
                error.without_url()
            ))
        })?;
        let session = response
            .headers()
            .get("Mcp-Session-Id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let status = response.status();
        let event_stream = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_lowercase()
            .contains("text/event-stream");
        let body = response.text().await.map_err(|error| {
            AppError::msg(format!(
                "Could not read MCP server '{}' response: {}",
                self.config.name,
                error.without_url()
            ))
        })?;
        Ok(HttpReply {
            status,
            session,
            event_stream,
            body,
        })
    }

    /// The result a remote server's reply holds for request `id`.
    fn read_reply(&self, reply: &HttpReply, id: i64, method: &str) -> Result<Value> {
        if !reply.status.is_success() {
            return Err(AppError::msg(format!(
                "MCP server '{}' returned HTTP {}",
                self.config.name,
                reply.status.as_u16()
            )));
        }
        let value = if reply.event_stream {
            parse_sse_response(&reply.body, id)?
        } else {
            serde_json::from_str(&reply.body).map_err(|error| {
                AppError::msg(format!(
                    "Invalid MCP response from '{}': {error}",
                    self.config.name
                ))
            })?
        };
        unwrap_response(value, method)
    }

    /// Opens a new session with a remote server that no longer knows the
    /// `expired` one, with the handshake the first one was opened with, and
    /// returns it. The lock is held throughout, so requests that find the
    /// session gone at the same time open one between them: the others meet
    /// a newer session than theirs here and use that.
    async fn renew_session(
        &self,
        client: &reqwest::Client,
        url: &str,
        session: &Mutex<Option<String>>,
        expired: Option<String>,
    ) -> Result<Option<String>> {
        let mut current = session.lock().await;
        if *current != expired {
            return Ok(current.clone());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let initialize = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "initialize",
            "params": self.initialize_params()
        });
        let reply = self.post(client, url, None, &initialize).await?;
        self.read_reply(&reply, id, "initialize")?;
        *current = reply.session;
        let initialized = json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        });
        let _ = self
            .post(client, url, current.as_deref(), &initialized)
            .await;
        Ok(current.clone())
    }

    async fn notify(&self, method: &str, params: Value) {
        let message = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        match &self.transport {
            Transport::Stdio(state) => {
                let _ = write_line(&state.stdin, &message).await;
            }
            Transport::Http {
                client,
                url,
                session,
            } => {
                let session = session.lock().await.clone();
                let _ = self.post(client, url, session.as_deref(), &message).await;
            }
        }
    }
}

/// What a remote server sent back for one message.
struct HttpReply {
    status: reqwest::StatusCode,
    /// The session the server opened with this reply, if it opened one.
    session: Option<String>,
    event_stream: bool,
    body: String,
}

/// Whether a reply says that the server no longer knows the session the
/// request was sent in: it was restarted, or let the session expire. The
/// protocol has it answer 404 then and the client open a new session. An
/// `initialize` opens one and is sent in none.
fn session_expired(status: reqwest::StatusCode, in_session: bool, method: &str) -> bool {
    status == reqwest::StatusCode::NOT_FOUND && in_session && method != "initialize"
}

fn unwrap_response(value: Value, method: &str) -> Result<Value> {
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(AppError::msg(format!("MCP {method} failed: {message}")));
    }
    Ok(value.get("result").cloned().unwrap_or(Value::Null))
}

fn parse_sse_response(body: &str, id: i64) -> Result<Value> {
    for line in body.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(data) {
            if value.get("method").is_none() && value.get("id").and_then(Value::as_i64) == Some(id)
            {
                return Ok(value);
            }
        }
    }
    Err(AppError::msg("No matching response in MCP event stream"))
}

/// Connects to a set of MCP servers and aggregates their tools. Connections are
/// kept open for the lifetime of the manager; dropping it terminates spawned
/// child processes.
pub struct McpManager {
    tools: Vec<McpToolInfo>,
    clients: HashMap<String, Arc<McpClient>>,
    exposed: HashMap<String, (String, String)>,
    pub errors: Vec<String>,
}

impl McpManager {
    pub fn empty() -> Self {
        Self {
            tools: Vec::new(),
            clients: HashMap::new(),
            exposed: HashMap::new(),
            errors: Vec::new(),
        }
    }

    /// Connects to servers that no `McpSessions` keeps.
    #[cfg(test)]
    pub async fn connect(
        configs: Vec<McpServerConfig>,
        root: Option<&Path>,
        starting: &(dyn Fn(&str) + Send + Sync),
    ) -> Self {
        Self::connect_listed(configs, root, starting, None).await
    }

    /// Connects to `configs` one after the other; `starting` hears the name of
    /// each before its connection begins. Local servers run in `root`, and
    /// their processes are entered in `running`.
    async fn connect_listed(
        configs: Vec<McpServerConfig>,
        root: Option<&Path>,
        starting: &(dyn Fn(&str) + Send + Sync),
        running: Option<&RunningServers>,
    ) -> Self {
        let mut manager = Self::empty();
        for config in configs {
            let server = config.name.clone();
            let source = config.source.clone();
            starting(&server);
            let client = match McpClient::connect_listed(config, root, running).await {
                Ok(client) => client,
                Err(error) => {
                    manager.errors.push(format!("{error} ({source})"));
                    continue;
                }
            };
            match client.list_tools().await {
                Ok(tools) => {
                    for mut tool in tools {
                        // Two tools can come to one name, sanitized or cut as
                        // it is. The later one gets a number, within the
                        // limit and until no other tool has that name either.
                        if manager.exposed.contains_key(&tool.exposed_name) {
                            let taken = std::mem::take(&mut tool.exposed_name);
                            let mut number = manager.tools.len();
                            tool.exposed_name = loop {
                                let name = with_suffix(&taken, &number.to_string());
                                if !manager.exposed.contains_key(&name) {
                                    break name;
                                }
                                number += 1;
                            };
                        }
                        manager.exposed.insert(
                            tool.exposed_name.clone(),
                            (tool.server.clone(), tool.name.clone()),
                        );
                        manager.tools.push(tool);
                    }
                    manager.clients.insert(server, client);
                }
                Err(error) => manager
                    .errors
                    .push(format!("MCP server '{server}': {error} ({source})")),
            }
        }
        manager
    }

    pub fn tools(&self) -> &[McpToolInfo] {
        &self.tools
    }

    /// Whether every server connected without an error and is still running,
    /// i.e. the manager can be reused as it is.
    fn is_healthy(&self) -> bool {
        self.errors.is_empty() && self.clients.values().all(|client| client.is_alive())
    }

    /// Ranks MCP tools against a natural-language query over their server,
    /// name and description. Returns the best matches first, up to `limit`.
    pub fn search(&self, query: &str, limit: usize) -> Vec<&McpToolInfo> {
        let terms: Vec<String> = query
            .to_lowercase()
            .split_whitespace()
            .filter(|term| !term.is_empty())
            .map(str::to_string)
            .collect();
        if terms.is_empty() {
            return Vec::new();
        }
        let mut scored: Vec<(i32, &McpToolInfo)> = self
            .tools
            .iter()
            .filter_map(|tool| {
                let name = tool.name.to_lowercase();
                let haystack =
                    format!("{} {} {}", tool.server, tool.name, tool.description).to_lowercase();
                let mut score = 0i32;
                for term in &terms {
                    if name.contains(term) {
                        score += 3;
                    } else if haystack.contains(term) {
                        score += 1;
                    }
                }
                (score > 0).then_some((score, tool))
            })
            .collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0));
        scored
            .into_iter()
            .take(limit)
            .map(|(_, tool)| tool)
            .collect()
    }

    pub fn schemas(&self) -> Vec<Value> {
        self.tools
            .iter()
            .map(|tool| {
                let description = if tool.description.is_empty() {
                    format!("MCP tool '{}' from server '{}'.", tool.name, tool.server)
                } else {
                    format!("[{}] {}", tool.server, tool.description)
                };
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.exposed_name,
                        "description": description,
                        "parameters": tool.input_schema
                    }
                })
            })
            .collect()
    }

    /// True when the exposed tool's own input schema has a `key` property.
    pub fn declares_argument(&self, exposed: &str, key: &str) -> bool {
        self.tools.iter().any(|tool| {
            tool.exposed_name == exposed
                && tool
                    .input_schema
                    .get("properties")
                    .and_then(Value::as_object)
                    .is_some_and(|properties| properties.contains_key(key))
        })
    }

    /// True when the server of the exposed tool says it changes nothing.
    pub fn reads_only(&self, exposed: &str) -> bool {
        self.tools
            .iter()
            .any(|tool| tool.exposed_name == exposed && tool.read_only)
    }

    /// What a "don't ask again" for the exposed tool remembers: the tool and
    /// the exact server it belongs to. `None` for a tool this manager lacks.
    pub fn tool_grant(&self, exposed: &str) -> Option<McpToolGrant> {
        let (server, tool) = self.exposed.get(exposed)?;
        let config = &self.clients.get(server)?.config;
        Some(McpToolGrant {
            server: server.clone(),
            tool: tool.clone(),
            source: config.source.clone(),
            fingerprint: config.fingerprint(),
        })
    }

    pub async fn call(&self, exposed: &str, arguments: Value) -> Result<(String, bool)> {
        let (server, tool) = self
            .exposed
            .get(exposed)
            .cloned()
            .ok_or_else(|| AppError::msg(format!("Unknown MCP tool '{exposed}'")))?;
        let client = self
            .clients
            .get(&server)
            .ok_or_else(|| AppError::msg(format!("MCP server '{server}' is not connected")))?;
        client.call_tool(&tool, arguments).await
    }
}

/// How many sessions keep their MCP servers running between turns. The least
/// recently used session beyond this stops its servers.
const MAX_CACHED_SESSIONS: usize = 4;

/// Keeps each session's MCP connections, and the servers each chat approved,
/// between turns: without it every message restarted every server and asked
/// to start it again.
#[derive(Default)]
pub struct McpSessions {
    inner: std::sync::Mutex<McpSessionsInner>,
    running: RunningServers,
}

#[derive(Default)]
struct McpSessionsInner {
    /// Chat id -> the exact server configurations the user approved there. A
    /// changed command, argument, variable or URL asks again.
    approved: HashMap<String, Vec<McpServerConfig>>,
    /// Session id, the configurations its manager connected, and the manager;
    /// least recently used first.
    managers: Vec<(String, Vec<McpServerConfig>, Arc<McpManager>)>,
}

impl McpSessions {
    pub fn is_approved(&self, chat_id: &str, config: &McpServerConfig) -> bool {
        self.inner
            .lock()
            .unwrap()
            .approved
            .get(chat_id)
            .is_some_and(|approved| approved.contains(config))
    }

    pub fn approve(&self, chat_id: &str, config: &McpServerConfig) {
        let mut inner = self.inner.lock().unwrap();
        let approved = inner.approved.entry(chat_id.to_string()).or_default();
        approved.retain(|existing| existing.name != config.name);
        approved.push(config.clone());
    }

    /// The session's manager for exactly `configs`: the one from its previous
    /// turn while that still fits and is healthy, otherwise a new connection.
    /// A running turn keeps its own handle, so replacing or evicting a manager
    /// only stops its servers once no turn uses them anymore.
    ///
    /// New connections start local servers in `root`, the session's project,
    /// and announce each server to `starting`. Dropping the returned future
    /// gives up the connection and stops what it had started.
    pub async fn manager(
        &self,
        session_id: &str,
        configs: Vec<McpServerConfig>,
        root: &Path,
        starting: &(dyn Fn(&str) + Send + Sync),
    ) -> Arc<McpManager> {
        if configs.is_empty() {
            self.remove(&[session_id.to_string()], false);
            return Arc::new(McpManager::empty());
        }
        let cached = {
            let inner = self.inner.lock().unwrap();
            inner
                .managers
                .iter()
                .find(|(id, connected, _)| id == session_id && *connected == configs)
                .map(|(_, _, manager)| manager.clone())
        };
        let manager = match cached {
            Some(manager) if manager.is_healthy() => manager,
            _ => Arc::new(
                McpManager::connect_listed(
                    configs.clone(),
                    Some(root),
                    starting,
                    Some(&self.running),
                )
                .await,
            ),
        };
        let mut inner = self.inner.lock().unwrap();
        inner.managers.retain(|(id, _, _)| id != session_id);
        inner
            .managers
            .push((session_id.to_string(), configs, manager.clone()));
        let excess = inner.managers.len().saturating_sub(MAX_CACHED_SESSIONS);
        inner.managers.drain(..excess);
        manager
    }

    /// Stops the servers of deleted, archived or removed sessions and drops
    /// the approvals of those chats.
    pub fn forget(&self, session_ids: &[String]) {
        self.remove(session_ids, true);
    }

    /// Stops every local server started for a session, each with what it
    /// started, at once and without waiting for anything. For the app's
    /// exit: nothing is dropped there, and a server in a process group of
    /// its own does not end with pumr by itself. The servers of a turn that
    /// still runs and of a connection still being made are stopped too.
    pub fn shutdown(&self) {
        self.running.stop_all();
    }

    fn remove(&self, session_ids: &[String], approvals: bool) {
        let dropped: Vec<Arc<McpManager>> = {
            let mut inner = self.inner.lock().unwrap();
            if approvals {
                for id in session_ids {
                    inner.approved.remove(id);
                }
            }
            let (dropped, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut inner.managers)
                .into_iter()
                .partition(|(id, _, _)| session_ids.contains(id));
            inner.managers = kept;
            dropped.into_iter().map(|(_, _, manager)| manager).collect()
        };
        // Dropped outside the lock: the last handle kills the server processes.
        drop(dropped);
    }
}

/// The longest function name the providers accept. One longer name has every
/// request it is sent with rejected, not only the calls of that tool.
const MAX_EXPOSED_NAME: usize = 64;

/// Builds the function name the model sees for an MCP tool. Names are
/// restricted to `[A-Za-z0-9_]` so every provider accepts them.
///
/// A name within the limit is left as it is. A longer one is cut and ends in
/// a digest of the server and the tool: the same on every run, and another
/// one for a sibling that begins alike. What a name stands for is looked up
/// (`McpManager::exposed`), never read back out of it.
pub fn exposed_name(server: &str, tool: &str) -> String {
    let name = format!("mcp__{}__{}", sanitize(server), sanitize(tool));
    if name.len() <= MAX_EXPOSED_NAME {
        return name;
    }
    use sha2::{Digest, Sha256};
    let digest: String = Sha256::digest(json!([server, tool]).to_string().as_bytes())
        .iter()
        .take(4)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    with_suffix(&name, &digest)
}

/// `name` with `_suffix` at its end, cut as far as the two need to fit the
/// limit together.
fn with_suffix(name: &str, suffix: &str) -> String {
    let kept = MAX_EXPOSED_NAME.saturating_sub(suffix.len() + 1);
    let name: String = name.chars().take(kept).collect();
    format!("{name}_{suffix}")
}

fn sanitize(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposed_names_are_sanitized() {
        assert_eq!(
            exposed_name("my-server", "read/file"),
            "mcp__my_server__read_file"
        );
    }

    /// A server and a tool of the Azure MCP server: together two characters
    /// more than a provider takes for a function name.
    const LONG_SERVER: &str = "azure-mcp-server";
    const LONG_TOOL: &str = "azmcp_monitor_healthmodels_entity_gethealth";

    #[test]
    fn exposed_names_are_no_longer_than_providers_accept() {
        // A name that fits is the one stored grants and rules know.
        assert_eq!(exposed_name("fake", "echo"), "mcp__fake__echo");
        let fits = "t".repeat(64 - "mcp__s__".len());
        assert_eq!(exposed_name("s", &fits), format!("mcp__s__{fits}"));

        // A longer one is cut and told apart by a digest: the same on every
        // run, as the model's history and the tool list must agree.
        let name = exposed_name(LONG_SERVER, LONG_TOOL);
        assert_eq!(
            name,
            "mcp__azure_mcp_server__azmcp_monitor_healthmodels_entit_0e211607"
        );
        assert_eq!(name.len(), 64);

        // Neither a sibling that begins alike nor a name that differs only
        // in what is sanitized away gets the same one.
        let names: std::collections::HashSet<String> = [
            LONG_TOOL.to_string(),
            format!("{LONG_TOOL}_status"),
            format!("{LONG_TOOL}/status"),
            format!("{LONG_TOOL}_status_history"),
        ]
        .iter()
        .map(|tool| exposed_name(LONG_SERVER, tool))
        .collect();
        assert_eq!(names.len(), 4);
        assert!(names.iter().all(|name| name.len() == 64), "{names:?}");
        assert!(names
            .iter()
            .all(|name| name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')));
    }

    #[test]
    fn sse_response_selects_matching_id() {
        let body =
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"ok\":true}}\n\n";
        let value = parse_sse_response(body, 2).unwrap();
        assert_eq!(value.pointer("/result/ok"), Some(&Value::Bool(true)));
        assert!(parse_sse_response(body, 3).is_err());
    }

    #[test]
    fn the_fingerprint_follows_every_part_of_a_server_configuration() {
        let config = McpServerConfig {
            name: "codegraph".to_string(),
            command: Some("codegraph".to_string()),
            args: vec!["serve".to_string(), "--mcp".to_string()],
            env: vec![("TOKEN".to_string(), "secret".to_string())],
            url: None,
            source: "/home/me/.config/opencode/opencode.json".to_string(),
        };
        let fingerprint = config.fingerprint();
        assert_eq!(fingerprint, config.clone().fingerprint());
        assert_eq!(fingerprint.len(), 64);
        // The variables are part of it without being readable from it.
        assert!(!fingerprint.contains("secret"));

        let changes: [fn(&mut McpServerConfig); 6] = [
            |config| config.name = "other".to_string(),
            |config| config.command = Some("/tmp/codegraph".to_string()),
            |config| config.args.push("--verbose".to_string()),
            |config| config.env[0].1 = "other".to_string(),
            |config| config.url = Some("https://example.com/mcp".to_string()),
            |config| config.source = "/tmp/opencode.json".to_string(),
        ];
        for change in changes {
            let mut changed = config.clone();
            change(&mut changed);
            assert_ne!(changed.fingerprint(), fingerprint, "{changed:?}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_tool_grant_names_the_tool_and_its_exact_server() {
        let dir = tempfile::tempdir().unwrap();
        let config = fake_server(dir.path());
        let manager = McpManager::connect(vec![config.clone()], None, &|_| {}).await;
        assert!(manager.errors.is_empty(), "{:?}", manager.errors);

        let grant = manager.tool_grant("mcp__fake__echo").unwrap();
        assert_eq!(
            (
                grant.server.as_str(),
                grant.tool.as_str(),
                grant.source.as_str()
            ),
            ("fake", "echo", "test")
        );
        assert_eq!(grant.fingerprint, config.fingerprint());
        assert!(manager.tool_grant("mcp__fake__missing").is_none());
    }

    /// A stdio MCP server with one `echo` tool, written as a shell script.
    #[cfg(unix)]
    fn fake_server(dir: &std::path::Path) -> McpServerConfig {
        use std::io::Write;

        let script = dir.join("fake-mcp.sh");
        let mut file = std::fs::File::create(&script).unwrap();
        write!(
            file,
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"initialize"'*) echo '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":"2024-11-05","capabilities":{{}},"serverInfo":{{"name":"fake","version":"1"}}}}}}' ;;
    *'"tools/list"'*) echo '{{"jsonrpc":"2.0","id":2,"result":{{"tools":[{{"name":"echo","description":"Echo","inputSchema":{{"type":"object","properties":{{"text":{{"type":"string"}}}}}}}}]}}}}' ;;
    *'"tools/call"'*) echo '{{"jsonrpc":"2.0","id":3,"result":{{"content":[{{"type":"text","text":"hello"}}]}}}}' ;;
  esac
done
"#
        )
        .unwrap();
        drop(file);

        McpServerConfig {
            name: "fake".to_string(),
            command: Some("/bin/sh".to_string()),
            args: vec![script.to_string_lossy().to_string()],
            env: Vec::new(),
            url: None,
            source: "test".to_string(),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stdio_server_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let manager = McpManager::connect(vec![fake_server(dir.path())], None, &|_| {}).await;
        assert!(manager.errors.is_empty(), "{:?}", manager.errors);
        assert_eq!(manager.tools().len(), 1);
        assert_eq!(manager.tools()[0].exposed_name, "mcp__fake__echo");

        let (text, is_error) = manager
            .call("mcp__fake__echo", json!({ "text": "hi" }))
            .await
            .unwrap();
        assert!(!is_error);
        assert_eq!(text, "hello");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sessions_reuse_their_servers_and_approvals_between_turns() {
        let dir = tempfile::tempdir().unwrap();
        let config = fake_server(dir.path());
        let sessions = McpSessions::default();

        assert!(!sessions.is_approved("chat", &config));
        sessions.approve("chat", &config);
        assert!(sessions.is_approved("chat", &config));
        assert!(!sessions.is_approved("other", &config));
        let mut changed = config.clone();
        changed.args.push("--verbose".to_string());
        assert!(!sessions.is_approved("chat", &changed));

        let root = dir.path();
        let first = sessions
            .manager("chat", vec![config.clone()], root, &|_| {})
            .await;
        let second = sessions
            .manager("chat", vec![config.clone()], root, &|_| {})
            .await;
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(second.tools().len(), 1);

        // Different servers mean a new connection; none at all, no manager.
        let third = sessions.manager("chat", vec![changed], root, &|_| {}).await;
        assert!(!Arc::ptr_eq(&second, &third));
        assert!(sessions
            .manager("chat", Vec::new(), root, &|_| {})
            .await
            .tools()
            .is_empty());
        assert!(sessions.inner.lock().unwrap().managers.is_empty());
        assert!(sessions.is_approved("chat", &config));

        sessions
            .manager("chat", vec![config.clone()], root, &|_| {})
            .await;
        sessions.forget(&["chat".to_string()]);
        assert!(!sessions.is_approved("chat", &config));
        assert!(sessions.inner.lock().unwrap().managers.is_empty());
    }

    /// A stdio server that runs `script` with `/bin/sh`.
    #[cfg(unix)]
    fn script_server(dir: &std::path::Path, name: &str, script: &str) -> McpServerConfig {
        let file = dir.join(format!("{name}.sh"));
        std::fs::write(&file, script).unwrap();
        McpServerConfig {
            name: name.to_string(),
            command: Some("/bin/sh".to_string()),
            args: vec![file.to_string_lossy().to_string()],
            env: Vec::new(),
            url: None,
            source: "test".to_string(),
        }
    }

    /// What a launcher prints whose interpreter is not on the `PATH`.
    #[cfg(unix)]
    const NO_NODE: &str = "env: node: No such file or directory";

    #[cfg(unix)]
    #[tokio::test]
    async fn a_server_that_dies_at_start_fails_at_once_and_says_why() {
        let dir = tempfile::tempdir().unwrap();
        // Gone before `initialize` is written, and gone once it has been
        // taken: the second used to wait out the whole request timeout.
        for (name, wait) in [("early", ""), ("late", "sleep 0.3\n")] {
            let script = format!("{wait}echo '{NO_NODE}' >&2\nexit 127\n");
            let started = std::time::Instant::now();
            let manager = McpManager::connect(
                vec![script_server(dir.path(), name, &script)],
                None,
                &|_| {},
            )
            .await;
            assert!(started.elapsed() < Duration::from_secs(10), "{name}");
            assert!(manager.tools().is_empty());
            let [error] = manager.errors.as_slice() else {
                panic!("{name}: {:?}", manager.errors);
            };
            assert!(error.contains(&format!("'{name}' stopped during initialize")));
            assert!(error.contains("exit status: 127"), "{error}");
            assert!(error.contains(NO_NODE), "{error}");
            assert!(!manager.is_healthy());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_server_whose_process_ends_fails_even_while_its_output_stays_open() {
        let dir = tempfile::tempdir().unwrap();
        // The background process inherits the output, so it never closes.
        let config = script_server(dir.path(), "wrapper", "sleep 5 &\nsleep 0.3\nexit 3\n");
        let started = std::time::Instant::now();
        let error = match McpClient::connect(config, None).await {
            Ok(_) => panic!("connected to a server that exited"),
            Err(error) => error.to_string(),
        };
        assert!(started.elapsed() < Duration::from_secs(4), "{error}");
        assert!(error.contains("exit status: 3"), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_server_that_stops_later_fails_its_calls_and_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        // Answers `initialize` and `tools/list`, then exits on the call.
        let script = r#"while IFS= read -r line; do
  case "$line" in
    *'"initialize"'*) echo '{"jsonrpc":"2.0","id":1,"result":{}}' ;;
    *'"tools/list"'*) echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo"}]}}' ;;
    *'"tools/call"'*) echo 'out of memory' >&2; exit 9 ;;
  esac
done
"#;
        let config = script_server(dir.path(), "crash", script);
        let sessions = McpSessions::default();
        let first = sessions
            .manager("chat", vec![config.clone()], dir.path(), &|_| {})
            .await;
        assert!(first.errors.is_empty(), "{:?}", first.errors);

        let started = std::time::Instant::now();
        let error = first
            .call("mcp__crash__echo", json!({}))
            .await
            .unwrap_err()
            .to_string();
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(error.contains("stopped during tools/call"), "{error}");
        assert!(error.contains("exit status: 9"), "{error}");
        assert!(error.contains("out of memory"), "{error}");
        // A call to the dead server no longer waits for anything.
        let again = first.call("mcp__crash__echo", json!({})).await.unwrap_err();
        assert!(again.to_string().contains("exit status: 9"));

        // The next turn starts the server anew and names it to the chat.
        let started = std::sync::Mutex::new(Vec::new());
        let second = sessions
            .manager("chat", vec![config], dir.path(), &|server| {
                started.lock().unwrap().push(server.to_string())
            })
            .await;
        assert!(!Arc::ptr_eq(&first, &second));
        assert!(second.errors.is_empty(), "{:?}", second.errors);
        assert_eq!(*started.lock().unwrap(), ["crash"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_servers_run_in_the_project_and_are_given_it_as_root() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("my project");
        std::fs::create_dir(&project).unwrap();
        // Asks for the client's roots once it is initialised, as codegraph
        // does, and reports them with its working directory and with what
        // `initialize` told it.
        let script = r#"roots=none
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      case "$line" in *'"roots":{'*) declared=yes ;; *) declared=no ;; esac
      version=$(printf '%s' "$line" | sed -n 's/.*"clientInfo":{[^}]*"version":"\([^"]*\)".*/\1/p')
      printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
    *'"notifications/initialized"'*) echo '{"jsonrpc":"2.0","id":"r1","method":"roots/list"}' ;;
    *'"id":"r1"'*) roots=$(printf '%s' "$line" | sed -n 's/.*"uri":"\([^"]*\)".*/\1/p') ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"where"}]}}\n' "$id" ;;
    *'"method":"tools/call"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"%s %s\\n%s\\n%s"}]}}\n' \
        "$id" "$declared" "$version" "$(pwd)" "$roots" ;;
  esac
done
"#;
        let config = script_server(dir.path(), "where", script);
        let manager = McpManager::connect(vec![config.clone()], Some(&project), &|_| {}).await;
        assert!(manager.errors.is_empty(), "{:?}", manager.errors);

        // The server's question and its answer cross the call, so ask until
        // the answer has arrived.
        let mut text = String::new();
        for _ in 0..100 {
            text = manager
                .call("mcp__where__where", json!({}))
                .await
                .unwrap()
                .0;
            if !text.ends_with("none") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let uri = reqwest::Url::from_file_path(&project).unwrap();
        assert!(uri.as_str().ends_with("/my%20project"), "{uri}");
        let cwd = project.canonicalize().unwrap();
        // The version users see, not the crate's own.
        let app: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let version = app["version"].as_str().unwrap();
        assert_eq!(text, format!("yes {version}\n{}\n{uri}", cwd.display()));

        // Without a project nothing is promised and nothing is told.
        let manager = McpManager::connect(vec![config], None, &|_| {}).await;
        let (text, _) = manager.call("mcp__where__where", json!({})).await.unwrap();
        assert!(text.starts_with("no "), "{text}");
    }

    /// A stdio server whose tools answer a call with the name they were
    /// called by.
    #[cfg(unix)]
    fn naming_server(dir: &std::path::Path, name: &str, tools: &[&str]) -> McpServerConfig {
        let listed: Vec<String> = tools
            .iter()
            .map(|tool| format!(r#"{{"name":"{tool}"}}"#))
            .collect();
        let script = format!(
            r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id" ;;
    *'"method":"tools/list"'*)
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"tools":[{listed}]}}}}\n' "$id" ;;
    *'"method":"tools/call"'*)
      name=$(printf '%s' "$line" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"content":[{{"type":"text","text":"%s"}}]}}}}\n' \
        "$id" "$name" ;;
  esac
done
"#,
            listed = listed.join(",")
        );
        script_server(dir, name, &script)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn long_and_clashing_tool_names_stay_short_unique_and_callable() {
        let dir = tempfile::tempdir().unwrap();
        let sibling = format!("{LONG_TOOL}_status");
        // The long tool is listed twice, so both get the same digest, and
        // `read/file` is `read_file` once it is sanitized.
        let tools = [LONG_TOOL, &sibling, LONG_TOOL, "read/file", "read_file"];
        let config = naming_server(dir.path(), LONG_SERVER, &tools);
        let manager = McpManager::connect(vec![config], None, &|_| {}).await;
        assert!(manager.errors.is_empty(), "{:?}", manager.errors);

        let exposed: Vec<&str> = manager
            .tools()
            .iter()
            .map(|tool| tool.exposed_name.as_str())
            .collect();
        assert_eq!(exposed[0], exposed_name(LONG_SERVER, LONG_TOOL));
        // Short names clash and are numbered as they always were.
        assert_eq!(
            exposed[3..],
            [
                "mcp__azure_mcp_server__read_file",
                "mcp__azure_mcp_server__read_file_4"
            ]
        );
        let unique: std::collections::HashSet<&str> = exposed.iter().copied().collect();
        assert_eq!(unique.len(), tools.len(), "{exposed:?}");
        assert!(exposed.iter().all(|name| name.len() <= 64), "{exposed:?}");

        // Every name is the one the provider is sent, and leads back to the
        // tool it stands for: in a call and in a remembered approval.
        let sent: Vec<Value> = manager
            .schemas()
            .iter()
            .map(|schema| schema["function"]["name"].clone())
            .collect();
        assert_eq!(sent, exposed);
        for (name, tool) in exposed.iter().zip(tools) {
            let (text, _) = manager.call(name, json!({})).await.unwrap();
            assert_eq!(text, tool);
            assert_eq!(manager.tool_grant(name).unwrap().tool, tool);
        }
    }

    #[tokio::test]
    async fn a_server_that_cannot_be_reached_is_reported_without_its_url() {
        // A port nothing listens on: taken and given back.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let config = McpServerConfig {
            name: "remote".to_string(),
            command: None,
            args: Vec::new(),
            env: Vec::new(),
            // Where services put the key that the model and the stored chat
            // must not get to see.
            url: Some(format!("http://127.0.0.1:{port}/mcp?apiKey=s3cret")),
            source: "test".to_string(),
        };
        let manager = McpManager::connect(vec![config], None, &|_| {}).await;
        let [error] = manager.errors.as_slice() else {
            panic!("{:?}", manager.errors);
        };
        assert!(
            error.starts_with("Could not reach MCP server 'remote': "),
            "{error}"
        );
        for part in ["s3cret", "apiKey", "127.0.0.1"] {
            assert!(!error.contains(part), "{error}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn output_that_is_not_utf8_does_not_end_the_connection() {
        let dir = tempfile::tempdir().unwrap();
        // Latin-1 on both outputs before the first answer, as a localised
        // console message or a path is written.
        let script = r#"while IFS= read -r line; do
  case "$line" in
    *'"initialize"'*)
      printf 'chemin: caf\351\n' >&2
      printf 'pr\352t \340 d\351marrer\n'
      echo '{"jsonrpc":"2.0","id":1,"result":{}}' ;;
    *'"tools/list"'*) echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo"}]}}' ;;
    *'"tools/call"'*) echo 'out of memory' >&2; exit 9 ;;
  esac
done
"#;
        let config = script_server(dir.path(), "latin", script);
        let manager = McpManager::connect(vec![config], None, &|_| {}).await;
        assert!(manager.errors.is_empty(), "{:?}", manager.errors);
        assert_eq!(manager.tools().len(), 1);

        // The error output was read on past its bad line as well.
        let error = manager
            .call("mcp__latin__echo", json!({}))
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("chemin: caf\u{fffd} | out of memory"),
            "{error}"
        );
    }

    /// A server as `npx`, `uvx` or `sh -c` start one: the process pumr starts
    /// only starts another, here a `sleep`, and goes on with `then`.
    #[cfg(unix)]
    fn wrapping_server(dir: &std::path::Path, name: &str, then: &str) -> McpServerConfig {
        let script = format!(
            "sleep 300 &\necho $! > '{}'\n{then}",
            dir.join(format!("{name}.pid")).display()
        );
        script_server(dir, name, &script)
    }

    /// Answers `initialize` and lists no tools.
    #[cfg(unix)]
    const ANSWERS: &str = r#"while IFS= read -r line; do
  case "$line" in
    *'"initialize"'*) echo '{"jsonrpc":"2.0","id":1,"result":{}}' ;;
    *'"tools/list"'*) echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}' ;;
  esac
done
"#;

    /// The process a `wrapping_server` started, once it has said which.
    #[cfg(unix)]
    async fn wrapped_process(dir: &std::path::Path, name: &str) -> i32 {
        for _ in 0..250 {
            let written = std::fs::read_to_string(dir.join(format!("{name}.pid")));
            if let Some(pid) = written.ok().and_then(|text| text.trim().parse().ok()) {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("'{name}' did not start its process");
    }

    #[cfg(unix)]
    fn is_running(pid: i32) -> bool {
        // SAFETY: signal 0 only checks whether the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// Whether the process ends within the time a kill may take.
    #[cfg(unix)]
    async fn ends(pid: i32) -> bool {
        for _ in 0..150 {
            if !is_running(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_dropped_server_takes_the_processes_it_started_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let config = wrapping_server(dir.path(), "wrapper", ANSWERS);
        let client = McpClient::connect(config, None).await.ok().unwrap();
        let wrapped = wrapped_process(dir.path(), "wrapper").await;
        assert!(is_running(wrapped));
        drop(client);
        assert!(ends(wrapped).await, "it outlived a server that was dropped");

        // One that ends by itself leaves nothing behind either.
        let config = wrapping_server(dir.path(), "leaver", "exit 3\n");
        assert!(McpClient::connect(config, None).await.is_err());
        let wrapped = wrapped_process(dir.path(), "leaver").await;
        assert!(ends(wrapped).await, "it outlived a server that had ended");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_stops_every_server_with_what_it_started() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = Arc::new(McpSessions::default());
        // One that is in use, and one that never answers: its connection is
        // still being made when the app exits.
        let config = wrapping_server(dir.path(), "used", ANSWERS);
        let manager = sessions
            .manager("chat", vec![config], dir.path(), &|_| {})
            .await;
        assert!(manager.errors.is_empty(), "{:?}", manager.errors);
        let silent = wrapping_server(dir.path(), "silent", "sleep 300\n");
        let connecting = {
            let sessions = sessions.clone();
            let root = dir.path().to_path_buf();
            tokio::spawn(async move {
                sessions
                    .manager("other", vec![silent], &root, &|_| {})
                    .await
            })
        };
        let used = wrapped_process(dir.path(), "used").await;
        let waiting = wrapped_process(dir.path(), "silent").await;
        assert!(is_running(used) && is_running(waiting));

        // Nothing is dropped: the turn still holds its manager.
        sessions.shutdown();
        assert!(ends(used).await, "a server in use outlived the shutdown");
        assert!(ends(waiting).await, "a starting server outlived it");
        assert!(!connecting.await.unwrap().errors.is_empty());
        drop(manager);
    }

    /// What a test's remote server was sent.
    #[derive(Debug)]
    struct Posted {
        method: String,
        session: Option<String>,
        /// Whether the client said it takes an event stream for an answer.
        accepts_stream: bool,
    }

    fn header(head: &str, name: &str) -> Option<String> {
        head.lines().find_map(|line| {
            let value = line.strip_prefix(name)?.strip_prefix(':')?;
            Some(value.trim().to_string())
        })
    }

    /// A remote MCP server on a local port, with what it is sent. Each
    /// `initialize` opens a session (`s1`, `s2`, …), and a `tools/call` is
    /// answered if `known` says the server still knows the session it came
    /// in, with a 404 otherwise.
    async fn remote_server(
        known: fn(&str) -> bool,
    ) -> (McpServerConfig, Arc<std::sync::Mutex<Vec<Posted>>>) {
        use tokio::io::AsyncReadExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let posted = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = posted.clone();
        tokio::spawn(async move {
            let mut sessions = 0;
            // One request for each connection keeps this short.
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut request = Vec::new();
                let (head, body) = loop {
                    let mut chunk = [0u8; 4096];
                    let read = stream.read(&mut chunk).await.unwrap();
                    assert!(read > 0, "the request ended early");
                    request.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&request);
                    let Some((head, body)) = text.split_once("\r\n\r\n") else {
                        continue;
                    };
                    let head = head.to_lowercase();
                    let length = header(&head, "content-length").unwrap();
                    if body.len() >= length.parse::<usize>().unwrap() {
                        break (head, body.to_string());
                    }
                };
                let message: Value = serde_json::from_str(&body).unwrap();
                let method = message["method"].as_str().unwrap().to_string();
                let session = header(&head, "mcp-session-id");
                let result = |result: Value| {
                    json!({ "jsonrpc": "2.0", "id": message["id"], "result": result }).to_string()
                };
                let (status, opened, answer) = match method.as_str() {
                    "initialize" => {
                        sessions += 1;
                        (200, Some(format!("s{sessions}")), result(json!({})))
                    }
                    "notifications/initialized" => (202, None, String::new()),
                    "tools/list" => (200, None, result(json!({ "tools": [{ "name": "echo" }] }))),
                    _ => match session.as_deref().filter(|session| known(session)) {
                        Some(session) => {
                            let text = format!("hello from {session}");
                            let content = json!({ "content": [{ "type": "text", "text": text }] });
                            (200, None, result(content))
                        }
                        None => (404, None, String::new()),
                    },
                };
                seen.lock().unwrap().push(Posted {
                    method,
                    session,
                    accepts_stream: header(&head, "accept")
                        .is_some_and(|accept| accept.contains("text/event-stream")),
                });
                let opened = opened
                    .map(|session| format!("Mcp-Session-Id: {session}\r\n"))
                    .unwrap_or_default();
                let response = format!(
                    "HTTP/1.1 {status} Status\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{opened}\r\n{answer}",
                    answer.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });
        let config = McpServerConfig {
            name: "remote".to_string(),
            command: None,
            args: Vec::new(),
            env: Vec::new(),
            url: Some(url),
            source: "test".to_string(),
        };
        (config, posted)
    }

    /// The methods a test's remote server was sent, each with its session.
    fn sent(posted: &[Posted]) -> Vec<(&str, Option<&str>)> {
        posted
            .iter()
            .map(|posted| (posted.method.as_str(), posted.session.as_deref()))
            .collect()
    }

    #[tokio::test]
    async fn a_remote_session_the_server_lost_is_opened_anew_and_the_call_sent_again() {
        // The server no longer knows its first session, as after a restart.
        let (config, posted) = remote_server(|session| session != "s1").await;
        let manager = McpManager::connect(vec![config], None, &|_| {}).await;
        assert!(manager.errors.is_empty(), "{:?}", manager.errors);

        let (text, _) = manager.call("mcp__remote__echo", json!({})).await.unwrap();
        assert_eq!(text, "hello from s2");
        let (text, _) = manager.call("mcp__remote__echo", json!({})).await.unwrap();
        assert_eq!(text, "hello from s2");

        let posted = posted.lock().unwrap();
        assert_eq!(
            sent(&posted),
            [
                ("initialize", None),
                // Sent in its session like a request: a server that keeps
                // sessions refuses it otherwise, and what follows with it.
                ("notifications/initialized", Some("s1")),
                ("tools/list", Some("s1")),
                ("tools/call", Some("s1")),
                ("initialize", None),
                ("notifications/initialized", Some("s2")),
                ("tools/call", Some("s2")),
                ("tools/call", Some("s2")),
            ]
        );
        assert!(
            posted.iter().all(|posted| posted.accepts_stream),
            "{posted:?}"
        );
    }

    #[tokio::test]
    async fn a_remote_server_that_keeps_answering_404_is_asked_once_more_and_no_further() {
        let (config, posted) = remote_server(|_| false).await;
        let manager = McpManager::connect(vec![config], None, &|_| {}).await;
        assert!(manager.errors.is_empty(), "{:?}", manager.errors);

        let error = manager
            .call("mcp__remote__echo", json!({}))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "MCP server 'remote' returned HTTP 404");
        assert_eq!(
            sent(&posted.lock().unwrap())[3..],
            [
                ("tools/call", Some("s1")),
                ("initialize", None),
                ("notifications/initialized", Some("s2")),
                ("tools/call", Some("s2")),
            ]
        );

        // Only a request that was sent in a session can have lost it.
        let not_found = reqwest::StatusCode::NOT_FOUND;
        assert!(session_expired(not_found, true, "tools/call"));
        assert!(!session_expired(not_found, false, "tools/call"));
        assert!(!session_expired(not_found, true, "initialize"));
        let bad_gateway = reqwest::StatusCode::BAD_GATEWAY;
        assert!(!session_expired(bad_gateway, true, "tools/call"));
    }

    #[test]
    fn a_bare_command_is_found_as_the_batch_file_windows_cannot_start_by_name() {
        // What installing Node, a package of its, uv and a tool of one's own
        // leave on the `PATH`.
        let files = [
            r"scripts\npx.cmd",
            r"C:\Program Files\nodejs\node.exe",
            r"C:\Program Files\nodejs\npx",
            r"C:\Program Files\nodejs\npx.cmd",
            r"C:\Program Files\nodejs\npx.ps1",
            r"C:\Users\me\AppData\Roaming\npm\tsx.cmd",
            r"C:\Users\me\AppData\Roaming\npm\uvx.cmd",
            r"C:\Python\Scripts\uvx.exe",
            r"C:\tools\run.bat",
            r"C:\tools\run.cmd",
            r"C:\tools\notes.vbs",
        ];
        // Names of files are the same in either case on Windows.
        let is_file = |file: &str| files.iter().any(|known| known.eq_ignore_ascii_case(file));
        let path = r#"scripts;"C:\Program Files\nodejs\";;C:\Users\me\AppData\Roaming\npm;C:\Python\Scripts;C:\tools"#;
        let pathext = ".COM;.EXE;.BAT;.CMD;.VBS";
        let find = |command: &str| windows_batch_file(command, path, pathext, &is_file);

        // Not the file without an extension next to it, which is for a Unix
        // shell, and not from a folder inside the project.
        assert_eq!(
            find("npx").as_deref(),
            Some(r"C:\Program Files\nodejs\npx.CMD")
        );
        assert_eq!(
            find("tsx").as_deref(),
            Some(r"C:\Users\me\AppData\Roaming\npm\tsx.CMD")
        );
        // In the order of `PATHEXT`.
        assert_eq!(find("run").as_deref(), Some(r"C:\tools\run.BAT"));

        // An `.exe` is started by Windows itself, wherever on the `PATH`.
        assert_eq!(find("node"), None);
        assert_eq!(find("uvx"), None);
        // So is what names its file or its path, and what cannot be started.
        for command in ["npx.cmd", r"C:\tools\run", "./run", "notes", "missing", ""] {
            assert_eq!(find(command), None, "{command:?}");
        }
        // Only with the extensions the server's process is given.
        assert_eq!(windows_batch_file("npx", path, ".COM;.EXE", &is_file), None);
        assert_eq!(windows_batch_file("npx", "", pathext, &is_file), None);
    }

    #[test]
    fn a_batch_file_is_given_only_arguments_the_command_prompt_cannot_misread() {
        let line = |args: &[&str]| {
            let args: Vec<String> = args.iter().map(|argument| argument.to_string()).collect();
            batch_command_line(r"C:\Program Files\nodejs\npx.cmd", &args)
        };
        assert_eq!(
            line(&["-y", "@modelcontextprotocol/server-filesystem@2025.8.21"]).unwrap(),
            r#"/e:ON /v:OFF /d /c ""C:\Program Files\nodejs\npx.cmd" -y @modelcontextprotocol/server-filesystem@2025.8.21""#
        );
        // Quoted wherever the prompt could read more into it than text, and
        // so that a last backslash does not take the quote with it.
        let project = r"C:\Users\me\My Project";
        let unusual = [project, r"D:\data\", "--port=8080", "a&calc", "^|<>()!", ""];
        assert_eq!(
            line(&unusual).unwrap(),
            r#"/e:ON /v:OFF /d /c ""C:\Program Files\nodejs\npx.cmd" "C:\Users\me\My Project" "D:\data\\" "--port=8080" "a&calc" "^|<>()!" """"#
        );

        // What no quoting makes safe is refused, and named by its place: an
        // argument may be a secret.
        let refused = ["say \"hi\" & calc", "%COMSPEC%", "100%", "one\ntwo", "a\tb"];
        for argument in refused {
            let error = line(&["-y", argument]).unwrap_err();
            assert!(error.starts_with("argument 2 holds"), "{error}");
            assert!(!error.contains(argument), "{error}");
        }
        assert!(batch_command_line(r"C:\100%\npx.cmd", &[]).is_err());
    }

    #[test]
    fn a_server_gets_an_answer_to_what_it_asks_of_its_client() {
        let link = StdioLink {
            requests: Default::default(),
            stderr: Default::default(),
            root: None,
        };
        assert_eq!(link.answer("ping"), Some(json!({})));
        assert_eq!(link.answer("roots/list"), Some(json!({ "roots": [] })));
        assert_eq!(link.answer("sampling/createMessage"), None);
    }

    #[test]
    fn the_error_about_a_stopped_server_keeps_the_end_of_its_error_output() {
        let link = StdioLink {
            requests: Default::default(),
            stderr: Default::default(),
            root: None,
        };
        for line in 1..=STDERR_TAIL_LINES + 2 {
            link.keep_stderr(&format!("line {line}\n"));
        }
        link.keep_stderr("   ");
        link.keep_stderr(&"x".repeat(STDERR_LINE_CHARS * 2));
        link.end(None);
        let reason = link.requests.lock().unwrap().ended.clone().unwrap();
        assert!(reason.starts_with("it closed its output. Last error output: line 4 | "));
        assert!(!reason.contains("line 3"));
        assert!(reason.ends_with(&format!(" | {}", "x".repeat(STDERR_LINE_CHARS))));
    }
}
