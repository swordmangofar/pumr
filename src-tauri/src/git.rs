use crate::error::{AppError, Result};
use crate::models::{
    FileChange, FileDiff, GitBlameLine, GitBranch, GitCommit, GitCommitDetail, GitInfo, GitRefs,
    GitStash, GitStatus, GitTag,
};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read};
use std::ops::Bound;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

mod hunks;
#[cfg(test)]
mod safety_tests;

pub use hunks::{git_apply_lines, project_file_hunks};

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

/// Paths per `git` invocation, comfortably under the platform ARG_MAX.
const PATH_CHUNK: usize = 512;

/// Larger files are not sent to the diff viewer.
const MAX_DIFF_BYTES: u64 = 4 * 1024 * 1024;

/// Upper bound for the line diff that counts additions and deletions.
const LINE_DIFF_TIMEOUT: Duration = Duration::from_millis(500);

/// Variables that tie a git command to a repository, index or object store
/// other than the one of the folder it runs in: what
/// `git rev-parse --local-env-vars` lists, without the two that only carry
/// `-c` settings. Git sets them for hooks and for `rebase --exec`, so a pumr
/// started from there would run every command in that repository instead.
const REPOSITORY_ENV: [&str; 13] = [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG",
    "GIT_DIR",
    "GIT_GRAFT_FILE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_REPLACE_REF_BASE",
    "GIT_SHALLOW_FILE",
    "GIT_WORK_TREE",
];

/// Settings shared by every git process pumr starts: it works on the
/// repository it is pointed at whatever the environment names, never prompts
/// or opens an editor, never takes optional locks, treats paths literally and
/// reports errors in English so the UI can classify them.
fn configure(command: &mut Command) {
    for name in REPOSITORY_ENV {
        command.env_remove(name);
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .env("GIT_EDITOR", "true")
        // Read-only commands such as `status` otherwise hold `index.lock` while
        // they run, so a stage or commit started meanwhile would fail.
        .env("GIT_OPTIONAL_LOCKS", "0")
        // Paths are file names reported by git, never patterns: discarding
        // `f[1].txt` must not also touch `f1.txt`.
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env_remove("LC_ALL")
        .env("LC_MESSAGES", "C")
        .stdin(Stdio::null());
}

fn git(root: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(["-c", "core.quotepath=false"])
        // `git diff` otherwise rewrites the index to bring its file times up
        // to date, holding `index.lock` like any other write.
        .args(["-c", "diff.autoRefreshIndex=false"]);
    configure(&mut command);
    // A project is the repository in its own folder or none (`is_repo_root`):
    // git must not go looking for one in the folders above. Git works from
    // where a linked folder really is, so that is the folder to stop at;
    // Windows spells resolved paths in a way git does not read (`\\?\C:\`).
    let resolved = match root.canonicalize() {
        Ok(resolved) if !cfg!(windows) => resolved,
        _ => root.to_path_buf(),
    };
    if let Some(parent) = resolved.parent().filter(|parent| parent.is_absolute()) {
        command.env("GIT_CEILING_DIRECTORIES", parent);
    }
    command
}

/// Git for an operation pumr passes no file names to, such as a commit, a
/// merge or a stash. These run the user's hooks and git's own helper commands,
/// which have to read pathspecs the way they do in a terminal: a hook listing
/// `'*.rs'` would otherwise match nothing, and `stash --include-untracked`
/// would leave the files it stashed in the work tree.
fn git_action(root: &Path) -> Command {
    let mut command = git(root);
    command.env_remove("GIT_LITERAL_PATHSPECS");
    command
}

fn git_failure(args: &[&str], output: &Output) -> AppError {
    AppError::msg(format!(
        "git {}: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

/// Runs git and returns its raw stdout, or its stderr as the error.
fn git_bytes(root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let output = git(root).args(args).output()?;
    if !output.status.success() {
        return Err(git_failure(args, &output));
    }
    Ok(output.stdout)
}

/// Runs git and returns stdout as text without trailing whitespace.
fn git_stdout(root: &Path, args: &[&str]) -> Result<String> {
    let stdout = git_bytes(root, args)?;
    Ok(String::from_utf8_lossy(&stdout).trim_end().to_string())
}

/// For queries where a failure or empty output just means "no value".
fn git_stdout_opt(root: &Path, args: &[&str]) -> Option<String> {
    git_stdout(root, args)
        .ok()
        .filter(|value| !value.is_empty())
}

fn git_succeeds(root: &Path, args: &[&str]) -> bool {
    git(root)
        .args(args)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Asks git whether `relative_path` is ignored. `check-ignore` takes plain
/// path names and rejects all pathspec magic, including the `literal` magic
/// that `GIT_LITERAL_PATHSPECS` implies, so that variable is dropped for it.
fn check_ignore(mut command: Command, relative_path: &str) -> bool {
    command
        .env_remove("GIT_LITERAL_PATHSPECS")
        .args(["check-ignore", "-q", "--", relative_path])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Splits NUL-terminated (`-z`) output into its entries. Unlike line output,
/// paths in it are never quoted, so spaces and quotes survive.
fn nul_entries(bytes: &[u8]) -> impl Iterator<Item = String> + '_ {
    bytes
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| String::from_utf8_lossy(entry).into_owned())
}

fn combined_output(output: Output, command: &str) -> Result<String> {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let mut text = stdout;
    if !stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&stderr);
    }
    if !output.status.success() {
        // A failure reports stdout too: that is where git names the conflicts
        // a merge, pick or stash stopped at, and says why nothing was
        // committed.
        if text.is_empty() {
            text = format!("git {command} failed");
        }
        return Err(AppError::msg(text));
    }
    Ok(text)
}

/// Runs an operation without file names (see [`git_action`]) and returns what
/// it printed.
fn git_combined(root: &Path, args: &[&str]) -> Result<String> {
    let output = git_action(root).args(args).output()?;
    combined_output(output, &args.join(" "))
}

type LockMap = OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>>;

/// Git locks only serialize processes and guard no data, so a lock poisoned by
/// a panic is still safe to use.
fn lock_ignoring_poison<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn keyed_lock(locks: &'static LockMap, key: &Path) -> Arc<Mutex<()>> {
    let mut locks = lock_ignoring_poison(locks.get_or_init(Default::default));
    locks.entry(key.to_path_buf()).or_default().clone()
}

/// All `ShadowRepo` instances for the same project share one lock so that
/// concurrent turns (and parallel subagents) never race on the git index.
fn shadow_lock(git_dir: &Path) -> Arc<Mutex<()>> {
    static LOCKS: LockMap = OnceLock::new();
    keyed_lock(&LOCKS, git_dir)
}

/// Serializes commands that write to a repository (index, HEAD, refs, config)
/// so two quick UI actions never collide on `index.lock`. Reads run without
/// optional locks and never wait on this.
fn with_repo_lock<T>(root: &Path, operation: impl FnOnce() -> Result<T>) -> Result<T> {
    static LOCKS: LockMap = OnceLock::new();
    let key = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let lock = keyed_lock(&LOCKS, &key);
    let _guard = lock_ignoring_poison(&lock);
    operation()
}

/// Rejects a ref, remote or name from the frontend that git could read as an
/// option or that carries control characters (a newline would also add a line
/// to a rebase todo). Git validates the ref format itself.
fn ensure_arg<'a>(value: &'a str, what: &str) -> Result<&'a str> {
    if value.is_empty() || value.starts_with('-') || value.chars().any(char::is_control) {
        return Err(AppError::msg(format!("invalid {what}: {value:?}")));
    }
    Ok(value)
}

fn ensure_hash(value: &str) -> Result<&str> {
    if (4..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(value)
    } else {
        Err(AppError::msg(format!("invalid commit hash: {value:?}")))
    }
}

/// Stash entries are only ever addressed as `stash@{N}`.
fn ensure_stash(value: &str) -> Result<&str> {
    let index = value
        .strip_prefix("stash@{")
        .and_then(|rest| rest.strip_suffix('}'));
    match index {
        Some(index) if !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit()) => {
            Ok(value)
        }
        _ => Err(AppError::msg(format!("invalid stash: {value:?}"))),
    }
}

/// Accepts only repository-relative paths: no absolute paths, no `..` and
/// nothing in a `.git`, which holds a repository's own data and is never a
/// path git lists.
fn ensure_relative_path(path: &str) -> Result<&str> {
    let valid = !path.is_empty()
        && Path::new(path)
            .components()
            .all(|component| match component {
                Component::Normal(name) => !name.eq_ignore_ascii_case(".git"),
                Component::CurDir => true,
                _ => false,
            });
    if valid {
        Ok(path)
    } else {
        Err(AppError::msg(format!("invalid path: {path:?}")))
    }
}

/// Resolves a repository-relative path to its directory entry. Its parent
/// folders must resolve inside the project, so a symlinked folder cannot
/// redirect a read or delete elsewhere; a symlink in the last component is
/// handled as the link itself and never followed.
pub(crate) fn project_entry(root: &Path, path: &str) -> Result<PathBuf> {
    let relative = Path::new(ensure_relative_path(path)?);
    let name = relative
        .file_name()
        .ok_or_else(|| AppError::msg(format!("invalid path: {path:?}")))?;
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let directory = match relative.parent() {
        Some(parent) => canonical_root.join(parent),
        None => canonical_root.clone(),
    };
    let outside = || AppError::msg("path is outside the project");
    let mut probe = directory.as_path();
    loop {
        if probe.exists() {
            if !probe.canonicalize()?.starts_with(&canonical_root) {
                return Err(outside());
            }
            break;
        }
        probe = match probe.parent() {
            Some(parent) if parent.starts_with(&canonical_root) => parent,
            _ => return Err(outside()),
        };
    }
    Ok(directory.join(name))
}

