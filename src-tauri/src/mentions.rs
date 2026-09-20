//! Resolves `@` mentions from the composer into model context.
//!
//! Files and directories are inlined, websites are fetched (respecting the
//! user's allow/deny rules), skills contribute their `SKILL.md` instructions,
//! and MCP mentions return the names of the servers that must be connected.

use crate::config::Settings;
use crate::discovery;
use crate::models::Mention;
use crate::permissions;
use crate::tools::{self, ToolRuntime};
use ignore::WalkBuilder;
use serde_json::json;
use std::path::{Path, PathBuf};

const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_DIR_ENTRIES: usize = 600;
const MAX_DIR_DEPTH: usize = 3;
const MAX_SKILL_FILES: usize = 20;

pub struct ResolvedMentions {
    pub context: String,
    pub mcp_servers: Vec<String>,
}

pub async fn resolve(
    runtime: &mut ToolRuntime,
    settings: &Settings,
    mentions: &[Mention],
) -> ResolvedMentions {
    let mut sections: Vec<String> = Vec::new();
    let mut mcp_servers: Vec<String> = Vec::new();
    for mention in mentions {
        let value = mention.value.trim();
        if value.is_empty() {
            continue;
        }
        match mention.kind.as_str() {
            "file" => sections.push(resolve_file(runtime, value)),
            "directory" => sections.push(resolve_directory(runtime, value)),
            "website" => sections.push(resolve_website(runtime, value).await),
            "skill" => sections.push(resolve_skill(settings, value)),
            "mcp" if !mcp_servers.iter().any(|entry| entry == value) => {
                mcp_servers.push(value.to_string());
            }
            _ => {}
        }
    }
    ResolvedMentions {
        context: sections.join("\n\n"),
        mcp_servers,
    }
}

fn allowed_path(runtime: &ToolRuntime, value: &str) -> Result<PathBuf, String> {
    let candidate = permissions::resolve_path(&runtime.project_root, value);
    if permissions::path_is_inside(
        &candidate,
        &runtime.project_root,
        &runtime.permissions.extra_folders(),
    ) {
        Ok(candidate)
    } else {
        Err(format!(
            "{} is outside the allowed folders.",
            candidate.display()
        ))
    }
}

fn resolve_file(runtime: &ToolRuntime, value: &str) -> String {
    let path = match allowed_path(runtime, value) {
        Ok(path) => path,
        Err(error) => return format!("## File: {value}\n\n{error}"),
    };
    let display = display_path(runtime, &path);
    if permissions::is_sensitive(&path) {
        return format!("## File: {display}\n\nSkipped: this looks like a sensitive file.");
    }
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) => {
            return format!("## File: {display}\n\nCould not read file: {error}");
        }
    };
    if !metadata.is_file() {
        return format!("## File: {display}\n\nNot a file.");
    }
    if metadata.len() > MAX_FILE_BYTES {
        return format!(
            "## File: {display}\n\nSkipped: the file is larger than {} KB.",
            MAX_FILE_BYTES / 1024
        );
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            format!("## File: {display}\n\n<file path=\"{display}\">\n{content}\n</file>")
        }
        Err(_) => format!("## File: {display}\n\nSkipped: the file is not valid UTF-8 text."),
    }
}

fn resolve_directory(runtime: &ToolRuntime, value: &str) -> String {
    let path = match allowed_path(runtime, value) {
        Ok(path) => path,
        Err(error) => return format!("## Directory: {value}\n\n{error}"),
    };
    let display = display_path(runtime, &path);
    if !path.is_dir() {
        return format!("## Directory: {display}\n\nNot a directory.");
    }
    let mut entries: Vec<String> = Vec::new();
    let mut truncated = false;
    let walker = WalkBuilder::new(&path)
        .hidden(false)
        .max_depth(Some(MAX_DIR_DEPTH))
        .build();
    for entry in walker.flatten() {
        let entry_path = entry.path();
        if entry_path == path {
            continue;
        }
        if entry_path
            .components()
            .any(|component| component.as_os_str() == ".git")
        {
            continue;
        }
        let Ok(relative) = entry_path.strip_prefix(&path) else {
            continue;
        };
        let mut line = relative.to_string_lossy().replace('\\', "/");
        if entry_path.is_dir() {
            line.push('/');
        }
        entries.push(line);
        if entries.len() >= MAX_DIR_ENTRIES {
            truncated = true;
            break;
        }
    }
    entries.sort();
    let mut body = entries.join("\n");
    if truncated {
        body.push_str(&format!(
            "\n… (listing truncated at {MAX_DIR_ENTRIES} entries)"
        ));
    }
    if body.is_empty() {
        body = "(empty directory)".to_string();
    }
    format!("## Directory: {display}\n\n<directory path=\"{display}\">\n{body}\n</directory>")
}

async fn resolve_website(runtime: &mut ToolRuntime, value: &str) -> String {
    let outcome = tools::web_fetch(runtime, &json!({ "url": value })).await;
    if outcome.status == "ok" {
        format!(
            "## Website: {value}\n\n<website url=\"{value}\">\n{}\n</website>",
            outcome.result
        )
    } else {
        format!(
            "## Website: {value}\n\nCould not load the page: {}",
            outcome.result
        )
    }
}

pub fn resolve_skill(settings: &Settings, value: &str) -> String {
    let Some(directory) = discovery::find_skill_dir(
        value,
        &settings.skill_folders,
        &settings.skills_disabled,
        settings.skills_auto_discovery,
    ) else {
        return format!("## Skill: {value}\n\nNo skill named '{value}' was found.");
    };
    let mut files: Vec<PathBuf> = Vec::new();
    let skill_file = directory.join("SKILL.md");
    if skill_file.is_file() {
        files.push(skill_file.clone());
    }
    if let Ok(entries) = std::fs::read_dir(&directory) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file()
                && path.extension().map(|ext| ext == "md").unwrap_or(false)
                && path != skill_file
            {
                files.push(path);
            }
        }
    }
    files.sort();
    files.truncate(MAX_SKILL_FILES);
    let mut body = String::new();
    for file in &files {
        if let Ok(content) = std::fs::read_to_string(file) {
            if let Some(name) = file.file_name() {
                body.push_str(&format!(
                    "\n### {}\n{}\n",
                    name.to_string_lossy(),
                    content.trim()
                ));
            }
        }
    }
    if body.trim().is_empty() {
        body = "\n(no readable instructions found)".to_string();
    }
    format!(
        "## Skill: {value}\n\n<skill name=\"{value}\" path=\"{}\">\n{}\n</skill>\n\nFollow the skill instructions above when they apply to the user's request.",
        directory.display(),
        body.trim()
    )
}

fn display_path(runtime: &ToolRuntime, path: &Path) -> String {
    if let Ok(relative) = path.strip_prefix(&runtime.project_root) {
        return relative.to_string_lossy().replace('\\', "/");
    }
    path.to_string_lossy().replace('\\', "/")
}
