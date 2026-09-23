use crate::error::{AppError, Result};
use crate::models::{
    FileChange, FileDiff, GitBranch, GitCommit, GitCommitDetail, GitStatus, GitTag,
};
use std::collections::HashMap;
use std::collections::HashSet;
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

/// Parses `git diff --numstat` output (tab-separated additions/deletions/path).
fn parse_numstat(output: &str) -> Vec<FileChange> {
    output
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
        .collect()
}

/// Parses `git diff --name-status` output into status-only changes.
fn parse_name_status(output: &str) -> Vec<FileChange> {
    output
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
        .collect()
}

/// Copies line counts from a numstat parse into a status parse by path.
fn apply_numstat(statuses: &mut [FileChange], numstat: &[FileChange]) {
    for change in statuses.iter_mut() {
        if let Some(stats) = numstat.iter().find(|entry| entry.path == change.path) {
            change.additions = stats.additions;
            change.deletions = stats.deletions;
        }
    }
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
        Ok(parse_numstat(&self.run(["diff", "--numstat", base, "--"])?))
    }

    fn changed_since_unlocked(&self, base: &str) -> Result<Vec<FileChange>> {
        self.stage_all_unlocked()?;
        Ok(parse_name_status(
            &self.run(["diff", "--name-status", base, "--"])?,
        ))
    }

    pub fn changes_since(&self, base: &str) -> Result<Vec<FileChange>> {
        let _guard = self.lock.lock().unwrap();
        let mut statuses = self.changed_since_unlocked(base)?;
        let numstat = self.diff_numstat_unlocked(base)?;
        apply_numstat(&mut statuses, &numstat);
        Ok(statuses)
    }

    /// Changes between two shadow commits. Unlike `changes_since`, this never
    /// looks at the live working tree, so it isolates exactly what happened in
    /// the range and cannot pick up edits made by other sessions.
    pub fn changes_between(&self, base: &str, after: &str) -> Result<Vec<FileChange>> {
        let _guard = self.lock.lock().unwrap();
        let mut statuses = self.changed_between_unlocked(base, after)?;
        let numstat = self.numstat_between_unlocked(base, after)?;
        apply_numstat(&mut statuses, &numstat);
        Ok(statuses)
    }

    fn changed_between_unlocked(&self, base: &str, after: &str) -> Result<Vec<FileChange>> {
        Ok(parse_name_status(
            &self.run(["diff", "--name-status", base, after, "--"])?,
        ))
    }

    fn numstat_between_unlocked(&self, base: &str, after: &str) -> Result<Vec<FileChange>> {
        Ok(parse_numstat(
            &self.run(["diff", "--numstat", base, after, "--"])?,
        ))
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

impl GitProbe<'_> {
    pub fn is_ignored(&self, relative_path: &str) -> bool {
        if self.project_root.join(".git").exists() {
            return Command::new("git")
                .arg("-C")
                .arg(self.project_root)
                .args(["-c", "core.quotepath=false"])
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
        .args(["-c", "core.quotepath=false"])
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
    let head = Command::new("git")
        .arg("-C")
        .arg(project_root)
        .args(["-c", "core.quotepath=false"])
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

/// Returns the subset of `paths` that git considers ignored. All paths are
/// checked in a single `git check-ignore` invocation for performance. Projects
/// without a real `.git` directory return an empty set.
pub fn ignored_paths(project_root: &Path, paths: &[PathBuf]) -> HashSet<PathBuf> {
    if paths.is_empty() || !project_root.join(".git").exists() {
        return HashSet::new();
    }
    use std::io::Write;
    use std::process::Stdio;
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(project_root)
        .args(["check-ignore", "--stdin", "-z"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return HashSet::new(),
    };
    if let Some(mut stdin) = child.stdin.take() {
        let mut payload: Vec<u8> = Vec::new();
        for path in paths {
            payload.extend_from_slice(path.to_string_lossy().as_bytes());
            payload.push(0);
        }
        let _ = stdin.write_all(&payload);
    }
    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(_) => return HashSet::new(),
    };
    String::from_utf8_lossy(&output.stdout)
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .map(PathBuf::from)
        .collect()
}

fn git(project_root: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(project_root)
        .args(["-c", "core.quotepath=false"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .env("GIT_EDITOR", "true");
    command
}

fn git_stdout(project_root: &Path, args: &[&str]) -> Result<String> {
    let output = git(project_root).args(args).output()?;
    if !output.status.success() {
        return Err(AppError::msg(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

fn git_stdout_opt(project_root: &Path, args: &[&str]) -> Option<String> {
    git(project_root)
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .trim_end()
                .to_string()
        })
}

fn git_stdout_raw(project_root: &Path, args: &[&str]) -> Option<String> {
    git(project_root)
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
}

fn combined_output(output: std::process::Output, command: &str) -> Result<String> {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let detail = if stderr.is_empty() {
            format!("git {command} failed")
        } else {
            stderr
        };
        return Err(AppError::msg(detail));
    }
    let mut text = stdout;
    if !stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&stderr);
    }
    Ok(text)
}

fn git_combined(project_root: &Path, args: &[&str]) -> Result<String> {
    let output = git(project_root).args(args).output()?;
    combined_output(output, &args.join(" "))
}

fn numstat(project_root: &Path, cached: bool) -> HashMap<String, (i64, i64)> {
    let mut args = vec!["diff", "--numstat", "--no-renames"];
    if cached {
        args.push("--cached");
    }
    args.push("--");
    let mut map = HashMap::new();
    if let Some(output) = git_stdout_opt(project_root, &args) {
        for line in output.lines() {
            let mut parts = line.split('\t');
            let additions = parts.next().unwrap_or("0");
            let deletions = parts.next().unwrap_or("0");
            let path = parts.next().unwrap_or("");
            if path.is_empty() {
                continue;
            }
            map.insert(
                path.to_string(),
                (
                    additions.parse().unwrap_or(0),
                    deletions.parse().unwrap_or(0),
                ),
            );
        }
    }
    map
}

pub fn project_branches(project_root: &Path) -> Vec<GitBranch> {
    let mut branches = Vec::new();
    let format = "%(refname)\t%(refname:short)\t%(HEAD)\t%(upstream:short)\t%(objectname)\t%(committerdate:unix)\t%(contents:subject)";
    if let Some(output) = git_stdout_opt(
        project_root,
        &[
            "for-each-ref",
            "--format",
            format,
            "refs/heads",
            "refs/remotes",
        ],
    ) {
        for line in output.lines() {
            let mut parts = line.splitn(7, '\t');
            let full = parts.next().unwrap_or("");
            let name = parts.next().unwrap_or("").to_string();
            let head = parts.next().unwrap_or("");
            let upstream = parts.next().unwrap_or("").to_string();
            let hash = parts.next().unwrap_or("").to_string();
            let timestamp = parts
                .next()
                .unwrap_or("")
                .parse::<i64>()
                .ok()
                .map(|seconds| seconds * 1000);
            let subject = parts.next().unwrap_or("").to_string();
            if name.is_empty() || name.ends_with("/HEAD") {
                continue;
            }
            branches.push(GitBranch {
                name,
                current: head == "*",
                remote: full.starts_with("refs/remotes/"),
                upstream: if upstream.is_empty() {
                    None
                } else {
                    Some(upstream)
                },
                hash: if hash.is_empty() { None } else { Some(hash) },
                subject: if subject.is_empty() {
                    None
                } else {
                    Some(subject)
                },
                timestamp,
            });
        }
    }
    branches
}

const COMMIT_SCAN_LIMIT: usize = 20_000;
const COMMIT_FORMAT: &str = "%H\x1f%h\x1f%an\x1f%at\x1f%D\x1f%P\x1f%s\x1e";

pub fn project_commits(
    project_root: &Path,
    query: Option<&str>,
    skip: usize,
    limit: usize,
) -> Result<Vec<GitCommit>> {
    let query = query
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    match query {
        None => {
            let format_arg = format!("--format={COMMIT_FORMAT}");
            let skip_arg = format!("--skip={skip}");
            let limit_arg = format!("--max-count={limit}");
            let args = vec![
                "log",
                "--all",
                "--decorate=short",
                &format_arg,
                &skip_arg,
                &limit_arg,
                "--",
            ];
            let output = git_stdout_opt(project_root, &args).unwrap_or_default();
            Ok(parse_commits(&output))
        }
        Some(query) => {
            // Filter with git itself so the entire history never has to be
            // pulled into memory and scanned in Rust.
            let mut commits = search_commits(project_root, &query);
            commits.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
            commits.dedup_by(|a, b| a.hash == b.hash);
            Ok(commits.into_iter().skip(skip).take(limit).collect())
        }
    }
}

/// Searches for commits whose message, author or hash matches `query`.
fn search_commits(project_root: &Path, query: &str) -> Vec<GitCommit> {
    let format_arg = format!("--format={COMMIT_FORMAT}");
    let scan_arg = format!("--max-count={COMMIT_SCAN_LIMIT}");
    let mut commits: Vec<GitCommit> = Vec::new();

    let message_args = vec![
        "log",
        "--all",
        "--decorate=short",
        &format_arg,
        &scan_arg,
        "--regexp-ignore-case",
        "--fixed-strings",
        "--grep",
        query,
        "--",
    ];
    if let Some(output) = git_stdout_opt(project_root, &message_args) {
        commits.extend(parse_commits(&output));
    }

    let author_pattern = format!("--author={query}");
    let author_args = vec![
        "log",
        "--all",
        "--decorate=short",
        &format_arg,
        &scan_arg,
        "--regexp-ignore-case",
        "--fixed-strings",
        &author_pattern,
        "--",
    ];
    if let Some(output) = git_stdout_opt(project_root, &author_args) {
        commits.extend(parse_commits(&output));
    }

    if query.len() >= 4 && query.chars().all(|character| character.is_ascii_hexdigit()) {
        let spec = format!("{query}^{{commit}}");
        if let Some(hash) = git_stdout_opt(project_root, &["rev-parse", "--quiet", "--verify", &spec])
        {
            let hash = hash.trim().to_string();
            if !hash.is_empty() {
                let args = vec!["show", "-s", &format_arg, hash.as_str()];
                if let Some(output) = git_stdout_opt(project_root, &args) {
                    commits.extend(parse_commits(&output));
                }
            }
        }
    }

    commits
}

fn parse_commits(output: &str) -> Vec<GitCommit> {
    output
        .split('\u{1e}')
        .map(|record| record.trim_start_matches(['\n', '\r']))
        .filter(|record| !record.trim().is_empty())
        .filter_map(|record| {
            let mut parts = record.splitn(7, '\u{1f}');
            let hash = parts.next()?.to_string();
            let short_hash = parts.next()?.to_string();
            let author = parts.next()?.to_string();
            let timestamp = parts
                .next()
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0)
                * 1000;
            let refs = parse_refs(parts.next().unwrap_or(""));
            let parents = parts
                .next()
                .unwrap_or("")
                .split_whitespace()
                .map(|parent| parent.to_string())
                .collect();
            let subject = parts.next().unwrap_or("").to_string();
            Some(GitCommit {
                hash,
                short_hash,
                author,
                timestamp,
                subject,
                refs,
                parents,
            })
        })
        .collect()
}

fn parse_refs(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .map(|part| {
            let part = part.strip_prefix("HEAD -> ").unwrap_or(part);
            let part = part.strip_prefix("tag: ").unwrap_or(part);
            part.trim().to_string()
        })
        .collect()
}

fn commit_changes(project_root: &Path, hash: &str) -> Vec<FileChange> {
    let name_status = git_stdout_opt(
        project_root,
        &["show", "--name-status", "--no-renames", "--format=", hash],
    )
    .unwrap_or_default();
    let numstat = git_stdout_opt(
        project_root,
        &["show", "--numstat", "--no-renames", "--format=", hash],
    )
    .unwrap_or_default();
    let mut stats: HashMap<String, (i64, i64)> = HashMap::new();
    for line in numstat.lines() {
        let mut parts = line.split('\t');
        let additions = parts.next().unwrap_or("0");
        let deletions = parts.next().unwrap_or("0");
        let path = parts.next().unwrap_or("");
        if !path.is_empty() {
            stats.insert(
                path.to_string(),
                (
                    additions.parse().unwrap_or(0),
                    deletions.parse().unwrap_or(0),
                ),
            );
        }
    }
    name_status
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let status = parts.next()?.chars().next()?.to_string();
            let path = parts.next()?.to_string();
            let (additions, deletions) = stats.get(&path).copied().unwrap_or((0, 0));
            Some(FileChange {
                path,
                additions,
                deletions,
                status,
            })
        })
        .collect()
}

pub fn project_commit_detail(project_root: &Path, hash: &str) -> Result<GitCommitDetail> {
    let format = "%H\t%h\t%an\t%ae\t%at\t%P\t%D\t%s\t%b";
    let output = git_stdout(
        project_root,
        &["show", "-s", &format!("--format={format}"), hash],
    )?;
    let mut parts = output.splitn(9, '\t');
    let full_hash = parts.next().unwrap_or("").to_string();
    let short_hash = parts.next().unwrap_or("").to_string();
    let author = parts.next().unwrap_or("").to_string();
    let author_email = parts.next().unwrap_or("").to_string();
    let timestamp = parts
        .next()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0)
        * 1000;
    let parents = parts
        .next()
        .unwrap_or("")
        .split_whitespace()
        .map(|parent| parent.to_string())
        .collect();
    let refs = parse_refs(parts.next().unwrap_or(""));
    let subject = parts.next().unwrap_or("").to_string();
    let body = parts.next().unwrap_or("").trim().to_string();
    let changes = commit_changes(project_root, &full_hash);
    Ok(GitCommitDetail {
        hash: full_hash,
        short_hash,
        author,
        author_email,
        timestamp,
        subject,
        body,
        parents,
        refs,
        changes,
    })
}

