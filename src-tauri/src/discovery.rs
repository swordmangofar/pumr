use crate::models::{McpCandidate, SkillCandidate};
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

pub fn discover_mcp(folders: &[String], disabled: &[String], auto: bool) -> Vec<McpCandidate> {
    let mut candidates: Vec<McpCandidate> = Vec::new();

    if auto {
        for (path, label) in standard_mcp_paths() {
            if path.is_file() {
                candidates.push(mcp_candidate(path, label.to_string(), "auto", disabled));
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

fn mcp_candidate(path: PathBuf, label: String, source: &str, disabled: &[String]) -> McpCandidate {
    let path_string = path.to_string_lossy().to_string();
    let (format, servers) = if path_string.ends_with(".toml") {
        ("toml", toml_server_names(&path))
    } else {
        ("json", json_server_names(&path))
    };
    McpCandidate {
        enabled: !disabled.iter().any(|entry| entry == &path_string),
        path: path_string,
        label,
        source: source.to_string(),
        format: format.to_string(),
        servers,
    }
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

pub fn discover_skills(folders: &[String], disabled: &[String], auto: bool) -> Vec<SkillCandidate> {
    let mut candidates: Vec<SkillCandidate> = Vec::new();

    if auto {
        for (path, label) in standard_skill_dirs() {
            if path.is_dir() {
                candidates.push(skill_candidate(path, label.to_string(), "auto", disabled));
            }
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
) -> SkillCandidate {
    let path_string = path.to_string_lossy().to_string();
    SkillCandidate {
        enabled: !disabled.iter().any(|entry| entry == &path_string),
        skills: skill_names(&path),
        path: path_string,
        label,
        source: source.to_string(),
    }
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
            false,
        );
        assert!(candidates.iter().any(|candidate| !candidate.enabled));
    }
}
