use crate::error::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const KEYRING_SERVICE: &str = "pumr";
pub const OPENROUTER_PROVIDER: &str = "openrouter";

pub fn default_system_prompt() -> String {
    r#"You are pumr, an agentic coding assistant running locally on the user's machine.

You help with software engineering tasks in the user's active project. You are precise, pragmatic and terse. Prefer the smallest correct change over broad rewrites.

Tools:
- Use read, glob and grep to inspect the codebase before changing anything. Never invent file contents or APIs.
- Use edit for targeted changes (exact string replacement) and write only for new files or full rewrites.
- Use bash to run tests, builds and git commands. Prefer project scripts (pnpm/npm scripts) over ad-hoc commands.
- Use webfetch to read a specific URL and websearch to look things up on the web. The user must approve every new website; if a website is denied, do not retry it.
- Use task to spawn subagents for independent work in parallel. Give each subagent a complete, self-contained prompt: it cannot see this conversation. Multiple task calls in one turn run concurrently. Prefer doing the work yourself for small tasks.
- Long-running commands are moved to the background automatically; tell the user they can stop them from the running processes indicator.
- Some tool calls require user approval. If a tool is denied, do not retry it; adapt or ask the user.

Guidelines:
- Explain briefly what changed and why after making changes.
- Respect the project's existing conventions, tooling and style.
- Never run destructive commands (rm, deletes, database drops, force pushes) without approval; pumr enforces this.
- Ask for clarification when requirements are ambiguous instead of guessing.
- Format code in fenced blocks with the correct language tag."#
        .to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub default_system_prompt: String,
    pub budget_usd: f64,
    pub language: String,
    pub extra_folders: Vec<String>,
    pub openrouter_base_url: String,
    pub default_model: Option<String>,
    pub default_reasoning_effort: Option<String>,
    pub favorite_models: Vec<String>,
    pub context_message_limit: usize,
    pub command_rules: Vec<String>,
    pub allowed_websites: Vec<String>,
    pub denied_websites: Vec<String>,
    pub mcp_auto_discovery: bool,
    pub mcp_folders: Vec<String>,
    pub mcp_disabled: Vec<String>,
    pub skills_auto_discovery: bool,
    pub skill_folders: Vec<String>,
    pub skills_disabled: Vec<String>,
    pub keep_awake: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            default_system_prompt: default_system_prompt(),
            budget_usd: 0.0,
            language: "en".to_string(),
            extra_folders: Vec::new(),
            openrouter_base_url: crate::providers::openrouter::DEFAULT_BASE_URL.to_string(),
            default_model: None,
            default_reasoning_effort: Some("medium".to_string()),
            favorite_models: Vec::new(),
            context_message_limit: 40,
            command_rules: Vec::new(),
            allowed_websites: Vec::new(),
            denied_websites: Vec::new(),
            mcp_auto_discovery: true,
            mcp_folders: Vec::new(),
            mcp_disabled: Vec::new(),
            skills_auto_discovery: true,
            skill_folders: Vec::new(),
            skills_disabled: Vec::new(),
            keep_awake: true,
        }
    }
}

pub fn load_settings(path: &Path) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
        .unwrap_or_default()
}

pub fn save_settings(path: &Path, settings: &Settings) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(settings)?;
    std::fs::write(path, raw)?;
    Ok(())
}

#[cfg(not(all(debug_assertions, target_os = "macos")))]
fn entry(provider: &str) -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(KEYRING_SERVICE, provider)?)
}

#[cfg(not(all(debug_assertions, target_os = "macos")))]
pub fn set_api_key(provider: &str, key: &str) -> Result<()> {
    entry(provider)?.set_password(key)?;
    Ok(())
}

#[cfg(not(all(debug_assertions, target_os = "macos")))]
pub fn get_api_key(provider: &str) -> Result<Option<String>> {
    match entry(provider)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

#[cfg(not(all(debug_assertions, target_os = "macos")))]
pub fn delete_api_key(provider: &str) -> Result<()> {
    match entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.into()),
    }
}

// On macOS, `tauri dev` runs an ad-hoc signed binary whose signature changes on
// every rebuild. macOS records "Always Allow" keychain permissions against that
// signature, so it can never match and the user is prompted on every launch.
// During development we therefore keep API keys in a plain-text file in the app
// data directory instead of the keychain. Release builds always use the keychain.
#[cfg(all(debug_assertions, target_os = "macos"))]
static DEV_KEY_FILE: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

#[cfg(all(debug_assertions, target_os = "macos"))]
pub fn init_dev_store(data_dir: &Path) {
    let _ = DEV_KEY_FILE.set(data_dir.join("dev-api-keys.json"));
}

#[cfg(not(all(debug_assertions, target_os = "macos")))]
pub fn init_dev_store(_data_dir: &Path) {}

#[cfg(all(debug_assertions, target_os = "macos"))]
mod dev_store {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn path() -> PathBuf {
        DEV_KEY_FILE
            .get()
            .cloned()
            .unwrap_or_else(|| std::env::temp_dir().join("pumr-dev-api-keys.json"))
    }

    fn load() -> HashMap<String, String> {
        std::fs::read_to_string(path())
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn save(keys: &HashMap<String, String>) -> Result<()> {
        let path = path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(keys)?)?;
        Ok(())
    }

    pub fn set(provider: &str, key: &str) -> Result<()> {
        let mut keys = load();
        keys.insert(provider.to_string(), key.to_string());
        save(&keys)
    }

    pub fn get(provider: &str) -> Result<Option<String>> {
        if let Some(key) = load().remove(provider) {
            return Ok(Some(key));
        }
        // One-time migration: a key may already live in the OS keychain from an
        // earlier build. Read it and copy it into the dev store so later launches
        // never touch the keychain (and never re-prompt) again.
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, provider) {
            if let Ok(key) = entry.get_password() {
                if !key.trim().is_empty() {
                    let _ = set(provider, &key);
                    return Ok(Some(key));
                }
            }
        }
        Ok(None)
    }

    pub fn delete(provider: &str) -> Result<()> {
        let mut keys = load();
        if keys.remove(provider).is_some() {
            save(&keys)?;
        }
        Ok(())
    }
}

#[cfg(all(debug_assertions, target_os = "macos"))]
pub fn set_api_key(provider: &str, key: &str) -> Result<()> {
    dev_store::set(provider, key)
}

#[cfg(all(debug_assertions, target_os = "macos"))]
pub fn get_api_key(provider: &str) -> Result<Option<String>> {
    dev_store::get(provider)
}

#[cfg(all(debug_assertions, target_os = "macos"))]
pub fn delete_api_key(provider: &str) -> Result<()> {
    dev_store::delete(provider)
}

pub fn has_api_key(provider: &str) -> Result<bool> {
    Ok(get_api_key(provider)?.is_some_and(|key| !key.trim().is_empty()))
}