pub fn project_commit_file_diff(project_root: &Path, hash: &str, path: &str) -> Result<FileDiff> {
    let old_content =
        git_stdout_raw(project_root, &["show", &format!("{hash}^:{path}")]).unwrap_or_default();
    let new_content =
        git_stdout_raw(project_root, &["show", &format!("{hash}:{path}")]).unwrap_or_default();
    let (additions, deletions) = count_line_changes(&old_content, &new_content);
    let status = if old_content.is_empty() && !new_content.is_empty() {
        "A"
    } else if !old_content.is_empty() && new_content.is_empty() {
        "D"
    } else {
        "M"
    };
    Ok(FileDiff {
        path: path.to_string(),
        old_content,
        new_content,
        language: language_for(path).to_string(),
        additions,
        deletions,
        status: status.to_string(),
    })
}

/// Detects an in-progress merge, rebase, cherry-pick or revert.
fn git_operation(project_root: &Path) -> Option<String> {
    let git_dir = project_root.join(".git");
    let operation = if git_dir.join("MERGE_HEAD").exists() {
        "merge"
    } else if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        "rebase"
    } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
        "cherry-pick"
    } else if git_dir.join("REVERT_HEAD").exists() {
        "revert"
    } else {
        return None;
    };
    Some(operation.to_string())
}

