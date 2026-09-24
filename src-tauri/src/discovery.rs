use crate::mcp::McpServerConfig;
use crate::models::{
    McpCandidate, McpServerRef, McpServerState, SkillCandidate, SkillRef, SkillState,
};
use serde_json::Value;
use std::path::{Path, PathBuf};

const MCP_FILE_NAMES: &[&str] = &[
    "mcp.json",
    ".mcp.json",
    "mcp_config.json",
    "claude_desktop_config.json",
    "opencode.json",
    "config.toml",
];

fn home() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .map(PathBuf::from)
}

fn standard_mcp_paths() -> Vec<(PathBuf, &'static str)> {
    let Some(home) = home() else {
        return Vec::new();
    };
    vec![
        (
            home.join("Library/Application Support/Claude/claude_desktop_config.json"),
            "Claude Desktop",
        ),
        (
            home.join(".config/Claude/claude_desktop_config.json"),
            "Claude Desktop",
        ),
        (
            home.join("AppData/Roaming/Claude/claude_desktop_config.json"),
            "Claude Desktop",
        ),
        (home.join(".claude.json"), "Claude Code"),
        (home.join(".claude/settings.json"), "Claude Code"),
        (home.join(".cursor/mcp.json"), "Cursor"),
        (home.join(".codeium/windsurf/mcp_config.json"), "Windsurf"),
        (
            home.join("Library/Application Support/Code/User/mcp.json"),
            "VS Code",
        ),
        (home.join(".config/Code/User/mcp.json"), "VS Code"),
        (home.join("AppData/Roaming/Code/User/mcp.json"), "VS Code"),
        (home.join(".codex/config.toml"), "OpenAI Codex"),
        (home.join(".config/opencode/opencode.json"), "opencode"),
        (home.join(".opencode/opencode.json"), "opencode"),
        (home.join(".devin/mcp.json"), "Devin"),
        (
            home.join("Library/Application Support/Devin/mcp.json"),
            "Devin",
        ),
        (home.join(".gemini/settings.json"), "Gemini CLI"),
    ]
}

fn standard_skill_dirs() -> Vec<(PathBuf, &'static str)> {
    let Some(home) = home() else {
        return Vec::new();
    };
    vec![
        (home.join(".claude/skills"), "Claude Code"),
        (
            home.join("Library/Application Support/Claude/skills"),
            "Claude Desktop",
        ),
        (home.join(".config/opencode/skill"), "opencode"),
        (home.join(".config/opencode/skills"), "opencode"),
        (home.join(".opencode/skill"), "opencode"),
        (home.join(".opencode/skills"), "opencode"),
        (home.join(".agents/skills"), "agents"),
        (home.join(".codex/skills"), "OpenAI Codex"),
        (home.join(".devin/skills"), "Devin"),
    ]
}

pub fn discover_mcp(
    folders: &[String],
    disabled: &[String],
    disabled_servers: &[McpServerRef],
    auto: bool,
) -> Vec<McpCandidate> {
    let mut candidates: Vec<McpCandidate> = Vec::new();

    if auto {
        for (path, label) in standard_mcp_paths() {
            if path.is_file() {
                candidates.push(mcp_candidate(
                    path,
                    label.to_string(),
                    "auto",
                    disabled,
                    disabled_servers,
                ));
            }
        }
    }

    for folder in folders {
        for path in scan_for_mcp_files(Path::new(folder)) {
            let already = candidates
                .iter()
                .any(|candidate| candidate.path == path.to_string_lossy());
            if !already {
                candidates.push(mcp_candidate(
                    path,
                    "Custom folder".to_string(),
                    "custom",
                    disabled,
                    disabled_servers,
                ));
            }
        }
    }

    candidates
}

fn scan_for_mcp_files(folder: &Path) -> Vec<PathBuf> {
    let mut results = Vec::new();
    let mut check = |path: PathBuf| {
        if path.is_file() {
            results.push(path);
        }
    };
    for name in MCP_FILE_NAMES {
        check(folder.join(name));
    }
    if let Ok(entries) = std::fs::read_dir(folder) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            for name in MCP_FILE_NAMES {
                check(path.join(name));
            }
        }
    }
    results
}