/// Deletes an untracked file, a symlink (the link, not its target) or a
/// directory. A missing entry counts as already deleted.
fn remove_entry(entry: &Path) -> Result<()> {
    match std::fs::symlink_metadata(entry) {
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(entry)?,
        Ok(_) => std::fs::remove_file(entry).or_else(|error| {
            // Windows removes directory symlinks as directories.
            if cfg!(windows) {
                std::fs::remove_dir(entry)
            } else {
                Err(error)
            }
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

/// Parses `--numstat -z` output. Renames are disabled everywhere, so every
/// entry is `added TAB deleted TAB path`; binary files report `-` and count 0.
fn parse_numstat(bytes: &[u8]) -> HashMap<String, (i64, i64)> {
    nul_entries(bytes)
        .filter_map(|entry| {
            let mut parts = entry.splitn(3, '\t');
            let additions = parts.next()?.parse().unwrap_or(0);
            let deletions = parts.next()?.parse().unwrap_or(0);
            let path = parts.next()?.to_string();
            Some((path, (additions, deletions)))
        })
        .collect()
}

/// Parses `--name-status -z` output (`STATUS NUL path NUL`, renames disabled)
/// and attaches the line counts from a numstat parse.
fn parse_name_status(bytes: &[u8], stats: &HashMap<String, (i64, i64)>) -> Vec<FileChange> {
    let mut entries = nul_entries(bytes);
    let mut changes = Vec::new();
    while let (Some(status), Some(path)) = (entries.next(), entries.next()) {
        let (additions, deletions) = stats.get(&path).copied().unwrap_or((0, 0));
        changes.push(FileChange {
            status: status.chars().next().unwrap_or('M').to_string(),
            path,
            additions,
            deletions,
        });
    }
    changes
}

/// One side of a file diff.
pub(crate) enum DiffSide {
    Missing,
    Content(Vec<u8>),
    TooLarge,
}

impl DiffSide {
    fn exists(&self) -> bool {
        !matches!(self, DiffSide::Missing)
    }

    fn into_bytes(self) -> Vec<u8> {
        match self {
            DiffSide::Content(bytes) => bytes,
            DiffSide::Missing | DiffSide::TooLarge => Vec::new(),
        }
    }
}

/// Loads a blob such as `HEAD:path` or `:0:path` for a diff, checking its size
/// before reading it.
fn blob_side(run: &dyn Fn(&[&str]) -> Result<Vec<u8>>, spec: &str) -> DiffSide {
    let Ok(size) = run(&["cat-file", "-s", spec]) else {
        return DiffSide::Missing;
    };
    let size: u64 = String::from_utf8_lossy(&size).trim().parse().unwrap_or(0);
    if size > MAX_DIFF_BYTES {
        return DiffSide::TooLarge;
    }
    run(&["cat-file", "blob", spec])
        .map(DiffSide::Content)
        .unwrap_or(DiffSide::Missing)
}

/// Loads the working-tree side of a diff. A symlink shows its target path,
/// the way git stores it, instead of being followed.
pub(crate) fn worktree_side(entry: &Path) -> DiffSide {
    let Ok(metadata) = std::fs::symlink_metadata(entry) else {
        return DiffSide::Missing;
    };
    if metadata.file_type().is_symlink() {
        return std::fs::read_link(entry)
            .map(|target| DiffSide::Content(target.to_string_lossy().into_owned().into_bytes()))
            .unwrap_or(DiffSide::Missing);
    }
    if !metadata.is_file() {
        return DiffSide::Missing;
    }
    if metadata.len() > MAX_DIFF_BYTES {
        return DiffSide::TooLarge;
    }
    std::fs::read(entry)
        .map(DiffSide::Content)
        .unwrap_or(DiffSide::Missing)
}

/// Git's own heuristic: a NUL byte in the first 8000 bytes means binary.
fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|byte| *byte == 0)
}

/// Builds the diff shown in the UI. The status comes from which sides exist
/// (not from whether they are empty), and binary or oversized files are
/// flagged instead of being sent as text.
pub(crate) fn build_file_diff(path: &str, old: DiffSide, new: DiffSide) -> FileDiff {
    let status = match (old.exists(), new.exists()) {
        (false, true) => "A",
        (true, false) => "D",
        _ => "M",
    };
    let too_large = matches!(old, DiffSide::TooLarge) || matches!(new, DiffSide::TooLarge);
    let (old, new) = (old.into_bytes(), new.into_bytes());
    let binary = !too_large && (is_binary(&old) || is_binary(&new));
    let (old_content, new_content, additions, deletions) = if too_large || binary {
        (String::new(), String::new(), 0, 0)
    } else {
        let old = String::from_utf8_lossy(&old).into_owned();
        let new = String::from_utf8_lossy(&new).into_owned();
        let (additions, deletions) = count_line_changes(&old, &new);
        (old, new, additions, deletions)
    };
    FileDiff {
        path: path.to_string(),
        old_content,
        new_content,
        language: language_for(path).to_string(),
        additions,
        deletions,
        status: status.to_string(),
        binary,
        too_large,
    }
}

pub fn shadow_dir(app_data_dir: &Path, project_id: &str) -> PathBuf {
    app_data_dir.join("shadow").join(project_id)
}

/// Deletes the shadow repository of a removed project.
pub fn remove_shadow(app_data_dir: &Path, project_id: &str) -> Result<()> {
    let git_dir = shadow_dir(app_data_dir, project_id);
    let lock = shadow_lock(&git_dir);
    let _guard = lock_ignoring_poison(&lock);
    match std::fs::remove_dir_all(&git_dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// The folder of a shadow repository that holds one note per snapshot: the
/// paths that snapshot left out because they were ignored.
const IGNORED_NOTES: &str = "pumr-ignored";

/// Whether `path` is one of the noted `ignored` paths or lies in an ignored
/// folder, which a note names with a trailing `/`.
fn was_ignored(ignored: &HashSet<String>, path: &str) -> bool {
    ignored.contains(path)
        || path
            .match_indices('/')
            .any(|(end, _)| ignored.contains(&path[..=end]))
}

/// Whether `path` names an ignore file that git reads in the work tree.
fn is_ignore_file(path: &str) -> bool {
    path == ".gitignore" || path.ends_with("/.gitignore")
}

pub struct ShadowRepo {
    git_dir: PathBuf,
    work_tree: PathBuf,
    lock: Arc<Mutex<()>>,
}

impl ShadowRepo {
    pub fn open(app_data_dir: &Path, project_id: &str, project_path: &Path) -> Result<Self> {
        let git_dir = shadow_dir(app_data_dir, project_id);
        let repo = Self {
            lock: shadow_lock(&git_dir),
            git_dir,
            work_tree: project_path.to_path_buf(),
        };
        repo.ensure_init()?;
        Ok(repo)
    }

    fn ensure_init(&self) -> Result<()> {
        let _guard = lock_ignoring_poison(&self.lock);
        // The exclude file is written last, so it marks a completed setup; an
        // interrupted one is simply redone (`git init` is idempotent).
        let exclude = self.git_dir.join("info").join("exclude");
        if self.git_dir.join("HEAD").exists() && exclude.exists() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.git_dir)?;
        let mut command = Command::new("git");
        configure(&mut command);
        // An empty `--template=` skips the user's `init.templateDir`, which may
        // carry hooks.
        let output = command
            .args(["init", "--bare", "--quiet", "--template="])
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
            ("core.worktree", &self.work_tree.to_string_lossy()),
            ("user.name", "pumr"),
            ("user.email", "pumr@local"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
            ("core.quotepath", "false"),
        ] {
            self.run(["config", key, value])?;
        }
        std::fs::create_dir_all(self.git_dir.join("info"))?;
        std::fs::write(exclude, DEFAULT_EXCLUDES)?;
        Ok(())
    }

    fn command(&self) -> Command {
        // Snapshots must never run the user's hooks, including global ones.
        let mut hooks = OsString::from("core.hooksPath=");
        hooks.push(self.git_dir.join("no-hooks"));
        let mut command = Command::new("git");
        command
            .arg("--git-dir")
            .arg(&self.git_dir)
            .arg("--work-tree")
            .arg(&self.work_tree)
            .arg("-c")
            .arg(hooks)
            .current_dir(&self.work_tree);
        configure(&mut command);
        command
    }

    fn run_bytes<I, S>(&self, args: I) -> Result<Vec<u8>>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let output = self.command().args(args).output()?;
        if !output.status.success() {
            return Err(AppError::msg(format!(
                "shadow git failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        Ok(output.stdout)
    }

    fn run<I, S>(&self, args: I) -> Result<String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let stdout = self.run_bytes(args)?;
        Ok(String::from_utf8_lossy(&stdout).trim().to_string())
    }

    fn stage_all_unlocked(&self) -> Result<()> {
        // A folder that is a repository without a commit cannot be staged,
        // not even as a link, and `git add` stops at the first one. With
        // `--ignore-errors` it stages everything else and names each of them,
        // so those folders are left out and any other error still fails.
        let output = self
            .command()
            .args(["add", "-A", "--ignore-errors", "--", "."])
            .output()?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let mut errors = stderr
            .lines()
            .filter(|line| line.starts_with("error: ") || line.starts_with("fatal: "))
            .peekable();
        let only_unborn = errors.peek().is_some()
            && errors.all(|line| line.ends_with("' does not have a commit checked out"));
        if only_unborn {
            Ok(())
        } else {
            Err(AppError::msg(format!(
                "shadow git failed: {}",
                stderr.trim()
            )))
        }
    }

    pub fn snapshot(&self, message: &str) -> Result<String> {
        let _guard = lock_ignoring_poison(&self.lock);
        self.stage_all_unlocked()?;
        self.run([
            "commit",
            "--allow-empty",
            "--no-verify",
            "--quiet",
            "-m",
            message,
        ])?;
        let head = self.head()?;
        self.note_ignored_unlocked(&head);
        Ok(head)
    }

    /// Notes which paths the snapshot `commit` left out because they were
    /// ignored: a folder an ignore pattern names as `folder/`, everything else
    /// file by file. They were there when it was taken although it does not
    /// hold them, and nothing else says so once an ignore file changes.
    /// Without a note (git failed, or the snapshot is older than the notes)
    /// `restore_to` falls back to keeping more.
    fn note_ignored_unlocked(&self, commit: &str) {
        // `--ignore-submodules` keeps git from running a status of its own in
        // every nested repository.
        let Ok(status) = self.run_bytes([
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=normal",
            "--ignored=matching",
            "--ignore-submodules=all",
        ]) else {
            return;
        };
        let mut listing = Vec::new();
        for entry in status.split(|byte| *byte == 0) {
            if let Some(path) = entry.strip_prefix(b"!! ") {
                listing.extend_from_slice(path);
                listing.push(0);
            }
        }
        let folder = self.git_dir.join(IGNORED_NOTES);
        if std::fs::create_dir_all(&folder).is_err() {
            return;
        }
        let note = folder.join(commit);
        // Most snapshots leave out what the one before left out. A hard link
        // to that note takes no room, however long the list is.
        let latest = folder.join("latest");
        let unchanged = std::fs::read(&latest).is_ok_and(|previous| previous == listing);
        if unchanged && std::fs::hard_link(&latest, &note).is_ok() {
            return;
        }
        // Written under another name first, so a note is never half a list.
        let draft = folder.join("draft");
        if std::fs::write(&draft, &listing).is_ok() && std::fs::rename(&draft, &note).is_ok() {
            let _ = std::fs::remove_file(&latest);
            let _ = std::fs::hard_link(&note, &latest);
        }
    }

    /// The note of the snapshot `commit`, or `None` when it has none.
    fn ignored_at(&self, commit: &str) -> Option<HashSet<String>> {
        let name = ensure_hash(commit).ok()?;
        let note = std::fs::read(self.git_dir.join(IGNORED_NOTES).join(name)).ok()?;
        Some(nul_entries(&note).collect())
    }

    /// Takes the additions out of `changes` that the snapshot `base` left out
    /// as ignored and returns them: they were there before, and only look new
    /// because an ignore file was changed or deleted since. `None` when the
    /// snapshot has no note to tell.
    fn take_formerly_ignored(
        &self,
        base: &str,
        changes: &mut Vec<FileChange>,
    ) -> Option<Vec<FileChange>> {
        let ignored = self.ignored_at(base)?;
        let (formerly_ignored, rest) = std::mem::take(changes)
            .into_iter()
            .partition(|change| change.status == "A" && was_ignored(&ignored, &change.path));
        *changes = rest;
        Some(formerly_ignored)
    }

    pub fn head(&self) -> Result<String> {
        self.run(["rev-parse", "HEAD"])
    }

    /// Changes for `revisions` (`--cached <commit>` or `<from> <to>`). Rename
    /// detection stays off so a rename is a delete plus an add: both paths are
    /// reported, and restoring removes the new one.
    fn diff_unlocked(&self, revisions: &[&str]) -> Result<Vec<FileChange>> {
        let mut numstat = vec!["diff", "--numstat", "-z", "--no-renames"];
        numstat.extend(revisions);
        numstat.push("--");
        let stats = parse_numstat(&self.run_bytes(&numstat)?);
        let mut name_status = vec!["diff", "--name-status", "-z", "--no-renames"];
        name_status.extend(revisions);
        name_status.push("--");
        Ok(parse_name_status(&self.run_bytes(&name_status)?, &stats))
    }

    /// Changes of the working tree since the snapshot `base`. A file that
    /// snapshot left out as ignored is not reported as added when an ignore
    /// file stops covering it.
    pub fn changes_since(&self, base: &str) -> Result<Vec<FileChange>> {
        let _guard = lock_ignoring_poison(&self.lock);
        self.stage_all_unlocked()?;
        let mut changes = self.diff_unlocked(&["--cached", base])?;
        self.take_formerly_ignored(base, &mut changes);
        Ok(changes)
    }

    /// Changes between two shadow commits. Unlike `changes_since`, this never
    /// looks at the live working tree, so it isolates exactly what happened in
    /// the range and cannot pick up edits made by other sessions.
    pub fn changes_between(&self, base: &str, after: &str) -> Result<Vec<FileChange>> {
        let _guard = lock_ignoring_poison(&self.lock);
        let mut changes = self.diff_unlocked(&[base, after])?;
        self.take_formerly_ignored(base, &mut changes);
        Ok(changes)
    }

    /// Whether `ancestor` is `commit` or one of its ancestors. Snapshots form
    /// one line of history, so this says which of two was taken first.
    pub fn is_ancestor(&self, ancestor: &str, commit: &str) -> bool {
        if ancestor.is_empty() || commit.is_empty() {
            return false;
        }
        self.command()
            .args(["merge-base", "--is-ancestor", ancestor, commit])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    /// Loads `relative_path` as of `commit` for a diff.
    pub(crate) fn side_at(&self, commit: &str, relative_path: &str) -> DiffSide {
        blob_side(
            &|args| self.run_bytes(args),
            &format!("{commit}:{relative_path}"),
        )
    }

    pub fn restore_to(&self, commit: &str) -> Result<Vec<String>> {
        let _guard = lock_ignoring_poison(&self.lock);
        self.stage_all_unlocked()?;
        let mut changes = self.diff_unlocked(&["--cached", commit])?;
        // Only what was made after the snapshot may be deleted. A file it left
        // out as ignored was there before and is not in it, so it could never
        // be brought back.
        let kept = match self.take_formerly_ignored(commit, &mut changes) {
            Some(kept) => kept,
            // An older snapshot does not say what it left out. Ignored files
            // only look new once an ignore file changed, and then every
            // addition is kept.
            None if changes.iter().any(|change| is_ignore_file(&change.path)) => {
                let (kept, rest) = std::mem::take(&mut changes)
                    .into_iter()
                    .partition(|change| change.status == "A");
                changes = rest;
                kept
            }
            None => Vec::new(),
        };
        let mut restore = Vec::new();
        for change in &changes {
            if change.status == "A" {
                // Only files and links are removed; a directory the snapshot
                // tracks as a nested repository is left alone.
                let absolute = self.work_tree.join(&change.path);
                let is_dir = std::fs::symlink_metadata(&absolute)
                    .map(|metadata| metadata.is_dir())
                    .unwrap_or(false);
                if !is_dir {
                    remove_entry(&absolute)?;
                }
            } else {
                restore.push(change.path.as_str());
            }
        }
        for chunk in restore.chunks(PATH_CHUNK) {
            let mut args = vec!["checkout", commit, "--"];
            args.extend(chunk);
            self.run(&args)?;
        }
        // What was kept leaves the index, so the files an ignore file covers
        // again are ignored again; the others are staged right back.
        let kept: Vec<&str> = kept.iter().map(|change| change.path.as_str()).collect();
        for chunk in kept.chunks(PATH_CHUNK) {
            let mut args = vec!["rm", "--cached", "-f", "--quiet", "--ignore-unmatch", "--"];
            args.extend(chunk);
            self.run(&args)?;
        }
        self.stage_all_unlocked()?;
        Ok(changes.into_iter().map(|change| change.path).collect())
    }

    pub fn is_ignored(&self, relative_path: &str) -> bool {
        check_ignore(self.command(), relative_path)
    }

    /// Untracked files and folders at or below `path` that snapshots skip
    /// because `.gitignore` (or the default excludes) ignores them, relative to
    /// the project root. A wholly ignored folder is listed once, with a
    /// trailing `/`. `None` when `path` is not below the project root, when
    /// it lies in, is or holds a repository of its own, or when git fails, so
    /// callers treat it as not restorable.
    pub fn ignored_entries(&self, path: &Path) -> Option<Vec<String>> {
        let relative = path.strip_prefix(&self.work_tree).ok()?.to_str()?;
        if relative.is_empty() || self.touches_repository(relative) {
            return None;
        }
        let output = self
            .run_bytes([
                "ls-files",
                "-z",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
                "--",
                relative,
            ])
            .ok()?;
        Some(
            output
                .split(|byte| *byte == 0)
                .filter(|entry| !entry.is_empty())
                .map(|entry| String::from_utf8_lossy(entry).into_owned())
                .collect(),
        )
    }

    /// Whether `relative` lies in, is or holds a repository of its own: a
    /// clone, a submodule or a linked worktree. A snapshot keeps the commit
    /// such a folder has checked out and nothing else, and nothing at all
    /// before its first commit, so its `.git`, its history and its
    /// uncommitted files cannot be restored.
    fn touches_repository(&self, relative: &str) -> bool {
        let is_repository = |folder: &Path| {
            std::fs::symlink_metadata(folder).is_ok_and(|metadata| metadata.is_dir())
                && std::fs::symlink_metadata(folder.join(".git")).is_ok()
        };
        // On the way down to the path and at the path itself.
        let mut folder = self.work_tree.clone();
        for component in Path::new(relative).components() {
            if component.as_os_str().eq_ignore_ascii_case(".git") {
                return true;
            }
            folder.push(component);
            if is_repository(&folder) {
                return true;
            }
        }
        // Below the path git says where to look, so nothing it ignores is
        // walked. The index holds a repository with a commit as a link (mode
        // 160000). One without a commit is an untracked folder that git lists
        // but does not enter. And a folder whose files were tracked before it
        // became a repository keeps them as plain entries, so the folders of
        // all entries are looked at as well.
        let Ok(entries) = self.run_bytes([
            "ls-files",
            "-z",
            "--stage",
            "--others",
            "--exclude-standard",
            "--",
            relative,
        ]) else {
            return true;
        };
        let mut looked_at = HashSet::new();
        for entry in entries.split(|byte| *byte == 0) {
            if entry.starts_with(b"160000 ") || entry.ends_with(b"/") {
                return true;
            }
            // An index entry is `mode hash stage TAB path`, an untracked one
            // just the path.
            let path = entry
                .splitn(2, |byte| *byte == b'\t')
                .last()
                .unwrap_or(entry);
            let path = String::from_utf8_lossy(path);
            for parent in Path::new(path.as_ref()).ancestors().skip(1) {
                // A folder seen before had the ones above it looked at too.
                if parent.as_os_str().is_empty() || !looked_at.insert(parent.to_path_buf()) {
                    break;
                }
                if is_repository(&self.work_tree.join(parent)) {
                    return true;
                }
            }
        }
        false
    }
}

/// A project is a repository when it is the root of one: `.git` is a folder,
/// or a file for linked worktrees and submodules. Repositories in parent
/// folders are deliberately not picked up: a home directory kept under version
/// control (dotfiles) would otherwise turn every project inside it into that
/// repository.
pub fn is_repo_root(project_root: &Path) -> bool {
    project_root.join(".git").exists()
}

pub struct GitProbe<'a> {
    pub project_root: &'a Path,
    pub shadow: Option<&'a ShadowRepo>,
}

impl GitProbe<'_> {
    pub fn is_ignored(&self, relative_path: &str) -> bool {
        if is_repo_root(self.project_root) {
            return check_ignore(git(self.project_root), relative_path);
        }
        self.shadow
            .map(|shadow| shadow.is_ignored(relative_path))
            .unwrap_or(false)
    }
}

/// The checked-out branch, or `None` when HEAD is detached. Unlike
/// `rev-parse --abbrev-ref`, this also names a branch that has no commit yet.
/// The name is cut from the full ref: `--short` would print `heads/name`
/// while a tag is called the same.
pub fn project_current_branch(project_root: &Path) -> Option<String> {
    let head = git_stdout_opt(project_root, &["symbolic-ref", "-q", "HEAD"])?;
    Some(
        head.strip_prefix("refs/heads/")
            .unwrap_or(&head)
            .to_string(),
    )
}

/// The revision that names the branch `name` for commands that take any
/// revision. They read a bare name as the tag when a tag is called the same,
/// so the branch is then spelled `heads/name` (or `remotes/origin/name`).
/// Anything that is not a branch, such as a commit hash, is returned as it is.
fn branch_revision(project_root: &Path, name: &str) -> String {
    // A full hash always means the commit.
    if matches!(name.len(), 40 | 64) && name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return name.to_string();
    }
    ["refs/heads/", "refs/remotes/"]
        .iter()
        .find_map(|namespace| {
            let full = format!("{namespace}{name}");
            git_stdout_opt(
                project_root,
                &["rev-parse", "--verify", "-q", "--abbrev-ref", &full],
            )
        })
        .unwrap_or_else(|| name.to_string())
}

pub fn project_git_info(project_root: &Path) -> GitInfo {
    GitInfo {
        is_repo: is_repo_root(project_root),
        branch: project_current_branch(project_root),
        head: git_stdout_opt(project_root, &["rev-parse", "--short", "HEAD"]),
    }
}

/// Returns the subset of `paths` that git considers ignored. All paths are
/// checked in a single `git check-ignore` invocation for performance. Projects
/// that are not a repository root return an empty set.
pub fn ignored_paths(project_root: &Path, paths: &[PathBuf]) -> HashSet<PathBuf> {
    use std::io::Write;
    if paths.is_empty() || !is_repo_root(project_root) {
        return HashSet::new();
    }
    let mut command = git(project_root);
    // See `check_ignore`: this command rejects literal pathspec magic.
    command
        .env_remove("GIT_LITERAL_PATHSPECS")
        .args(["check-ignore", "--stdin", "-z"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return HashSet::new(),
    };
    // Feed stdin from a separate thread. `git check-ignore` echoes every ignored
    // path to stdout, so writing the payload inline before draining stdout can
    // deadlock once the OS pipe buffer fills (git blocks on stdout and stops
    // reading stdin, while we block writing it).
    let writer = child.stdin.take().map(|mut stdin| {
        let mut payload: Vec<u8> = Vec::new();
        for path in paths {
            payload.extend_from_slice(path.to_string_lossy().as_bytes());
            payload.push(0);
        }
        std::thread::spawn(move || {
            let _ = stdin.write_all(&payload);
        })
    });
    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(_) => return HashSet::new(),
    };
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    String::from_utf8_lossy(&output.stdout)
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .map(PathBuf::from)
        .collect()
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

/// Splits `remote/branch` using the known remotes, preferring the longest
/// match, so remote names that contain `/` work.
fn split_remote_ref(remotes: &[String], name: &str) -> Option<(String, String)> {
    remotes
        .iter()
        .filter_map(|remote| {
            let branch = name.strip_prefix(remote.as_str())?.strip_prefix('/')?;
            (!branch.is_empty()).then(|| (remote.clone(), branch.to_string()))
        })
        .max_by_key(|(remote, _)| remote.len())
}

fn non_empty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_string())
}

/// The name is the ref without `refs/heads/` or `refs/remotes/`, the form the
/// branch commands take. `%(refname:short)` is not: it prints `heads/name`
/// while a tag is called the same.
const BRANCH_FORMAT: &str = "--format=%(refname)%1f%(refname:lstrip=2)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:remotename)%1f%(upstream:remoteref)%1f%(objectname)%1f%(committerdate:unix)%1f%(contents:subject)";

fn project_branches(project_root: &Path, remotes: &[String]) -> Vec<GitBranch> {
    let Some(output) = git_stdout_opt(
        project_root,
        &["for-each-ref", BRANCH_FORMAT, "refs/heads", "refs/remotes"],
    ) else {
        return Vec::new();
    };
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(9, '\u{1f}');
            let full = parts.next()?;
            let name = parts.next()?.to_string();
            let head = parts.next().unwrap_or("");
            let upstream = parts.next().unwrap_or("");
            let upstream_remote = parts.next().unwrap_or("");
            let upstream_ref = parts.next().unwrap_or("");
            let hash = parts.next().unwrap_or("");
            let timestamp = parts
                .next()
                .unwrap_or("")
                .parse::<i64>()
                .ok()
                .map(|seconds| seconds * 1000);
            let subject = parts.next().unwrap_or("");
            let remote_tracking = full.strip_prefix("refs/remotes/");
            // `refs/remotes/origin/HEAD` is a pointer, not a branch.
            if name.is_empty() || remote_tracking.is_some_and(|rest| rest.ends_with("/HEAD")) {
                return None;
            }
            let (remote_name, remote_branch) = match remote_tracking {
                Some(rest) => match split_remote_ref(remotes, rest) {
                    Some((remote, branch)) => (Some(remote), Some(branch)),
                    None => (None, None),
                },
                None => (
                    non_empty(upstream_remote),
                    non_empty(
                        upstream_ref
                            .strip_prefix("refs/heads/")
                            .unwrap_or(upstream_ref),
                    ),
                ),
            };
            Some(GitBranch {
                name,
                current: head == "*",
                remote: remote_tracking.is_some(),
                upstream: non_empty(upstream),
                remote_name,
                remote_branch,
                hash: non_empty(hash),
                subject: non_empty(subject),
                timestamp,
            })
        })
        .collect()
}