/// Counts newline-separated lines without loading the whole file into memory and
/// without counting binary files. Mirrors `str::lines().count()` for text files.
fn count_file_lines(path: &Path) -> i64 {
    use std::io::Read;
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return 0,
    };
    let mut buffer = [0u8; 8192];
    let mut lines = 0i64;
    let mut saw_any = false;
    let mut last_byte = b'\n';
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                saw_any = true;
                let chunk = &buffer[..read];
                if chunk.contains(&0) {
                    return 0;
                }
                lines += chunk.iter().filter(|&&byte| byte == b'\n').count() as i64;
                last_byte = buffer[read - 1];
            }
            Err(_) => return 0,
        }
    }
    if saw_any && last_byte != b'\n' {
        lines += 1;
    }
    lines
}

pub fn project_git_status(project_root: &Path) -> Result<GitStatus> {
    if !project_root.join(".git").exists() {
        return Ok(GitStatus {
            is_repo: false,
            branch: None,
            head: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            staged: Vec::new(),
            unstaged: Vec::new(),
            branches: Vec::new(),
            tags: Vec::new(),
            stashes: Vec::new(),
            submodules: Vec::new(),
            operation: None,
            conflicted: Vec::new(),
        });
    }
    let branch = git_stdout_opt(project_root, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let head = git_stdout_opt(project_root, &["rev-parse", "--short", "HEAD"]);
    let upstream = git_stdout_opt(
        project_root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    );
    let (ahead, behind) = if upstream.is_some() {
        match git_stdout_opt(
            project_root,
            &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
        ) {
            Some(text) => {
                let mut parts = text.split_whitespace();
                let behind = parts
                    .next()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0);
                let ahead = parts
                    .next()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0);
                (ahead, behind)
            }
            None => (0, 0),
        }
    } else {
        (0, 0)
    };

    let status_text = git_stdout(
        project_root,
        &[
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--no-renames",
        ],
    )?;
    let unstaged_stats = numstat(project_root, false);
    let staged_stats = numstat(project_root, true);
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    for line in status_text.lines() {
        if line.len() < 3 {
            continue;
        }
        let bytes = line.as_bytes();
        let index_status = bytes[0] as char;
        let worktree_status = bytes[1] as char;
        let path = line[3..].to_string();
        if index_status == '?' && worktree_status == '?' {
            let additions = count_file_lines(&project_root.join(&path));
            unstaged.push(FileChange {
                path,
                additions,
                deletions: 0,
                status: "A".to_string(),
            });
            continue;
        }
        if index_status != ' ' && index_status != '?' {
            let (additions, deletions) = staged_stats.get(&path).copied().unwrap_or((0, 0));
            staged.push(FileChange {
                path: path.clone(),
                additions,
                deletions,
                status: index_status.to_string(),
            });
        }
        if worktree_status != ' ' {
            let (additions, deletions) = unstaged_stats.get(&path).copied().unwrap_or((0, 0));
            unstaged.push(FileChange {
                path,
                additions,
                deletions,
                status: worktree_status.to_string(),
            });
        }
    }

    Ok(GitStatus {
        is_repo: true,
        branch,
        head,
        upstream,
        ahead,
        behind,
        staged,
        unstaged,
        branches: project_branches(project_root),
        tags: git_stdout_opt(
            project_root,
            &[
                "tag",
                "--sort=-creatordate",
                "--format=%(refname:short)\t%(objecttype)\t%(objectname:short)\t%(*objectname:short)",
            ],
        )
        .map(|output| {
            output
                .lines()
                .filter_map(|line| {
                    let mut parts = line.splitn(4, '\t');
                    let name = parts.next()?.to_string();
                    let object_type = parts.next().unwrap_or("");
                    let object_hash = parts.next().unwrap_or("");
                    let peeled_hash = parts.next().unwrap_or("");
                    if name.is_empty() {
                        return None;
                    }
                    // Annotated tags point at a tag object; use the peeled
                    // commit hash so callers can resolve it directly.
                    let hash = if object_type == "tag" && !peeled_hash.is_empty() {
                        peeled_hash.to_string()
                    } else {
                        object_hash.to_string()
                    };
                    Some(GitTag { name, hash })
                })
                .collect()
        })
        .unwrap_or_default(),
        stashes: git_stdout_opt(project_root, &["stash", "list", "--format=%gd"])
            .map(|output| output.lines().map(|line| line.to_string()).collect())
            .unwrap_or_default(),
        submodules: git_stdout_opt(project_root, &["submodule", "--quiet", "status"])
            .map(|output| {
                output
                    .lines()
                    .filter_map(|line| line.split_whitespace().nth(1).map(|path| path.to_string()))
                    .collect()
            })
            .unwrap_or_default(),
        operation: git_operation(project_root),
        conflicted: git_stdout_opt(
            project_root,
            &["diff", "--name-only", "--diff-filter=U"],
        )
        .map(|output| {
            output
                .lines()
                .map(|line| line.to_string())
                .filter(|line| !line.is_empty())
                .collect()
        })
        .unwrap_or_default(),
    })
}