fn mcp_candidate(
    path: PathBuf,
    label: String,
    source: &str,
    disabled: &[String],
    disabled_servers: &[McpServerRef],
) -> McpCandidate {
    let path_string = path.to_string_lossy().to_string();
    let (format, names) = if path_string.ends_with(".toml") {
        ("toml", toml_server_names(&path))
    } else {
        ("json", json_server_names(&path))
    };
    let enabled = !disabled.iter().any(|entry| entry == &path_string);
    let servers = names
        .into_iter()
        .map(|name| McpServerState {
            enabled: enabled && !is_server_disabled(disabled_servers, &path_string, &name),
            name,
        })
        .collect();
    McpCandidate {
        enabled,
        path: path_string,
        label,
        source: source.to_string(),
        format: format.to_string(),
        servers,
    }
}

/// True when the user switched this exact server off. Both the config file path
/// and the in-file name must match, because names repeat across files.
fn is_server_disabled(disabled: &[McpServerRef], path: &str, name: &str) -> bool {
    disabled
        .iter()
        .any(|entry| entry.path == path && entry.name == name)
}

fn json_server_names(path: &Path) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let mut names: Vec<String> = Vec::new();
    for key in ["mcpServers", "mcp_servers", "mcp", "servers"] {
        if let Some(object) = value.get(key).and_then(Value::as_object) {
            names.extend(object.keys().cloned());
        }
    }
    names.sort();
    names.dedup();
    names
}

fn toml_server_names(path: &Path) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = toml::from_str::<toml::Value>(&raw) else {
        return Vec::new();
    };
    let mut names: Vec<String> = Vec::new();
    for key in ["mcp_servers", "mcpServers", "mcp"] {
        if let Some(table) = value.get(key).and_then(toml::Value::as_table) {
            names.extend(table.keys().cloned());
        }
    }
    names.sort();
    names.dedup();
    names
}

pub fn discover_skills(
    folders: &[String],
    disabled: &[String],
    disabled_skills: &[SkillRef],
    auto: bool,
    installed: &[PathBuf],
) -> Vec<SkillCandidate> {
    let mut candidates: Vec<SkillCandidate> = Vec::new();

    if auto {
        for (path, label) in standard_skill_dirs() {
            if path.is_dir() {
                candidates.push(skill_candidate(
                    path,
                    label.to_string(),
                    "auto",
                    disabled,
                    disabled_skills,
                ));
            }
        }
    }

    // Skills installed from a marketplace are always available, regardless of
    // auto-discovery, because the user opted in explicitly.
    for path in installed {
        if path.is_dir()
            && !candidates
                .iter()
                .any(|candidate| candidate.path == path.to_string_lossy())
        {
            candidates.push(skill_candidate(
                path.clone(),
                "Marketplace".to_string(),
                "marketplace",
                disabled,
                disabled_skills,
            ));
        }
    }

    for folder in folders {
        let path = PathBuf::from(folder);
        if path.is_dir() {
            let already = candidates
                .iter()
                .any(|candidate| candidate.path == path.to_string_lossy());
            if !already {
                candidates.push(skill_candidate(
                    path,
                    "Custom folder".to_string(),
                    "custom",
                    disabled,
                    disabled_skills,
                ));
            }
        }
    }

    candidates
}

fn skill_candidate(
    path: PathBuf,
    label: String,
    source: &str,
    disabled: &[String],
    disabled_skills: &[SkillRef],
) -> SkillCandidate {
    let path_string = path.to_string_lossy().to_string();
    let enabled = !disabled.iter().any(|entry| entry == &path_string);
    let skills = skill_names(&path)
        .into_iter()
        .map(|name| SkillState {
            enabled: enabled && !is_skill_disabled(disabled_skills, &path_string, &name),
            name,
        })
        .collect();
    SkillCandidate {
        enabled,
        skills,
        path: path_string,
        label,
        source: source.to_string(),
    }
}

