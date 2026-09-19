use crate::error::{AppError, Result};
use crate::models::FileChange;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

const DEFAULT_EXCLUDES: &str = "\
node_modules/
dist/
build/
target/
.next/
.nuxt/
out/
coverage/
.venv/
venv/
__pycache__/
.cache/
tmp/
.turbo/
.parcel-cache/
.DS_Store
*.log
";

pub trait RepoProbe {
    fn is_tracked(&self, relative_path: &str) -> bool;
    fn is_ignored(&self, relative_path: &str) -> bool;
}

pub struct ShadowRepo {
    git_dir: PathBuf,
    work_tree: PathBuf,
    lock: Arc<Mutex<()>>,
}

/// All `ShadowRepo` instances for the same project share one lock so that
/// concurrent turns (and parallel subagents) never race on the git index.
fn shadow_lock(git_dir: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    locks
        .entry(git_dir.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

impl ShadowRepo {
    pub fn open(app_data_dir: &Path, project_id: &str, project_path: &Path) -> Result<Self> {
        let git_dir = app_data_dir.join("shadow").join(project_id);
        let repo = Self {
            lock: shadow_lock(&git_dir),
            git_dir,
            work_tree: project_path.to_path_buf(),
        };
        repo.ensure_init()?;
        Ok(repo)
    }

    fn ensure_init(&self) -> Result<()> {
        if self.git_dir.join("HEAD").exists() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.git_dir)?;
        let output = Command::new("git")
            .args(["init", "--bare", "--quiet"])
            .arg(&self.git_dir)
            .output()?;
        if !output.status.success() {
            return Err(AppError::msg(format!(
                "shadow git init failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        for (key, value) in [
            ("core.bare", "false"),
            (
                "core.worktree",
                &self.work_tree.to_string_lossy().to_string(),
            ),
            ("user.name", "pumr"),
            ("user.email", "pumr@local"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
            ("core.quotepath", "false"),
        ] {
            self.run(["config", key, value])?;
        }
        std::fs::create_dir_all(self.git_dir.join("info"))?;
        std::fs::write(self.git_dir.join("info").join("exclude"), DEFAULT_EXCLUDES)?;
        Ok(())
    }

    fn command(&self) -> Command {
        let mut command = Command::new("git");
        command
            .arg(format!("--git-dir={}", self.git_dir.display()))
            .arg(format!("--work-tree={}", self.work_tree.display()))
            .current_dir(&self.work_tree)
            .env("GIT_TERMINAL_PROMPT", "0");
        command
    }

    fn run<I, S>(&self, args: I) -> Result<String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let output = self.command().args(args).output()?;
        if !output.status.success() {
            return Err(AppError::msg(format!(
                "shadow git failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn run_raw<I, S>(&self, args: I) -> Result<String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let output = self.command().args(args).output()?;
        if !output.status.success() {
            return Err(AppError::msg(format!(
                "shadow git failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    fn stage_all_unlocked(&self) -> Result<()> {
        self.run(["add", "-A", "--", "."])?;
        Ok(())
    }

    pub fn snapshot(&self, message: &str) -> Result<String> {
        let _guard = self.lock.lock().unwrap();
        self.stage_all_unlocked()?;
        self.run(["commit", "--allow-empty", "--quiet", "-m", message])?;
        self.head()
    }

    pub fn head(&self) -> Result<String> {
        self.run(["rev-parse", "HEAD"])
    }

    fn diff_numstat_unlocked(&self, base: &str) -> Result<Vec<FileChange>> {
        self.stage_all_unlocked()?;
        let output = self.run(["diff", "--numstat", base, "--"])?;
        Ok(output
            .lines()
            .filter_map(|line| {
                let mut parts = line.split('\t');
                let additions = parts.next()?;
                let deletions = parts.next()?;
                let path = parts.next()?;
                Some(FileChange {
                    path: path.to_string(),
                    additions: additions.parse().unwrap_or(0),
                    deletions: deletions.parse().unwrap_or(0),
                    status: String::new(),
                })
            })
            .collect())
    }

    fn changed_since_unlocked(&self, base: &str) -> Result<Vec<FileChange>> {
        self.stage_all_unlocked()?;
        let output = self.run(["diff", "--name-status", base, "--"])?;
        Ok(output
            .lines()
            .filter_map(|line| {
                let mut parts = line.split('\t');
                let status = parts.next()?.chars().next()?.to_string();
                let path = parts.next()?;
                Some(FileChange {
                    path: path.to_string(),
                    additions: 0,
                    deletions: 0,
                    status,
                })
            })
            .collect())
    }

    pub fn changes_since(&self, base: &str) -> Result<Vec<FileChange>> {
        let _guard = self.lock.lock().unwrap();
        let mut statuses = self.changed_since_unlocked(base)?;
        let numstat = self.diff_numstat_unlocked(base)?;
        for change in statuses.iter_mut() {
            if let Some(stats) = numstat.iter().find(|entry| entry.path == change.path) {
                change.additions = stats.additions;
                change.deletions = stats.deletions;
            }
        }
        Ok(statuses)
    }

    pub fn file_at(&self, commit: &str, relative_path: &str) -> Result<String> {
        self.run_raw(["show", &format!("{commit}:{relative_path}")])
    }

    pub fn restore_to(&self, commit: &str) -> Result<Vec<String>> {
        let _guard = self.lock.lock().unwrap();
        let changes = self.changed_since_unlocked(commit)?;
        let mut restored = Vec::new();
        for change in changes {
            let absolute = self.work_tree.join(&change.path);
            if change.status == "A" {
                if absolute.is_file() {
                    std::fs::remove_file(&absolute)?;
                }
            } else {
                self.run(["checkout", commit, "--", &change.path])?;
            }
            restored.push(change.path);
        }
        self.stage_all_unlocked()?;
        Ok(restored)
    }

    pub fn is_tracked(&self, relative_path: &str) -> bool {
        self.command()
            .args(["ls-files", "--error-unmatch", "--", relative_path])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    pub fn is_ignored(&self, relative_path: &str) -> bool {
        self.command()
            .args(["check-ignore", "-q", "--", relative_path])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
}

pub struct GitProbe<'a> {
    pub project_root: &'a Path,
    pub shadow: Option<&'a ShadowRepo>,
}

impl RepoProbe for GitProbe<'_> {
    fn is_tracked(&self, relative_path: &str) -> bool {
        if self.project_root.join(".git").exists() {
            return Command::new("git")
                .arg("-C")
                .arg(self.project_root)
                .args(["ls-files", "--error-unmatch", "--", relative_path])
                .output()
                .map(|output| output.status.success())
                .unwrap_or(false);
        }
        self.shadow
            .map(|shadow| shadow.is_tracked(relative_path))
            .unwrap_or(false)
    }

    fn is_ignored(&self, relative_path: &str) -> bool {
        if self.project_root.join(".git").exists() {
            return Command::new("git")
                .arg("-C")
                .arg(self.project_root)
                .args(["check-ignore", "-q", "--", relative_path])
                .output()
                .map(|output| output.status.success())
                .unwrap_or(false);
        }
        self.shadow
            .map(|shadow| shadow.is_ignored(relative_path))
            .unwrap_or(false)
    }
}

pub fn project_git_info(project_root: &Path) -> crate::models::GitInfo {
    let branch = Command::new("git")
        .arg("-C")
        .arg(project_root)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
    let head = Command::new("git")
        .arg("-C")
        .arg(project_root)
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
    crate::models::GitInfo {
        is_repo: project_root.join(".git").exists(),
        branch,
        head,
    }
}

pub fn count_line_changes(old: &str, new: &str) -> (i64, i64) {
    use similar::{ChangeTag, TextDiff};
    let diff = TextDiff::from_lines(old, new);
    let mut additions = 0;
    let mut deletions = 0;
    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => additions += 1,
            ChangeTag::Delete => deletions += 1,
            ChangeTag::Equal => {}
        }
    }
    (additions, deletions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shadow_repo_tracks_new_modified_and_restores() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(project.join("src")).unwrap();
        std::fs::write(project.join("src/main.ts"), "line1\nline2\n").unwrap();

        let shadow = ShadowRepo::open(temp.path(), "project-1", &project).unwrap();
        let base = shadow.snapshot("base").unwrap();

        std::fs::write(project.join("src/main.ts"), "line1\nline2 changed\nline3\n").unwrap();
        std::fs::write(project.join("src/new.ts"), "new file\n").unwrap();
        std::fs::create_dir_all(project.join("node_modules/pkg")).unwrap();
        std::fs::write(project.join("node_modules/pkg/index.js"), "ignored\n").unwrap();

        let changes = shadow.changes_since(&base).unwrap();
        let main = changes
            .iter()
            .find(|change| change.path == "src/main.ts")
            .expect("modified file tracked");
        assert_eq!(main.additions, 2);
        assert_eq!(main.deletions, 1);
        let new_file = changes
            .iter()
            .find(|change| change.path == "src/new.ts")
            .expect("new file tracked");
        assert_eq!(new_file.status, "A");
        assert!(!changes
            .iter()
            .any(|change| change.path.contains("node_modules")));

        let old = shadow.file_at(&base, "src/main.ts").unwrap();
        assert_eq!(old, "line1\nline2\n");

        shadow.restore_to(&base).unwrap();
        assert_eq!(
            std::fs::read_to_string(project.join("src/main.ts")).unwrap(),
            "line1\nline2\n"
        );
        assert!(!project.join("src/new.ts").exists());
        assert!(shadow.changes_since(&base).unwrap().is_empty());
    }
}