pub fn project_file_diff(project_root: &Path, path: &str, staged: bool) -> Result<FileDiff> {
    let old_content = if staged {
        git_stdout_raw(project_root, &["show", &format!("HEAD:{path}")]).unwrap_or_default()
    } else {
        git_stdout_raw(project_root, &["show", &format!(":{path}")]).unwrap_or_default()
    };
    let new_content = if staged {
        git_stdout_raw(project_root, &["show", &format!(":{path}")]).unwrap_or_default()
    } else {
        std::fs::read_to_string(project_root.join(path)).unwrap_or_default()
    };
    let (additions, deletions) = count_line_changes(&old_content, &new_content);
    let status = if old_content.is_empty() && !new_content.is_empty() {
        "A"
    } else if !old_content.is_empty() && new_content.is_empty() {
        "D"
    } else {
        "M"
    };
    Ok(FileDiff {
        path: path.to_string(),
        old_content,
        new_content,
        language: language_for(path).to_string(),
        additions,
        deletions,
        status: status.to_string(),
    })
}

pub fn git_stage(project_root: &Path, path: Option<&str>) -> Result<()> {
    match path {
        Some(path) => git_stdout(project_root, &["add", "-A", "--", path])?,
        None => git_stdout(project_root, &["add", "-A", "--", "."])?,
    };
    Ok(())
}

