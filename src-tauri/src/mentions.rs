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

pub struct ResolvedMentions {
    pub context: String,
    pub mcp_servers: Vec<String>,
}

pub async fn resolve(
    runtime: &mut ToolRuntime,
    settings: &Settings,
    mentions: &[Mention],
    installed_skills: &[PathBuf],
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
            "skill" => sections.push(resolve_skill(settings, value, installed_skills)),
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

pub fn resolve_skill(settings: &Settings, value: &str, installed_skills: &[PathBuf]) -> String {
    let Some(directory) = discovery::find_skill_dir(
        value,
        &settings.integrations.skill_folders,
        &settings.integrations.skills_disabled,
        &settings.integrations.skills_disabled_items,
        settings.integrations.skills_auto_discovery,
        installed_skills,
    ) else {
        return format!("## Skill: {value}\n\nNo skill named '{value}' was found.");
    };
    match discovery::skill_instructions(value, &directory) {
        Some(instructions) => format!("## Skill: {value}\n\n{instructions}"),
        None => format!("## Skill: {value}\n\n(no readable instructions found)"),
    }
}

fn display_path(runtime: &ToolRuntime, path: &Path) -> String {
    if let Ok(relative) = path.strip_prefix(&runtime.project_root) {
        return relative.to_string_lossy().replace('\\', "/");
    }
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SkillRef;
    use crate::tools::tests::test_runtime;

    fn mention(kind: &str, value: &str) -> Mention {
        Mention {
            kind: kind.to_string(),
            value: value.to_string(),
            label: value.to_string(),
        }
    }

    /// Settings that only see the skill folders a test passes in, never the
    /// skills installed on the machine running the tests.
    fn isolated_settings(skill_folders: Vec<String>) -> Settings {
        let mut settings = Settings::default();
        settings.integrations.skills_auto_discovery = false;
        settings.integrations.skill_folders = skill_folders;
        settings
    }

    struct Project {
        _temp: tempfile::TempDir,
        root: PathBuf,
        runtime: ToolRuntime,
    }

    fn project() -> Project {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        let runtime = test_runtime(&root, &temp.path().join("app-data"));
        Project {
            _temp: temp,
            root,
            runtime,
        }
    }

    async fn resolve_one(project: &mut Project, kind: &str, value: &str) -> String {
        resolve(
            &mut project.runtime,
            &isolated_settings(Vec::new()),
            &[mention(kind, value)],
            &[],
        )
        .await
        .context
    }

    #[tokio::test]
    async fn inlines_a_project_file_with_its_relative_path() {
        let mut project = project();
        std::fs::create_dir_all(project.root.join("src")).unwrap();
        std::fs::write(
            project.root.join("src/lib.rs"),
            "pub fn answer() -> u8 { 42 }",
        )
        .unwrap();

        let context = resolve_one(&mut project, "file", "src/lib.rs").await;

        assert_eq!(
            context,
            "## File: src/lib.rs\n\n<file path=\"src/lib.rs\">\npub fn answer() -> u8 { 42 }\n</file>"
        );
    }

    #[tokio::test]
    async fn refuses_files_outside_the_project() {
        let mut project = project();
        let outside = project.root.parent().unwrap().join("outside.txt");
        std::fs::write(&outside, "top secret").unwrap();

        let context = resolve_one(&mut project, "file", outside.to_str().unwrap()).await;
        assert!(
            context.contains("is outside the allowed folders."),
            "{context}"
        );
        assert!(!context.contains("top secret"));

        let context = resolve_one(&mut project, "file", "../outside.txt").await;
        assert!(
            context.contains("is outside the allowed folders."),
            "{context}"
        );
        assert!(!context.contains("top secret"));
    }

    #[tokio::test]
    async fn skips_sensitive_files_but_allows_env_templates() {
        let mut project = project();
        std::fs::write(project.root.join(".env"), "API_KEY=real").unwrap();
        std::fs::write(project.root.join("server.pem"), "-----BEGIN KEY-----").unwrap();
        std::fs::write(project.root.join(".env.example"), "API_KEY=").unwrap();

        for name in [".env", "server.pem"] {
            let context = resolve_one(&mut project, "file", name).await;
            assert_eq!(
                context,
                format!("## File: {name}\n\nSkipped: this looks like a sensitive file.")
            );
        }
        let context = resolve_one(&mut project, "file", ".env.example").await;
        assert!(context.contains("<file path=\".env.example\">\nAPI_KEY=\n</file>"));
    }

    #[tokio::test]
    async fn reports_missing_large_binary_and_directory_paths() {
        let mut project = project();
        std::fs::create_dir_all(project.root.join("folder")).unwrap();
        let large = "x".repeat(MAX_FILE_BYTES as usize + 1);
        std::fs::write(project.root.join("big.txt"), large).unwrap();
        std::fs::write(project.root.join("blob.bin"), [0xff, 0xfe, 0x00, 0x80]).unwrap();

        let missing = resolve_one(&mut project, "file", "missing.txt").await;
        assert!(missing.starts_with("## File: missing.txt\n\nCould not read file:"));
        assert_eq!(
            resolve_one(&mut project, "file", "folder").await,
            "## File: folder\n\nNot a file."
        );
        assert_eq!(
            resolve_one(&mut project, "file", "big.txt").await,
            "## File: big.txt\n\nSkipped: the file is larger than 256 KB."
        );
        assert_eq!(
            resolve_one(&mut project, "file", "blob.bin").await,
            "## File: blob.bin\n\nSkipped: the file is not valid UTF-8 text."
        );
    }

    #[tokio::test]
    async fn lists_a_directory_sorted_with_folders_marked_and_git_hidden() {
        let mut project = project();
        let docs = project.root.join("docs");
        std::fs::create_dir_all(docs.join("guides/deep/deeper")).unwrap();
        std::fs::create_dir_all(docs.join(".git")).unwrap();
        std::fs::write(docs.join(".git/HEAD"), "ref").unwrap();
        std::fs::write(docs.join("b.md"), "").unwrap();
        std::fs::write(docs.join("a.md"), "").unwrap();
        std::fs::write(docs.join("guides/intro.md"), "").unwrap();
        // Beyond the maximum depth of three levels.
        std::fs::write(docs.join("guides/deep/deeper/hidden.md"), "").unwrap();

        let context = resolve_one(&mut project, "directory", "docs").await;

        assert_eq!(
            context,
            "## Directory: docs\n\n<directory path=\"docs\">\n\
             a.md\nb.md\nguides/\nguides/deep/\nguides/deep/deeper/\nguides/intro.md\n\
             </directory>"
        );
    }

    #[tokio::test]
    async fn marks_empty_missing_and_truncated_directories() {
        let mut project = project();
        std::fs::create_dir_all(project.root.join("empty")).unwrap();
        std::fs::write(project.root.join("file.txt"), "").unwrap();
        let many = project.root.join("many");
        std::fs::create_dir_all(&many).unwrap();
        for index in 0..=MAX_DIR_ENTRIES {
            std::fs::write(many.join(format!("{index:04}.txt")), "").unwrap();
        }

        assert!(resolve_one(&mut project, "directory", "empty")
            .await
            .contains("\n(empty directory)\n"));
        assert_eq!(
            resolve_one(&mut project, "directory", "file.txt").await,
            "## Directory: file.txt\n\nNot a directory."
        );
        assert!(resolve_one(&mut project, "directory", "../")
            .await
            .contains("is outside the allowed folders."));

        let listing = resolve_one(&mut project, "directory", "many").await;
        assert!(listing.contains("… (listing truncated at 600 entries)"));
        assert_eq!(listing.matches(".txt\n").count(), MAX_DIR_ENTRIES);
    }

    #[tokio::test]
    async fn collects_unique_mcp_servers_and_ignores_blank_or_unknown_mentions() {
        let mut project = project();
        std::fs::write(project.root.join("notes.md"), "hello").unwrap();

        let resolved = resolve(
            &mut project.runtime,
            &isolated_settings(Vec::new()),
            &[
                mention("mcp", "github"),
                mention("file", "   "),
                mention("mcp", "github"),
                mention("unknown", "whatever"),
                mention("mcp", " postgres "),
                mention("file", "notes.md"),
            ],
            &[],
        )
        .await;

        assert_eq!(resolved.mcp_servers, vec!["github", "postgres"]);
        assert_eq!(
            resolved.context,
            "## File: notes.md\n\n<file path=\"notes.md\">\nhello\n</file>"
        );
    }

    #[tokio::test]
    async fn joins_several_sections_with_a_blank_line() {
        let mut project = project();
        std::fs::write(project.root.join("a.txt"), "A").unwrap();
        std::fs::write(project.root.join("b.txt"), "B").unwrap();

        let resolved = resolve(
            &mut project.runtime,
            &isolated_settings(Vec::new()),
            &[mention("file", "a.txt"), mention("file", "b.txt")],
            &[],
        )
        .await;

        let sections: Vec<&str> = resolved.context.split("\n\n## ").collect();
        assert_eq!(sections.len(), 2);
        assert!(sections[0].starts_with("## File: a.txt"));
        assert!(sections[1].starts_with("File: b.txt"));
    }

    #[test]
    fn inlines_a_skills_instructions_and_names_its_other_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        // Grouped one folder down, as collections keep their skills.
        let skill = root.join("team/release");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "  Bump the version.  ").unwrap();
        std::fs::write(skill.join("changelog.md"), "Write the changelog.").unwrap();
        let settings = isolated_settings(vec![root.to_string_lossy().to_string()]);

        let context = resolve_skill(&settings, "release", &[]);

        assert!(
            context.starts_with(&format!(
                "## Skill: release\n\n<skill name=\"release\" path=\"{}\">\nBump the version.\n</skill>\n",
                skill.display()
            )),
            "{context}"
        );
        // The other file is named, to be read when the instructions call for it.
        assert!(context.contains("\n- changelog.md\n"), "{context}");
        assert!(!context.contains("Write the changelog."));
        assert!(context.ends_with(
            "Follow the skill instructions above when they apply to the user's request."
        ));
    }

    #[test]
    fn reports_unknown_and_disabled_skills() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        std::fs::create_dir_all(root.join("release")).unwrap();
        std::fs::write(root.join("release/SKILL.md"), "Bump.").unwrap();
        let root_string = root.to_string_lossy().to_string();
        let mut settings = isolated_settings(vec![root_string.clone()]);

        assert_eq!(
            resolve_skill(&settings, "deploy", &[]),
            "## Skill: deploy\n\nNo skill named 'deploy' was found."
        );

        settings.integrations.skills_disabled_items = vec![SkillRef {
            path: root_string,
            name: "release".to_string(),
        }];
        assert!(resolve_skill(&settings, "release", &[]).contains("No skill named 'release'"));
    }

    #[test]
    fn resolves_installed_marketplace_skills() {
        let temp = tempfile::tempdir().unwrap();
        let installed = temp.path().join("installed");
        std::fs::create_dir_all(installed.join("review")).unwrap();
        std::fs::write(installed.join("review/SKILL.md"), "Review carefully.").unwrap();

        let context = resolve_skill(&isolated_settings(Vec::new()), "review", &[installed]);
        assert!(context.contains("\nReview carefully.\n</skill>"), "{context}");
    }

    #[test]
    fn notes_skills_without_readable_instructions() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        std::fs::create_dir_all(root.join("empty")).unwrap();
        // The skill is found by its SKILL.md, which cannot be read as text.
        std::fs::write(root.join("empty/SKILL.md"), [0xff, 0xfe, 0x00]).unwrap();
        let settings = isolated_settings(vec![root.to_string_lossy().to_string()]);

        assert!(resolve_skill(&settings, "empty", &[]).contains("(no readable instructions found)"));
    }
}
