use crate::mcp::McpServerConfig;
use crate::models::{
    McpCandidate, McpServerRef, McpServerState, SkillCandidate, SkillEntry, SkillRef, SkillState,
};
use serde_json::Value;
use std::path::{Path, PathBuf};

const MCP_FILE_NAMES: &[&str] = &[
    "mcp.json",
    ".mcp.json",
    "mcp_config.json",
    "claude_desktop_config.json",
    "opencode.json",
    "opencode.jsonc",
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
        (home.join(".config/opencode/opencode.jsonc"), "opencode"),
        (home.join(".opencode/opencode.json"), "opencode"),
        (home.join(".opencode/opencode.jsonc"), "opencode"),
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
    let mut directories = vec![
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
    ];
    for config in [
        ".config/opencode/opencode.json",
        ".config/opencode/opencode.jsonc",
        ".opencode/opencode.json",
        ".opencode/opencode.jsonc",
    ] {
        for skills in opencode_plugin_skill_dirs(&home.join(config), &home) {
            if !directories.iter().any(|(known, _)| *known == skills) {
                directories.push((skills, "opencode plugin"));
            }
        }
    }
    directories
}

/// The `skills` folders of the plugins an opencode config loads from a local
/// path. Such a plugin registers its skills with opencode in code, which pumr
/// does not run; a skill collection keeps them in a `skills` folder at its
/// root, the plugin being that root or `<root>/.opencode/plugins/<name>.js`.
/// Plugins named as a package or a URL are not on this machine to look into.
fn opencode_plugin_skill_dirs(config: &Path, home: &Path) -> Vec<PathBuf> {
    let Some(plugins) =
        read_json(config).and_then(|value| value.get("plugin").and_then(Value::as_array).cloned())
    else {
        return Vec::new();
    };
    let mut directories: Vec<PathBuf> = Vec::new();
    for entry in plugins.iter().filter_map(Value::as_str) {
        let entry = entry.trim();
        let entry = entry.strip_prefix("file://").unwrap_or(entry);
        let path = match entry.strip_prefix("~/") {
            Some(below_home) => home.join(below_home),
            None => PathBuf::from(entry),
        };
        if !path.is_absolute() {
            continue;
        }
        let mut roots: Vec<&Path> = Vec::new();
        if path.is_dir() {
            roots.push(&path);
        } else if let Some(folder) = path.parent() {
            roots.push(folder);
            let named = |path: &Path, names: &[&str]| {
                path.file_name()
                    .is_some_and(|name| names.iter().any(|expected| name == *expected))
            };
            if let Some(dot_opencode) = folder.parent() {
                if named(folder, &["plugins", "plugin"]) && named(dot_opencode, &[".opencode"]) {
                    roots.extend(dot_opencode.parent());
                }
            }
        }
        if let Some(skills) = roots
            .into_iter()
            .map(|root| root.join("skills"))
            .find(|skills| skills.is_dir())
        {
            if !directories.contains(&skills) {
                directories.push(skills);
            }
        }
    }
    directories
}