fn project_tags(project_root: &Path) -> Vec<GitTag> {
    // `lstrip=2` for the plain name, see `BRANCH_FORMAT`.
    let format = "--format=%(refname:lstrip=2)%1f%(objecttype)%1f%(objectname)%1f%(*objectname)";
    git_stdout_opt(project_root, &["tag", "--sort=-creatordate", format])
        .map(|output| {
            output
                .lines()
                .filter_map(|line| {
                    let mut parts = line.splitn(4, '\u{1f}');
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
                        peeled_hash
                    } else {
                        object_hash
                    };
                    Some(GitTag {
                        name,
                        hash: hash.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn project_stashes(project_root: &Path) -> Vec<GitStash> {
    git_stdout_opt(
        project_root,
        &["stash", "list", "--format=%gd%x1f%H%x1f%gs"],
    )
    .map(|output| {
        output
            .lines()
            .filter_map(|line| {
                let mut parts = line.splitn(3, '\u{1f}');
                Some(GitStash {
                    name: parts.next()?.to_string(),
                    hash: parts.next()?.to_string(),
                    message: parts.next().unwrap_or("").to_string(),
                })
            })
            .collect()
    })
    .unwrap_or_default()
}

/// Submodule paths from `.gitmodules`; read as NUL-separated config so paths
/// with spaces survive and no submodule has to be inspected.
fn project_submodules(project_root: &Path) -> Vec<String> {
    let Ok(output) = git_bytes(
        project_root,
        &[
            "config",
            "-z",
            "--file",
            ".gitmodules",
            "--get-regexp",
            r"^submodule\..*\.path$",
        ],
    ) else {
        return Vec::new();
    };
    nul_entries(&output)
        .filter_map(|entry| entry.split_once('\n').map(|(_, path)| path.to_string()))
        .collect()
}

/// Branches, tags, stashes, submodules and remotes. Loaded separately from
/// the working-tree status because they only change on ref operations, not on
/// every stage or discard.
pub fn project_git_refs(project_root: &Path) -> Result<GitRefs> {
    if !is_repo_root(project_root) {
        return Ok(GitRefs::default());
    }
    let remotes = project_remotes(project_root);
    Ok(GitRefs {
        branches: project_branches(project_root, &remotes),
        tags: project_tags(project_root),
        stashes: project_stashes(project_root),
        submodules: project_submodules(project_root),
        remotes,
    })
}

const COMMIT_FORMAT: &str = "--format=%H%x1f%h%x1f%an%x1f%at%x1f%D%x1f%P%x1f%s%x1e";
/// `COMMIT_FORMAT` plus the author email and the full message, for searching.
const SEARCH_FORMAT: &str = "--format=%H%x1f%h%x1f%an%x1f%at%x1f%D%x1f%P%x1f%s%x1f%ae%x1f%B%x1e";

pub fn project_commits(
    project_root: &Path,
    query: Option<&str>,
    path: Option<&str>,
    skip: usize,
    limit: usize,
) -> Result<Vec<GitCommit>> {
    let query = query
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let path = path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    // `log.showSignature` would print what it finds out about a signature
    // in front of each commit.
    let mut args = vec!["log", "--no-show-signature"];
    match &path {
        Some(path) => {
            ensure_relative_path(path)?;
            // File history follows HEAD, which does not exist before the
            // first commit.
            if !git_succeeds(project_root, &["rev-parse", "--verify", "-q", "HEAD"]) {
                return Ok(Vec::new());
            }
            args.push("--follow");
        }
        // Date order keeps every parent below its children, which the graph
        // relies on; plain order does not when clocks were skewed.
        None => args.extend(["--all", "--date-order"]),
    }
    args.push("--decorate=short");
    let skip_arg = format!("--skip={skip}");
    let limit_arg = format!("--max-count={limit}");
    match &query {
        None => args.extend([COMMIT_FORMAT, skip_arg.as_str(), limit_arg.as_str()]),
        Some(_) => args.push(SEARCH_FORMAT),
    }
    args.push("--");
    if let Some(path) = &path {
        args.push(path);
    }
    match &query {
        None => Ok(parse_commits(&git_stdout(project_root, &args)?)),
        Some(query) => search_log(project_root, &args, query, skip, limit),
    }
}

/// Streams `git log` and keeps commits whose hash, author or message contains
/// `query` (ignoring case). Every commit is seen once, in log order, and
/// reading stops as soon as the requested page is complete.
fn search_log(
    project_root: &Path,
    args: &[&str],
    query: &str,
    skip: usize,
    limit: usize,
) -> Result<Vec<GitCommit>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let needle = query.to_lowercase();
    let hash_prefix = (needle.len() >= 4 && needle.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(&needle);
    let mut child = git(project_root)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    // Drain stderr on its own thread so a chatty git cannot block on it while
    // this thread waits for stdout.
    let stderr = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });
    let mut commits = Vec::new();
    let mut matched = 0usize;
    let mut complete = false;
    if let Some(stdout) = child.stdout.take() {
        let mut reader = BufReader::new(stdout);
        let mut record = Vec::new();
        loop {
            record.clear();
            if reader.read_until(0x1e, &mut record)? == 0 {
                break;
            }
            let text = String::from_utf8_lossy(&record);
            let text = text
                .trim_start_matches(['\n', '\r'])
                .trim_end_matches('\u{1e}');
            let fields: Vec<&str> = text.splitn(9, '\u{1f}').collect();
            let Some(commit) = commit_from_fields(&fields) else {
                continue;
            };
            let email = fields.get(7).copied().unwrap_or("");
            let message = fields.get(8).copied().unwrap_or("");
            let found = hash_prefix.is_some_and(|prefix| commit.hash.starts_with(prefix.as_str()))
                || commit.author.to_lowercase().contains(&needle)
                || email.to_lowercase().contains(&needle)
                || message.to_lowercase().contains(&needle);
            if !found {
                continue;
            }
            matched += 1;
            if matched > skip {
                commits.push(commit);
                if commits.len() >= limit {
                    complete = true;
                    break;
                }
            }
        }
    }
    if complete {
        let _ = child.kill();
    }
    let status = child.wait()?;
    let stderr = stderr_reader.join().unwrap_or_default();
    if !complete && !status.success() {
        return Err(AppError::msg(format!("git log: {}", stderr.trim())));
    }
    Ok(commits)
}

fn commit_from_fields(fields: &[&str]) -> Option<GitCommit> {
    let [hash, short_hash, author, timestamp, refs, parents, subject, ..] = fields else {
        return None;
    };
    Some(GitCommit {
        hash: hash.to_string(),
        short_hash: short_hash.to_string(),
        author: author.to_string(),
        timestamp: timestamp.parse::<i64>().unwrap_or(0) * 1000,
        subject: subject.to_string(),
        refs: parse_refs(refs),
        parents: parents.split_whitespace().map(str::to_string).collect(),
    })
}

fn parse_commits(output: &str) -> Vec<GitCommit> {
    output
        .split('\u{1e}')
        .map(|record| record.trim_start_matches(['\n', '\r']))
        .filter(|record| !record.trim().is_empty())
        .filter_map(|record| commit_from_fields(&record.splitn(7, '\u{1f}').collect::<Vec<_>>()))
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

/// Files a commit changed. `-m --first-parent` compares a merge with its first
/// parent (the base the file diff uses too); the default combined diff lists
/// nothing for a clean merge.
fn commit_changes(project_root: &Path, hash: &str) -> Result<Vec<FileChange>> {
    let show = |mode: &'static str| {
        git_bytes(
            project_root,
            &[
                "show",
                "--no-show-signature",
                "-m",
                "--first-parent",
                mode,
                "-z",
                "--no-renames",
                "--format=",
                hash,
            ],
        )
    };
    let stats = parse_numstat(&show("--numstat")?);
    Ok(parse_name_status(&show("--name-status")?, &stats))
}

pub fn project_commit_detail(project_root: &Path, revision: &str) -> Result<GitCommitDetail> {
    ensure_arg(revision, "revision")?;
    let output = git_stdout(
        project_root,
        &[
            "show",
            "-s",
            "--no-show-signature",
            "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%D%x1f%s%x1f%b",
            revision,
            // `HEAD` may also be the name of a file.
            "--",
        ],
    )?;
    let mut parts = output.splitn(9, '\u{1f}');
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
    let changes = commit_changes(project_root, &full_hash)?;
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
    let hash = ensure_hash(hash)?;
    let path = ensure_relative_path(path)?;
    let run = |args: &[&str]| git_bytes(project_root, args);
    let old = blob_side(&run, &format!("{hash}^:{path}"));
    let new = blob_side(&run, &format!("{hash}:{path}"));
    Ok(build_file_diff(path, old, new))
}

/// Detects an in-progress merge, rebase, cherry-pick or revert. The state
/// lives in the git dir, which for a linked worktree is not `<root>/.git`.
fn git_operation(project_root: &Path) -> Option<String> {
    let git_dir = PathBuf::from(git_stdout_opt(
        project_root,
        &["rev-parse", "--absolute-git-dir"],
    )?);
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
/// Only regular files are read: a symlink is never followed, so a link to a
/// FIFO or a huge file elsewhere cannot stall the status.
fn count_file_lines(path: &Path) -> i64 {
    let is_file = std::fs::symlink_metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false);
    if !is_file {
        return 0;
    }
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

/// Line counts for a set of untracked files, computed with a small worker pool
/// so a project with many untracked files does not pay for them serially.
fn count_untracked_lines(project_root: &Path, paths: &[String]) -> HashMap<String, i64> {
    use std::sync::atomic::{AtomicUsize, Ordering};

    // Counting lines means opening every untracked file. With tens of thousands
    // of untracked files (build output, node_modules, ...) that turns a status
    // refresh into a multi-second disk scan, so skip the line badge for large
    // sets and keep status responsive.
    const UNTRACKED_LINE_SCAN_LIMIT: usize = 500;

    if paths.is_empty() || paths.len() > UNTRACKED_LINE_SCAN_LIMIT {
        return HashMap::new();
    }
    let workers = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
        .min(8)
        .min(paths.len());
    let next = AtomicUsize::new(0);
    let counts = Mutex::new(HashMap::with_capacity(paths.len()));
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(path) = paths.get(index) else {
                    break;
                };
                let lines = count_file_lines(&project_root.join(path));
                lock_ignoring_poison(&counts).insert(path.clone(), lines);
            });
        }
    });
    counts.into_inner().unwrap_or_else(PoisonError::into_inner)
}

/// The working-tree status. Refs (branches, tags, stashes, submodules) come
/// from [`project_git_refs`] so this stays cheap enough to run after every
/// stage or discard.
pub fn project_git_status(project_root: &Path) -> Result<GitStatus> {
    if !is_repo_root(project_root) {
        return Ok(GitStatus {
            is_repo: false,
            branch: None,
            head: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            staged: Vec::new(),
            unstaged: Vec::new(),
            operation: None,
            conflicted: Vec::new(),
        });
    }
    let branch = project_current_branch(project_root);
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

    // `-z` output is never quoted; line output quotes any path with a space.
    let status_output = git_bytes(
        project_root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
        ],
    )?;
    let unstaged_stats = parse_numstat(
        &git_bytes(
            project_root,
            &["diff", "--numstat", "-z", "--no-renames", "--"],
        )
        .unwrap_or_default(),
    );
    let staged_stats = parse_numstat(
        &git_bytes(
            project_root,
            &["diff", "--cached", "--numstat", "-z", "--no-renames", "--"],
        )
        .unwrap_or_default(),
    );
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();
    for entry in nul_entries(&status_output) {
        if entry.len() < 4 {
            continue;
        }
        let bytes = entry.as_bytes();
        let index_status = bytes[0] as char;
        let worktree_status = bytes[1] as char;
        let path = entry[3..].to_string();
        if index_status == '?' && worktree_status == '?' {
            untracked.push(path);
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
    // Untracked files have no numstat entry, so their line count has to come
    // from disk. This is the only part of status that scales with the number of
    // untracked files, so read them in parallel instead of one at a time.
    let untracked_lines = count_untracked_lines(project_root, &untracked);
    for path in untracked {
        unstaged.push(FileChange {
            additions: untracked_lines.get(&path).copied().unwrap_or(0),
            path,
            deletions: 0,
            status: "A".to_string(),
        });
    }
    let conflicted = git_bytes(
        project_root,
        &["diff", "--name-only", "-z", "--diff-filter=U"],
    )
    .map(|output| nul_entries(&output).collect())
    .unwrap_or_default();

    Ok(GitStatus {
        is_repo: true,
        branch,
        head,
        upstream,
        ahead,
        behind,
        staged,
        unstaged,
        operation: git_operation(project_root),
        conflicted,
    })
}

pub fn project_file_diff(project_root: &Path, path: &str, staged: bool) -> Result<FileDiff> {
    let entry = project_entry(project_root, path)?;
    let run = |args: &[&str]| git_bytes(project_root, args);
    let (old, new) = if staged {
        (
            blob_side(&run, &format!("HEAD:{path}")),
            blob_side(&run, &format!(":0:{path}")),
        )
    } else {
        // A conflicted file has no stage 0; compare against "ours" instead.
        let index = match blob_side(&run, &format!(":0:{path}")) {
            DiffSide::Missing => blob_side(&run, &format!(":2:{path}")),
            side => side,
        };
        (index, worktree_side(&entry))
    };
    Ok(build_file_diff(path, old, new))
}

fn has_head(project_root: &Path) -> bool {
    git_succeeds(project_root, &["rev-parse", "--quiet", "--verify", "HEAD"])
}

/// Starts the error of an unstage that named nothing but conflicted files.
const UNSTAGE_CONFLICT: &str = "conflicts are resolved, not unstaged";

/// The entries (`-z`) a listing `command` prints for `paths`, which it is
/// given a chunk at a time.
fn list_for_paths(project_root: &Path, command: &[&str], paths: &[&str]) -> Result<Vec<String>> {
    let mut entries = Vec::new();
    for chunk in paths.chunks(PATH_CHUNK) {
        let mut args = command.to_vec();
        args.extend(chunk);
        entries.extend(nul_entries(&git_bytes(project_root, &args)?));
    }
    Ok(entries)
}

fn unstage_unlocked(project_root: &Path, paths: &[&str]) -> Result<()> {
    // A conflicted path is left as it is. Unstaging it would take the conflict
    // out of the index while the merge stays open, and continuing would then
    // commit the file as HEAD has it, without what was merged. Whatever else
    // is staged at or below `paths` is unstaged by name instead.
    let unmerged: BTreeSet<String> =
        list_for_paths(project_root, &["ls-files", "-u", "-z", "--"], paths)?
            .into_iter()
            .filter_map(|entry| entry.split_once('\t').map(|(_, path)| path.to_string()))
            .collect();
    let staged: Vec<String>;
    let paths = if unmerged.is_empty() {
        paths.to_vec()
    } else {
        let listing = [
            "diff",
            "--cached",
            "--name-only",
            "-z",
            "--no-renames",
            "--",
        ];
        staged = list_for_paths(project_root, &listing, paths)?
            .into_iter()
            .filter(|path| !unmerged.contains(path))
            .collect();
        if staged.is_empty() {
            let mut names: Vec<String> = unmerged.iter().take(5).cloned().collect();
            if unmerged.len() > 5 {
                names.push(format!("and {} more", unmerged.len() - 5));
            }
            return Err(AppError::msg(format!(
                "{UNSTAGE_CONFLICT}: {}",
                names.join(", ")
            )));
        }
        staged.iter().map(String::as_str).collect()
    };
    // Before the first commit there is nothing to restore from, so the paths
    // are dropped from the index without touching the work tree. `-f` lets
    // that happen for a file that was edited after it was staged, which git
    // otherwise refuses for fear of losing the staged version.
    let command: &[&str] = if has_head(project_root) {
        &["restore", "--staged", "--"]
    } else {
        &["rm", "--cached", "-r", "-f", "--quiet", "--"]
    };
    for chunk in paths.chunks(PATH_CHUNK) {
        let mut args = command.to_vec();
        args.extend(chunk);
        git_stdout(project_root, &args)?;
    }
    Ok(())
}

pub fn git_stage(project_root: &Path, path: Option<&str>) -> Result<()> {
    let path = ensure_relative_path(path.unwrap_or("."))?;
    with_repo_lock(project_root, || {
        git_stdout(project_root, &["add", "-A", "--", path])?;
        Ok(())
    })
}

pub fn git_unstage(project_root: &Path, path: Option<&str>) -> Result<()> {
    let path = ensure_relative_path(path.unwrap_or("."))?;
    with_repo_lock(project_root, || unstage_unlocked(project_root, &[path]))
}

/// Stages many paths in a few `git add` invocations instead of one process per
/// file, which is what makes "select all" usable in large repositories.
pub fn git_stage_paths(project_root: &Path, paths: &[String]) -> Result<()> {
    let paths = paths
        .iter()
        .map(|path| ensure_relative_path(path))
        .collect::<Result<Vec<_>>>()?;
    if paths.is_empty() {
        return Ok(());
    }
    with_repo_lock(project_root, || {
        for chunk in paths.chunks(PATH_CHUNK) {
            let mut args = vec!["add", "-A", "--"];
            args.extend(chunk);
            git_stdout(project_root, &args)?;
        }
        Ok(())
    })
}

/// Unstages many paths in a few `git` invocations instead of one process per file.
pub fn git_unstage_paths(project_root: &Path, paths: &[String]) -> Result<()> {
    let paths = paths
        .iter()
        .map(|path| ensure_relative_path(path))
        .collect::<Result<Vec<_>>>()?;
    if paths.is_empty() {
        return Ok(());
    }
    with_repo_lock(project_root, || unstage_unlocked(project_root, &paths))
}

/// Discards the unstaged changes of `paths`: anything in the index is restored
/// to its staged version (staged work is never touched), and untracked files
/// are deleted. Tracked paths are restored in chunks, so tens of thousands of
/// files do not mean tens of thousands of processes.
///
/// Only what was named is lost. A repository inside the project is kept, and
/// so is a path whose restoring would delete other files; the rest is still
/// discarded and the error says what was kept.
pub fn git_discard_paths(project_root: &Path, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    with_repo_lock(project_root, || discard_paths_unlocked(project_root, paths))
}

/// The index entries inside a folder; a folder that has some is tracked.
fn entries_below<'a>(
    index: &'a BTreeSet<String>,
    folder: &str,
) -> impl Iterator<Item = &'a String> {
    let prefix = format!("{}/", folder.trim_end_matches('/'));
    index
        .range::<str, _>((Bound::Included(prefix.as_str()), Bound::Unbounded))
        .take_while(move |entry| entry.starts_with(&prefix))
}