pub fn git_unstage(project_root: &Path, path: Option<&str>) -> Result<()> {
    let has_head = git(project_root)
        .args(["rev-parse", "--quiet", "--verify", "HEAD"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    if has_head {
        let mut args = vec!["restore", "--staged", "--"];
        args.push(path.unwrap_or("."));
        git_stdout(project_root, &args)?;
        return Ok(());
    }
    // No commit yet: drop the path from the index without touching the work tree.
    let mut args = vec!["rm", "--cached", "-r", "--quiet", "--"];
    args.push(path.unwrap_or("."));
    git_stdout(project_root, &args)?;
    Ok(())
}

pub fn git_discard(project_root: &Path, path: &str) -> Result<()> {
    let in_head = git(project_root)
        .args(["cat-file", "-e", &format!("HEAD:{path}")])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    if in_head {
        git_stdout(project_root, &["checkout", "--", path])?;
        return Ok(());
    }
    // The path is new (untracked or staged-but-never-committed): remove it from
    // the index if present, then delete it from the work tree.
    let tracked = git(project_root)
        .args(["ls-files", "--error-unmatch", "--", path])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    if tracked {
        let _ = git_stdout(project_root, &["rm", "--cached", "-r", "--quiet", "--", path]);
    }
    let absolute = project_root.join(path);
    if absolute.is_file() {
        std::fs::remove_file(&absolute)?;
    } else if absolute.is_dir() {
        std::fs::remove_dir_all(&absolute)?;
    }
    Ok(())
}

pub fn git_commit(project_root: &Path, message: &str, amend: bool) -> Result<String> {
    if message.trim().is_empty() {
        if amend {
            return git_combined(project_root, &["commit", "--amend", "--no-edit"]);
        }
        return Err(AppError::msg("commit message is required"));
    }
    let mut args = vec!["commit", "-m", message];
    if amend {
        args.push("--amend");
    }
    git_combined(project_root, &args)
}

pub fn git_checkout(
    project_root: &Path,
    branch: &str,
    track: bool,
    local_branch: Option<&str>,
) -> Result<String> {
    let mut args = vec!["checkout"];
    if track {
        args.push("--track");
        if let Some(name) = local_branch.filter(|name| !name.is_empty()) {
            args.push("-b");
            args.push(name);
        }
    }
    args.push(branch);
    git_combined(project_root, &args)
}

pub fn git_fetch(project_root: &Path) -> Result<String> {
    git_combined(project_root, &["fetch", "--all", "--prune"])
}

pub fn git_pull(project_root: &Path, strategy: Option<&str>) -> Result<String> {
    let args = match strategy {
        Some("merge") => vec!["pull", "--no-rebase"],
        Some("rebase") => vec!["pull", "--rebase"],
        _ => vec!["pull", "--ff-only"],
    };
    git_combined(project_root, &args)
}

pub fn git_push(project_root: &Path) -> Result<String> {
    git_combined(project_root, &["push"])
}

/// Aborts an in-progress merge, rebase, cherry-pick or revert.
pub fn git_operation_abort(project_root: &Path, operation: &str) -> Result<String> {
    match operation {
        "merge" => git_combined(project_root, &["merge", "--abort"]),
        "rebase" => git_combined(project_root, &["rebase", "--abort"]),
        "cherry-pick" => git_combined(project_root, &["cherry-pick", "--abort"]),
        "revert" => git_combined(project_root, &["revert", "--abort"]),
        other => Err(AppError::msg(format!("cannot abort '{other}'"))),
    }
}

/// Continues an in-progress rebase after conflicts were resolved.
pub fn git_operation_continue(project_root: &Path) -> Result<String> {
    git_combined(project_root, &["rebase", "--continue"])
}

pub fn git_stash_push(
    project_root: &Path,
    message: Option<&str>,
    include_untracked: bool,
) -> Result<String> {
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    if let Some(message) = message.filter(|value| !value.trim().is_empty()) {
        args.push("-m");
        args.push(message);
    }
    git_combined(project_root, &args)
}

pub fn git_stash_apply(project_root: &Path, stash: &str) -> Result<String> {
    git_combined(project_root, &["stash", "apply", stash])
}

pub fn git_stash_pop(project_root: &Path, stash: &str) -> Result<String> {
    git_combined(project_root, &["stash", "pop", stash])
}

pub fn git_stash_drop(project_root: &Path, stash: &str) -> Result<String> {
    git_combined(project_root, &["stash", "drop", stash])
}

pub fn git_init(project_root: &Path) -> Result<String> {
    git_combined(project_root, &["init"])
}

pub fn git_clone(url: &str, dest: &Path) -> Result<String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut command = Command::new("git");
    command
        .args(["-c", "core.quotepath=false"])
        .env("GIT_TERMINAL_PROMPT", "0");
    command.args(["clone", "--", url]).arg(dest);
    let output = command.output()?;
    combined_output(output, &format!("clone {url}"))
}

pub fn git_tag_delete(project_root: &Path, name: &str) -> Result<String> {
    git_combined(project_root, &["tag", "-d", name])
}

pub fn git_tag_push(project_root: &Path, remote: &str, name: &str) -> Result<String> {
    git_combined(project_root, &["push", remote, &format!("refs/tags/{name}")])
}

pub fn git_submodule_update(project_root: &Path, path: Option<&str>) -> Result<String> {
    let mut args = vec!["submodule", "update", "--init", "--recursive"];
    if let Some(path) = path.filter(|value| !value.is_empty()) {
        args.push("--");
        args.push(path);
    }
    git_combined(project_root, &args)
}

fn split_upstream(upstream: &str) -> (String, String) {
    match upstream.split_once('/') {
        Some((remote, branch)) => (remote.to_string(), branch.to_string()),
        None => (upstream.to_string(), String::new()),
    }
}

pub fn project_remotes(project_root: &Path) -> Vec<String> {
    git_stdout_opt(project_root, &["remote"])
        .map(|output| {
            output
                .lines()
                .map(|line| line.trim().to_string())
                .filter(|line| !line.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

pub fn project_current_branch(project_root: &Path) -> Option<String> {
    git_stdout_opt(project_root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .filter(|name| name != "HEAD")
}

fn default_branch(project_root: &Path, remote: &str) -> String {
    git_stdout_opt(
        project_root,
        &[
            "symbolic-ref",
            "--short",
            &format!("refs/remotes/{remote}/HEAD"),
        ],
    )
    .and_then(|value| value.split_once('/').map(|(_, branch)| branch.to_string()))
    .unwrap_or_else(|| "main".to_string())
}

pub fn git_fast_forward(project_root: &Path, branch: &str, upstream: &str) -> Result<String> {
    let (remote, remote_branch) = split_upstream(upstream);
    if project_current_branch(project_root).as_deref() == Some(branch) {
        let fetched = git_combined(project_root, &["fetch", &remote])?;
        let merged = git_combined(project_root, &["merge", "--ff-only", upstream])?;
        if fetched.is_empty() {
            return Ok(merged);
        }
        if merged.is_empty() {
            return Ok(fetched);
        }
        return Ok(format!("{fetched}\n{merged}"));
    }
    git_combined(
        project_root,
        &["fetch", &remote, &format!("{remote_branch}:{branch}")],
    )
}

pub fn git_merge(project_root: &Path, branch: &str) -> Result<String> {
    git_combined(project_root, &["merge", "--no-edit", branch])
}

pub fn git_rebase(project_root: &Path, onto: &str) -> Result<String> {
    git_combined(project_root, &["rebase", "--autostash", onto])
}

pub fn git_rebase_interactive(
    project_root: &Path,
    onto: &str,
    todo: &[(String, String)],
) -> Result<String> {
    if todo.is_empty() {
        return git_rebase(project_root, onto);
    }
    let text = todo
        .iter()
        .map(|(action, hash)| format!("{action} {hash}"))
        .collect::<Vec<_>>()
        .join("\n");
    let path = std::env::temp_dir().join(format!("pumr-rebase-{}.todo", uuid::Uuid::new_v4()));
    std::fs::write(&path, format!("{text}\n"))?;
    let editor = sequence_editor_command(&path);
    let output = git(project_root)
        .args(["rebase", "-i", "--autostash", onto])
        .env("GIT_SEQUENCE_EDITOR", editor)
        .output();
    let _ = std::fs::remove_file(&path);
    combined_output(output?, &format!("rebase -i {onto}"))
}

/// Builds a `GIT_SEQUENCE_EDITOR` command that overwrites git's todo file with
/// our own. Git appends the todo path to the editor command, so the command only
/// has to copy our file onto it. Uses the platform's native copy tool.
fn sequence_editor_command(source: &Path) -> String {
    #[cfg(windows)]
    {
        format!("cmd /C copy /Y \"{}\"", source.display())
    }
    #[cfg(not(windows))]
    {
        format!("cp -f '{}'", source.display())
    }
}

pub fn git_branch_create(
    project_root: &Path,
    name: &str,
    start_point: Option<&str>,
    checkout: bool,
) -> Result<String> {
    let mut args = if checkout {
        vec!["checkout", "-b", name]
    } else {
        vec!["branch", name]
    };
    if let Some(start) = start_point.filter(|value| !value.is_empty()) {
        args.push(start);
    }
    git_combined(project_root, &args)
}

pub fn git_tag_create(
    project_root: &Path,
    name: &str,
    target: Option<&str>,
    message: Option<&str>,
) -> Result<String> {
    let mut args = vec!["tag"];
    if let Some(message) = message.filter(|value| !value.trim().is_empty()) {
        args.push("-a");
        args.push("-m");
        args.push(message);
    }
    args.push(name);
    if let Some(target) = target.filter(|value| !value.is_empty()) {
        args.push(target);
    }
    git_combined(project_root, &args)
}

pub fn git_branch_rename(project_root: &Path, from: &str, to: &str) -> Result<String> {
    git_combined(project_root, &["branch", "-m", from, to])
}

pub fn git_branch_delete(project_root: &Path, branch: &str, remote: bool) -> Result<String> {
    if remote {
        let (remote_name, branch_name) = split_upstream(branch);
        return git_combined(
            project_root,
            &["push", &remote_name, "--delete", &branch_name],
        );
    }
    match git_combined(project_root, &["branch", "-d", branch]) {
        Ok(output) => Ok(output),
        Err(_) => git_combined(project_root, &["branch", "-D", branch]),
    }
}

pub fn git_set_upstream(project_root: &Path, branch: &str, upstream: &str) -> Result<String> {
    git_combined(
        project_root,
        &["branch", "--set-upstream-to", upstream, branch],
    )
}

pub fn git_push_branch(
    project_root: &Path,
    branch: &str,
    remote: &str,
    set_upstream: bool,
) -> Result<String> {
    let mut args = vec!["push"];
    if set_upstream {
        args.push("-u");
    }
    args.push(remote);
    args.push(branch);
    git_combined(project_root, &args)
}

fn parse_remote(url: &str) -> Option<(String, String)> {
    let url = url.trim().trim_end_matches('/');
    if let Some(rest) = url.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        return Some((host.to_string(), path.trim_start_matches('/').to_string()));
    }
    let after_scheme = url.split("://").nth(1)?;
    let after_user = after_scheme
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(after_scheme);
    let (host, path) = after_user.split_once('/')?;
    Some((host.to_string(), path.to_string()))
}

pub fn git_pull_request_url(
    project_root: &Path,
    remote: &str,
    branch: &str,
) -> Result<String> {
    let raw = git_stdout(project_root, &["remote", "get-url", remote])?;
    let (host, path) = parse_remote(&raw).ok_or_else(|| {
        AppError::msg(format!("unsupported remote url for '{remote}': {raw}"))
    })?;
    let path = path.trim_end_matches(".git").trim_end_matches('/').to_string();
    let base = default_branch(project_root, remote);
    let host_lower = host.to_lowercase();
    if host_lower.contains("github") {
        Ok(format!(
            "https://{host}/{path}/compare/{base}...{branch}?expand=1"
        ))
    } else if host_lower.contains("gitlab") {
        Ok(format!(
            "https://{host}/{path}/-/merge_requests/new?merge_request%5Bsource_branch%5D={branch}"
        ))
    } else if host_lower.contains("bitbucket") {
        Ok(format!(
            "https://{host}/{path}/pull-requests/new?source={branch}"
        ))
    } else {
        Ok(format!("https://{host}/{path}"))
    }
}

pub fn project_rebase_commits(project_root: &Path, onto: &str) -> Result<Vec<GitCommit>> {
    let format = "%H\x1f%h\x1f%an\x1f%at\x1f%s";
    let output = git_stdout(
        project_root,
        &[
            "log",
            "--reverse",
            &format!("--format={format}"),
            &format!("{onto}..HEAD"),
        ],
    )?;
    let commits = output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(5, '\u{1f}');
            let hash = parts.next()?.to_string();
            let short_hash = parts.next()?.to_string();
            let author = parts.next()?.to_string();
            let timestamp = parts
                .next()
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0)
                * 1000;
            let subject = parts.next().unwrap_or("").to_string();
            Some(GitCommit {
                hash,
                short_hash,
                author,
                timestamp,
                subject,
                refs: Vec::new(),
                parents: Vec::new(),
            })
        })
        .collect();
    Ok(commits)
}

pub fn language_for(path: &str) -> &'static str {
    let extension = Path::new(path)
        .extension()
        .map(|extension| extension.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "ts" => "typescript",
        "tsx" => "typescript",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascript",
        "json" | "jsonc" => "json",
        "rs" => "rust",
        "py" => "python",
        "rb" => "ruby",
        "go" => "go",
        "java" => "java",
        "kt" => "kotlin",
        "swift" => "swift",
        "c" | "h" => "c",
        "cpp" | "cc" | "hpp" | "hh" => "cpp",
        "cs" => "csharp",
        "php" => "php",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "md" | "markdown" => "markdown",
        "toml" => "ini",
        "yaml" | "yml" => "yaml",
        "sh" | "bash" | "zsh" => "shell",
        "sql" => "sql",
        "xml" => "xml",
        "dockerfile" => "dockerfile",
        _ => "plaintext",
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

    #[test]
    fn changes_between_isolates_turns_across_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("a.txt"), "a\n").unwrap();
        std::fs::write(project.join("b.txt"), "b\n").unwrap();

        let shadow = ShadowRepo::open(temp.path(), "project-1", &project).unwrap();
        let base_a = shadow.snapshot("before session a").unwrap();

        std::fs::write(project.join("a.txt"), "a changed\n").unwrap();
        let after_a = shadow.snapshot("after session a").unwrap();

        // Session B starts from A's end state, then edits an unrelated file.
        let base_b = after_a.clone();
        std::fs::write(project.join("b.txt"), "b changed\n").unwrap();
        let after_b = shadow.snapshot("after session b").unwrap();

        let a_changes = shadow.changes_between(&base_a, &after_a).unwrap();
        assert_eq!(a_changes.len(), 1);
        assert_eq!(a_changes[0].path, "a.txt");

        let b_changes = shadow.changes_between(&base_b, &after_b).unwrap();
        assert_eq!(b_changes.len(), 1);
        assert_eq!(b_changes[0].path, "b.txt");

        // A diff against the live work tree (the old behaviour) would leak B's
        // edit into session A.
        let leaked = shadow.changes_since(&base_a).unwrap();
        assert!(leaked.iter().any(|change| change.path == "b.txt"));
    }

    fn init_repo(project: &Path) {
        std::fs::create_dir_all(project).unwrap();
        git_stdout(project, &["init", "-q"]).unwrap();
        std::fs::write(project.join("tracked.txt"), "one\n").unwrap();
        git_stdout(project, &["add", "--", "tracked.txt"]).unwrap();
        git_stdout(
            project,
            &[
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=test",
                "commit",
                "-q",
                "-m",
                "init",
            ],
        )
        .unwrap();
    }

    #[test]
    fn status_and_diff_report_staged_and_unstaged_changes() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        std::fs::write(project.join("tracked.txt"), "one\ntwo\n").unwrap();
        std::fs::write(project.join("new.txt"), "new\n").unwrap();

        let status = project_git_status(&project).unwrap();
        assert!(status.is_repo);
        assert!(status
            .unstaged
            .iter()
            .any(|change| change.path == "tracked.txt"));
        assert!(status
            .unstaged
            .iter()
            .any(|change| change.path == "new.txt" && change.status == "A"));
        assert!(status.staged.is_empty());

        git_stage(&project, Some("new.txt")).unwrap();
        let status = project_git_status(&project).unwrap();
        assert!(status
            .staged
            .iter()
            .any(|change| change.path == "new.txt" && change.status == "A"));

        let diff = project_file_diff(&project, "new.txt", true).unwrap();
        assert_eq!(diff.old_content, "");
        assert_eq!(diff.new_content, "new\n");
        assert_eq!(diff.additions, 1);

        let diff = project_file_diff(&project, "tracked.txt", false).unwrap();
        assert_eq!(diff.old_content, "one\n");
        assert_eq!(diff.new_content, "one\ntwo\n");
        assert_eq!(diff.additions, 1);

        git_unstage(&project, Some("new.txt")).unwrap();
        assert!(project_git_status(&project).unwrap().staged.is_empty());
    }

    #[test]
    fn non_repo_status_is_flagged() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("plain");
        std::fs::create_dir_all(&project).unwrap();
        let status = project_git_status(&project).unwrap();
        assert!(!status.is_repo);
    }

    #[test]
    fn tags_are_listed_with_hash() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        git_stdout(&project, &["tag", "v1"]).unwrap();

        let status = project_git_status(&project).unwrap();
        assert_eq!(status.tags.len(), 1);
        assert_eq!(status.tags[0].name, "v1");
        assert!(!status.tags[0].hash.is_empty());
    }

    #[test]
    fn branches_and_commits_are_reported() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        let branches = project_branches(&project);
        let current = branches
            .iter()
            .find(|branch| branch.current)
            .expect("current branch listed");
        assert!(!current.remote);
        assert_eq!(current.subject.as_deref(), Some("init"));
        assert!(current.hash.is_some());
        assert!(current.timestamp.is_some());

        let commits = project_commits(&project, None, 0, 10).unwrap();
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].subject, "init");
        assert!(!commits[0].short_hash.is_empty());

        let head_commits = project_commits(&project, None, 0, 10).unwrap();
        assert_eq!(head_commits.len(), 1);
    }

    #[test]
    fn commit_detail_and_file_diff_are_reported() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        std::fs::write(project.join("tracked.txt"), "one\ntwo\n").unwrap();
        git_stdout(&project, &["add", "--", "tracked.txt"]).unwrap();
        git_stdout(
            &project,
            &[
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=test",
                "commit",
                "-q",
                "-m",
                "second",
            ],
        )
        .unwrap();

        let commits = project_commits(&project, None, 0, 10).unwrap();
        assert_eq!(commits.len(), 2);
        let head = &commits[0];
        assert_eq!(head.subject, "second");
        assert!(!head.refs.is_empty());

        let detail = project_commit_detail(&project, &head.hash).unwrap();
        assert_eq!(detail.subject, "second");
        assert_eq!(detail.changes.len(), 1);
        assert_eq!(detail.changes[0].path, "tracked.txt");
        assert_eq!(detail.changes[0].additions, 1);
        assert_eq!(detail.parents.len(), 1);

        let diff = project_commit_file_diff(&project, &head.hash, "tracked.txt").unwrap();
        assert_eq!(diff.old_content, "one\n");
        assert_eq!(diff.new_content, "one\ntwo\n");
        assert_eq!(diff.additions, 1);
    }

    #[test]
    fn commit_search_matches_message_author_and_hash() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        std::fs::write(project.join("tracked.txt"), "one\ntwo\n").unwrap();
        git_stdout(&project, &["add", "--", "tracked.txt"]).unwrap();
        git_stdout(
            &project,
            &[
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Alice",
                "commit",
                "-q",
                "-m",
                "Add feature",
            ],
        )
        .unwrap();

        let by_message = project_commits(&project, Some("feature"), 0, 10).unwrap();
        assert_eq!(by_message.len(), 1);
        assert_eq!(by_message[0].subject, "Add feature");

        let by_author = project_commits(&project, Some("alice"), 0, 10).unwrap();
        assert_eq!(by_author.len(), 1);

        let prefix = &by_message[0].short_hash[..4];
        let by_hash = project_commits(&project, Some(prefix), 0, 10).unwrap();
        assert_eq!(by_hash.len(), 1);

        let none = project_commits(&project, Some("zzzzz"), 0, 10).unwrap();
        assert!(none.is_empty());
    }

    fn commit(project: &Path, message: &str) {
        git_stdout(project, &["add", "-A", "--", "."]).unwrap();
        git_stdout(
            project,
            &[
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=test",
                "commit",
                "-q",
                "-m",
                message,
            ],
        )
        .unwrap();
    }

    #[test]
    fn branch_create_rename_and_delete_are_supported() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        git_branch_create(&project, "feature", Some("HEAD"), false).unwrap();
        assert!(project_branches(&project)
            .iter()
            .any(|branch| branch.name == "feature"));

        git_branch_rename(&project, "feature", "feature-renamed").unwrap();
        assert!(project_branches(&project)
            .iter()
            .any(|branch| branch.name == "feature-renamed"));

        git_branch_delete(&project, "feature-renamed", false).unwrap();
        assert!(!project_branches(&project)
            .iter()
            .any(|branch| branch.name == "feature-renamed"));
    }

    #[test]
    fn tag_create_supports_lightweight_and_annotated() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        git_tag_create(&project, "v1", Some("HEAD"), None).unwrap();
        git_tag_create(&project, "v2", Some("HEAD"), Some("release two")).unwrap();
        let tags = project_git_status(&project).unwrap().tags;
        assert_eq!(tags.len(), 2);
        assert!(tags.iter().any(|tag| tag.name == "v1"));
        assert!(tags.iter().any(|tag| tag.name == "v2"));
    }

    #[test]
    fn merge_rebase_and_upstream_are_supported() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        let default = project_current_branch(&project).expect("default branch");
        git_branch_create(&project, "feature", Some("HEAD"), true).unwrap();
        std::fs::write(project.join("feature.txt"), "feature\n").unwrap();
        commit(&project, "feature work");

        git_checkout(&project, &default, false, None).unwrap();
        git_merge(&project, "feature").unwrap();
        assert!(project.join("feature.txt").exists());

        git_branch_create(&project, "topic", Some("HEAD"), true).unwrap();
        git_rebase(&project, &default).unwrap();
    }

    #[test]
    fn interactive_rebase_reorders_and_drops_commits() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        std::fs::write(project.join("a.txt"), "a\n").unwrap();
        commit(&project, "a");
        std::fs::write(project.join("b.txt"), "b\n").unwrap();
        commit(&project, "b");
        std::fs::write(project.join("c.txt"), "c\n").unwrap();
        commit(&project, "c");

        let commits = project_rebase_commits(&project, "HEAD~3").unwrap();
        assert_eq!(commits.len(), 3);
        assert_eq!(commits[0].subject, "a");

        let todo = vec![
            ("pick".to_string(), commits[0].hash.clone()),
            ("drop".to_string(), commits[1].hash.clone()),
            ("pick".to_string(), commits[2].hash.clone()),
        ];
        git_rebase_interactive(&project, "HEAD~3", &todo).unwrap();
        let subjects: Vec<String> = project_commits(&project, None, 0, 10)
            .unwrap()
            .into_iter()
            .map(|commit| commit.subject)
            .collect();
        assert_eq!(subjects, vec!["c", "a", "init"]);
    }

    #[test]
    fn fast_forward_advances_branch_to_upstream() {
        let temp = tempfile::tempdir().unwrap();
        let origin = temp.path().join("origin");
        init_repo(&origin);
        let origin_branch = project_current_branch(&origin).expect("origin branch");
        let project = temp.path().join("project");
        git_stdout(
            temp.path(),
            &["clone", "-q", origin.to_str().unwrap(), project.to_str().unwrap()],
        )
        .unwrap();
        git_stdout(
            &project,
            &[
                "checkout",
                "-q",
                "-b",
                "local",
                &format!("origin/{origin_branch}"),
            ],
        )
        .unwrap();

        std::fs::write(origin.join("tracked.txt"), "one\ntwo\n").unwrap();
        commit(&origin, "advance");
        let origin_head = git_stdout(&origin, &["rev-parse", &origin_branch]).unwrap();

        let before = git_stdout(&project, &["rev-parse", "local"]).unwrap();
        git_fast_forward(&project, "local", &format!("origin/{origin_branch}")).unwrap();
        let after = git_stdout(&project, &["rev-parse", "local"]).unwrap();
        assert_ne!(before, after);
        assert_eq!(after, origin_head);
    }

    #[test]
    fn pull_request_urls_are_derived_from_remote() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        git_stdout(
            &project,
            &[
                "remote",
                "add",
                "origin",
                "git@github.com:acme/pumr.git",
            ],
        )
        .unwrap();

        let url = git_pull_request_url(&project, "origin", "feature").unwrap();
        assert_eq!(
            url,
            "https://github.com/acme/pumr/compare/main...feature?expand=1"
        );

        let remotes = project_remotes(&project);
        assert_eq!(remotes, vec!["origin".to_string()]);
    }

    #[test]
    fn discard_removes_staged_new_and_untracked_files() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        std::fs::write(project.join("staged.txt"), "staged\n").unwrap();
        git_stage(&project, Some("staged.txt")).unwrap();
        git_discard(&project, "staged.txt").unwrap();
        assert!(!project.join("staged.txt").exists());
        assert!(project_git_status(&project).unwrap().staged.is_empty());

        std::fs::write(project.join("untracked.txt"), "untracked\n").unwrap();
        git_discard(&project, "untracked.txt").unwrap();
        assert!(!project.join("untracked.txt").exists());

        std::fs::write(project.join("tracked.txt"), "one\ntwo\n").unwrap();
        git_discard(&project, "tracked.txt").unwrap();
        assert_eq!(
            std::fs::read_to_string(project.join("tracked.txt")).unwrap(),
            "one\n"
        );
    }

    #[test]
    fn unstage_works_before_the_first_commit() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        git_stdout(&project, &["init", "-q"]).unwrap();

        std::fs::write(project.join("first.txt"), "first\n").unwrap();
        git_stage(&project, Some("first.txt")).unwrap();
        git_unstage(&project, Some("first.txt")).unwrap();

        let status = project_git_status(&project).unwrap();
        assert!(status.staged.is_empty());
        assert!(project.join("first.txt").exists());
    }

    #[test]
    fn tag_listing_peels_annotated_tags_to_a_commit() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        let head = git_stdout(&project, &["rev-parse", "--short", "HEAD"]).unwrap();

        git_tag_create(&project, "annotated", Some("HEAD"), Some("release")).unwrap();
        git_tag_create(&project, "lightweight", Some("HEAD"), None).unwrap();

        let tags = project_git_status(&project).unwrap().tags;
        for tag in tags {
            assert_eq!(tag.hash, head, "tag {} should peel to the commit", tag.name);
        }
    }

    #[test]
    fn stash_push_pop_and_drop_are_supported() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        std::fs::write(project.join("tracked.txt"), "one\ntwo\n").unwrap();
        git_stash_push(&project, Some("wip"), true).unwrap();
        assert_eq!(
            std::fs::read_to_string(project.join("tracked.txt")).unwrap(),
            "one\n"
        );

        let stashes = project_git_status(&project).unwrap().stashes;
        assert_eq!(stashes.len(), 1);

        git_stash_pop(&project, &stashes[0]).unwrap();
        assert_eq!(
            std::fs::read_to_string(project.join("tracked.txt")).unwrap(),
            "one\ntwo\n"
        );
        assert!(project_git_status(&project).unwrap().stashes.is_empty());

        std::fs::write(project.join("tracked.txt"), "one\nthree\n").unwrap();
        git_stash_push(&project, None, false).unwrap();
        let stashes = project_git_status(&project).unwrap().stashes;
        git_stash_drop(&project, &stashes[0]).unwrap();
        assert!(project_git_status(&project).unwrap().stashes.is_empty());
    }

    #[test]
    fn merge_conflict_state_can_be_aborted() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        let default = project_current_branch(&project).expect("default branch");

        git_branch_create(&project, "feature", Some("HEAD"), true).unwrap();
        std::fs::write(project.join("tracked.txt"), "feature\n").unwrap();
        commit(&project, "feature change");

        git_checkout(&project, &default, false, None).unwrap();
        std::fs::write(project.join("tracked.txt"), "main\n").unwrap();
        commit(&project, "main change");

        let _ = git_merge(&project, "feature");
        let status = project_git_status(&project).unwrap();
        assert_eq!(status.operation.as_deref(), Some("merge"));
        assert!(status.conflicted.iter().any(|path| path == "tracked.txt"));

        git_operation_abort(&project, "merge").unwrap();
        let status = project_git_status(&project).unwrap();
        assert!(status.operation.is_none());
        assert!(status.conflicted.is_empty());
    }

    #[test]
    fn init_creates_a_repository() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        assert!(!project_git_status(&project).unwrap().is_repo);

        git_init(&project).unwrap();
        assert!(project_git_status(&project).unwrap().is_repo);
    }

    #[test]
    fn amend_without_a_message_keeps_the_previous_subject() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        std::fs::write(project.join("tracked.txt"), "one\ntwo\n").unwrap();
        git_stage(&project, None).unwrap();
        git_commit(&project, "second", false).unwrap();

        std::fs::write(project.join("tracked.txt"), "one\ntwo\nthree\n").unwrap();
        git_stage(&project, None).unwrap();
        git_commit(&project, "", true).unwrap();

        let commits = project_commits(&project, None, 0, 10).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "second");
    }
}