/// True when the user switched this exact skill off. Both the root directory path
/// and the skill name must match, because names repeat across roots.
fn is_skill_disabled(disabled: &[SkillRef], path: &str, name: &str) -> bool {
    disabled
        .iter()
        .any(|entry| entry.path == path && entry.name == name)
}

fn skill_names(directory: &Path) -> Vec<String> {
    let mut names = Vec::new();
    if directory.join("SKILL.md").is_file() {
        if let Some(name) = directory.file_name() {
            names.push(name.to_string_lossy().to_string());
        }
    }
    if let Ok(entries) = std::fs::read_dir(directory) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if path.join("SKILL.md").is_file() {
                if let Some(name) = path.file_name() {
                    names.push(name.to_string_lossy().to_string());
                }
            }
        }
    }
    names.sort();
    names.dedup();
    names
}

/// Finds every enabled MCP config file and parses concrete server definitions
/// (command line or URL) so the MCP client can connect to them.
pub fn discover_mcp_servers(
    folders: &[String],
    disabled: &[String],
    disabled_servers: &[McpServerRef],
    auto: bool,
) -> Vec<McpServerConfig> {
    let mut paths: Vec<PathBuf> = Vec::new();
    if auto {
        for (path, _) in standard_mcp_paths() {
            if path.is_file() {
                paths.push(path);
            }
        }
    }
    for folder in folders {
        for path in scan_for_mcp_files(Path::new(folder)) {
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    let mut configs: Vec<McpServerConfig> = Vec::new();
    for path in paths {
        let key = path.to_string_lossy().to_string();
        if disabled.iter().any(|entry| entry == &key) {
            continue;
        }
        configs.extend(parse_server_configs(&path));
    }
    configs.retain(|config| !is_server_disabled(disabled_servers, &config.source, &config.name));
    configs
}

fn parse_server_configs(path: &Path) -> Vec<McpServerConfig> {
    let source = path.to_string_lossy().to_string();
    if source.ends_with(".toml") {
        let Ok(raw) = std::fs::read_to_string(path) else {
            return Vec::new();
        };
        let Ok(value) = toml::from_str::<toml::Value>(&raw) else {
            return Vec::new();
        };
        let mut configs = Vec::new();
        for key in ["mcp_servers", "mcpServers", "mcp", "servers"] {
            if let Some(table) = value.get(key).and_then(toml::Value::as_table) {
                for (name, entry) in table {
                    configs.push(toml_config(name, entry, &source));
                }
            }
        }
        return configs;
    }
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let mut configs = Vec::new();
    for key in ["mcpServers", "mcp_servers", "mcp", "servers"] {
        if let Some(object) = value.get(key).and_then(Value::as_object) {
            for (name, entry) in object {
                if let Some(config) = json_config(name, entry, &source) {
                    configs.push(config);
                }
            }
        }
    }
    configs
}

fn json_config(name: &str, entry: &Value, source: &str) -> Option<McpServerConfig> {
    let object = entry.as_object()?;
    let mut command = object
        .get("command")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut args: Vec<String> = object
        .get("args")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    // opencode uses `"command": ["npx", "-y", "..."]`.
    if command.is_none() {
        if let Some(parts) = object.get("command").and_then(Value::as_array) {
            let mut parts = parts.iter().filter_map(Value::as_str);
            command = parts.next().map(str::to_string);
            args = parts.map(str::to_string).collect();
        }
    }
    let config = McpServerConfig {
        name: name.to_string(),
        command,
        args,
        env: json_env(object),
        url: object
            .get("url")
            .or_else(|| object.get("serverUrl"))
            .or_else(|| object.get("httpUrl"))
            .and_then(Value::as_str)
            .map(str::to_string),
        source: source.to_string(),
    };
    if config.command.is_none() && config.url.is_none() {
        return None;
    }
    Some(config)
}

fn json_env(object: &serde_json::Map<String, Value>) -> Vec<(String, String)> {
    for key in ["env", "environment"] {
        if let Some(env) = object.get(key).and_then(Value::as_object) {
            return env
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect();
        }
    }
    Vec::new()
}

fn toml_config(name: &str, entry: &toml::Value, source: &str) -> McpServerConfig {
    let mut command = entry
        .get("command")
        .and_then(toml::Value::as_str)
        .map(str::to_string);
    let mut args: Vec<String> = entry
        .get("args")
        .and_then(toml::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(toml::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if command.is_none() {
        if let Some(parts) = entry.get("command").and_then(toml::Value::as_array) {
            let mut parts = parts.iter().filter_map(toml::Value::as_str);
            command = parts.next().map(str::to_string);
            args = parts.map(str::to_string).collect();
        }
    }
    let env = entry
        .get("env")
        .or_else(|| entry.get("environment"))
        .and_then(toml::Value::as_table)
        .map(|table| {
            table
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    McpServerConfig {
        name: name.to_string(),
        command,
        args,
        env,
        url: entry
            .get("url")
            .or_else(|| entry.get("serverUrl"))
            .and_then(toml::Value::as_str)
            .map(str::to_string),
        source: source.to_string(),
    }
}

/// Locates the directory that holds the `SKILL.md` for a named skill, across
/// the standard locations and the user's custom folders.
pub fn find_skill_dir(
    name: &str,
    folders: &[String],
    disabled: &[String],
    disabled_skills: &[SkillRef],
    auto: bool,
    installed: &[PathBuf],
) -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if auto {
        for (path, _) in standard_skill_dirs() {
            if path.is_dir() {
                roots.push(path);
            }
        }
    }
    for path in installed {
        if path.is_dir() {
            roots.push(path.clone());
        }
    }
    for folder in folders {
        let path = PathBuf::from(folder);
        if path.is_dir() {
            roots.push(path);
        }
    }
    for root in roots {
        let root_string = root.to_string_lossy();
        if disabled.iter().any(|entry| entry == &*root_string) {
            continue;
        }
        // A skill switched off on its own is skipped here, so a same-named skill
        // in another enabled root can still resolve.
        if is_skill_disabled(disabled_skills, &root_string, name) {
            continue;
        }
        // The root itself may be the skill directory.
        if root.file_name().map(|value| value == name).unwrap_or(false)
            && root.join("SKILL.md").is_file()
        {
            return Some(root);
        }
        let candidate = root.join(name);
        if candidate.join("SKILL.md").is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_json_mcp_servers() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("mcp.json");
        std::fs::write(
            &file,
            r#"{"mcpServers":{"filesystem":{"command":"npx"},"github":{"command":"npx"}}}"#,
        )
        .unwrap();
        assert_eq!(json_server_names(&file), vec!["filesystem", "github"]);
    }

    #[test]
    fn parses_toml_mcp_servers() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("config.toml");
        std::fs::write(&file, "[mcp_servers.filesystem]\ncommand = \"npx\"\n").unwrap();
        assert_eq!(toml_server_names(&file), vec!["filesystem"]);
    }

    #[test]
    fn finds_skills_in_subdirectories() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("code-review")).unwrap();
        std::fs::write(temp.path().join("code-review/SKILL.md"), "# Review").unwrap();
        std::fs::create_dir_all(temp.path().join("not-a-skill")).unwrap();
        assert_eq!(skill_names(temp.path()), vec!["code-review"]);
    }

    #[test]
    fn disabled_sources_are_marked() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("mcp.json");
        std::fs::write(&file, r#"{"mcpServers":{}}"#).unwrap();
        let disabled = vec![file.to_string_lossy().to_string()];
        let candidates = discover_mcp(
            &[temp.path().to_string_lossy().to_string()],
            &disabled,
            &[],
            false,
        );
        assert!(candidates.iter().any(|candidate| !candidate.enabled));
    }

    #[test]
    fn individual_servers_can_be_disabled() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("mcp.json");
        std::fs::write(
            &file,
            r#"{"mcpServers":{"filesystem":{"command":"npx"},"github":{"command":"npx"}}}"#,
        )
        .unwrap();
        let path = file.to_string_lossy().to_string();
        let disabled_servers = vec![McpServerRef {
            path: path.clone(),
            name: "github".to_string(),
        }];

        let candidates = discover_mcp(
            &[temp.path().to_string_lossy().to_string()],
            &[],
            &disabled_servers,
            false,
        );
        let candidate = candidates.iter().find(|c| c.path == path).unwrap();
        assert!(candidate.enabled);
        let states: Vec<(String, bool)> = candidate
            .servers
            .iter()
            .map(|s| (s.name.clone(), s.enabled))
            .collect();
        assert_eq!(
            states,
            vec![
                ("filesystem".to_string(), true),
                ("github".to_string(), false)
            ]
        );

        let configs = discover_mcp_servers(
            &[temp.path().to_string_lossy().to_string()],
            &[],
            &disabled_servers,
            false,
        );
        let names: Vec<String> = configs.iter().map(|c| c.name.clone()).collect();
        assert_eq!(names, vec!["filesystem"]);
    }

    #[test]
    fn disabling_a_file_overrides_its_servers() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("mcp.json");
        std::fs::write(&file, r#"{"mcpServers":{"filesystem":{"command":"npx"}}}"#).unwrap();
        let path = file.to_string_lossy().to_string();
        let disabled = vec![path.clone()];
        let candidates = discover_mcp(
            &[temp.path().to_string_lossy().to_string()],
            &disabled,
            &[],
            false,
        );
        let candidate = candidates.iter().find(|c| c.path == path).unwrap();
        assert!(!candidate.enabled);
        assert!(candidate.servers.iter().all(|server| !server.enabled));
    }

    #[test]
    fn individual_skills_can_be_disabled() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        std::fs::create_dir_all(root.join("code-review")).unwrap();
        std::fs::write(root.join("code-review/SKILL.md"), "# Review").unwrap();
        std::fs::create_dir_all(root.join("commit-message")).unwrap();
        std::fs::write(root.join("commit-message/SKILL.md"), "# Commit").unwrap();
        let root_string = root.to_string_lossy().to_string();
        let folders = vec![root_string.clone()];
        let disabled = vec![SkillRef {
            path: root_string.clone(),
            name: "code-review".to_string(),
        }];

        let candidates = discover_skills(&folders, &[], &disabled, false, &[]);
        let candidate = candidates.iter().find(|c| c.path == root_string).unwrap();
        assert!(candidate.enabled);
        let states: Vec<(String, bool)> = candidate
            .skills
            .iter()
            .map(|skill| (skill.name.clone(), skill.enabled))
            .collect();
        assert_eq!(
            states,
            vec![
                ("code-review".to_string(), false),
                ("commit-message".to_string(), true)
            ]
        );

        // Runtime resolution refuses the disabled skill but keeps its sibling.
        assert!(find_skill_dir("code-review", &folders, &[], &disabled, false, &[]).is_none());
        assert_eq!(
            find_skill_dir("commit-message", &folders, &[], &disabled, false, &[]),
            Some(root.join("commit-message"))
        );
    }

    #[test]
    fn disabling_a_skill_root_overrides_its_skills() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        std::fs::create_dir_all(root.join("code-review")).unwrap();
        std::fs::write(root.join("code-review/SKILL.md"), "# Review").unwrap();
        let root_string = root.to_string_lossy().to_string();
        let folders = vec![root_string.clone()];
        let disabled = vec![root_string.clone()];

        let candidates = discover_skills(&folders, &disabled, &[], false, &[]);
        let candidate = candidates.iter().find(|c| c.path == root_string).unwrap();
        assert!(!candidate.enabled);
        assert!(candidate.skills.iter().all(|skill| !skill.enabled));
    }
}