/// Whether a folder is a repository of its own (a linked worktree and a
/// submodule are, too) or has one somewhere inside. Git lists such a folder as
/// a single untracked entry and `git clean` skips it: deleting it would take
/// that repository's history and its uncommitted work along.
fn holds_repository(folder: &Path) -> bool {
    let is_folder = std::fs::symlink_metadata(folder).is_ok_and(|metadata| metadata.is_dir());
    if !is_folder {
        return false;
    }
    if std::fs::symlink_metadata(folder.join(".git")).is_ok() {
        return true;
    }
    match std::fs::read_dir(folder) {
        Ok(children) => children
            .flatten()
            .any(|child| holds_repository(&child.path())),
        // What cannot be read cannot be vouched for.
        Err(_) => true,
    }
}

/// Whether a folder holds anything but empty folders.
fn has_files(folder: &Path) -> bool {
    match std::fs::read_dir(folder) {
        Ok(children) => children.flatten().any(|child| {
            let path = child.path();
            std::fs::symlink_metadata(&path)
                .map_or(true, |metadata| !metadata.is_dir() || has_files(&path))
        }),
        Err(_) => true,
    }
}

/// Why `git checkout -- path` would delete other files to put an index entry
/// back. Git forces its way: a folder that took the file's place goes with
/// all it holds, and so does a file that took the place of one of the entry's
/// folders. Those are files nobody named, ignored ones included.
fn restore_blocker(project_root: &Path, path: &str) -> Option<String> {
    let mut current = project_root.to_path_buf();
    let mut walked = String::new();
    let mut parts = path
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .peekable();
    while let Some(part) = parts.next() {
        current.push(part);
        if !walked.is_empty() {
            walked.push('/');
        }
        walked.push_str(part);
        let Ok(metadata) = std::fs::symlink_metadata(&current) else {
            // Nothing is here, so nothing is in the way further down either.
            return None;
        };
        if parts.peek().is_some() {
            if !metadata.is_dir() {
                return Some(format!(
                    "{walked} is not a folder anymore and would be deleted"
                ));
            }
        } else if metadata.is_dir() {
            // Git leaves the folder of a submodule alone.
            let submodule = std::fs::symlink_metadata(current.join(".git")).is_ok();
            return (!submodule && has_files(&current))
                .then(|| "it is a folder now and its files would be deleted".to_string());
        }
    }
    None
}

fn discard_paths_unlocked(project_root: &Path, paths: &[String]) -> Result<()> {
    let entries = paths
        .iter()
        .map(|path| project_entry(project_root, path))
        .collect::<Result<Vec<_>>>()?;
    let index: BTreeSet<String> =
        nul_entries(&git_bytes(project_root, &["ls-files", "-z"])?).collect();
    let mut restore = Vec::new();
    let mut delete = Vec::new();
    for (path, entry) in paths.iter().zip(entries) {
        // An untracked file can sit where a tracked folder was. It is then
        // the file that was named, not the folder.
        let is_file = std::fs::symlink_metadata(&entry).is_ok_and(|metadata| !metadata.is_dir());
        let tracked = index.contains(path.as_str())
            || (!is_file && entries_below(&index, path).next().is_some());
        if tracked {
            restore.push(path.as_str());
        } else {
            delete.push((path.as_str(), entry));
        }
    }
    let mut kept = Vec::new();
    // Deleting comes first: an untracked file that was named may be what
    // stands in the way of a restore.
    for (path, entry) in delete {
        if holds_repository(&entry) {
            kept.push(format!("{path} is a git repository and was not deleted"));
        } else {
            remove_entry(&entry)?;
        }
    }
    let mut checkout = Vec::new();
    for path in restore {
        let blocker = if index.contains(path) {
            restore_blocker(project_root, path)
        } else {
            entries_below(&index, path).find_map(|entry| restore_blocker(project_root, entry))
        };
        match blocker {
            Some(reason) => kept.push(format!("{path} was not restored: {reason}")),
            None => checkout.push(path),
        }
    }
    for chunk in checkout.chunks(PATH_CHUNK) {
        let mut args = vec!["checkout", "--"];
        args.extend(chunk);
        git_stdout(project_root, &args)?;
    }
    if kept.is_empty() {
        Ok(())
    } else {
        Err(AppError::msg(kept.join("; ")))
    }
}

/// Returns the per-line blame for a tracked file.
pub fn project_blame(project_root: &Path, path: &str) -> Result<Vec<GitBlameLine>> {
    let path = ensure_relative_path(path)?;
    let output = git_bytes(project_root, &["blame", "--line-porcelain", "--", path])?;
    let output = String::from_utf8_lossy(&output);
    let mut lines = Vec::new();
    let mut hash = String::new();
    let mut author = String::new();
    let mut timestamp = 0i64;
    let mut final_line = 0i64;
    for line in output.lines() {
        if let Some(content) = line.strip_prefix('\t') {
            if !hash.is_empty() {
                lines.push(GitBlameLine {
                    short_hash: hash.chars().take(7).collect(),
                    hash: hash.clone(),
                    author: author.clone(),
                    timestamp: timestamp * 1000,
                    line: final_line,
                    content: content.to_string(),
                });
            }
            continue;
        }
        let mut parts = line.split(' ');
        let candidate = parts.next().unwrap_or("");
        // Commit headers start with a full SHA-1 or SHA-256 object name.
        if matches!(candidate.len(), 40 | 64)
            && candidate.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            hash = candidate.to_string();
            let _original_line = parts.next();
            final_line = parts
                .next()
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            author.clear();
            timestamp = 0;
        } else if let Some(value) = line.strip_prefix("author ") {
            author = value.to_string();
        } else if let Some(value) = line.strip_prefix("author-time ") {
            timestamp = value.trim().parse().unwrap_or(0);
        }
    }
    Ok(lines)
}

/// Turns a repository-relative path into a `.gitignore` pattern for exactly
/// that path: anchored to the root, with pattern characters escaped.
fn gitignore_entry(path: &str) -> String {
    let mut entry = String::from("/");
    for character in path.trim_start_matches("./").chars() {
        if matches!(character, '*' | '?' | '[' | '\\') {
            entry.push('\\');
        }
        entry.push(character);
    }
    // Git drops trailing spaces unless they are escaped.
    let kept = entry.trim_end_matches(' ').len();
    let spaces = entry.len() - kept;
    if spaces > 0 {
        entry.truncate(kept);
        entry.push_str(&"\\ ".repeat(spaces));
    }
    entry
}

/// Appends a path to the repository's root `.gitignore`.
pub fn git_ignore(project_root: &Path, path: &str) -> Result<()> {
    let path = ensure_relative_path(path)?;
    if path.contains(['\n', '\r']) {
        return Err(AppError::msg(format!("invalid path: {path:?}")));
    }
    let entry = gitignore_entry(path);
    with_repo_lock(project_root, || {
        let gitignore = project_root.join(".gitignore");
        let existing = match std::fs::read_to_string(&gitignore) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error.into()),
        };
        if existing.lines().any(|line| line.trim_end() == entry) {
            return Ok(());
        }
        let mut content = existing;
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&entry);
        content.push('\n');
        std::fs::write(&gitignore, content)?;
        Ok(())
    })
}

/// Reveals a path in the platform file manager (Finder, Explorer, xdg-open).
pub fn reveal_path(project_root: &Path, path: &str) -> Result<()> {
    let absolute = project_entry(project_root, path)?;
    let parent = absolute
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| project_root.to_path_buf());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new("explorer");
        if std::fs::symlink_metadata(&absolute).is_ok() {
            command.raw_arg(format!("/select,\"{}\"", absolute.display()));
        } else {
            command.arg(&parent);
        }
        // Explorer exits with 1 even when it opened the window, so only a
        // failure to start it counts as an error.
        command
            .spawn()
            .map(|_| ())
            .map_err(|error| AppError::msg(error.to_string()))
    }
    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(target_os = "macos")]
        let status = if std::fs::symlink_metadata(&absolute).is_ok() {
            Command::new("open").arg("-R").arg(&absolute).status()
        } else {
            Command::new("open").arg(&parent).status()
        };
        #[cfg(not(target_os = "macos"))]
        let status = {
            let target = if absolute.is_dir() {
                absolute.clone()
            } else {
                parent
            };
            Command::new("xdg-open").arg(target).status()
        };
        match status {
            Ok(status) if status.success() => Ok(()),
            Ok(_) => Err(AppError::msg(format!("could not reveal {path}"))),
            Err(error) => Err(AppError::msg(error.to_string())),
        }
    }
}

pub fn git_commit(project_root: &Path, message: &str, amend: bool) -> Result<String> {
    if message.trim().is_empty() {
        if amend {
            return with_repo_lock(project_root, || {
                git_combined(project_root, &["commit", "--amend", "--no-edit"])
            });
        }
        return Err(AppError::msg("commit message is required"));
    }
    let mut args = vec!["commit", "-m", message];
    if amend {
        args.push("--amend");
    }
    with_repo_lock(project_root, || git_combined(project_root, &args))
}

/// Whether `hash` names a commit with more than one parent.
fn is_merge_commit(project_root: &Path, hash: &str) -> bool {
    git_stdout_opt(
        project_root,
        &["rev-list", "--parents", "-n", "1", hash, "--"],
    )
    .is_some_and(|line| line.split_whitespace().count() > 2)
}

/// Applies the change a commit introduced on top of HEAD. A merge commit is
/// replayed against its first parent, the branch it was merged into.
pub fn git_cherry_pick(project_root: &Path, hash: &str) -> Result<String> {
    let hash = ensure_hash(hash)?;
    with_repo_lock(project_root, || {
        let mut args = vec!["cherry-pick"];
        if is_merge_commit(project_root, hash) {
            args.extend(["-m", "1"]);
        }
        args.push(hash);
        git_combined(project_root, &args)
    })
}

/// Commits the inverse of a commit, relative to its first parent for a merge.
pub fn git_revert(project_root: &Path, hash: &str) -> Result<String> {
    let hash = ensure_hash(hash)?;
    with_repo_lock(project_root, || {
        let mut args = vec!["revert", "--no-edit"];
        if is_merge_commit(project_root, hash) {
            args.extend(["-m", "1"]);
        }
        args.push(hash);
        git_combined(project_root, &args)
    })
}

/// Moves the current branch to a commit. `soft` keeps the changes staged,
/// `mixed` keeps them in the work tree and `hard` throws them away.
pub fn git_reset(project_root: &Path, hash: &str, mode: &str) -> Result<String> {
    let hash = ensure_hash(hash)?;
    let flag = match mode {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        other => return Err(AppError::msg(format!("invalid reset mode: {other:?}"))),
    };
    with_repo_lock(project_root, || {
        git_combined(project_root, &["reset", flag, hash, "--"])
    })
}

/// Checks out a commit without a branch (a detached HEAD).
pub fn git_checkout_commit(project_root: &Path, hash: &str) -> Result<String> {
    let hash = ensure_hash(hash)?;
    with_repo_lock(project_root, || {
        git_combined(project_root, &["checkout", "--detach", hash, "--"])
    })
}

/// Resolves a conflicted path with one side's version: `ours` is what HEAD
/// had, `theirs` the change being merged, rebased or picked. When that side
/// deleted the file, resolving removes it.
pub fn git_resolve_conflict(project_root: &Path, path: &str, side: &str) -> Result<()> {
    let path = ensure_relative_path(path)?;
    let (flag, stage) = match side {
        "ours" => ("--ours", "2"),
        "theirs" => ("--theirs", "3"),
        other => return Err(AppError::msg(format!("invalid conflict side: {other:?}"))),
    };
    with_repo_lock(project_root, || {
        let output = git_bytes(project_root, &["ls-files", "-u", "-z", "--", path])?;
        let stages: Vec<String> = nul_entries(&output)
            .filter_map(|entry| {
                let (meta, name) = entry.split_once('\t')?;
                (name == path).then(|| meta.split(' ').nth(2).unwrap_or_default().to_string())
            })
            .collect();
        if stages.is_empty() {
            return Err(AppError::msg(format!("{path} has no conflict")));
        }
        if stages.iter().any(|entry| entry == stage) {
            git_stdout(project_root, &["checkout", flag, "--", path])?;
            git_stdout(project_root, &["add", "--", path])?;
        } else {
            git_stdout(project_root, &["rm", "--quiet", "--", path])?;
        }
        Ok(())
    })
}

/// What a commit message is written from.
pub struct StagedSummary {
    pub branch: Option<String>,
    pub stat: String,
    /// The staged diff, cut to the requested size.
    pub patch: String,
    pub truncated: bool,
    /// Subjects of recent commits, newest first, for the project's style.
    pub recent_subjects: Vec<String>,
}

pub fn staged_summary(project_root: &Path, max_patch_chars: usize) -> Result<StagedSummary> {
    let stat = git_stdout(
        project_root,
        &[
            "diff",
            "--cached",
            "--no-color",
            "--no-ext-diff",
            "--stat=160",
        ],
    )?;
    if stat.trim().is_empty() {
        return Err(AppError::msg("nothing is staged"));
    }
    let raw = git_bytes(
        project_root,
        &[
            "diff",
            "--cached",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "-U2",
        ],
    )?;
    let full = String::from_utf8_lossy(&raw);
    let truncated = full.chars().count() > max_patch_chars;
    let patch = if truncated {
        full.chars().take(max_patch_chars).collect()
    } else {
        full.into_owned()
    };
    let recent_subjects = git_stdout_opt(
        project_root,
        &[
            "log",
            "--no-show-signature",
            "-n",
            "12",
            "--no-merges",
            "--format=%s",
            "--",
        ],
    )
    .map(|text| text.lines().map(str::to_string).collect())
    .unwrap_or_default();
    Ok(StagedSummary {
        branch: project_current_branch(project_root),
        stat,
        patch,
        truncated,
        recent_subjects,
    })
}

pub fn git_checkout(
    project_root: &Path,
    branch: &str,
    track: bool,
    local_branch: Option<&str>,
) -> Result<String> {
    ensure_arg(branch, "branch")?;
    let mut args = vec!["checkout"];
    if track {
        args.push("--track");
        if let Some(name) = local_branch.filter(|name| !name.is_empty()) {
            args.push("-b");
            args.push(ensure_arg(name, "branch")?);
        }
    }
    args.push(branch);
    // Without `--`, a file named like the branch would be restored instead.
    args.push("--");
    with_repo_lock(project_root, || git_combined(project_root, &args))
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
    with_repo_lock(project_root, || git_combined(project_root, &args))
}

pub fn git_push(project_root: &Path) -> Result<String> {
    git_combined(project_root, &["push"])
}

/// Aborts an in-progress merge, rebase, cherry-pick or revert.
pub fn git_operation_abort(project_root: &Path, operation: &str) -> Result<String> {
    let args: &[&str] = match operation {
        "merge" => &["merge", "--abort"],
        "rebase" => &["rebase", "--abort"],
        "cherry-pick" => &["cherry-pick", "--abort"],
        "revert" => &["revert", "--abort"],
        other => return Err(AppError::msg(format!("cannot abort '{other}'"))),
    };
    with_repo_lock(project_root, || git_combined(project_root, args))
}

/// Continues an in-progress merge, rebase, cherry-pick or revert once its
/// conflicts are resolved and staged.
pub fn git_operation_continue(project_root: &Path, operation: &str) -> Result<String> {
    let args: &[&str] = match operation {
        "merge" => &["merge", "--continue"],
        "rebase" => &["rebase", "--continue"],
        "cherry-pick" => &["cherry-pick", "--continue"],
        "revert" => &["revert", "--continue"],
        other => return Err(AppError::msg(format!("cannot continue '{other}'"))),
    };
    with_repo_lock(project_root, || git_combined(project_root, args))
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
    with_repo_lock(project_root, || git_combined(project_root, &args))
}

/// Runs `git stash <action> <stash>` after checking that `stash@{N}` is still
/// the entry the user picked: indices shift whenever a stash is added or
/// dropped elsewhere.
fn stash_action(project_root: &Path, action: &str, stash: &str, hash: &str) -> Result<String> {
    let stash = ensure_stash(stash)?;
    let hash = ensure_hash(hash)?;
    with_repo_lock(project_root, || {
        let current = git_stdout_opt(project_root, &["rev-parse", "--verify", "-q", stash])
            .unwrap_or_default();
        if current != hash {
            return Err(AppError::msg(format!(
                "{stash} changed since the stash list was loaded; refresh and try again"
            )));
        }
        git_combined(project_root, &["stash", action, stash])
    })
}

pub fn git_stash_apply(project_root: &Path, stash: &str, hash: &str) -> Result<String> {
    stash_action(project_root, "apply", stash, hash)
}

pub fn git_stash_pop(project_root: &Path, stash: &str, hash: &str) -> Result<String> {
    stash_action(project_root, "pop", stash, hash)
}

pub fn git_stash_drop(project_root: &Path, stash: &str, hash: &str) -> Result<String> {
    stash_action(project_root, "drop", stash, hash)
}

pub fn git_init(project_root: &Path) -> Result<String> {
    with_repo_lock(project_root, || git_combined(project_root, &["init"]))
}

pub fn git_clone(url: &str, dest: &Path) -> Result<String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut command = Command::new("git");
    command.args(["-c", "core.quotepath=false"]);
    configure(&mut command);
    command.args(["clone", "--", url]).arg(dest);
    let output = command.output()?;
    combined_output(output, &format!("clone {url}"))
}

