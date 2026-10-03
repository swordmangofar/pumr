//! What the harness adds to the system prompt on its own account: where the
//! agent runs, which checks the project has, and how to go about the work.
//! A model that has to guess these guesses wrong: `npm` in a pnpm project,
//! a test command that does not exist, GNU flags on macOS.

use crate::models::ModelInfo;
use serde_json::Value;
use std::path::Path;

/// Most check commands named in the prompt.
const MAX_CHECKS: usize = 6;

/// Scripts of a `package.json` that check the project, the quickest first.
const CHECK_SCRIPTS: [&str; 7] = [
    "typecheck",
    "type-check",
    "check",
    "lint",
    "test",
    "build",
    "verify",
];

/// What a project's own files say about how it is built and checked.
#[derive(Debug, Default, PartialEq)]
pub struct ProjectFacts {
    pub package_manager: Option<&'static str>,
    /// Commands that check the project, the quickest first.
    pub checks: Vec<String>,
}

/// Reads the manifests at the project root. Cheap enough for every turn: a
/// handful of small files, none of them parsed beyond what is listed here.
pub fn detect(project_root: &Path) -> ProjectFacts {
    let mut facts = ProjectFacts::default();
    let has = |name: &str| project_root.join(name).is_file();
    let read = |name: &str| std::fs::read_to_string(project_root.join(name)).ok();

    if let Some(manifest) =
        read("package.json").and_then(|text| serde_json::from_str::<Value>(&text).ok())
    {
        let declared = manifest
            .get("packageManager")
            .and_then(Value::as_str)
            .unwrap_or("");
        let manager = if has("pnpm-lock.yaml") || declared.starts_with("pnpm") {
            "pnpm"
        } else if has("yarn.lock") || declared.starts_with("yarn") {
            "yarn"
        } else if has("bun.lockb") || has("bun.lock") || declared.starts_with("bun") {
            "bun"
        } else {
            "npm"
        };
        facts.package_manager = Some(manager);
        if let Some(scripts) = manifest.get("scripts").and_then(Value::as_object) {
            for script in CHECK_SCRIPTS {
                if scripts.contains_key(script) {
                    facts.checks.push(format!("{manager} run {script}"));
                }
            }
        }
    }

    for (manifest, flag) in [
        ("Cargo.toml", String::new()),
        (
            "src-tauri/Cargo.toml",
            " --manifest-path src-tauri/Cargo.toml".to_string(),
        ),
    ] {
        if has(manifest) {
            facts.checks.push(format!("cargo check{flag}"));
            facts.checks.push(format!("cargo test{flag}"));
        }
    }
    if has("go.mod") {
        facts.checks.push("go build ./...".to_string());
        facts.checks.push("go test ./...".to_string());
    }
    let pyproject = read("pyproject.toml").unwrap_or_default();
    if pyproject.contains("ruff") {
        facts.checks.push("ruff check .".to_string());
    }
    if pyproject.contains("pytest") || has("pytest.ini") {
        facts.checks.push("pytest".to_string());
    }
    if has("pom.xml") {
        facts.checks.push("mvn -q test".to_string());
    }
    if has("build.gradle") || has("build.gradle.kts") {
        let gradle = if has("gradlew") { "./gradlew" } else { "gradle" };
        facts.checks.push(format!("{gradle} test"));
    }
    if let Some(makefile) = read("Makefile") {
        for target in ["check", "lint", "test"] {
            if makefile
                .lines()
                .any(|line| line.starts_with(&format!("{target}:")))
            {
                facts.checks.push(format!("make {target}"));
            }
        }
    }
    facts.checks.truncate(MAX_CHECKS);
    facts
}

/// The branch checked out in the project, read from `.git/HEAD`.
fn git_branch(project_root: &Path) -> Option<String> {
    let head = std::fs::read_to_string(project_root.join(".git/HEAD")).ok()?;
    let branch = head.trim().strip_prefix("ref: refs/heads/")?;
    (!branch.is_empty()).then(|| branch.to_string())
}

fn platform() -> String {
    let system = match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    };
    let shell = if cfg!(windows) {
        "cmd.exe, so use Windows commands"
    } else {
        "/bin/sh"
    };
    format!(
        "{system} ({}); bash commands run in {shell}",
        std::env::consts::ARCH
    )
}

