//! Minimal Model Context Protocol client.
//!
//! Supports the two transports pumr can reasonably manage itself: local
//! `stdio` servers (spawned as child processes) and remote streamable-HTTP
//! servers. Only the subset needed to expose tools to the agent loop is
//! implemented: `initialize`, `tools/list` and `tools/call`.

use crate::error::{AppError, Result};
use crate::models::McpToolInfo;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

const PROTOCOL_VERSION: &str = "2024-11-05";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct McpServerConfig {
    pub name: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub url: Option<String>,
    pub source: String,
}

struct StdioState {
    stdin: Mutex<ChildStdin>,
    _child: Mutex<Child>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
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
    pub async fn connect(config: McpServerConfig) -> Result<Arc<McpClient>> {
        let transport = if let Some(url) = config.url.clone() {
            Transport::Http {
                client: reqwest::Client::builder()
                    .user_agent("pumr/0.1")
                    .build()
                    .map_err(|error| AppError::msg(format!("HTTP client error: {error}")))?,
                url,
                session: Mutex::new(None),
            }
        } else if let Some(command) = config.command.clone() {
            let mut process = Command::new(&command);
            process.args(&config.args);
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
            process
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            let mut child = process.spawn().map_err(|error| {
                AppError::msg(format!(
                    "Could not start MCP server '{}': {error}",
                    config.name
                ))
            })?;
            let stdin = child.stdin.take().ok_or_else(|| {
                AppError::msg(format!("MCP server '{}' has no stdin", config.name))
            })?;
            let stdout = child.stdout.take().ok_or_else(|| {
                AppError::msg(format!("MCP server '{}' has no stdout", config.name))
            })?;
            if let Some(stderr) = child.stderr.take() {
                tokio::spawn(async move {
                    let mut lines = BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        log::debug!("mcp stderr: {line}");
                    }
                });
            }
            let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>> =
                Arc::new(Mutex::new(HashMap::new()));
            let reader_pending = pending.clone();
            let server_name = config.name.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let Ok(value) = serde_json::from_str::<Value>(line) else {
                        continue;
                    };
                    if let Some(id) = value.get("id").and_then(Value::as_i64) {
                        if let Some(sender) = reader_pending.lock().await.remove(&id) {
                            let _ = sender.send(value);
                        }
                    }
                }
                log::warn!("MCP server '{server_name}' closed its output");
            });
            Transport::Stdio(StdioState {
                stdin: Mutex::new(stdin),
                _child: Mutex::new(child),
                pending,
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

    async fn initialize(&self) -> Result<()> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "pumr", "version": env!("CARGO_PKG_VERSION") }
            }),
        )
        .await?;
        self.notify("notifications/initialized", json!({})).await;
        Ok(())
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
                let (sender, receiver) = oneshot::channel();
                state.pending.lock().await.insert(id, sender);
                {
                    let mut stdin = state.stdin.lock().await;
                    let mut line = serde_json::to_string(&message)?;
                    line.push('\n');
                    stdin.write_all(line.as_bytes()).await.map_err(|error| {
                        AppError::msg(format!(
                            "Could not write to MCP server '{}': {error}",
                            self.config.name
                        ))
                    })?;
                    let _ = stdin.flush().await;
                }
                let response = tokio::time::timeout(REQUEST_TIMEOUT, receiver)
                    .await
                    .map_err(|_| {
                        AppError::msg(format!(
                            "MCP server '{}' timed out on {method}",
                            self.config.name
                        ))
                    })?
                    .map_err(|_| {
                        AppError::msg(format!(
                            "MCP server '{}' disconnected during {method}",
                            self.config.name
                        ))
                    })?;
                unwrap_response(response, method)
            }
            Transport::Http {
                client,
                url,
                session,
            } => {
                let mut request = client
                    .post(url)
                    .header("Accept", "application/json, text/event-stream")
                    .json(&message);
                if let Some(session_id) = session.lock().await.clone() {
                    request = request.header("Mcp-Session-Id", session_id);
                }
                let response = request.send().await.map_err(|error| {
                    AppError::msg(format!(
                        "Could not reach MCP server '{}': {error}",
                        self.config.name
                    ))
                })?;
                if let Some(session_id) = response
                    .headers()
                    .get("Mcp-Session-Id")
                    .and_then(|value| value.to_str().ok())
                {
                    *session.lock().await = Some(session_id.to_string());
                }
                let status = response.status();
                let content_type = response
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("")
                    .to_lowercase();
                let body = response.text().await.map_err(|error| {
                    AppError::msg(format!(
                        "Could not read MCP server '{}' response: {error}",
                        self.config.name
                    ))
                })?;
                if !status.is_success() {
                    return Err(AppError::msg(format!(
                        "MCP server '{}' returned HTTP {}",
                        self.config.name,
                        status.as_u16()
                    )));
                }
                let value = if content_type.contains("text/event-stream") {
                    parse_sse_response(&body, id)?
                } else {
                    serde_json::from_str(&body).map_err(|error| {
                        AppError::msg(format!(
                            "Invalid MCP response from '{}': {error}",
                            self.config.name
                        ))
                    })?
                };
                unwrap_response(value, method)
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) {
        let message = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        match &self.transport {
            Transport::Stdio(state) => {
                let mut stdin = state.stdin.lock().await;
                if let Ok(mut line) = serde_json::to_string(&message) {
                    line.push('\n');
                    let _ = stdin.write_all(line.as_bytes()).await;
                    let _ = stdin.flush().await;
                }
            }
            Transport::Http { client, url, .. } => {
                let _ = client.post(url).json(&message).send().await;
            }
        }
    }
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
            if value.get("id").and_then(Value::as_i64) == Some(id) {
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

    pub async fn connect(configs: Vec<McpServerConfig>) -> Self {
        let mut manager = Self::empty();
        for config in configs {
            let server = config.name.clone();
            let source = config.source.clone();
            let client = match McpClient::connect(config).await {
                Ok(client) => client,
                Err(error) => {
                    manager.errors.push(format!("{error} ({source})"));
                    continue;
                }
            };
            match client.list_tools().await {
                Ok(tools) => {
                    for mut tool in tools {
                        if manager.exposed.contains_key(&tool.exposed_name) {
                            tool.exposed_name =
                                format!("{}_{}", tool.exposed_name, manager.tools.len());
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
        scored.into_iter().take(limit).map(|(_, tool)| tool).collect()
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

/// Builds the function name the model sees for an MCP tool. Names are
/// restricted to `[A-Za-z0-9_]` so every provider accepts them.
pub fn exposed_name(server: &str, tool: &str) -> String {
    format!("mcp__{}__{}", sanitize(server), sanitize(tool))
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

    #[test]
    fn sse_response_selects_matching_id() {
        let body =
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"ok\":true}}\n\n";
        let value = parse_sse_response(body, 2).unwrap();
        assert_eq!(value.pointer("/result/ok"), Some(&Value::Bool(true)));
        assert!(parse_sse_response(body, 3).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stdio_server_round_trip() {
        use std::io::Write;

        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-mcp.sh");
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

        let config = McpServerConfig {
            name: "fake".to_string(),
            command: Some("/bin/sh".to_string()),
            args: vec![script.to_string_lossy().to_string()],
            env: Vec::new(),
            url: None,
            source: "test".to_string(),
        };
        let manager = McpManager::connect(vec![config]).await;
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
}