pub fn git_tag_delete(project_root: &Path, name: &str) -> Result<String> {
    let name = ensure_arg(name, "tag")?;
    with_repo_lock(project_root, || {
        git_combined(project_root, &["tag", "-d", name])
    })
}

pub fn git_tag_push(project_root: &Path, remote: &str, name: &str) -> Result<String> {
    let remote = ensure_arg(remote, "remote")?;
    let name = ensure_arg(name, "tag")?;
    git_combined(
        project_root,
        &["push", remote, &format!("refs/tags/{name}")],
    )
}

pub fn git_submodule_update(project_root: &Path, path: Option<&str>) -> Result<String> {
    let mut args = vec!["submodule", "update", "--init", "--recursive"];
    if let Some(path) = path.filter(|value| !value.is_empty()) {
        args.push("--");
        args.push(ensure_relative_path(path)?);
    }
    // The path is a file name, so pathspecs stay literal here.
    let output = git(project_root).args(&args).output()?;
    combined_output(output, &args.join(" "))
}

/// The remote and merge ref (`refs/heads/...`) a local branch tracks.
fn branch_upstream(project_root: &Path, branch: &str) -> Option<(String, String)> {
    let remote = git_stdout_opt(
        project_root,
        &["config", "--get", &format!("branch.{branch}.remote")],
    )?;
    let merge = git_stdout_opt(
        project_root,
        &["config", "--get", &format!("branch.{branch}.merge")],
    )?;
    Some((remote, merge))
}