/// Tells the model where it runs, so it does not probe the filesystem with
/// guessed paths (`cd /Users/*/project || cd ../project; pwd`) that only
/// trigger permission prompts, and which commands the project itself offers.
pub fn section(project_root: &Path, scratch_dir: Option<&Path>, facts: &ProjectFacts) -> String {
    let mut section = format!(
        "\n\n# Environment\n- Project root: {}\n- bash commands already run in the project root unless you pass `cwd`; do not `cd` into it or probe for it with `pwd`/`ls`.\n- Relative paths in tools resolve against the project root. Paths outside it require user approval.",
        project_root.display()
    );
    // Agents reach for `/tmp` for downloads and throwaway files, which is
    // outside the project and asks every time.
    if let Some(scratch) = scratch_dir {
        section.push_str(&format!(
            "\n- Scratch folder for temporary files (downloads, experiments, notes): {}. It needs no approval and is deleted with this chat. Use it instead of `/tmp`, and never for files the project needs.",
            scratch.display()
        ));
    }
    section.push_str(&format!(
        "\n- Platform: {}. Today is {}.",
        platform(),
        chrono::Local::now().format("%Y-%m-%d")
    ));
    if let Some(branch) = git_branch(project_root) {
        section.push_str(&format!("\n- Git branch: {branch}"));
    }
    if let Some(manager) = facts.package_manager {
        section.push_str(&format!(
            "\n- Package manager: {manager}. Use it, not another one."
        ));
    }
    if !facts.checks.is_empty() {
        section.push_str(&format!(
            "\n- Checks this project has: {}. The project rules and README have the last word on how to run them.",
            facts
                .checks
                .iter()
                .map(|check| format!("`{check}`"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    section
}

/// Input price, in dollars per million tokens, below which a model gets the
/// longer working method.
const GUIDED_BELOW_PRICE: f64 = 1.0;

/// Whether `model` gets the longer working method. The catalog says nothing
/// about how capable a model is, so its price stands in for that: small and
/// local models are the ones that need the method spelled out, and there the
/// extra tokens cost next to nothing. An unknown model gets the short one.
pub fn is_guided(model: Option<&ModelInfo>) -> bool {
    model.is_some_and(|model| model.prompt_price_per_m < GUIDED_BELOW_PRICE)
}

/// How to go about the work. It closes the system prompt, after the project
/// rules, MCP tools and skills, where a model weighs it most. The long form
/// adds what stronger models do unasked.
pub fn method_section(guided: bool) -> String {
    let mut section = String::from(
        "\n\n# Working method\n- Find the place with grep or glob, read the code you are about to change, then edit. Ask for independent reads and searches together in one step.\n- For a bug: reproduce it first (a failing test, or a script in the scratch folder), fix the cause, then run the same reproduction again to see it pass.\n- After a change the user can see in the interface, show it with the screenshot tool.",
    );
    if guided {
        section.push_str(
            "\n- Say in one line what you are about to do, then call the tool. Apply code with edit or write; never paste it into the chat in place of a tool call.\n- Change only what the task needs: no unrelated refactoring, renaming, comments or new dependencies.\n- When a command fails, read its output, fix the cause and run the same command again. After two failed attempts at one approach, take another or ask the user.",
        );
    }
    section
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(price: f64) -> ModelInfo {
        ModelInfo {
            id: "m".to_string(),
            name: "m".to_string(),
            description: String::new(),
            context_length: 0,
            prompt_price_per_m: price,
            completion_price_per_m: 0.0,
            cache_read_price_per_m: 0.0,
            supports_reasoning: false,
            supports_vision: false,
            supports_tools: true,
            input_modalities: Vec::new(),
            supported_parameters: Vec::new(),
            created: 0,
            source: String::new(),
        }
    }

    #[test]
    fn a_node_project_names_its_package_manager_and_check_scripts() {
        let project = tempfile::tempdir().unwrap();
        std::fs::write(
            project.path().join("package.json"),
            r#"{ "scripts": { "start": "ng serve", "test": "ng test", "lint": "eslint .", "build": "ng build" } }"#,
        )
        .unwrap();
        std::fs::write(project.path().join("pnpm-lock.yaml"), "").unwrap();
        std::fs::create_dir_all(project.path().join("src-tauri")).unwrap();
        std::fs::write(project.path().join("src-tauri/Cargo.toml"), "[package]").unwrap();

        let facts = detect(project.path());
        assert_eq!(facts.package_manager, Some("pnpm"));
        assert_eq!(
            facts.checks,
            vec![
                "pnpm run lint",
                "pnpm run test",
                "pnpm run build",
                "cargo check --manifest-path src-tauri/Cargo.toml",
                "cargo test --manifest-path src-tauri/Cargo.toml",
            ]
        );
    }

    #[test]
    fn a_project_without_manifests_has_no_checks() {
        let project = tempfile::tempdir().unwrap();
        assert_eq!(detect(project.path()), ProjectFacts::default());
        let section = section(project.path(), None, &ProjectFacts::default());
        assert!(!section.contains("Checks this project has"));
        assert!(!section.contains("Package manager"));
        assert!(section.contains("Platform: "));
    }

    #[test]
    fn other_ecosystems_are_recognised_by_their_manifest() {
        let project = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("go.mod"), "module x").unwrap();
        std::fs::write(
            project.path().join("pyproject.toml"),
            "[tool.pytest.ini_options]\n[tool.ruff]",
        )
        .unwrap();
        std::fs::write(
            project.path().join("Makefile"),
            "build:\n\ttrue\ntest: build\n\ttrue\n",
        )
        .unwrap();
        assert_eq!(
            detect(project.path()).checks,
            vec![
                "go build ./...",
                "go test ./...",
                "ruff check .",
                "pytest",
                "make test"
            ]
        );
    }

    #[test]
    fn the_environment_names_branch_manager_and_checks() {
        let project = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(project.path().join(".git")).unwrap();
        std::fs::write(
            project.path().join(".git/HEAD"),
            "ref: refs/heads/feature/x\n",
        )
        .unwrap();
        let facts = ProjectFacts {
            package_manager: Some("yarn"),
            checks: vec!["yarn run test".to_string()],
        };
        let section = section(project.path(), None, &facts);
        assert!(section.contains("- Git branch: feature/x"));
        assert!(section.contains("- Package manager: yarn."));
        assert!(section.contains("`yarn run test`"));
    }

    #[test]
    fn cheap_and_local_models_get_the_longer_method() {
        assert!(is_guided(Some(&model(0.0))));
        assert!(is_guided(Some(&model(0.3))));
        assert!(!is_guided(Some(&model(3.0))));
        assert!(!is_guided(None));
        assert!(method_section(true).len() > method_section(false).len());
        assert!(method_section(false).contains("reproduce it first"));
    }
}