pub fn discover_mcp(
    folders: &[String],
    disabled: &[String],
    disabled_servers: &[McpServerRef],
    auto: bool,
    installed: &[PathBuf],
) -> Vec<McpCandidate> {
    let mut candidates: Vec<McpCandidate> = Vec::new();

    // Servers the user installed through pumr are always available, regardless
    // of auto-discovery, because the user opted in explicitly.
    for path in installed {
        if path.is_file() {
            candidates.push(mcp_candidate(
                path.clone(),
                "pumr".to_string(),
                "installed",
                disabled,
                disabled_servers,
            ));
        }
    }

    if auto {
        for (path, label) in standard_mcp_paths() {
            let already = candidates
                .iter()
                .any(|candidate| candidate.path == path.to_string_lossy());
            if path.is_file() && !already {
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
    let configs = parse_server_configs(&path);
    let servers = names
        .into_iter()
        .map(|name| McpServerState {
            enabled: enabled && !is_server_disabled(disabled_servers, &path_string, &name),
            detail: configs
                .iter()
                .find(|config| config.name == name)
                .and_then(server_detail),
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

/// A short, human-readable summary of how a server is reached: its URL, or its
/// command line without environment values (which may hold secrets).
fn server_detail(config: &McpServerConfig) -> Option<String> {
    if let Some(url) = &config.url {
        return Some(url.clone());
    }
    let command = config.command.as_ref()?;
    let mut parts = vec![command.clone()];
    parts.extend(config.args.iter().cloned());
    Some(parts.join(" "))
}

/// True when the user switched this exact server off. Both the config file path
/// and the in-file name must match, because names repeat across files.
fn is_server_disabled(disabled: &[McpServerRef], path: &str, name: &str) -> bool {
    disabled
        .iter()
        .any(|entry| entry.path == path && entry.name == name)
}

/// Reads a JSON config file. Several tools write theirs as JSONC (opencode,
/// VS Code), with comments and trailing commas that strict JSON refuses.
fn read_json(path: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw)
        .or_else(|_| serde_json::from_str(&strip_jsonc(&raw)))
        .ok()
}

/// Turns JSONC into JSON: drops `//` and `/* */` comments, the comma before a
/// closing bracket and a byte order mark. Strings stay as they are.
fn strip_jsonc(raw: &str) -> String {
    let mut json = String::with_capacity(raw.len());
    let mut chars = raw.trim_start_matches('\u{feff}').chars().peekable();
    let mut in_string = false;
    while let Some(character) = chars.next() {
        if in_string {
            json.push(character);
            match character {
                '\\' => json.extend(chars.next()),
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match character {
            '"' => {
                in_string = true;
                json.push(character);
            }
            '/' if chars.peek() == Some(&'/') => {
                // The end of the line stays.
                while chars.next_if(|next| *next != '\n').is_some() {}
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut previous = ' ';
                for next in chars.by_ref() {
                    if previous == '*' && next == '/' {
                        break;
                    }
                    previous = next;
                }
            }
            '}' | ']' => {
                // Comments are gone by now, so only blanks can lie between a
                // trailing comma and its bracket.
                let end = json.trim_end().len();
                if json[..end].ends_with(',') {
                    json.remove(end - 1);
                }
                json.push(character);
            }
            _ => json.push(character),
        }
    }
    json
}

/// The server definitions of a JSON config file with their names, under every
/// key the tools keep them. opencode has used both `mcp.<name>` and
/// `mcp.servers.<name>`. Servers the file itself switches off are left out.
fn json_servers(value: &Value) -> Vec<(&String, &Value)> {
    let mut servers = Vec::new();
    for key in ["mcpServers", "mcp_servers", "mcp", "servers"] {
        let Some(object) = value.get(key).and_then(Value::as_object) else {
            continue;
        };
        for (name, entry) in object {
            // `mcp.servers` holds the servers, unless it is one itself.
            let holds_servers = key == "mcp"
                && name == "servers"
                && !["command", "url", "serverUrl", "httpUrl"]
                    .iter()
                    .any(|field| entry.get(field).is_some());
            match entry.as_object().filter(|_| holds_servers) {
                Some(nested) => servers.extend(nested),
                None => servers.push((name, entry)),
            }
        }
    }
    servers.retain(|(_, entry)| {
        !switched_off(
            entry.get("enabled").and_then(Value::as_bool),
            entry.get("disabled").and_then(Value::as_bool),
        )
    });
    servers
}

/// True when a config file switches one of its own servers off, with
/// `enabled: false` (opencode, Codex) or `disabled: true` (opencode, Cline).
/// Such a server is not offered, like in the tool the file belongs to.
fn switched_off(enabled: Option<bool>, disabled: Option<bool>) -> bool {
    enabled == Some(false) || disabled == Some(true)
}

fn toml_switched_off(entry: &toml::Value) -> bool {
    switched_off(
        entry.get("enabled").and_then(toml::Value::as_bool),
        entry.get("disabled").and_then(toml::Value::as_bool),
    )
}

fn json_server_names(path: &Path) -> Vec<String> {
    let Some(value) = read_json(path) else {
        return Vec::new();
    };
    let mut names: Vec<String> = json_servers(&value)
        .into_iter()
        .map(|(name, _)| name.clone())
        .collect();
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
            names.extend(
                table
                    .iter()
                    .filter(|(_, entry)| !toml_switched_off(entry))
                    .map(|(name, _)| name.clone()),
            );
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

/// Flattens discovered skills into a catalogue of enabled entries with their
/// description, so the agent can be told what it may load on demand.
pub fn skill_catalog(
    folders: &[String],
    disabled: &[String],
    disabled_skills: &[SkillRef],
    auto: bool,
    installed: &[PathBuf],
) -> Vec<SkillEntry> {
    let mut entries: Vec<SkillEntry> = Vec::new();
    for candidate in discover_skills(folders, disabled, disabled_skills, auto, installed) {
        if !candidate.enabled {
            continue;
        }
        let directories = skill_dirs(Path::new(&candidate.path));
        for skill in candidate.skills {
            if !skill.enabled {
                continue;
            }
            let Some((_, directory)) = directories.iter().find(|(name, _)| *name == skill.name)
            else {
                continue;
            };
            let description = read_skill_description(&directory.join("SKILL.md"));
            entries.push(SkillEntry {
                name: skill.name,
                description,
                path: directory.to_string_lossy().to_string(),
            });
        }
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries.dedup_by(|a, b| a.name == b.name);
    entries
}

/// Reads a skill's one-line description from its YAML frontmatter, falling back
/// to the first non-empty line.
fn read_skill_description(file: &Path) -> String {
    let Ok(content) = std::fs::read_to_string(file) else {
        return String::new();
    };
    let content = without_bom(&content);
    let mut body = content;
    if let Some(rest) = content.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let lines: Vec<&str> = rest[..end].lines().collect();
            for (index, line) in lines.iter().enumerate() {
                if let Some(value) = line.strip_prefix("description:") {
                    return frontmatter_value(value, 0, &lines[index + 1..]);
                }
            }
            body = rest[end + 4..].trim_start_matches('-');
        }
    }
    body.lines()
        .map(|line| line.trim().trim_start_matches('#').trim())
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

/// A file's text without the byte order mark some editors put in front of it,
/// which would hide the `---` that opens the frontmatter.
pub(crate) fn without_bom(content: &str) -> &str {
    content.strip_prefix('\u{feff}').unwrap_or(content)
}

/// The value of a frontmatter key as one line: `value` is what follows the
/// colon, `following` the lines after it, and `indent` how far the key itself
/// is indented. A YAML block scalar (`description: >-` or `description: |`)
/// has its text on the deeper indented lines below. Those are joined with
/// spaces, the literal kind too, because a description is listed, and told to
/// the agent, as a single line.
pub(crate) fn frontmatter_value(value: &str, indent: usize, following: &[&str]) -> String {
    let value = value.trim();
    if !opens_block_scalar(value) {
        return value.trim_matches('"').trim_matches('\'').to_string();
    }
    let mut text: Vec<&str> = Vec::new();
    for line in following {
        let content = line.trim();
        // An empty line belongs to the block; the next key ends it.
        if content.is_empty() {
            continue;
        }
        if line.len() - line.trim_start().len() <= indent {
            break;
        }
        text.push(content);
    }
    text.join(" ")
}

/// Whether a YAML value opens a block scalar: `|` or `>`, which may be
/// followed by a chomping sign and an indentation digit, and by a comment.
fn opens_block_scalar(value: &str) -> bool {
    let Some(rest) = value.strip_prefix(['|', '>']) else {
        return false;
    };
    let rest = rest.trim_start_matches(|character| matches!(character, '+' | '-' | '1'..='9'));
    rest.is_empty() || (rest.starts_with([' ', '\t']) && rest.trim_start().starts_with('#'))
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
    let skills = skill_dirs(&path)
        .into_iter()
        .map(|(name, directory)| {
            let description = read_skill_description(&directory.join("SKILL.md"));
            SkillState {
                enabled: enabled && !is_skill_disabled(disabled_skills, &path_string, &name),
                description: (!description.is_empty()).then_some(description),
                name,
            }
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

/// How far below a skills folder a skill may sit. Collections keep theirs in
/// a folder of their own (`skills/elevation4/brainstorming/SKILL.md`).
const MAX_SKILL_DEPTH: usize = 3;

/// How many folders one skills folder is searched through, so a folder that
/// is no skill collection (a whole home directory) cannot hold up a turn.
const MAX_SKILL_FOLDERS: usize = 2_000;

/// The skills of a skills folder by name, each with the directory that holds
/// its `SKILL.md`: the folder itself, its subfolders, and the subfolders of
/// those that only group skills. What lies inside a skill belongs to it and
/// is not searched for more skills. Sorted by name; of two skills with one
/// name the one nearer the folder is kept.
fn skill_dirs(directory: &Path) -> Vec<(String, PathBuf)> {
    let named = |path: &Path| {
        path.file_name()
            .map(|name| name.to_string_lossy().to_string())
    };
    let mut skills: Vec<(String, PathBuf)> = Vec::new();
    if directory.join("SKILL.md").is_file() {
        if let Some(name) = named(directory) {
            skills.push((name, directory.to_path_buf()));
        }
    }
    let mut level: Vec<PathBuf> = vec![directory.to_path_buf()];
    let mut searched = 0;
    for depth in 1..=MAX_SKILL_DEPTH {
        let mut next: Vec<PathBuf> = Vec::new();
        for folder in level {
            let Ok(entries) = std::fs::read_dir(&folder) else {
                continue;
            };
            let mut children: Vec<PathBuf> = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect();
            children.sort();
            for child in children {
                searched += 1;
                if searched > MAX_SKILL_FOLDERS {
                    break;
                }
                let Some(name) = named(&child) else {
                    continue;
                };
                if child.join("SKILL.md").is_file() {
                    skills.push((name, child));
                } else if depth < MAX_SKILL_DEPTH
                    && !name.starts_with('.')
                    && name != "node_modules"
                {
                    next.push(child);
                }
            }
        }
        level = next;
    }
    // Stable, so the skill found first, nearest the folder, comes first.
    skills.sort_by(|a, b| a.0.cmp(&b.0));
    skills.dedup_by(|later, first| later.0 == first.0);
    skills
}

/// How many of a skill's other files are named when it is loaded.
const MAX_SKILL_FILES: usize = 40;

/// What the agent is given when it loads a skill: the instructions of its
/// `SKILL.md`, and which other files the skill's folder holds. Those are not
/// loaded with it, as the instructions say when each one is needed; reading
/// them asks for no permission (see `tools::ensure_path_access`). `None` for a
/// skill without readable instructions.
pub fn skill_instructions(name: &str, directory: &Path) -> Option<String> {
    let content = std::fs::read_to_string(directory.join("SKILL.md")).ok()?;
    let body = skill_body(&content).trim();
    if body.is_empty() {
        return None;
    }
    let mut text = format!(
        "<skill name=\"{name}\" path=\"{}\">\n{body}\n</skill>\n",
        directory.display()
    );
    let mut files = skill_files(directory);
    if !files.is_empty() {
        let more = files.len().saturating_sub(MAX_SKILL_FILES);
        files.truncate(MAX_SKILL_FILES);
        text.push_str(&format!(
            "\nThe skill's folder holds more files, which are not loaded yet. Read one with the read tool when the instructions refer to it; paths are relative to {}:\n",
            directory.display()
        ));
        for file in files {
            text.push_str(&format!("- {file}\n"));
        }
        if more > 0 {
            text.push_str(&format!("- … and {more} more\n"));
        }
    }
    text.push_str(
        "\nFollow the skill instructions above when they apply to the user's request.",
    );
    Some(text)
}

/// A `SKILL.md` without its frontmatter: the name and description in it are
/// what the agent chose the skill by.
fn skill_body(content: &str) -> &str {
    let content = without_bom(content);
    let Some(rest) = content.strip_prefix("---") else {
        return content;
    };
    let Some(end) = rest.find("\n---") else {
        return content;
    };
    let closing = &rest[end + 4..];
    closing.find('\n').map_or("", |line_end| &closing[line_end + 1..])
}

/// The files of a skill next to its `SKILL.md`, relative to its folder.
fn skill_files(directory: &Path) -> Vec<String> {
    fn collect(folder: &Path, prefix: &str, depth: usize, files: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(folder) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let relative = format!("{prefix}{name}");
            if path.is_dir() {
                if depth < MAX_SKILL_DEPTH {
                    collect(&path, &format!("{relative}/"), depth + 1, files);
                }
            } else if relative != "SKILL.md" {
                files.push(relative);
            }
        }
    }
    let mut files = Vec::new();
    collect(directory, "", 1, &mut files);
    files.sort();
    files
}

/// Finds every enabled MCP config file and parses concrete server definitions
/// (command line or URL) so the MCP client can connect to them.
pub fn discover_mcp_servers(
    folders: &[String],
    disabled: &[String],
    disabled_servers: &[McpServerRef],
    auto: bool,
    installed: &[PathBuf],
) -> Vec<McpServerConfig> {
    let mut paths: Vec<PathBuf> = installed
        .iter()
        .filter(|path| path.is_file())
        .cloned()
        .collect();
    if auto {
        for (path, _) in standard_mcp_paths() {
            if path.is_file() && !paths.contains(&path) {
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
                    if !toml_switched_off(entry) {
                        configs.push(toml_config(name, entry, &source));
                    }
                }
            }
        }
        return configs;
    }
    let Some(value) = read_json(path) else {
        return Vec::new();
    };
    json_servers(&value)
        .into_iter()
        .filter_map(|(name, entry)| json_config(name, entry, &source))
        .collect()
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
        // The root itself may be the skill, or hold it one or two folders down.
        if let Some((_, directory)) = skill_dirs(&root)
            .into_iter()
            .find(|(found, _)| found == name)
        {
            return Some(directory);
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

    /// What the codegraph installer writes for opencode: the shape of its
    /// current version, and the one before.
    const OPENCODE_NESTED: &str = r#"{"mcp":{"servers":{"codegraph":{"type":"local","command":["codegraph","serve","--mcp"],"disabled":false,"codemode":false}}}}"#;
    const OPENCODE_FLAT: &str = r#"{"mcp":{"codegraph":{"type":"local","command":["codegraph","serve","--mcp"],"enabled":true}}}"#;

    /// The servers the picker lists for the one config file in `folder`, with
    /// their detail, and the ones that can be started.
    fn offered(folder: &Path) -> (Vec<(String, Option<String>)>, Vec<McpServerConfig>) {
        let folders = [folder.to_string_lossy().to_string()];
        let candidates = discover_mcp(&folders, &[], &[], false, &[]);
        assert_eq!(candidates.len(), 1, "{candidates:?}");
        let listed = candidates[0]
            .servers
            .iter()
            .map(|server| (server.name.clone(), server.detail.clone()))
            .collect();
        (listed, discover_mcp_servers(&folders, &[], &[], false, &[]))
    }

    #[test]
    fn reads_opencode_servers_in_both_shapes_and_both_files() {
        for file_name in ["opencode.json", "opencode.jsonc"] {
            for content in [OPENCODE_NESTED, OPENCODE_FLAT] {
                let temp = tempfile::tempdir().unwrap();
                std::fs::write(temp.path().join(file_name), content).unwrap();
                let (listed, startable) = offered(temp.path());
                assert_eq!(
                    listed,
                    [(
                        "codegraph".to_string(),
                        Some("codegraph serve --mcp".to_string())
                    )],
                    "{file_name}: {content}"
                );
                assert_eq!(startable.len(), 1);
                assert_eq!(startable[0].name, "codegraph");
                assert_eq!(startable[0].command.as_deref(), Some("codegraph"));
                assert_eq!(startable[0].args, ["serve", "--mcp"]);
            }
        }
        assert!(standard_mcp_paths().iter().any(|(path, label)| {
            path.ends_with(".config/opencode/opencode.jsonc") && *label == "opencode"
        }));
    }

    #[test]
    fn reads_config_files_with_comments_and_trailing_commas() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("opencode.json"),
            r#"// Written by an installer.
{
  "$schema": "https://opencode.ai/config.json", // a URL is no comment
  /* The servers
     of this machine. */
  "mcp": {
    "servers": {
      "codegraph": {
        "type": "local",
        "command": ["codegraph", "serve", "--mcp",],
        "environment": { "NOTE": "a // b /* c */ , }" },
      },
    },
  },
}
"#,
        )
        .unwrap();
        let (listed, startable) = offered(temp.path());
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].0, "codegraph");
        assert_eq!(startable[0].args, ["serve", "--mcp"]);
        assert_eq!(
            startable[0].env,
            [("NOTE".to_string(), "a // b /* c */ , }".to_string())]
        );

        let lenient = strip_jsonc("\u{feff}{\"a\":\"x\\\"//y\",\"b\":[1,2 , ] /* c */ , }");
        assert_eq!(
            serde_json::from_str::<Value>(&lenient).unwrap(),
            serde_json::json!({ "a": "x\"//y", "b": [1, 2] })
        );
    }

    #[test]
    fn servers_switched_off_in_their_own_file_are_not_offered() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("opencode.json"),
            r#"{"mcp":{
                "servers":{"off":{"command":["a"],"disabled":true},"on":{"command":["b"],"disabled":false}},
                "old-off":{"command":["c"],"enabled":false},
                "old-on":{"command":["d"],"enabled":true}
            }}"#,
        )
        .unwrap();
        let (listed, startable) = offered(temp.path());
        let listed: Vec<&str> = listed.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(listed, ["old-on", "on"]);
        let mut startable: Vec<String> = startable.into_iter().map(|config| config.name).collect();
        startable.sort();
        assert_eq!(startable, ["old-on", "on"]);

        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("config.toml"),
            "[mcp_servers.off]\ncommand = \"a\"\nenabled = false\n\n[mcp_servers.on]\ncommand = \"b\"\n",
        )
        .unwrap();
        let (listed, startable) = offered(temp.path());
        assert_eq!(listed, [("on".to_string(), Some("b".to_string()))]);
        assert_eq!(startable.len(), 1);
    }

    #[test]
    fn an_opencode_server_named_servers_stays_a_server() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("opencode.json"),
            r#"{"mcp":{"servers":{"type":"local","command":["x","--stdio"]}}}"#,
        )
        .unwrap();
        let (listed, startable) = offered(temp.path());
        assert_eq!(
            listed,
            [("servers".to_string(), Some("x --stdio".to_string()))]
        );
        assert_eq!(startable.len(), 1);
    }

    #[test]
    fn finds_skills_in_subdirectories() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("code-review")).unwrap();
        std::fs::write(temp.path().join("code-review/SKILL.md"), "# Review").unwrap();
        std::fs::create_dir_all(temp.path().join("not-a-skill")).unwrap();
        assert_eq!(
            skill_dirs(temp.path()),
            vec![("code-review".to_string(), temp.path().join("code-review"))]
        );
    }

    /// A skills folder laid out like a collection: skills of its own, and a
    /// group of skills one folder down.
    fn collection(root: &Path) {
        for skill in [
            "work-with-jira",
            "elevation4/brainstorming",
            "elevation4/systematic-debugging",
            // The same name twice: the one nearer the folder is the skill.
            "elevation4/work-with-jira",
            // Too deep to be looked for.
            "a/b/c/too-deep",
            // Folders nobody keeps skills in.
            "node_modules/pkg/vendored",
            ".cache/x/hidden",
        ] {
            std::fs::create_dir_all(root.join(skill)).unwrap();
            std::fs::write(
                root.join(skill).join("SKILL.md"),
                format!("---\nname: x\ndescription: \"About {skill}\"\n---\n# {skill}\n"),
            )
            .unwrap();
        }
        // What lies inside a skill is part of it, not another skill.
        let inner = root.join("elevation4/systematic-debugging/examples/inner");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(inner.join("SKILL.md"), "# Not a skill of its own").unwrap();
    }

    #[test]
    fn finds_the_skills_a_collection_groups_in_a_folder_of_their_own() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        collection(&root);
        let folders = vec![root.to_string_lossy().to_string()];

        let found: Vec<(String, PathBuf)> = skill_dirs(&root);
        assert_eq!(
            found,
            vec![
                (
                    "brainstorming".to_string(),
                    root.join("elevation4/brainstorming")
                ),
                (
                    "systematic-debugging".to_string(),
                    root.join("elevation4/systematic-debugging")
                ),
                ("work-with-jira".to_string(), root.join("work-with-jira")),
            ]
        );

        // The settings list, the catalogue the agent is told about and the
        // lookup of one skill all see the same three, each in its real folder.
        let candidates = discover_skills(&folders, &[], &[], false, &[]);
        let listed: Vec<(&str, Option<&str>)> = candidates[0]
            .skills
            .iter()
            .map(|skill| (skill.name.as_str(), skill.description.as_deref()))
            .collect();
        assert_eq!(
            listed,
            vec![
                ("brainstorming", Some("About elevation4/brainstorming")),
                (
                    "systematic-debugging",
                    Some("About elevation4/systematic-debugging")
                ),
                ("work-with-jira", Some("About work-with-jira")),
            ]
        );
        let catalog = skill_catalog(&folders, &[], &[], false, &[]);
        assert_eq!(
            catalog
                .iter()
                .map(|entry| (entry.name.as_str(), PathBuf::from(&entry.path)))
                .collect::<Vec<_>>(),
            found
                .iter()
                .map(|(name, directory)| (name.as_str(), directory.clone()))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            find_skill_dir("brainstorming", &folders, &[], &[], false, &[]),
            Some(root.join("elevation4/brainstorming"))
        );
        assert_eq!(
            find_skill_dir("too-deep", &folders, &[], &[], false, &[]),
            None
        );

        // A grouped skill is switched off like any other: by folder and name.
        let disabled = vec![SkillRef {
            path: folders[0].clone(),
            name: "brainstorming".to_string(),
        }];
        assert_eq!(
            find_skill_dir("brainstorming", &folders, &[], &disabled, false, &[]),
            None
        );
        assert_eq!(skill_catalog(&folders, &[], &disabled, false, &[]).len(), 2);
    }

    #[test]
    fn finds_the_skills_of_plugins_opencode_loads_from_a_local_path() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        // A collection whose plugin file sits in `.opencode/plugins`.
        let collection = home.join("git/ai-skills");
        std::fs::create_dir_all(collection.join(".opencode/plugins")).unwrap();
        std::fs::create_dir_all(collection.join("skills/work-with-jira")).unwrap();
        std::fs::write(collection.join(".opencode/plugins/elevation4.js"), "").unwrap();
        // One that is named by its folder, and one without any skills.
        let by_folder = temp.path().join("packs/review");
        std::fs::create_dir_all(by_folder.join("skills")).unwrap();
        let no_skills = temp.path().join("packs/theme");
        std::fs::create_dir_all(&no_skills).unwrap();
        std::fs::write(no_skills.join("index.js"), "").unwrap();
        // A `skills` folder further up is not the plugin's.
        std::fs::create_dir_all(temp.path().join("skills")).unwrap();

        let config = home.join(".config/opencode/opencode.jsonc");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(
            &config,
            format!(
                r#"{{
  // written by the collection's install script
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "~/git/ai-skills/.opencode/plugins/elevation4.js",
    "{by_folder}",
    "file://{by_folder}",
    "{no_skills}/index.js",
    "opencode-helicone-session",
    "elevation4@git+https://example.com/templates.git",
    "/does/not/exist/plugin.js",
  ],
}}"#,
                by_folder = by_folder.display(),
                no_skills = no_skills.display(),
            ),
        )
        .unwrap();

        assert_eq!(
            opencode_plugin_skill_dirs(&config, &home),
            vec![collection.join("skills"), by_folder.join("skills")]
        );
        // No config, or one without plugins.
        assert!(opencode_plugin_skill_dirs(&home.join("missing.json"), &home).is_empty());
        std::fs::write(&config, r#"{"plugin": "not a list"}"#).unwrap();
        assert!(opencode_plugin_skill_dirs(&config, &home).is_empty());
    }

    #[test]
    fn a_loaded_skill_is_its_instructions_and_a_list_of_its_other_files() {
        let temp = tempfile::tempdir().unwrap();
        let skill = temp.path().join("work-with-jira");
        std::fs::create_dir_all(skill.join("providers")).unwrap();
        std::fs::create_dir_all(skill.join(".git")).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: work-with-jira\ndescription: \"Jira\"\n---\n\n# Jira\n\nToken: $OC_CREDENTIALS/jira-credentials\n\n---\n\nSee [SI](./jira-project-si.md).\n",
        )
        .unwrap();
        std::fs::write(
            skill.join("jira-project-si.md"),
            "SI rules that are not loaded",
        )
        .unwrap();
        std::fs::write(skill.join("providers/ionos.md"), "").unwrap();
        std::fs::write(skill.join("find-polluter.sh"), "").unwrap();
        std::fs::write(skill.join(".git/HEAD"), "").unwrap();

        let directory = skill.display();
        assert_eq!(
            skill_instructions("work-with-jira", &skill).unwrap(),
            format!(
                "<skill name=\"work-with-jira\" path=\"{directory}\">\n\
                 # Jira\n\nToken: $OC_CREDENTIALS/jira-credentials\n\n---\n\nSee [SI](./jira-project-si.md).\n\
                 </skill>\n\n\
                 The skill's folder holds more files, which are not loaded yet. Read one with the read tool when the instructions refer to it; paths are relative to {directory}:\n\
                 - find-polluter.sh\n\
                 - jira-project-si.md\n\
                 - providers/ionos.md\n\n\
                 Follow the skill instructions above when they apply to the user's request."
            )
        );
    }

    #[test]
    fn a_skill_of_one_file_names_no_others_and_an_empty_one_is_not_loaded() {
        let temp = tempfile::tempdir().unwrap();
        let skill = temp.path().join("release");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "  Bump the version.  ").unwrap();
        assert_eq!(
            skill_instructions("release", &skill).unwrap(),
            format!(
                "<skill name=\"release\" path=\"{}\">\nBump the version.\n</skill>\n\nFollow the skill instructions above when they apply to the user's request.",
                skill.display()
            )
        );

        // Only frontmatter, or bytes that are not text.
        std::fs::write(skill.join("SKILL.md"), "---\nname: release\n---\n").unwrap();
        assert_eq!(skill_instructions("release", &skill), None);
        std::fs::write(skill.join("SKILL.md"), [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(skill_instructions("release", &skill), None);
        assert_eq!(
            skill_instructions("missing", &temp.path().join("missing")),
            None
        );
    }

    #[test]
    fn a_description_written_as_a_block_scalar_is_read_as_one_line() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("SKILL.md");
        let describe = |content: &str| {
            std::fs::write(&file, content).unwrap();
            read_skill_description(&file)
        };
        // Folded and literal, with the signs and the comment YAML allows.
        for header in [">-", ">", "|", "|+", ">2-", "|- # one line"] {
            for newline in ["\n", "\r\n"] {
                let content = format!(
                    "---\nname: pdf\ndescription: {header}\n  Fill in PDF forms.\n\n  Use it for: invoices\n    and receipts.\nlicense: MIT\n---\n# PDF\n"
                )
                .replace('\n', newline);
                assert_eq!(
                    describe(&content),
                    "Fill in PDF forms. Use it for: invoices and receipts.",
                    "{header:?} {newline:?}"
                );
            }
        }
        // A block without text is an empty description, not its sign.
        assert_eq!(describe("---\ndescription: >-\nname: pdf\n---\n# PDF\n"), "");

        // What opens no block stays as it was: quotes, colons, a leading sign.
        assert_eq!(
            describe("---\ndescription: \"Review: code\"\n  indented: no\n---\n"),
            "Review: code"
        );
        assert_eq!(describe("---\r\ndescription: 'Jira'\r\n---\r\n"), "Jira");
        assert_eq!(
            describe("---\ndescription: > 5 files at once\n---\n"),
            "> 5 files at once"
        );
        assert_eq!(describe("---\ndescription: |x\n  y\n---\n"), "|x");
    }

    #[test]
    fn a_byte_order_mark_does_not_hide_the_frontmatter() {
        let temp = tempfile::tempdir().unwrap();
        let skill = temp.path().join("release");
        std::fs::create_dir_all(&skill).unwrap();
        let file = skill.join("SKILL.md");
        std::fs::write(
            &file,
            "\u{feff}---\nname: release\ndescription: Cut a release\n---\n# Release\n\nBump the version.\n",
        )
        .unwrap();
        assert_eq!(read_skill_description(&file), "Cut a release");
        // The agent is given the instructions, not the frontmatter again.
        let loaded = skill_instructions("release", &skill).unwrap();
        let instructions = format!(
            "<skill name=\"release\" path=\"{}\">\n# Release\n\nBump the version.\n</skill>\n",
            skill.display()
        );
        assert!(loaded.starts_with(&instructions), "{loaded}");

        // Without frontmatter the mark is no part of the first line either.
        std::fs::write(&file, "\u{feff}# Release notes\n").unwrap();
        assert_eq!(read_skill_description(&file), "Release notes");
        assert_eq!(skill_body("\u{feff}Bump the version."), "Bump the version.");
    }

    #[test]
    fn a_long_list_of_skill_files_is_cut_with_a_count() {
        let temp = tempfile::tempdir().unwrap();
        let skill = temp.path().join("many");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "Many files.").unwrap();
        for index in 0..MAX_SKILL_FILES + 3 {
            std::fs::write(skill.join(format!("{index:03}.md")), "").unwrap();
        }
        let text = skill_instructions("many", &skill).unwrap();
        assert_eq!(text.matches("\n- ").count(), MAX_SKILL_FILES + 1);
        assert!(text.contains("\n- 039.md\n- … and 3 more\n"), "{text}");
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
            &[],
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
            &[],
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
            &[],
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
            &[],
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