/// Fast-forwards a local branch to its upstream without checking it out.
pub fn git_fast_forward(project_root: &Path, branch: &str) -> Result<String> {
    let branch = ensure_arg(branch, "branch")?;
    let (remote, merge) = branch_upstream(project_root, branch)
        .ok_or_else(|| AppError::msg(format!("branch '{branch}' has no upstream")))?;
    let remote = ensure_arg(&remote, "remote")?;
    if project_current_branch(project_root).as_deref() == Some(branch) {
        let fetched = git_combined(project_root, &["fetch", remote])?;
        let merged = with_repo_lock(project_root, || {
            git_combined(project_root, &["merge", "--ff-only", "@{upstream}"])
        })?;
        return Ok([fetched, merged]
            .into_iter()
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"));
    }
    // A refspec without `+` only ever fast-forwards the local branch.
    git_combined(
        project_root,
        &["fetch", remote, &format!("{merge}:refs/heads/{branch}")],
    )
}

pub fn git_merge(project_root: &Path, branch: &str) -> Result<String> {
    let branch = branch_revision(project_root, ensure_arg(branch, "branch")?);
    with_repo_lock(project_root, || {
        git_combined(project_root, &["merge", "--no-edit", &branch])
    })
}

pub fn git_rebase(project_root: &Path, onto: &str) -> Result<String> {
    let onto = branch_revision(project_root, ensure_arg(onto, "branch")?);
    with_repo_lock(project_root, || {
        git_combined(project_root, &["rebase", "--autostash", &onto])
    })
}

const REBASE_ACTIONS: [&str; 4] = ["pick", "squash", "fixup", "drop"];

/// Checks a todo from the frontend before it reaches git: only the actions the
/// UI offers (never `exec`), full commit hashes, and no squash or fixup without
/// an earlier commit to fold into.
fn validate_rebase_todo(todo: &[(String, String)]) -> Result<()> {
    for (action, hash) in todo {
        if !REBASE_ACTIONS.contains(&action.as_str()) {
            return Err(AppError::msg(format!("invalid rebase action: {action:?}")));
        }
        let full =
            matches!(hash.len(), 40 | 64) && hash.bytes().all(|byte| byte.is_ascii_hexdigit());
        if !full {
            return Err(AppError::msg(format!("invalid commit hash: {hash:?}")));
        }
    }
    let first = todo.iter().find(|(action, _)| action != "drop");
    if first.is_some_and(|(action, _)| action == "squash" || action == "fixup") {
        return Err(AppError::msg(
            "the first commit cannot be squashed or fixed up",
        ));
    }
    Ok(())
}

pub fn git_rebase_interactive(
    project_root: &Path,
    onto: &str,
    todo: &[(String, String)],
) -> Result<String> {
    let onto = branch_revision(project_root, ensure_arg(onto, "branch")?);
    let onto = onto.as_str();
    if todo.is_empty() {
        return git_rebase(project_root, onto);
    }
    validate_rebase_todo(todo)?;
    with_repo_lock(project_root, || {
        // The todo replaces git's own list, so any commit missing from it would
        // be dropped. Refuse if the branch changed since the list was loaded.
        let expected: HashSet<String> = project_rebase_commits(project_root, onto)?
            .into_iter()
            .map(|commit| commit.hash)
            .collect();
        let listed: HashSet<&str> = todo.iter().map(|(_, hash)| hash.as_str()).collect();
        let unchanged = listed.len() == todo.len()
            && expected.len() == todo.len()
            && expected.iter().all(|hash| listed.contains(hash.as_str()));
        if !unchanged {
            return Err(AppError::msg(
                "the branch changed since the commit list was loaded; open the interactive rebase again",
            ));
        }
        let text: String = todo
            .iter()
            .map(|(action, hash)| format!("{action} {hash}\n"))
            .collect();
        let path = std::env::temp_dir().join(format!("pumr-rebase-{}.todo", uuid::Uuid::new_v4()));
        std::fs::write(&path, text)?;
        let output = git_action(project_root)
            .args([
                "-c",
                "rebase.missingCommitsCheck=error",
                "rebase",
                "-i",
                "--autostash",
                onto,
            ])
            .env("GIT_SEQUENCE_EDITOR", sequence_editor_command(&path))
            .output();
        let _ = std::fs::remove_file(&path);
        combined_output(output?, &format!("rebase -i {onto}"))
    })
}

/// Builds a `GIT_SEQUENCE_EDITOR` command that overwrites git's todo file with
/// ours. Git runs editors through a POSIX shell on every platform (Git for
/// Windows ships `sh` and `cp`) and appends the todo path, so copying onto it
/// is enough.
fn sequence_editor_command(source: &Path) -> String {
    let path = source.to_string_lossy().replace('\\', "/");
    format!("cp -f '{}'", path.replace('\'', r"'\''"))
}

pub fn git_branch_create(
    project_root: &Path,
    name: &str,
    start_point: Option<&str>,
    checkout: bool,
) -> Result<String> {
    let name = ensure_arg(name, "branch name")?;
    let start = start_point
        .filter(|value| !value.is_empty())
        .map(|value| ensure_arg(value, "start point"))
        .transpose()?
        .map(|value| branch_revision(project_root, value));
    let mut args = if checkout {
        vec!["checkout", "-b", name]
    } else {
        vec!["branch", name]
    };
    args.extend(start.as_deref());
    with_repo_lock(project_root, || git_combined(project_root, &args))
}

pub fn git_tag_create(
    project_root: &Path,
    name: &str,
    target: Option<&str>,
    message: Option<&str>,
) -> Result<String> {
    let name = ensure_arg(name, "tag")?;
    let target = target
        .filter(|value| !value.is_empty())
        .map(|value| ensure_arg(value, "target"))
        .transpose()?
        .map(|value| branch_revision(project_root, value));
    let mut args = vec!["tag"];
    if let Some(message) = message.filter(|value| !value.trim().is_empty()) {
        args.push("-a");
        args.push("-m");
        args.push(message);
    }
    args.push(name);
    args.extend(target.as_deref());
    with_repo_lock(project_root, || git_combined(project_root, &args))
}

pub fn git_branch_rename(project_root: &Path, from: &str, to: &str) -> Result<String> {
    let from = ensure_arg(from, "branch")?;
    let to = ensure_arg(to, "branch name")?;
    with_repo_lock(project_root, || {
        git_combined(project_root, &["branch", "-m", from, to])
    })
}

/// Deletes a branch. A local branch is only removed with `-d` unless `force`
/// is set: git refuses to delete unmerged work, and the caller asks the user
/// before forcing it.
pub fn git_branch_delete(
    project_root: &Path,
    branch: &str,
    remote: bool,
    force: bool,
) -> Result<String> {
    let branch = ensure_arg(branch, "branch")?;
    if remote {
        let remotes = project_remotes(project_root);
        let (remote_name, branch_name) = split_remote_ref(&remotes, branch)
            .ok_or_else(|| AppError::msg(format!("'{branch}' is not on a known remote")))?;
        // The full name: a tag on the remote may be called the same.
        return git_combined(
            project_root,
            &[
                "push",
                &remote_name,
                "--delete",
                &format!("refs/heads/{branch_name}"),
            ],
        );
    }
    let flag = if force { "-D" } else { "-d" };
    with_repo_lock(project_root, || {
        git_combined(project_root, &["branch", flag, branch])
    })
}

pub fn git_set_upstream(project_root: &Path, branch: &str, upstream: &str) -> Result<String> {
    let branch = ensure_arg(branch, "branch")?;
    let upstream = ensure_arg(upstream, "upstream")?;
    with_repo_lock(project_root, || {
        git_combined(
            project_root,
            &["branch", "--set-upstream-to", upstream, branch],
        )
    })
}

/// Pushes a local branch. When it tracks a branch on `remote`, that branch is
/// updated even if its name differs; otherwise a branch of the same name is.
pub fn git_push_branch(
    project_root: &Path,
    branch: &str,
    remote: &str,
    set_upstream: bool,
) -> Result<String> {
    let branch = ensure_arg(branch, "branch")?;
    let remote = ensure_arg(remote, "remote")?;
    let destination = match branch_upstream(project_root, branch) {
        Some((upstream_remote, merge)) if upstream_remote == remote => merge,
        _ => format!("refs/heads/{branch}"),
    };
    let refspec = format!("refs/heads/{branch}:{destination}");
    let mut args = vec!["push"];
    if set_upstream {
        args.push("-u");
    }
    args.push(remote);
    args.push(&refspec);
    git_combined(project_root, &args)
}

/// The web address of a repository from its remote URL, for
/// `scheme://[user@]host[:port]/path` and scp-like `[user@]host:path`.
fn remote_web_url(url: &str) -> Option<reqwest::Url> {
    let url = url.trim().trim_end_matches('/');
    let (scheme, authority, path) = match url.split_once("://") {
        Some((scheme, rest)) => {
            let (authority, path) = rest.split_once('/')?;
            (scheme, authority, path)
        }
        None => {
            // scp-like syntax: the host ends at the first ':' and has no '/'.
            let (host, path) = url.split_once(':')?;
            if host.contains('/') {
                return None;
            }
            ("ssh", host, path)
        }
    };
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let web = matches!(scheme, "http" | "https");
    // An ssh or git port says nothing about the web interface.
    let host = match host.rsplit_once(':') {
        Some((name, port)) if !web && port.bytes().all(|byte| byte.is_ascii_digit()) => name,
        _ => host,
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    if host.is_empty() || path.is_empty() {
        return None;
    }
    let scheme = if scheme == "http" { "http" } else { "https" };
    let mut base = reqwest::Url::parse(&format!("{scheme}://{host}/")).ok()?;
    base.path_segments_mut().ok()?.extend(path.split('/'));
    Some(base)
}

/// The page that starts a pull (or merge) request for `branch` on `remote`.
/// GitHub and GitLab pick the default branch as the base themselves.
pub fn git_pull_request_url(project_root: &Path, remote: &str, branch: &str) -> Result<String> {
    let remote = ensure_arg(remote, "remote")?;
    let branch = ensure_arg(branch, "branch")?;
    let raw = git_stdout(project_root, &["remote", "get-url", remote])?;
    let mut url = remote_web_url(&raw)
        .ok_or_else(|| AppError::msg(format!("unsupported remote url for '{remote}': {raw}")))?;
    let host = url.host_str().unwrap_or_default().to_lowercase();
    let unsupported = || AppError::msg(format!("unsupported remote url for '{remote}': {raw}"));
    if host.contains("gitlab") {
        url.path_segments_mut()
            .map_err(|_| unsupported())?
            .extend(["-", "merge_requests", "new"]);
        url.query_pairs_mut()
            .append_pair("merge_request[source_branch]", branch);
    } else if host.contains("bitbucket") {
        url.path_segments_mut()
            .map_err(|_| unsupported())?
            .extend(["pull-requests", "new"]);
        url.query_pairs_mut().append_pair("source", branch);
    } else if host.contains("github") {
        url.path_segments_mut()
            .map_err(|_| unsupported())?
            .extend(["pull", "new"])
            .extend(branch.split('/'));
    }
    Ok(url.to_string())
}

/// The commits an interactive rebase onto `onto` works on, oldest first. This
/// mirrors git's own todo: no merges and no commits `onto` already contains as
/// an equivalent patch.
pub fn project_rebase_commits(project_root: &Path, onto: &str) -> Result<Vec<GitCommit>> {
    let onto = branch_revision(project_root, ensure_arg(onto, "branch")?);
    let output = git_stdout(
        project_root,
        &[
            "log",
            "--no-show-signature",
            "--no-merges",
            "--topo-order",
            "--reverse",
            "--right-only",
            "--cherry-pick",
            "--format=%H%x1f%h%x1f%an%x1f%at%x1f%x1f%x1f%s%x1e",
            &format!("{onto}...HEAD"),
            "--",
        ],
    )?;
    Ok(parse_commits(&output))
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
    // Past the timeout similar approximates, which only affects the counts.
    let diff = TextDiff::configure()
        .timeout(LINE_DIFF_TIMEOUT)
        .diff_lines(old, new);
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

    /// Runs a raw git command in a test repository and returns trimmed stdout.
    fn sh(project: &Path, args: &[&str]) -> String {
        git_stdout(project, args).unwrap()
    }

    /// Pins identity and signing so tests do not depend on the host's config.
    fn configure_test_repo(project: &Path) {
        for (key, value) in [
            ("user.name", "test"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("tag.gpgsign", "false"),
        ] {
            sh(project, &["config", key, value]);
        }
    }

    fn init_repo(project: &Path) {
        std::fs::create_dir_all(project).unwrap();
        sh(project, &["init", "-q"]);
        configure_test_repo(project);
        std::fs::write(project.join("tracked.txt"), "one\n").unwrap();
        sh(project, &["add", "--", "tracked.txt"]);
        sh(project, &["commit", "-q", "-m", "init"]);
    }

    fn commit(project: &Path, message: &str) {
        sh(project, &["add", "-A", "--", "."]);
        sh(project, &["commit", "-q", "-m", message]);
    }

    fn side_text(side: DiffSide) -> String {
        String::from_utf8(side.into_bytes()).unwrap()
    }

    fn refs(project: &Path) -> GitRefs {
        project_git_refs(project).unwrap()
    }

    #[test]
    fn ignored_entries_lists_what_snapshots_skip() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().canonicalize().unwrap().join("project");
        std::fs::create_dir_all(project.join("src")).unwrap();
        std::fs::create_dir_all(project.join("data")).unwrap();
        std::fs::create_dir_all(project.join("node_modules/pkg")).unwrap();
        std::fs::write(project.join(".gitignore"), "data/\nsrc/local.json\n").unwrap();
        std::fs::write(project.join("src/main.ts"), "tracked\n").unwrap();
        std::fs::write(project.join("src/local.json"), "{}\n").unwrap();
        std::fs::write(project.join("data/store.bin"), "precious\n").unwrap();
        std::fs::write(project.join("node_modules/pkg/index.js"), "installed\n").unwrap();
        let shadow = ShadowRepo::open(temp.path(), "project-1", &project).unwrap();
        shadow.snapshot("base").unwrap();

        assert_eq!(
            shadow.ignored_entries(&project.join("src/main.ts")),
            Some(Vec::new())
        );
        assert_eq!(
            shadow.ignored_entries(&project.join("src")),
            Some(vec!["src/local.json".to_string()])
        );
        assert_eq!(
            shadow.ignored_entries(&project.join("data")),
            Some(vec!["data/".to_string()])
        );
        assert_eq!(
            shadow.ignored_entries(&project.join("node_modules")),
            Some(vec!["node_modules/".to_string()])
        );
        // Outside the project or the project itself: nothing to vouch for.
        assert_eq!(shadow.ignored_entries(temp.path()), None);
        assert_eq!(shadow.ignored_entries(&project), None);
    }

    #[test]
    fn a_nested_repository_is_not_vouched_for_as_restorable() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().canonicalize().unwrap().join("project");
        std::fs::create_dir_all(project.join("src")).unwrap();
        std::fs::create_dir_all(project.join("packages/app/src")).unwrap();
        std::fs::write(project.join("src/main.ts"), "tracked\n").unwrap();
        std::fs::write(project.join("packages/app/src/index.ts"), "tracked\n").unwrap();
        // A cloned dependency with history and work of its own. The snapshot
        // records which commit it is on and nothing else.
        init_repo(&project.join("vendor/lib"));
        std::fs::write(project.join("vendor/lib/uncommitted.txt"), "work\n").unwrap();
        let shadow = ShadowRepo::open(temp.path(), "project-1", &project).unwrap();
        shadow.snapshot("base").unwrap();
        // One that was cloned after the last snapshot.
        init_repo(&project.join("tools/cloned"));
        // And a folder that became one after snapshots held its files, which
        // they keep doing without its `.git`.
        init_repo(&project.join("packages/app"));
        shadow.snapshot("later").unwrap();

        for path in [
            "vendor/lib",
            "vendor",
            "vendor/lib/tracked.txt",
            "vendor/lib/.git",
            "tools/cloned",
            "tools",
            "packages/app",
            "packages",
            "packages/app/src",
        ] {
            assert_eq!(shadow.ignored_entries(&project.join(path)), None, "{path}");
        }
        // Ordinary tracked files and folders stay restorable.
        assert_eq!(
            shadow.ignored_entries(&project.join("src")),
            Some(Vec::new())
        );
        assert_eq!(
            shadow.ignored_entries(&project.join("src/main.ts")),
            Some(Vec::new())
        );
    }

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
        assert!(shadow.is_ignored("node_modules/pkg/index.js"));
        assert!(!shadow.is_ignored("src/[main].ts"));

        assert_eq!(
            side_text(shadow.side_at(&base, "src/main.ts")),
            "line1\nline2\n"
        );

        shadow.restore_to(&base).unwrap();
        assert_eq!(
            std::fs::read_to_string(project.join("src/main.ts")).unwrap(),
            "line1\nline2\n"
        );
        assert!(!project.join("src/new.ts").exists());
        assert!(shadow.changes_since(&base).unwrap().is_empty());
    }

    #[test]
    fn shadow_restore_undoes_renames_and_tracks_both_paths() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let content: String = (1..=20).map(|line| format!("line {line}\n")).collect();
        std::fs::write(project.join("original.ts"), &content).unwrap();
        std::fs::write(project.join("with space.ts"), "x\n").unwrap();

        let shadow = ShadowRepo::open(temp.path(), "project-1", &project).unwrap();
        let base = shadow.snapshot("base").unwrap();
        std::fs::rename(project.join("original.ts"), project.join("renamed.ts")).unwrap();
        std::fs::write(project.join("with space.ts"), "x\ny\n").unwrap();

        let changes = shadow.changes_since(&base).unwrap();
        let status_of = |path: &str| {
            changes
                .iter()
                .find(|change| change.path == path)
                .map(|change| change.status.clone())
        };
        assert_eq!(status_of("original.ts").as_deref(), Some("D"));
        assert_eq!(status_of("renamed.ts").as_deref(), Some("A"));
        let spaced = changes
            .iter()
            .find(|change| change.path == "with space.ts")
            .expect("path with a space is reported unquoted");
        assert_eq!(spaced.additions, 1);

        shadow.restore_to(&base).unwrap();
        assert_eq!(
            std::fs::read_to_string(project.join("original.ts")).unwrap(),
            content
        );
        assert!(!project.join("renamed.ts").exists());
        assert!(shadow.changes_since(&base).unwrap().is_empty());
    }

    /// A project whose ignore files hide `secret.env`, `src/local.json` and
    /// all of `uploads`, its own ignore file included. `assets` holds nothing
    /// but a log, which the default excludes ignore.
    fn project_with_ignored_files(project: &Path) {
        for (path, content) in [
            (".gitignore", "secret.env\n"),
            ("secret.env", "KEY=1\n"),
            ("src/.gitignore", "local.json\n"),
            ("src/local.json", "{}\n"),
            ("src/main.ts", "main\n"),
            ("uploads/.gitignore", "*\n"),
            ("uploads/photo.png", "pixels\n"),
            ("assets/cache.log", "log\n"),
        ] {
            let file = project.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, content).unwrap();
        }
    }

    fn listed(changes: Vec<FileChange>) -> Vec<String> {
        let mut listed: Vec<String> = changes
            .into_iter()
            .map(|change| format!("{} {}", change.status, change.path))
            .collect();
        listed.sort();
        listed
    }

    fn read(project: &Path, path: &str) -> String {
        std::fs::read_to_string(project.join(path)).unwrap()
    }

    #[test]
    fn restore_keeps_ignored_files_after_a_turn_edited_the_ignore_files() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().canonicalize().unwrap().join("project");
        project_with_ignored_files(&project);
        let shadow = ShadowRepo::open(temp.path(), "project-1", &project).unwrap();
        let base = shadow.snapshot("base").unwrap();

        // The turn empties the ignore files, so git sees every file, and adds
        // files of its own next to the ones that were ignored.
        for ignore_file in [".gitignore", "src/.gitignore", "uploads/.gitignore"] {
            std::fs::write(project.join(ignore_file), "").unwrap();
        }
        for made in ["made.txt", "uploads/made.png", "assets/logo.svg"] {
            std::fs::write(project.join(made), "made\n").unwrap();
        }

        // Only the turn's own work is a change: what was ignored is not new.
        let turn = [
            "A assets/logo.svg",
            "A made.txt",
            "A uploads/made.png",
            "M .gitignore",
            "M src/.gitignore",
        ];
        assert_eq!(listed(shadow.changes_since(&base).unwrap()), turn);
        let after = shadow.snapshot("change set").unwrap();
        assert_eq!(listed(shadow.changes_between(&base, &after).unwrap()), turn);

        let mut restored = shadow.restore_to(&base).unwrap();
        restored.sort();
        assert_eq!(
            restored,
            [
                ".gitignore",
                "assets/logo.svg",
                "made.txt",
                "src/.gitignore",
                "uploads/made.png"
            ]
        );
        for made in ["made.txt", "uploads/made.png", "assets/logo.svg"] {
            assert!(!project.join(made).exists(), "{made}");
        }
        assert_eq!(read(&project, ".gitignore"), "secret.env\n");
        assert_eq!(read(&project, "src/.gitignore"), "local.json\n");
        assert_eq!(read(&project, "secret.env"), "KEY=1\n");
        assert_eq!(read(&project, "src/local.json"), "{}\n");
        assert_eq!(read(&project, "uploads/photo.png"), "pixels\n");
        assert_eq!(read(&project, "assets/cache.log"), "log\n");
        // An ignored ignore file was never in a snapshot and stays as edited.
        assert_eq!(read(&project, "uploads/.gitignore"), "");
        assert!(shadow.changes_since(&base).unwrap().is_empty());
        // Covered by its ignore file again, the secret is ignored again.
        assert_eq!(
            shadow.ignored_entries(&project.join("secret.env")),
            Some(vec!["secret.env".to_string()])
        );
    }

    #[test]
    fn restore_keeps_ignored_files_after_a_turn_deleted_the_ignore_files() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        project_with_ignored_files(&project);
        let shadow = ShadowRepo::open(temp.path(), "project-1", &project).unwrap();
        let base = shadow.snapshot("base").unwrap();

        for ignore_file in [".gitignore", "src/.gitignore", "uploads/.gitignore"] {
            std::fs::remove_file(project.join(ignore_file)).unwrap();
        }
        std::fs::write(project.join("made.txt"), "made\n").unwrap();
        // The snapshot at the end of the turn stages what is no longer ignored.
        shadow.snapshot("change set").unwrap();

        let mut restored = shadow.restore_to(&base).unwrap();
        restored.sort();
        assert_eq!(restored, [".gitignore", "made.txt", "src/.gitignore"]);
        assert!(!project.join("made.txt").exists());
        assert_eq!(read(&project, ".gitignore"), "secret.env\n");
        assert_eq!(read(&project, "src/.gitignore"), "local.json\n");
        assert_eq!(read(&project, "secret.env"), "KEY=1\n");
        assert_eq!(read(&project, "src/local.json"), "{}\n");
        assert_eq!(read(&project, "uploads/photo.png"), "pixels\n");
        assert_eq!(read(&project, "assets/cache.log"), "log\n");
        // No snapshot ever held this one, so it cannot come back.
        assert!(!project.join("uploads/.gitignore").exists());
        assert!(shadow.changes_since(&base).unwrap().is_empty());
    }

    #[test]
    fn restore_to_a_snapshot_without_a_note_keeps_additions_once_an_ignore_file_changed() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        project_with_ignored_files(&project);
        let shadow = ShadowRepo::open(temp.path(), "project-1", &project).unwrap();
        let base = shadow.snapshot("base").unwrap();
        // A snapshot from before notes were kept.
        std::fs::remove_file(shadow.git_dir.join(IGNORED_NOTES).join(&base)).unwrap();

        std::fs::write(project.join("made.txt"), "made\n").unwrap();
        shadow.restore_to(&base).unwrap();
        assert!(!project.join("made.txt").exists());

        std::fs::write(project.join(".gitignore"), "").unwrap();
        std::fs::write(project.join("made.txt"), "made\n").unwrap();
        shadow.restore_to(&base).unwrap();
        assert_eq!(read(&project, ".gitignore"), "secret.env\n");
        assert_eq!(read(&project, "secret.env"), "KEY=1\n");
        // Nothing tells this file from the secret, so it is kept as well.
        assert_eq!(read(&project, "made.txt"), "made\n");
    }

    #[test]
    fn snapshots_leave_out_a_repository_without_commits() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().canonicalize().unwrap().join("project");
        std::fs::create_dir_all(project.join("src")).unwrap();
        std::fs::write(project.join("src/main.ts"), "one\n").unwrap();
        // `git init` and no commit: an empty one, one with a file and one two
        // folders down, next to an ordinary file.
        for nested in ["empty", "draft", "deep/a/b"] {
            std::fs::create_dir_all(project.join(nested)).unwrap();
            sh(&project.join(nested), &["init", "-q"]);
        }
        std::fs::write(project.join("draft/notes.txt"), "notes\n").unwrap();
        std::fs::write(project.join("deep/a/sibling.txt"), "sibling\n").unwrap();

        let shadow = ShadowRepo::open(temp.path(), "project-1", &project).unwrap();
        let base = shadow.snapshot("base").unwrap();
        std::fs::write(project.join("src/main.ts"), "two\n").unwrap();
        std::fs::write(project.join("deep/a/sibling.txt"), "changed\n").unwrap();
        std::fs::write(project.join("draft/notes.txt"), "more notes\n").unwrap();
        assert_eq!(
            listed(shadow.changes_since(&base).unwrap()),
            ["M deep/a/sibling.txt", "M src/main.ts"]
        );

        shadow.restore_to(&base).unwrap();
        assert_eq!(read(&project, "src/main.ts"), "one\n");
        assert_eq!(read(&project, "deep/a/sibling.txt"), "sibling\n");
        // What no snapshot holds is neither restored nor vouched for.
        assert_eq!(read(&project, "draft/notes.txt"), "more notes\n");
        for path in ["empty", "draft", "draft/notes.txt", "deep", "deep/a/b"] {
            assert_eq!(shadow.ignored_entries(&project.join(path)), None, "{path}");
        }
        assert_eq!(
            shadow.ignored_entries(&project.join("src")),
            Some(Vec::new())
        );
    }

    #[test]
    fn shadow_snapshots_skip_hooks() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let shadow = ShadowRepo::open(temp.path(), "project-1", &project).unwrap();
        let hooks = shadow.git_dir.join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("pre-commit");
        std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::write(project.join("a.txt"), "a\n").unwrap();
        shadow.snapshot("with a failing hook installed").unwrap();
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

    #[test]
    fn removing_a_shadow_deletes_its_directory() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        ShadowRepo::open(temp.path(), "project-1", &project).unwrap();
        assert!(shadow_dir(temp.path(), "project-1").exists());
        remove_shadow(temp.path(), "project-1").unwrap();
        assert!(!shadow_dir(temp.path(), "project-1").exists());
        remove_shadow(temp.path(), "project-1").unwrap();
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
        assert_eq!(diff.status, "A");

        let diff = project_file_diff(&project, "tracked.txt", false).unwrap();
        assert_eq!(diff.old_content, "one\n");
        assert_eq!(diff.new_content, "one\ntwo\n");
        assert_eq!(diff.additions, 1);
        assert_eq!(diff.status, "M");

        git_unstage(&project, Some("new.txt")).unwrap();
        assert!(project_git_status(&project).unwrap().staged.is_empty());
    }

    #[test]
    fn paths_with_spaces_and_quotes_are_reported_verbatim() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        for name in ["my file.txt", "quote\".txt", "tab\there.txt"] {
            std::fs::write(project.join(name), "a\nb\n").unwrap();
        }

        let status = project_git_status(&project).unwrap();
        for name in ["my file.txt", "quote\".txt", "tab\there.txt"] {
            let change = status
                .unstaged
                .iter()
                .find(|change| change.path == name)
                .unwrap_or_else(|| panic!("{name} listed verbatim"));
            assert_eq!(change.additions, 2);
        }

        git_stage(&project, Some("my file.txt")).unwrap();
        git_stage_paths(&project, &["quote\".txt".to_string()]).unwrap();
        let status = project_git_status(&project).unwrap();
        assert!(status
            .staged
            .iter()
            .any(|change| change.path == "my file.txt"));
        assert!(status
            .staged
            .iter()
            .any(|change| change.path == "quote\".txt"));

        std::fs::write(project.join("my file.txt"), "a\nb\nc\n").unwrap();
        let diff = project_file_diff(&project, "my file.txt", false).unwrap();
        assert_eq!(diff.old_content, "a\nb\n");
        assert_eq!(diff.new_content, "a\nb\nc\n");
        assert_eq!(diff.additions, 1);
    }

    #[test]
    fn skips_line_counts_for_huge_untracked_sets() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        std::fs::write(project.join("small.txt"), "one\ntwo\nthree\n").unwrap();
        let status = project_git_status(&project).unwrap();
        let small = status
            .unstaged
            .iter()
            .find(|change| change.path == "small.txt")
            .unwrap();
        assert_eq!(small.additions, 3);

        for index in 0..501 {
            std::fs::write(project.join(format!("file-{index}.txt")), "x\n").unwrap();
        }
        let status = project_git_status(&project).unwrap();
        assert!(!status.unstaged.is_empty());
        assert!(status.unstaged.iter().all(|change| change.additions == 0));
    }

    #[test]
    fn discard_restores_the_staged_version_and_deletes_untracked_files() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        std::fs::write(project.join("tracked.txt"), "one\ntwo\n").unwrap();
        // Staged as new, then edited again: discarding the edit keeps the file.
        std::fs::write(project.join("staged_new.txt"), "staged\n").unwrap();
        git_stage(&project, Some("staged_new.txt")).unwrap();
        std::fs::write(project.join("staged_new.txt"), "staged\nunstaged\n").unwrap();
        std::fs::write(project.join("untracked.txt"), "untracked\n").unwrap();

        git_discard_paths(&project, &["staged_new.txt".to_string()]).unwrap();
        assert_eq!(
            std::fs::read_to_string(project.join("staged_new.txt")).unwrap(),
            "staged\n"
        );

        let paths = vec!["tracked.txt".to_string(), "untracked.txt".to_string()];
        git_discard_paths(&project, &paths).unwrap();
        assert_eq!(
            std::fs::read_to_string(project.join("tracked.txt")).unwrap(),
            "one\n"
        );
        assert!(!project.join("untracked.txt").exists());

        let status = project_git_status(&project).unwrap();
        assert!(status.unstaged.is_empty());
        assert!(status
            .staged
            .iter()
            .any(|change| change.path == "staged_new.txt" && change.status == "A"));
    }

    #[test]
    fn discard_treats_paths_literally() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        std::fs::write(project.join("f[1].txt"), "orig\n").unwrap();
        std::fs::write(project.join("f1.txt"), "orig\n").unwrap();
        commit(&project, "add files");

        std::fs::write(project.join("f[1].txt"), "changed\n").unwrap();
        std::fs::write(project.join("f1.txt"), "unsaved work\n").unwrap();
        git_discard_paths(&project, &["f[1].txt".to_string()]).unwrap();

        assert_eq!(
            std::fs::read_to_string(project.join("f[1].txt")).unwrap(),
            "orig\n"
        );
        assert_eq!(
            std::fs::read_to_string(project.join("f1.txt")).unwrap(),
            "unsaved work\n"
        );
    }

    #[test]
    fn discard_rejects_paths_outside_the_project() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        std::fs::write(temp.path().join("outside.txt"), "keep\n").unwrap();
        assert!(git_discard_paths(&project, &["../outside.txt".to_string()]).is_err());
        assert!(git_discard_paths(&project, &["/etc/hosts".to_string()]).is_err());
        assert!(temp.path().join("outside.txt").exists());
    }

    #[test]
    fn stage_and_unstage_paths_handle_many_files() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        let mut paths = Vec::new();
        for index in 0..3 {
            let name = format!("file-{index}.txt");
            std::fs::write(project.join(&name), "x\n").unwrap();
            paths.push(name);
        }
        git_stage_paths(&project, &paths).unwrap();
        assert_eq!(project_git_status(&project).unwrap().staged.len(), 3);

        git_unstage_paths(&project, &paths).unwrap();
        let status = project_git_status(&project).unwrap();
        assert!(status.staged.is_empty());
        assert_eq!(status.unstaged.len(), 3);
    }

    #[test]
    fn concurrent_stages_and_status_reads_do_not_collide() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        let paths: Vec<String> = (0..24).map(|index| format!("file-{index}.txt")).collect();
        for path in &paths {
            std::fs::write(project.join(path), "x\n").unwrap();
        }

        std::thread::scope(|scope| {
            for path in &paths {
                let project = &project;
                scope.spawn(move || git_stage(project, Some(path.as_str())).unwrap());
                scope.spawn(move || project_git_status(project).unwrap());
            }
        });
        assert_eq!(
            project_git_status(&project).unwrap().staged.len(),
            paths.len()
        );
    }

    #[test]
    fn non_repo_status_is_flagged() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("plain");
        std::fs::create_dir_all(&project).unwrap();
        let status = project_git_status(&project).unwrap();
        assert!(!status.is_repo);
        assert!(refs(&project).branches.is_empty());
    }

    #[test]
    fn branch_is_named_before_the_first_commit_and_absent_when_detached() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        sh(&project, &["init", "-q", "-b", "trunk"]);
        let status = project_git_status(&project).unwrap();
        assert_eq!(status.branch.as_deref(), Some("trunk"));
        assert!(status.head.is_none());

        configure_test_repo(&project);
        std::fs::write(project.join("a.txt"), "a\n").unwrap();
        commit(&project, "first");
        sh(&project, &["checkout", "-q", "--detach"]);
        let status = project_git_status(&project).unwrap();
        assert!(status.branch.is_none());
        assert!(status.head.is_some());
    }

    #[test]
    fn tags_are_listed_with_full_peeled_hashes() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        let head = sh(&project, &["rev-parse", "HEAD"]);

        git_tag_create(&project, "annotated", Some("HEAD"), Some("release")).unwrap();
        git_tag_create(&project, "lightweight", Some("HEAD"), None).unwrap();

        let tags = refs(&project).tags;
        assert_eq!(tags.len(), 2);
        for tag in tags {
            assert_eq!(tag.hash, head, "tag {} should peel to the commit", tag.name);
        }
    }

    #[test]
    fn branches_and_commits_are_reported() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        let branches = refs(&project).branches;
        let current = branches
            .iter()
            .find(|branch| branch.current)
            .expect("current branch listed");
        assert!(!current.remote);
        assert_eq!(current.subject.as_deref(), Some("init"));
        assert!(current.hash.is_some());
        assert!(current.timestamp.is_some());

        let commits = project_commits(&project, None, None, 0, 10).unwrap();
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].subject, "init");
        assert!(!commits[0].short_hash.is_empty());
    }

    #[test]
    fn commits_of_an_empty_repository_are_empty() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        sh(&project, &["init", "-q"]);
        assert!(project_commits(&project, None, None, 0, 10)
            .unwrap()
            .is_empty());
        assert!(project_commits(&project, None, Some("a.txt"), 0, 10)
            .unwrap()
            .is_empty());
        assert!(project_commits(&project, Some("x"), None, 0, 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn remote_head_is_not_a_branch_and_remote_names_are_split() {
        let temp = tempfile::tempdir().unwrap();
        let origin = temp.path().join("origin");
        init_repo(&origin);
        let default = project_current_branch(&origin).unwrap();
        sh(&origin, &["checkout", "-q", "-b", "feature/x"]);
        sh(&origin, &["checkout", "-q", &default]);
        let project = temp.path().join("project");
        sh(
            temp.path(),
            &[
                "clone",
                "-q",
                origin.to_str().unwrap(),
                project.to_str().unwrap(),
            ],
        );
        sh(&project, &["remote", "rename", "origin", "team/origin"]);
        sh(
            &project,
            &[
                "checkout",
                "-q",
                "--track",
                "-b",
                "local-x",
                "team/origin/feature/x",
            ],
        );

        let branches = refs(&project).branches;
        assert!(branches
            .iter()
            .all(|branch| branch.name != "team/origin" && !branch.name.ends_with("/HEAD")));
        let remote = branches
            .iter()
            .find(|branch| branch.remote && branch.name == "team/origin/feature/x")
            .expect("remote branch listed");
        assert_eq!(remote.remote_name.as_deref(), Some("team/origin"));
        assert_eq!(remote.remote_branch.as_deref(), Some("feature/x"));
        let local = branches
            .iter()
            .find(|branch| branch.name == "local-x")
            .expect("tracking branch listed");
        assert_eq!(local.remote_name.as_deref(), Some("team/origin"));
        assert_eq!(local.remote_branch.as_deref(), Some("feature/x"));
    }

    #[test]
    fn stashes_carry_their_message_and_hash() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        std::fs::write(project.join("tracked.txt"), "one\ntwo\n").unwrap();
        git_stash_push(&project, Some("wip"), true).unwrap();
        assert_eq!(
            std::fs::read_to_string(project.join("tracked.txt")).unwrap(),
            "one\n"
        );

        let stashes = refs(&project).stashes;
        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].name, "stash@{0}");
        assert!(stashes[0].message.ends_with("wip"));

        git_stash_pop(&project, &stashes[0].name, &stashes[0].hash).unwrap();
        assert_eq!(
            std::fs::read_to_string(project.join("tracked.txt")).unwrap(),
            "one\ntwo\n"
        );
        assert!(refs(&project).stashes.is_empty());

        std::fs::write(project.join("tracked.txt"), "one\nthree\n").unwrap();
        git_stash_push(&project, None, false).unwrap();
        let stashes = refs(&project).stashes;
        git_stash_drop(&project, &stashes[0].name, &stashes[0].hash).unwrap();
        assert!(refs(&project).stashes.is_empty());
    }

    #[test]
    fn stash_actions_refuse_an_entry_that_moved() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        std::fs::write(project.join("tracked.txt"), "first\n").unwrap();
        git_stash_push(&project, Some("first"), false).unwrap();
        let picked = refs(&project).stashes.remove(0);

        std::fs::write(project.join("tracked.txt"), "second\n").unwrap();
        git_stash_push(&project, Some("second"), false).unwrap();

        // `stash@{0}` is now "second"; dropping it must not happen.
        assert!(git_stash_drop(&project, &picked.name, &picked.hash).is_err());
        assert_eq!(refs(&project).stashes.len(), 2);
        assert!(git_stash_drop(&project, "stash@{0}; rm -rf /", &picked.hash).is_err());
    }

    #[test]
    fn blame_reports_author_and_content() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        let blame = project_blame(&project, "tracked.txt").unwrap();
        assert_eq!(blame.len(), 1);
        assert_eq!(blame[0].content, "one");
        assert_eq!(blame[0].author, "test");
        assert_eq!(blame[0].line, 1);
        assert_eq!(blame[0].short_hash.len(), 7);
        assert!(blame[0].timestamp > 0);
    }

    #[test]
    fn ignore_appends_to_gitignore_without_duplicates() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        git_ignore(&project, "new.txt").unwrap();
        git_ignore(&project, "new.txt").unwrap();
        let gitignore = std::fs::read_to_string(project.join(".gitignore")).unwrap();
        assert_eq!(gitignore.matches("new.txt").count(), 1);
    }

    #[test]
    fn ignore_entries_match_exactly_one_path() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        std::fs::create_dir_all(project.join("app/nested")).unwrap();

        git_ignore(&project, "app/[id].tsx").unwrap();
        git_ignore(&project, "notes.txt").unwrap();
        let ignored = |path: &str| check_ignore(git(&project), path);
        assert!(ignored("app/[id].tsx"));
        assert!(!ignored("app/i.tsx"));
        assert!(ignored("notes.txt"));
        assert!(!ignored("app/nested/notes.txt"));
        assert!(git_ignore(&project, "../escape.txt").is_err());
    }

    #[test]
    fn ignored_paths_handles_large_candidate_sets_without_deadlock() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        std::fs::write(project.join(".gitignore"), "ignored/\n").unwrap();

        let paths: Vec<PathBuf> = (0..5000)
            .map(|index| project.join(format!("ignored/file-{index}.txt")))
            .collect();
        let ignored = ignored_paths(&project, &paths);
        assert_eq!(ignored.len(), paths.len());
        assert!(paths.iter().all(|path| ignored.contains(path)));
    }

    #[test]
    fn probe_reports_gitignored_paths() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        std::fs::write(project.join(".gitignore"), "secret/\n").unwrap();
        let probe = GitProbe {
            project_root: &project,
            shadow: None,
        };
        assert!(probe.is_ignored("secret/[key].pem"));
        assert!(!probe.is_ignored("src/[id].tsx"));
    }

    #[test]
    fn file_history_filters_commits_by_path() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        std::fs::write(project.join("other.txt"), "other\n").unwrap();
        commit(&project, "other");

        assert_eq!(
            project_commits(&project, None, None, 0, 10).unwrap().len(),
            2
        );
        let tracked = project_commits(&project, None, Some("tracked.txt"), 0, 10).unwrap();
        assert_eq!(tracked.len(), 1);
        assert_eq!(tracked[0].subject, "init");
        assert!(project_commits(&project, None, Some("missing.txt"), 0, 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn commit_detail_and_file_diff_are_reported() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        std::fs::write(project.join("tracked.txt"), "one\ntwo\n").unwrap();
        commit(&project, "second");

        let commits = project_commits(&project, None, None, 0, 10).unwrap();
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
    fn merge_commit_details_list_what_the_merge_brought_in() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        let default = project_current_branch(&project).unwrap();
        sh(&project, &["checkout", "-q", "-b", "side"]);
        std::fs::write(project.join("side file.txt"), "side\n").unwrap();
        commit(&project, "side");
        sh(&project, &["checkout", "-q", &default]);
        std::fs::write(project.join("main.txt"), "main\n").unwrap();
        commit(&project, "main");
        sh(
            &project,
            &["merge", "-q", "--no-ff", "side", "-m", "merge side"],
        );

        let detail = project_commit_detail(&project, "HEAD").unwrap();
        assert_eq!(detail.parents.len(), 2);
        assert_eq!(detail.changes.len(), 1);
        assert_eq!(detail.changes[0].path, "side file.txt");
        assert_eq!(detail.changes[0].status, "A");
    }

    #[test]
    fn diffs_flag_binary_files_and_keep_non_utf8_text() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        std::fs::write(project.join("latin1.txt"), b"caf\xe9\n").unwrap();
        std::fs::write(project.join("image.bin"), b"\x89PNG\0\0data").unwrap();
        std::fs::write(project.join("empty.txt"), b"").unwrap();
        commit(&project, "files");

        std::fs::write(project.join("latin1.txt"), b"caf\xe9\ncr\xe8me\n").unwrap();
        let diff = project_file_diff(&project, "latin1.txt", false).unwrap();
        assert_eq!(diff.status, "M");
        assert!(!diff.binary);
        assert_eq!(diff.additions, 1);
        assert!(diff.new_content.starts_with("caf"));

        std::fs::write(project.join("image.bin"), b"\x89PNG\0\0other").unwrap();
        let diff = project_file_diff(&project, "image.bin", false).unwrap();
        assert!(diff.binary);
        assert_eq!(diff.status, "M");
        assert!(diff.old_content.is_empty() && diff.new_content.is_empty());

        // An empty file that still exists is modified, not deleted.
        std::fs::write(project.join("tracked.txt"), b"").unwrap();
        assert_eq!(
            project_file_diff(&project, "tracked.txt", false)
                .unwrap()
                .status,
            "M"
        );
        std::fs::remove_file(project.join("empty.txt")).unwrap();
        assert_eq!(
            project_file_diff(&project, "empty.txt", false)
                .unwrap()
                .status,
            "D"
        );
    }

    #[test]
    fn oversized_files_are_not_sent_to_the_diff() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        let big = "x".repeat(MAX_DIFF_BYTES as usize + 1);
        std::fs::write(project.join("big.txt"), &big).unwrap();
        let diff = project_file_diff(&project, "big.txt", false).unwrap();
        assert!(diff.too_large);
        assert!(diff.new_content.is_empty());
        assert_eq!(diff.status, "A");
    }

    #[test]
    fn commit_search_matches_message_author_and_hash() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        std::fs::write(project.join("tracked.txt"), "one\ntwo\n").unwrap();
        sh(&project, &["add", "--", "tracked.txt"]);
        sh(
            &project,
            &[
                "-c",
                "user.name=Alice",
                "commit",
                "-q",
                "-m",
                "Add feature",
                "-m",
                "Body mentions Zebra",
            ],
        );

        let by_message = project_commits(&project, Some("feature"), None, 0, 10).unwrap();
        assert_eq!(by_message.len(), 1);
        assert_eq!(by_message[0].subject, "Add feature");

        let by_body = project_commits(&project, Some("zebra"), None, 0, 10).unwrap();
        assert_eq!(by_body.len(), 1);

        let by_author = project_commits(&project, Some("alice"), None, 0, 10).unwrap();
        assert_eq!(by_author.len(), 1);

        let prefix = &by_message[0].short_hash[..4];
        let by_hash = project_commits(&project, Some(prefix), None, 0, 10).unwrap();
        assert!(by_hash.iter().any(|commit| commit.subject == "Add feature"));

        let none = project_commits(&project, Some("zzzzz"), None, 0, 10).unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn commit_search_lists_each_commit_once_and_pages() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        // Same timestamps and a query that matches author and message alike.
        for index in 0..5 {
            std::fs::write(project.join("tracked.txt"), format!("{index}\n")).unwrap();
            sh(&project, &["add", "-A"]);
            let output = git(&project)
                .args([
                    "-c",
                    "user.name=Carol",
                    "commit",
                    "-q",
                    "-m",
                    &format!("Carol change {index}"),
                ])
                .env("GIT_AUTHOR_DATE", "2024-01-01T00:00:00Z")
                .env("GIT_COMMITTER_DATE", "2024-01-01T00:00:00Z")
                .output()
                .unwrap();
            assert!(output.status.success());
        }

        let all = project_commits(&project, Some("carol"), None, 0, 50).unwrap();
        assert_eq!(all.len(), 5);
        let unique: HashSet<&str> = all.iter().map(|commit| commit.hash.as_str()).collect();
        assert_eq!(unique.len(), 5);

        let first = project_commits(&project, Some("carol"), None, 0, 2).unwrap();
        let second = project_commits(&project, Some("carol"), None, 2, 2).unwrap();
        assert_eq!(first.len(), 2);
        assert_eq!(second.len(), 2);
        assert_eq!(first[0].hash, all[0].hash);
        assert_eq!(second[0].hash, all[2].hash);
    }

    #[test]
    fn branch_create_rename_and_delete_are_supported() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        git_branch_create(&project, "feature", Some("HEAD"), false).unwrap();
        assert!(refs(&project)
            .branches
            .iter()
            .any(|branch| branch.name == "feature"));

        git_branch_rename(&project, "feature", "feature-renamed").unwrap();
        assert!(refs(&project)
            .branches
            .iter()
            .any(|branch| branch.name == "feature-renamed"));

        git_branch_delete(&project, "feature-renamed", false, false).unwrap();
        assert!(!refs(&project)
            .branches
            .iter()
            .any(|branch| branch.name == "feature-renamed"));
    }

    #[test]
    fn unmerged_branches_are_only_deleted_when_forced() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        let default = project_current_branch(&project).unwrap();
        sh(&project, &["checkout", "-q", "-b", "wip"]);
        std::fs::write(project.join("wip.txt"), "work\n").unwrap();
        commit(&project, "unmerged work");
        sh(&project, &["checkout", "-q", &default]);

        assert!(git_branch_delete(&project, "wip", false, false).is_err());
        assert!(refs(&project)
            .branches
            .iter()
            .any(|branch| branch.name == "wip"));
        git_branch_delete(&project, "wip", false, true).unwrap();
        assert!(!refs(&project)
            .branches
            .iter()
            .any(|branch| branch.name == "wip"));
    }

    #[test]
    fn option_like_arguments_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        let target = temp.path().join("written-by-git");
        let output = format!("--output={}", target.display());

        assert!(project_commit_detail(&project, &output).is_err());
        assert!(git_checkout(&project, "--orphan=x", false, None).is_err());
        assert!(git_merge(&project, "--no-verify").is_err());
        assert!(git_rebase(&project, "--exec=true").is_err());
        assert!(git_tag_push(&project, "--receive-pack=true", "v1").is_err());
        assert!(git_push_branch(&project, "main", "--repo=x", false).is_err());
        assert!(project_rebase_commits(&project, "--all").is_err());
        assert!(!target.exists());
        // HEAD stays usable for the amend prefill.
        assert_eq!(
            project_commit_detail(&project, "HEAD").unwrap().subject,
            "init"
        );
    }

    #[test]
    fn checkout_prefers_the_branch_over_a_file_of_the_same_name() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        std::fs::write(project.join("feature"), "file\n").unwrap();
        commit(&project, "file named feature");
        sh(&project, &["branch", "feature"]);
        std::fs::write(project.join("feature"), "unsaved\n").unwrap();

        git_checkout(&project, "feature", false, None).unwrap();
        assert_eq!(project_current_branch(&project).as_deref(), Some("feature"));
        assert_eq!(
            std::fs::read_to_string(project.join("feature")).unwrap(),
            "unsaved\n"
        );
    }

    #[test]
    fn a_branch_and_a_tag_of_the_same_name_are_told_apart() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        let default = project_current_branch(&project).unwrap();
        let first = sh(&project, &["rev-parse", "HEAD"]);
        // The tag stays on the first commit while the branch moves on.
        sh(&project, &["tag", "release"]);
        sh(&project, &["checkout", "-q", "-b", "release"]);
        std::fs::write(project.join("released.txt"), "released\n").unwrap();
        commit(&project, "on the branch");
        let tip = sh(&project, &["rev-parse", "HEAD"]);
        let commit_of = |name: &str| sh(&project, &["rev-parse", &format!("{name}^{{commit}}")]);

        // Both are listed under the name the commands take.
        assert_eq!(project_current_branch(&project).as_deref(), Some("release"));
        let all = refs(&project);
        let current = all.branches.iter().find(|branch| branch.current);
        assert_eq!(current.map(|branch| branch.name.as_str()), Some("release"));
        let tags: Vec<&str> = all.tags.iter().map(|tag| tag.name.as_str()).collect();
        assert_eq!(tags, ["release"]);

        // Checking the name out switches to the branch, not to the tag's commit.
        git_checkout(&project, &default, false, None).unwrap();
        git_checkout(&project, "release", false, None).unwrap();
        assert_eq!(project_current_branch(&project).as_deref(), Some("release"));
        assert_eq!(commit_of("HEAD"), tip);
        git_checkout(&project, &default, false, None).unwrap();

        // As a revision the name means the branch as well.
        git_branch_create(&project, "from-release", Some("release"), false).unwrap();
        assert_eq!(commit_of("refs/heads/from-release"), tip);
        git_tag_create(&project, "on-release", Some("release"), None).unwrap();
        assert_eq!(commit_of("refs/tags/on-release"), tip);
        git_merge(&project, "release").unwrap();
        assert_eq!(commit_of("HEAD"), tip);
        // Nothing is ahead of the branch now; a commit is ahead of the tag.
        assert!(project_rebase_commits(&project, "release")
            .unwrap()
            .is_empty());

        // Renaming and deleting one leaves the other alone.
        git_branch_rename(&project, "release", "renamed").unwrap();
        git_branch_rename(&project, "renamed", "release").unwrap();
        git_tag_delete(&project, "release").unwrap();
        assert_eq!(commit_of("refs/heads/release"), tip);
        sh(&project, &["tag", "release", &first]);
        git_branch_delete(&project, "release", false, false).unwrap();
        assert!(!refs(&project)
            .branches
            .iter()
            .any(|branch| branch.name == "release"));
        assert_eq!(commit_of("refs/tags/release"), first);
    }

    #[test]
    fn tag_create_supports_lightweight_and_annotated() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);

        git_tag_create(&project, "v1", Some("HEAD"), None).unwrap();
        git_tag_create(&project, "v2", Some("HEAD"), Some("release two")).unwrap();
        let tags = refs(&project).tags;
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
        let subjects: Vec<String> = project_commits(&project, None, None, 0, 10)
            .unwrap()
            .into_iter()
            .map(|commit| commit.subject)
            .collect();
        assert_eq!(subjects, vec!["c", "a", "init"]);
    }

    #[test]
    fn interactive_rebase_rejects_exec_squash_first_and_stale_lists() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        let base = sh(&project, &["rev-parse", "HEAD"]);
        std::fs::write(project.join("a.txt"), "a\n").unwrap();
        commit(&project, "a");
        std::fs::write(project.join("b.txt"), "b\n").unwrap();
        commit(&project, "b");
        let commits = project_rebase_commits(&project, &base).unwrap();
        let hash = |index: usize| commits[index].hash.clone();

        let exec = vec![
            ("exec touch pwned #".to_string(), hash(0)),
            ("pick".to_string(), hash(1)),
        ];
        assert!(git_rebase_interactive(&project, &base, &exec).is_err());
        let squash_first = vec![
            ("squash".to_string(), hash(0)),
            ("pick".to_string(), hash(1)),
        ];
        assert!(git_rebase_interactive(&project, &base, &squash_first).is_err());
        let injected = vec![("pick".to_string(), format!("{}\nexec touch pwned", hash(0)))];
        assert!(git_rebase_interactive(&project, &base, &injected).is_err());

        // A commit made after the list was loaded would be dropped silently.
        let stale = vec![("pick".to_string(), hash(0)), ("pick".to_string(), hash(1))];
        std::fs::write(project.join("c.txt"), "c\n").unwrap();
        commit(&project, "c");
        assert!(git_rebase_interactive(&project, &base, &stale).is_err());
        assert!(project_git_status(&project).unwrap().operation.is_none());
        assert_eq!(
            project_commits(&project, None, None, 0, 10).unwrap().len(),
            4
        );
        assert!(!project.join("pwned").exists());
    }

    #[test]
    fn rebase_commit_list_matches_the_todo_git_would_write() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        let default = project_current_branch(&project).unwrap();
        sh(&project, &["checkout", "-q", "-b", "topic"]);
        std::fs::write(project.join("one.txt"), "1\n").unwrap();
        commit(&project, "one");
        sh(&project, &["checkout", "-q", "-b", "side"]);
        std::fs::write(project.join("side.txt"), "s\n").unwrap();
        commit(&project, "side");
        sh(&project, &["checkout", "-q", "topic"]);
        sh(
            &project,
            &["merge", "-q", "--no-ff", "side", "-m", "merge side"],
        );
        std::fs::write(project.join("two.txt"), "2\n").unwrap();
        commit(&project, "two");
        // `one` also lands upstream as an identical patch.
        sh(&project, &["checkout", "-q", &default]);
        std::fs::write(project.join("one.txt"), "1\n").unwrap();
        commit(&project, "one upstream");
        sh(&project, &["checkout", "-q", "topic"]);

        let subjects: Vec<String> = project_rebase_commits(&project, &default)
            .unwrap()
            .into_iter()
            .map(|commit| commit.subject)
            .collect();
        assert_eq!(subjects, vec!["side", "two"]);
    }

    fn clone_with_upstream(temp: &Path) -> (PathBuf, PathBuf, String) {
        let origin = temp.join("origin");
        init_repo(&origin);
        let origin_branch = project_current_branch(&origin).expect("origin branch");
        let project = temp.join("project");
        sh(
            temp,
            &[
                "clone",
                "-q",
                origin.to_str().unwrap(),
                project.to_str().unwrap(),
            ],
        );
        configure_test_repo(&project);
        sh(
            &project,
            &[
                "checkout",
                "-q",
                "--track",
                "-b",
                "local",
                &format!("origin/{origin_branch}"),
            ],
        );
        std::fs::write(origin.join("tracked.txt"), "one\ntwo\n").unwrap();
        commit(&origin, "advance");
        (origin, project, origin_branch)
    }

    #[test]
    fn fast_forward_advances_the_current_branch_to_upstream() {
        let temp = tempfile::tempdir().unwrap();
        let (origin, project, origin_branch) = clone_with_upstream(temp.path());
        let origin_head = sh(&origin, &["rev-parse", &origin_branch]);

        let before = sh(&project, &["rev-parse", "local"]);
        git_fast_forward(&project, "local").unwrap();
        let after = sh(&project, &["rev-parse", "local"]);
        assert_ne!(before, after);
        assert_eq!(after, origin_head);
    }

    #[test]
    fn fast_forward_advances_a_branch_that_is_not_checked_out() {
        let temp = tempfile::tempdir().unwrap();
        let (origin, project, origin_branch) = clone_with_upstream(temp.path());
        let origin_head = sh(&origin, &["rev-parse", &origin_branch]);
        sh(&project, &["checkout", "-q", "-b", "elsewhere"]);

        git_fast_forward(&project, "local").unwrap();
        assert_eq!(sh(&project, &["rev-parse", "local"]), origin_head);
        assert!(git_fast_forward(&project, "elsewhere").is_err());
    }

    #[test]
    fn push_branch_updates_the_tracked_branch_even_when_names_differ() {
        let temp = tempfile::tempdir().unwrap();
        let origin = temp.path().join("origin.git");
        sh(
            temp.path(),
            &["init", "-q", "--bare", origin.to_str().unwrap()],
        );
        let project = temp.path().join("project");
        init_repo(&project);
        sh(
            &project,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        sh(
            &project,
            &["push", "-q", "origin", "HEAD:refs/heads/feature/x"],
        );
        sh(&project, &["fetch", "-q", "origin"]);
        sh(
            &project,
            &["checkout", "-q", "--track", "-b", "x", "origin/feature/x"],
        );
        std::fs::write(project.join("x.txt"), "x\n").unwrap();
        commit(&project, "work on x");

        git_push_branch(&project, "x", "origin", false).unwrap();
        let remote_heads = sh(
            &origin,
            &["for-each-ref", "--format=%(refname)", "refs/heads"],
        );
        assert_eq!(remote_heads, "refs/heads/feature/x");
        assert_eq!(
            sh(&origin, &["rev-parse", "feature/x"]),
            sh(&project, &["rev-parse", "x"])
        );
    }

    #[test]
    fn pull_request_urls_are_derived_from_remote() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        let remotes = [
            ("origin", "git@github.com:acme/pumr.git"),
            ("enterprise", "ssh://git@github.acme.dev:2222/team/app.git"),
            ("lab", "https://gitlab.com/group/sub/app.git"),
            ("bucket", "https://user@bitbucket.org/team/app.git"),
        ];
        for (name, url) in remotes {
            sh(&project, &["remote", "add", name, url]);
        }

        assert_eq!(
            git_pull_request_url(&project, "origin", "feature").unwrap(),
            "https://github.com/acme/pumr/pull/new/feature"
        );
        assert_eq!(
            git_pull_request_url(&project, "enterprise", "fix/#12").unwrap(),
            "https://github.acme.dev/team/app/pull/new/fix/%2312"
        );
        assert_eq!(
            git_pull_request_url(&project, "lab", "feature/x").unwrap(),
            "https://gitlab.com/group/sub/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fx"
        );
        assert_eq!(
            git_pull_request_url(&project, "bucket", "a&b").unwrap(),
            "https://bitbucket.org/team/app/pull-requests/new?source=a%26b"
        );

        assert_eq!(
            project_remotes(&project),
            vec!["bucket", "enterprise", "lab", "origin"]
        );
    }

    #[test]
    fn unstage_works_before_the_first_commit() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        sh(&project, &["init", "-q"]);

        std::fs::write(project.join("first.txt"), "first\n").unwrap();
        git_stage(&project, Some("first.txt")).unwrap();
        git_unstage(&project, Some("first.txt")).unwrap();

        let status = project_git_status(&project).unwrap();
        assert!(status.staged.is_empty());
        assert!(project.join("first.txt").exists());

        // A file edited after it was staged matches neither the index nor a
        // commit, and git drops its entry only when forced to.
        std::fs::write(project.join("second.txt"), "second\n").unwrap();
        git_stage(&project, None).unwrap();
        std::fs::write(project.join("first.txt"), "first\nedited\n").unwrap();
        git_unstage(&project, None).unwrap();
        assert!(project_git_status(&project).unwrap().staged.is_empty());

        git_stage(&project, None).unwrap();
        std::fs::write(project.join("first.txt"), "first\nedited twice\n").unwrap();
        git_unstage_paths(&project, &["first.txt".to_string()]).unwrap();
        let status = project_git_status(&project).unwrap();
        assert_eq!(listed(status.staged), ["A second.txt"]);
        assert_eq!(read(&project, "first.txt"), "first\nedited twice\n");
    }

    #[test]
    fn unstaging_leaves_a_conflicted_file_in_conflict() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        start_conflicting_merge(&project);
        std::fs::write(project.join("other.txt"), "other\n").unwrap();
        git_stage(&project, Some("other.txt")).unwrap();
        let conflict = sh(&project, &["ls-files", "-u"]);
        assert_eq!(conflict.lines().count(), 3);
        let other_is_staged = || {
            let staged = project_git_status(&project).unwrap().staged;
            staged.iter().any(|change| change.path == "other.txt")
        };

        // Named on its own, the conflicted file is refused.
        let by_path = git_unstage(&project, Some("tracked.txt"));
        let by_list = git_unstage_paths(&project, &["tracked.txt".to_string()]);
        for result in [by_path, by_list] {
            assert_eq!(
                result.unwrap_err().to_string(),
                "conflicts are resolved, not unstaged: tracked.txt"
            );
        }
        assert!(git_apply_lines(&project, "tracked.txt", true, "unstage", 3, "", &[0]).is_err());
        assert!(other_is_staged());

        // Named along with others, it is skipped and the others are unstaged.
        git_unstage(&project, None).unwrap();
        assert!(!other_is_staged());
        git_stage(&project, Some("other.txt")).unwrap();
        git_unstage_paths(
            &project,
            &["tracked.txt".to_string(), "other.txt".to_string()],
        )
        .unwrap();
        assert!(!other_is_staged());
        // Nothing but the conflict is left to unstage.
        assert!(git_unstage(&project, None).is_err());

        // The merge is still open and still waits for the conflict.
        assert_eq!(sh(&project, &["ls-files", "-u"]), conflict);
        let status = project_git_status(&project).unwrap();
        assert_eq!(status.operation.as_deref(), Some("merge"));
        assert_eq!(status.conflicted, ["tracked.txt"]);
        assert!(git_operation_continue(&project, "merge").is_err());
    }

    #[test]
    fn a_merge_stopped_by_conflicts_names_them() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        start_conflicting_merge(&project);
        git_operation_abort(&project, "merge").unwrap();

        let error = git_merge(&project, "feature").unwrap_err().to_string();
        assert!(
            error.contains("CONFLICT (content): Merge conflict in tracked.txt"),
            "{error}"
        );
    }

    fn start_conflicting_merge(project: &Path) {
        let default = project_current_branch(project).expect("default branch");
        git_branch_create(project, "feature", Some("HEAD"), true).unwrap();
        std::fs::write(project.join("tracked.txt"), "feature\n").unwrap();
        commit(project, "feature change");
        git_checkout(project, &default, false, None).unwrap();
        std::fs::write(project.join("tracked.txt"), "main\n").unwrap();
        commit(project, "main change");
        assert!(git_merge(project, "feature").is_err());
    }

    #[test]
    fn merge_conflict_state_can_be_aborted() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        start_conflicting_merge(&project);

        let status = project_git_status(&project).unwrap();
        assert_eq!(status.operation.as_deref(), Some("merge"));
        assert!(status.conflicted.iter().any(|path| path == "tracked.txt"));

        git_operation_abort(&project, "merge").unwrap();
        let status = project_git_status(&project).unwrap();
        assert!(status.operation.is_none());
        assert!(status.conflicted.is_empty());
    }

    #[test]
    fn a_resolved_merge_can_be_continued() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        start_conflicting_merge(&project);

        std::fs::write(project.join("tracked.txt"), "resolved\n").unwrap();
        git_stage(&project, Some("tracked.txt")).unwrap();
        git_operation_continue(&project, "merge").unwrap();

        let status = project_git_status(&project).unwrap();
        assert!(status.operation.is_none());
        let head = project_commit_detail(&project, "HEAD").unwrap();
        assert_eq!(head.parents.len(), 2);
        assert!(git_operation_continue(&project, "bisect").is_err());
    }

    #[test]
    fn operations_are_detected_in_linked_worktrees() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        let worktree = temp.path().join("worktree");
        sh(
            &project,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "wt",
                worktree.to_str().unwrap(),
            ],
        );
        assert!(worktree.join(".git").is_file());

        start_conflicting_merge(&worktree);
        let status = project_git_status(&worktree).unwrap();
        assert_eq!(status.operation.as_deref(), Some("merge"));
        assert!(project_git_status(&project).unwrap().operation.is_none());
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

        let commits = project_commits(&project, None, None, 0, 10).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "second");
    }

    #[test]
    fn submodules_with_spaces_are_listed() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        std::fs::write(
            project.join(".gitmodules"),
            "[submodule \"libs\"]\n\tpath = libs/shared code\n\turl = ../shared\n",
        )
        .unwrap();
        assert_eq!(refs(&project).submodules, vec!["libs/shared code"]);
    }

    fn head(project: &Path) -> String {
        sh(project, &["rev-parse", "HEAD"])
    }

    #[test]
    fn commits_can_be_cherry_picked_and_reverted() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        let default = project_current_branch(&project).expect("default branch");
        git_branch_create(&project, "feature", Some("HEAD"), true).unwrap();
        std::fs::write(project.join("feature.txt"), "feature\n").unwrap();
        commit(&project, "add feature");
        let picked = head(&project);
        git_checkout(&project, &default, false, None).unwrap();
        std::fs::write(project.join("main.txt"), "main\n").unwrap();
        commit(&project, "main moves on");

        git_cherry_pick(&project, &picked).unwrap();
        assert_eq!(
            std::fs::read_to_string(project.join("feature.txt")).unwrap(),
            "feature\n"
        );
        let cherry = head(&project);
        assert_ne!(cherry, picked);

        git_revert(&project, &cherry).unwrap();
        assert!(!project.join("feature.txt").exists());
        let subject = sh(&project, &["log", "-1", "--format=%s"]);
        assert!(subject.starts_with("Revert"), "{subject}");
        assert!(git_revert(&project, "--hard").is_err());
    }

    #[test]
    fn merge_commits_are_picked_against_their_first_parent() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        let default = project_current_branch(&project).expect("default branch");
        git_branch_create(&project, "feature", Some("HEAD"), true).unwrap();
        std::fs::write(project.join("feature.txt"), "feature\n").unwrap();
        commit(&project, "feature");
        git_checkout(&project, &default, false, None).unwrap();
        std::fs::write(project.join("main.txt"), "main\n").unwrap();
        commit(&project, "main");
        sh(
            &project,
            &["merge", "--no-ff", "-q", "-m", "merge feature", "feature"],
        );
        let merge = head(&project);
        assert!(is_merge_commit(&project, &merge));

        git_revert(&project, &merge).unwrap();
        assert!(!project.join("feature.txt").exists());
        assert!(project.join("main.txt").exists());
    }

    #[test]
    fn reset_modes_keep_or_drop_changes() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        let base = head(&project);
        std::fs::write(project.join("tracked.txt"), "two\n").unwrap();
        commit(&project, "second");

        git_reset(&project, &base, "soft").unwrap();
        assert_eq!(head(&project), base);
        let status = project_git_status(&project).unwrap();
        assert!(status
            .staged
            .iter()
            .any(|change| change.path == "tracked.txt"));

        git_reset(&project, &base, "mixed").unwrap();
        let status = project_git_status(&project).unwrap();
        assert!(status.staged.is_empty());
        assert!(status
            .unstaged
            .iter()
            .any(|change| change.path == "tracked.txt"));

        git_reset(&project, &base, "hard").unwrap();
        assert_eq!(
            std::fs::read_to_string(project.join("tracked.txt")).unwrap(),
            "one\n"
        );
        assert!(git_reset(&project, &base, "keep").is_err());
    }

    #[test]
    fn a_commit_can_be_checked_out_detached() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        let base = head(&project);
        std::fs::write(project.join("tracked.txt"), "two\n").unwrap();
        commit(&project, "second");

        git_checkout_commit(&project, &base).unwrap();
        assert_eq!(head(&project), base);
        assert_eq!(project_current_branch(&project), None);
    }

    #[test]
    fn conflicts_resolve_with_either_side() {
        for (side, expected) in [("ours", "main\n"), ("theirs", "feature\n")] {
            let temp = tempfile::tempdir().unwrap();
            let project = temp.path().join("project");
            init_repo(&project);
            start_conflicting_merge(&project);

            git_resolve_conflict(&project, "tracked.txt", side).unwrap();
            assert_eq!(
                std::fs::read_to_string(project.join("tracked.txt")).unwrap(),
                expected
            );
            let status = project_git_status(&project).unwrap();
            assert!(status.conflicted.is_empty());
            assert!(git_resolve_conflict(&project, "tracked.txt", side).is_err());
        }
    }

    #[test]
    fn resolving_with_the_deleting_side_removes_the_file() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        let default = project_current_branch(&project).expect("default branch");
        git_branch_create(&project, "feature", Some("HEAD"), true).unwrap();
        sh(&project, &["rm", "-q", "--", "tracked.txt"]);
        sh(&project, &["commit", "-q", "-m", "delete"]);
        git_checkout(&project, &default, false, None).unwrap();
        std::fs::write(project.join("tracked.txt"), "changed\n").unwrap();
        commit(&project, "change");
        assert!(git_merge(&project, "feature").is_err());

        git_resolve_conflict(&project, "tracked.txt", "theirs").unwrap();
        assert!(!project.join("tracked.txt").exists());
        assert!(project_git_status(&project).unwrap().conflicted.is_empty());
    }

    #[test]
    fn staged_summary_lists_the_staged_diff_and_recent_subjects() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project);
        assert!(staged_summary(&project, 1000).is_err());

        std::fs::write(project.join("tracked.txt"), "one\ntwo\n").unwrap();
        git_stage(&project, None).unwrap();
        let summary = staged_summary(&project, 1000).unwrap();
        assert!(summary.stat.contains("tracked.txt"));
        assert!(summary.patch.contains("+two"));
        assert!(!summary.truncated);
        assert_eq!(summary.recent_subjects, vec!["init".to_string()]);

        let summary = staged_summary(&project, 10).unwrap();
        assert!(summary.truncated);
        assert_eq!(summary.patch.chars().count(), 10);
    }
}
