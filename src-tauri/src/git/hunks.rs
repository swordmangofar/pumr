//! Hunk diffs and line staging for the Changes view.
//!
//! The hunks come straight from `git diff`, and a selection of their lines is
//! turned back into a partial patch that `git apply` checks against the index
//! or the work tree, so what the user saw is exactly what gets applied. An
//! untracked file has no diff in git: its chosen lines are staged by hashing
//! them as the file's content and discarded by rewriting the file.

use super::{
    discard_paths_unlocked, ensure_relative_path, git, git_bytes, git_failure, git_stdout,
    git_stdout_opt, git_succeeds, is_binary, language_for, nul_entries, project_entry,
    remove_entry, unstage_unlocked, with_repo_lock, MAX_DIFF_BYTES,
};
use crate::error::{AppError, Result};
use crate::models::{GitDiffHunk, GitDiffLine, GitDiffLineKind, GitHunkDiff};
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

/// Context lines at or above this show the whole file as one hunk.
const MAX_CONTEXT: u32 = 10_000_000;

/// Starts the error of a line action whose diff changed after it was loaded;
/// the UI reloads the diff when it sees it.
pub const STALE_DIFF: &str = "stale diff";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineAction {
    Stage,
    Unstage,
    Discard,
}

impl LineAction {
    /// Staging and discarding work on the working-tree diff, unstaging on the
    /// staged one.
    fn parse(action: &str, staged: bool) -> Result<Self> {
        match (action, staged) {
            ("stage", false) => Ok(Self::Stage),
            ("discard", false) => Ok(Self::Discard),
            ("unstage", true) => Ok(Self::Unstage),
            _ => Err(AppError::msg(format!(
                "cannot {action} lines of the {} diff",
                if staged { "staged" } else { "working tree" }
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileKind {
    Modified,
    Added,
    Deleted,
}

#[derive(Debug)]
struct Line {
    kind: GitDiffLineKind,
    /// The raw line without its prefix and without the `\n`.
    content: Vec<u8>,
    no_newline: bool,
}

#[derive(Debug)]
struct Hunk {
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
    section: Vec<u8>,
    lines: Vec<Line>,
}

#[derive(Debug)]
struct ParsedDiff {
    kind: FileKind,
    /// The mode of a new or deleted file.
    mode: Option<String>,
    binary: bool,
    /// Why the lines of this diff cannot be applied on their own.
    blocked: Option<&'static str>,
    hunks: Vec<Hunk>,
}

/// Where a diff came from, which decides how its lines are applied.
enum Origin {
    /// `git diff` output for a tracked path.
    Patch {
        kind: FileKind,
        mode: Option<String>,
    },
    /// An untracked file, read from the work tree.
    Untracked { bytes: Vec<u8>, entry: PathBuf },
    /// A diff without lines to apply (binary, too large, a conflict, ...).
    Unavailable,
}

struct FileHunks {
    origin: Origin,
    status: &'static str,
    hunks: Vec<Hunk>,
    binary: bool,
    too_large: bool,
    blocked: Option<&'static str>,
    fingerprint: String,
}

impl FileHunks {
    fn unavailable(status: &'static str, reason: &'static str) -> Self {
        Self {
            origin: Origin::Unavailable,
            status,
            hunks: Vec::new(),
            binary: reason == "binary",
            too_large: reason == "tooLarge",
            blocked: Some(reason),
            fingerprint: String::new(),
        }
    }
}

/// The diff of one changed path, split into hunks. `context` is the number of
/// unchanged lines around each change; very large values show the whole file.
/// With `ignore_whitespace` the hunks hide whitespace-only changes, and their
/// lines cannot be applied one by one.
pub fn project_file_hunks(
    project_root: &Path,
    path: &str,
    staged: bool,
    context: u32,
    ignore_whitespace: bool,
) -> Result<GitHunkDiff> {
    let path = ensure_relative_path(path)?;
    let loaded = load(project_root, path, staged, context, ignore_whitespace)?;
    Ok(to_model(path, staged, loaded))
}

/// Stages, unstages or discards the chosen lines (`ids` from the diff that
/// [`project_file_hunks`] returned with the same `context`). The diff is built
/// again and has to match `fingerprint`, so a file that changed meanwhile is
/// refused instead of patched blindly.
pub fn git_apply_lines(
    project_root: &Path,
    path: &str,
    staged: bool,
    action: &str,
    context: u32,
    fingerprint: &str,
    ids: &[u32],
) -> Result<()> {
    let path = ensure_relative_path(path)?;
    let action = LineAction::parse(action, staged)?;
    with_repo_lock(project_root, || {
        let loaded = load(project_root, path, staged, context, false)?;
        if loaded.fingerprint.is_empty() || loaded.fingerprint != fingerprint {
            return Err(AppError::msg(format!(
                "{STALE_DIFF}: {path} changed since its diff was loaded"
            )));
        }
        if let Some(reason) = loaded.blocked {
            return Err(AppError::msg(format!(
                "the lines of {path} cannot be applied one by one ({reason})"
            )));
        }
        let selected = chosen_changes(&loaded.hunks, ids);
        if selected.is_empty() {
            return Ok(());
        }
        let whole = selected.len() == change_count(&loaded.hunks);
        match loaded.origin {
            Origin::Untracked { bytes, entry } => {
                apply_untracked(project_root, path, action, &bytes, &entry, &selected, whole)
            }
            Origin::Patch { kind, mode } => {
                if whole {
                    return apply_whole_file(project_root, path, action);
                }
                let direction = match action {
                    LineAction::Stage => Direction::Forward,
                    LineAction::Unstage | LineAction::Discard => Direction::Reverse,
                };
                let patch = build_patch(
                    path,
                    kind,
                    mode.as_deref(),
                    &loaded.hunks,
                    &selected,
                    direction,
                );
                let args: &[&str] = match action {
                    LineAction::Stage => &["apply", "--cached", "--whitespace=nowarn", "-"],
                    LineAction::Unstage => &["apply", "--cached", "-R", "--whitespace=nowarn", "-"],
                    LineAction::Discard => &["apply", "-R", "--whitespace=nowarn", "-"],
                };
                git_with_input(project_root, args, &patch).map(|_| ())
            }
            Origin::Unavailable => Err(AppError::msg(format!(
                "the lines of {path} cannot be applied one by one"
            ))),
        }
    })
}

fn load(
    project_root: &Path,
    path: &str,
    staged: bool,
    context: u32,
    ignore_whitespace: bool,
) -> Result<FileHunks> {
    let entry = project_entry(project_root, path)?;
    let index = index_entries(project_root, path)?;
    let in_index = !index.is_empty();
    let status = existence_status(project_root, path, staged, in_index, &entry);
    if index.iter().any(|entry| entry.stage != 0) {
        return Ok(FileHunks::unavailable(status, "conflict"));
    }
    let mut loaded = if !staged && !in_index {
        load_untracked(entry)?
    } else {
        if let Some(reason) = index.iter().find_map(|entry| special_mode(&entry.mode)) {
            return Ok(FileHunks::unavailable(status, reason));
        }
        let worktree = std::fs::symlink_metadata(&entry).ok();
        if !staged
            && worktree
                .as_ref()
                .is_some_and(|meta| meta.file_type().is_symlink())
        {
            return Ok(FileHunks::unavailable(status, "symlink"));
        }
        // Sizes first: `git diff` would read a huge file in full.
        let too_large = if staged {
            blob_too_large(project_root, &format!("HEAD:{path}"))
                || blob_too_large(project_root, &format!(":0:{path}"))
        } else {
            blob_too_large(project_root, &format!(":0:{path}"))
                || worktree.is_some_and(|meta| meta.len() > MAX_DIFF_BYTES)
        };
        if too_large {
            return Ok(FileHunks::unavailable(status, "tooLarge"));
        }
        let args = diff_args(staged, context, ignore_whitespace, path);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let raw = git_bytes(project_root, &args)?;
        let diff = parse_diff(&raw)?;
        if diff.binary {
            return Ok(FileHunks::unavailable(status, "binary"));
        }
        let status = match diff.kind {
            FileKind::Added => "A",
            FileKind::Deleted => "D",
            FileKind::Modified => status,
        };
        FileHunks {
            origin: Origin::Patch {
                kind: diff.kind,
                mode: diff.mode,
            },
            status,
            hunks: diff.hunks,
            binary: false,
            too_large: false,
            blocked: diff.blocked,
            fingerprint: fingerprint("diff", &raw),
        }
    };
    if ignore_whitespace && loaded.blocked.is_none() {
        loaded.blocked = Some("whitespace");
    }
    Ok(loaded)
}

fn load_untracked(entry: PathBuf) -> Result<FileHunks> {
    let metadata = std::fs::symlink_metadata(&entry)?;
    if metadata.file_type().is_symlink() {
        return Ok(FileHunks::unavailable("A", "symlink"));
    }
    if !metadata.is_file() {
        return Err(AppError::msg(format!("{} is not a file", entry.display())));
    }
    if metadata.len() > MAX_DIFF_BYTES {
        return Ok(FileHunks::unavailable("A", "tooLarge"));
    }
    let bytes = std::fs::read(&entry)?;
    if is_binary(&bytes) {
        return Ok(FileHunks::unavailable("A", "binary"));
    }
    let lines: Vec<Line> = split_lines(&bytes)
        .into_iter()
        .map(|line| Line {
            kind: GitDiffLineKind::Add,
            content: line.strip_suffix(b"\n").unwrap_or(line).to_vec(),
            no_newline: !line.ends_with(b"\n"),
        })
        .collect();
    let hunks = if lines.is_empty() {
        Vec::new()
    } else {
        vec![Hunk {
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: lines.len() as u32,
            section: Vec::new(),
            lines,
        }]
    };
    Ok(FileHunks {
        fingerprint: fingerprint("untracked", &bytes),
        origin: Origin::Untracked { bytes, entry },
        status: "A",
        hunks,
        binary: false,
        too_large: false,
        blocked: None,
    })
}

/// `git diff` for one path, pinned against user configuration that would
/// change its output: colors, external or textconv drivers, blank context
/// lines without their space and submodule diffs.
fn diff_args(staged: bool, context: u32, ignore_whitespace: bool, path: &str) -> Vec<String> {
    let mut args: Vec<String> = [
        "-c",
        "diff.suppressBlankEmpty=false",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--submodule=short",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    args.push(format!("-U{}", context.clamp(1, MAX_CONTEXT)));
    if staged {
        args.push("--cached".into());
    }
    if ignore_whitespace {
        args.push("--ignore-all-space".into());
    }
    args.push("--".into());
    args.push(path.into());
    args
}

struct IndexEntry {
    mode: String,
    stage: u8,
}

/// The index entries of exactly `path`: one normally, several while it is
/// conflicted, none when it is untracked.
fn index_entries(project_root: &Path, path: &str) -> Result<Vec<IndexEntry>> {
    let output = git_bytes(project_root, &["ls-files", "-s", "-z", "--", path])?;
    Ok(nul_entries(&output)
        .filter_map(|entry| {
            let (meta, name) = entry.split_once('\t')?;
            // A folder of the same name lists its files instead.
            if name != path {
                return None;
            }
            let mut parts = meta.split(' ');
            let mode = parts.next()?.to_string();
            parts.next()?;
            let stage = parts.next()?.parse().ok()?;
            Some(IndexEntry { mode, stage })
        })
        .collect())
}

/// Symlinks and submodules have content that is not lines of text.
fn special_mode(mode: &str) -> Option<&'static str> {
    match mode {
        "120000" => Some("symlink"),
        "160000" => Some("submodule"),
        _ => None,
    }
}

fn existence_status(
    project_root: &Path,
    path: &str,
    staged: bool,
    in_index: bool,
    entry: &Path,
) -> &'static str {
    if staged {
        let in_head = git_succeeds(project_root, &["cat-file", "-e", &format!("HEAD:{path}")]);
        match (in_head, in_index) {
            (false, true) => "A",
            (true, false) => "D",
            _ => "M",
        }
    } else if !in_index {
        "A"
    } else if std::fs::symlink_metadata(entry).is_err() {
        "D"
    } else {
        "M"
    }
}

fn blob_too_large(project_root: &Path, spec: &str) -> bool {
    git_stdout_opt(project_root, &["cat-file", "-s", spec])
        .and_then(|size| size.parse::<u64>().ok())
        .is_some_and(|size| size > MAX_DIFF_BYTES)
}

fn fingerprint(kind: &str, bytes: &[u8]) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    kind.hash(&mut hasher);
    bytes.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Splits content into lines that keep their `\n`; the last one may lack it.
fn split_lines(bytes: &[u8]) -> Vec<&[u8]> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            lines.push(&bytes[start..=index]);
            start = index + 1;
        }
    }
    if start < bytes.len() {
        lines.push(&bytes[start..]);
    }
    lines
}

fn malformed(reason: &str) -> AppError {
    AppError::msg(format!("unexpected git diff output: {reason}"))
}

/// Parses `git diff` output for a single path.
fn parse_diff(output: &[u8]) -> Result<ParsedDiff> {
    let mut diff = ParsedDiff {
        kind: FileKind::Modified,
        mode: None,
        binary: false,
        blocked: None,
        hunks: Vec::new(),
    };
    let block = |diff: &mut ParsedDiff, reason: &'static str| {
        diff.blocked.get_or_insert(reason);
    };
    let mut headers = 0;
    let mut lines = output.split(|byte| *byte == b'\n').peekable();
    while let Some(line) = lines.next() {
        if line.starts_with(b"@@ ") {
            let mut hunk = parse_hunk_header(line)?;
            let (mut old_left, mut new_left) = (hunk.old_lines, hunk.new_lines);
            while old_left > 0 || new_left > 0 {
                let line = lines.next().ok_or_else(|| malformed("a hunk ends early"))?;
                let (kind, content) = match line.first() {
                    Some(b' ') => (GitDiffLineKind::Context, &line[1..]),
                    Some(b'-') => (GitDiffLineKind::Del, &line[1..]),
                    Some(b'+') => (GitDiffLineKind::Add, &line[1..]),
                    Some(b'\\') => {
                        mark_no_newline(&mut hunk)?;
                        continue;
                    }
                    // `diff.suppressBlankEmpty` drops the space of a blank context line.
                    None => (GitDiffLineKind::Context, line),
                    Some(_) => return Err(malformed("an unknown line in a hunk")),
                };
                let fits = match kind {
                    GitDiffLineKind::Context => old_left > 0 && new_left > 0,
                    GitDiffLineKind::Del => old_left > 0,
                    GitDiffLineKind::Add => new_left > 0,
                };
                if !fits {
                    return Err(malformed("a hunk is longer than its header"));
                }
                if kind != GitDiffLineKind::Add {
                    old_left -= 1;
                }
                if kind != GitDiffLineKind::Del {
                    new_left -= 1;
                }
                hunk.lines.push(Line {
                    kind,
                    content: content.to_vec(),
                    no_newline: false,
                });
            }
            // The marker of the hunk's last line follows once its counts are used up.
            if lines
                .peek()
                .is_some_and(|next| next.first() == Some(&b'\\'))
            {
                lines.next();
                mark_no_newline(&mut hunk)?;
            }
            diff.hunks.push(hunk);
            continue;
        }
        if line.starts_with(b"diff --cc ") || line.starts_with(b"diff --combined ") {
            block(&mut diff, "conflict");
        } else if line.starts_with(b"diff --git ") {
            // A path that turned into a symlink (or back) prints two diffs.
            headers += 1;
            if headers > 1 {
                block(&mut diff, "symlink");
            }
        } else if let Some(mode) = line.strip_prefix(b"new file mode ") {
            diff.kind = FileKind::Added;
            diff.mode = Some(String::from_utf8_lossy(mode).into_owned());
        } else if let Some(mode) = line.strip_prefix(b"deleted file mode ") {
            diff.kind = FileKind::Deleted;
            diff.mode = Some(String::from_utf8_lossy(mode).into_owned());
        } else if line.starts_with(b"Binary files ") || line == b"GIT binary patch" {
            diff.binary = true;
        }
        let mode = line
            .strip_prefix(b"new file mode ")
            .or_else(|| line.strip_prefix(b"deleted file mode "))
            .or_else(|| line.strip_prefix(b"old mode "))
            .or_else(|| line.strip_prefix(b"new mode "))
            .or_else(|| {
                // `index <old>..<new> <mode>` names the mode when it did not change.
                line.strip_prefix(b"index ")
                    .and_then(|rest| rest.split(|byte| *byte == b' ').nth(1))
            });
        if let Some(reason) = mode.and_then(|mode| special_mode(&String::from_utf8_lossy(mode))) {
            block(&mut diff, reason);
        }
    }
    Ok(diff)
}

fn mark_no_newline(hunk: &mut Hunk) -> Result<()> {
    let line = hunk
        .lines
        .last_mut()
        .ok_or_else(|| malformed("a newline marker without a line"))?;
    line.no_newline = true;
    Ok(())
}

/// Parses `@@ -old[,count] +new[,count] @@ section`.
fn parse_hunk_header(line: &[u8]) -> Result<Hunk> {
    let rest = &line[3..];
    let end = rest
        .windows(3)
        .position(|window| window == b" @@")
        .ok_or_else(|| malformed("a hunk header without its end"))?;
    let ranges = std::str::from_utf8(&rest[..end])
        .map_err(|_| malformed("a hunk header that is not text"))?;
    let section = rest[end + 3..]
        .strip_prefix(b" ")
        .unwrap_or(&rest[end + 3..])
        .to_vec();
    let mut parts = ranges.split(' ');
    let old = parts.next().and_then(|part| part.strip_prefix('-'));
    let new = parts.next().and_then(|part| part.strip_prefix('+'));
    let (Some((old_start, old_lines)), Some((new_start, new_lines))) =
        (old.and_then(parse_range), new.and_then(parse_range))
    else {
        return Err(malformed("an unreadable hunk header"));
    };
    Ok(Hunk {
        old_start,
        old_lines,
        new_start,
        new_lines,
        section,
        lines: Vec::new(),
    })
}

fn parse_range(range: &str) -> Option<(u32, u32)> {
    match range.split_once(',') {
        Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
        None => Some((range.parse().ok()?, 1)),
    }
}

fn to_model(path: &str, staged: bool, loaded: FileHunks) -> GitHunkDiff {
    let mut id = 0u32;
    let (mut additions, mut deletions) = (0i64, 0i64);
    let hunks = loaded
        .hunks
        .iter()
        .map(|hunk| {
            let (mut old, mut new) = (hunk.old_start, hunk.new_start);
            let lines = hunk
                .lines
                .iter()
                .map(|line| {
                    let (old_line, new_line) = match line.kind {
                        GitDiffLineKind::Context => {
                            old += 1;
                            new += 1;
                            (Some(old - 1), Some(new - 1))
                        }
                        GitDiffLineKind::Del => {
                            deletions += 1;
                            old += 1;
                            (Some(old - 1), None)
                        }
                        GitDiffLineKind::Add => {
                            additions += 1;
                            new += 1;
                            (None, Some(new - 1))
                        }
                    };
                    let content = line.content.strip_suffix(b"\r").unwrap_or(&line.content);
                    id += 1;
                    GitDiffLine {
                        id: id - 1,
                        kind: line.kind,
                        old_line,
                        new_line,
                        text: String::from_utf8_lossy(content).into_owned(),
                        no_newline: line.no_newline,
                    }
                })
                .collect();
            GitDiffHunk {
                old_start: hunk.old_start,
                old_lines: hunk.old_lines,
                new_start: hunk.new_start,
                new_lines: hunk.new_lines,
                section: String::from_utf8_lossy(&hunk.section).into_owned(),
                lines,
            }
        })
        .collect();
    GitHunkDiff {
        path: path.to_string(),
        staged,
        status: loaded.status.to_string(),
        language: language_for(path).to_string(),
        hunks,
        additions,
        deletions,
        binary: loaded.binary,
        too_large: loaded.too_large,
        blocked: loaded.blocked.map(String::from),
        fingerprint: loaded.fingerprint,
    }
}

/// The chosen ids that name an added or removed line; context is ignored.
fn chosen_changes(hunks: &[Hunk], ids: &[u32]) -> HashSet<u32> {
    let wanted: HashSet<u32> = ids.iter().copied().collect();
    hunks
        .iter()
        .flat_map(|hunk| &hunk.lines)
        .zip(0u32..)
        .filter(|(line, id)| line.kind != GitDiffLineKind::Context && wanted.contains(id))
        .map(|(_, id)| id)
        .collect()
}

fn change_count(hunks: &[Hunk]) -> usize {
    hunks
        .iter()
        .flat_map(|hunk| &hunk.lines)
        .filter(|line| line.kind != GitDiffLineKind::Context)
        .count()
}

/// Choosing every change of a file is the whole-file action, which also
/// covers what a partial patch leaves out, such as a mode change.
fn apply_whole_file(project_root: &Path, path: &str, action: LineAction) -> Result<()> {
    match action {
        LineAction::Stage => git_stdout(project_root, &["add", "-A", "--", path]).map(|_| ()),
        LineAction::Unstage => unstage_unlocked(project_root, &[path]),
        LineAction::Discard => discard_paths_unlocked(project_root, &[path.to_string()]),
    }
}

fn apply_untracked(
    project_root: &Path,
    path: &str,
    action: LineAction,
    bytes: &[u8],
    entry: &Path,
    selected: &HashSet<u32>,
    whole: bool,
) -> Result<()> {
    if whole {
        return match action {
            LineAction::Discard => remove_entry(entry),
            _ => apply_whole_file(project_root, path, action),
        };
    }
    let lines = split_lines(bytes);
    let pick = |keep_selected: bool| -> Vec<u8> {
        lines
            .iter()
            .enumerate()
            .filter(|(index, _)| selected.contains(&(*index as u32)) == keep_selected)
            .flat_map(|(_, line)| line.iter().copied())
            .collect()
    };
    match action {
        LineAction::Stage => {
            // `--path` runs the clean filters `git add` would, such as CRLF conversion.
            let hash = git_with_input(
                project_root,
                &["hash-object", "-w", "--stdin", &format!("--path={path}")],
                &pick(true),
            )?;
            let hash = String::from_utf8_lossy(&hash).trim().to_string();
            let mode = if is_executable(project_root, entry) {
                "100755"
            } else {
                "100644"
            };
            git_stdout(
                project_root,
                &[
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    &format!("{mode},{hash},{path}"),
                ],
            )
            .map(|_| ())
        }
        LineAction::Discard => {
            std::fs::write(entry, pick(false))?;
            Ok(())
        }
        LineAction::Unstage => Err(AppError::msg("an untracked file has nothing staged")),
    }
}

/// The mode `git add` would give a new file: executable only where git
/// trusts the file system's executable bit.
fn is_executable(project_root: &Path, entry: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let trusted = git_stdout_opt(project_root, &["config", "--bool", "core.fileMode"])
            .is_none_or(|value| value != "false");
        trusted
            && std::fs::metadata(entry)
                .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        let _ = (project_root, entry);
        false
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Direction {
    /// Applied as is: the chosen changes move from the old side to the new.
    Forward,
    /// Applied with `-R`: the chosen changes are taken back out of the new side.
    Reverse,
}

/// Builds a patch with only the chosen changes. Going forward, an unchosen
/// removal stays as context and an unchosen addition is dropped; in reverse
/// the roles swap. The side the patch is matched against is unchanged, so
/// `git apply` checks it exactly as `git diff` printed it.
fn build_patch(
    path: &str,
    kind: FileKind,
    mode: Option<&str>,
    hunks: &[Hunk],
    selected: &HashSet<u32>,
    direction: Direction,
) -> Vec<u8> {
    let mut body = Vec::new();
    let mut next_id = 0u32;
    // New lines minus old lines of the hunks written so far.
    let mut delta = 0i64;
    let (mut old_total, mut new_total) = (0u32, 0u32);
    for hunk in hunks {
        let first_id = next_id;
        next_id += hunk.lines.len() as u32;
        let chosen = |index: usize| selected.contains(&(first_id + index as u32));
        let changed =
            |index: usize, kind: GitDiffLineKind| hunk.lines[index].kind == kind && chosen(index);
        let any_chosen = (0..hunk.lines.len())
            .any(|index| hunk.lines[index].kind != GitDiffLineKind::Context && chosen(index));
        if !any_chosen {
            continue;
        }
        let mut lines: Vec<(u8, &[u8], bool)> = Vec::new();
        for (index, line) in hunk.lines.iter().enumerate() {
            let content = line.content.as_slice();
            let later = |kind| (index + 1..hunk.lines.len()).any(|next| changed(next, kind));
            match (line.kind, direction, chosen(index)) {
                (GitDiffLineKind::Context, _, _) => lines.push((b' ', content, line.no_newline)),
                (GitDiffLineKind::Del, _, true) => lines.push((b'-', content, line.no_newline)),
                (GitDiffLineKind::Add, _, true) => lines.push((b'+', content, line.no_newline)),
                (GitDiffLineKind::Del, Direction::Forward, false) => {
                    // The old last line stays, but a chosen addition goes after
                    // it, so the line has to gain its newline.
                    if line.no_newline && later(GitDiffLineKind::Add) {
                        lines.push((b'-', content, true));
                        lines.push((b'+', content, false));
                    } else {
                        lines.push((b' ', content, line.no_newline));
                    }
                }
                (GitDiffLineKind::Add, Direction::Reverse, false) => {
                    if line.no_newline && later(GitDiffLineKind::Del) {
                        lines.push((b'-', content, false));
                        lines.push((b'+', content, true));
                    } else {
                        lines.push((b' ', content, line.no_newline));
                    }
                }
                (GitDiffLineKind::Add, Direction::Forward, false)
                | (GitDiffLineKind::Del, Direction::Reverse, false) => {}
            }
        }
        let old_count = lines.iter().filter(|(prefix, ..)| *prefix != b'+').count() as u32;
        let new_count = lines.iter().filter(|(prefix, ..)| *prefix != b'-').count() as u32;
        // An empty range names the line before it.
        let (old_start, new_start) = match direction {
            Direction::Forward => {
                let before = i64::from(hunk.old_start) - i64::from(hunk.old_lines > 0);
                (
                    i64::from(hunk.old_start),
                    before + delta + i64::from(new_count > 0),
                )
            }
            Direction::Reverse => {
                let before = i64::from(hunk.new_start) - i64::from(hunk.new_lines > 0);
                (
                    before - delta + i64::from(old_count > 0),
                    i64::from(hunk.new_start),
                )
            }
        };
        delta += i64::from(new_count) - i64::from(old_count);
        old_total += old_count;
        new_total += new_count;
        body.extend_from_slice(
            format!(
                "@@ -{},{} +{},{} @@\n",
                old_start.max(0),
                old_count,
                new_start.max(0),
                new_count
            )
            .as_bytes(),
        );
        for (prefix, content, no_newline) in lines {
            body.push(prefix);
            body.extend_from_slice(content);
            body.push(b'\n');
            if no_newline {
                body.extend_from_slice(b"\\ No newline at end of file\n");
            }
        }
    }
    let old_name = quote_path("a/", path);
    let new_name = quote_path("b/", path);
    let mode = mode.unwrap_or("100644");
    // Git ends a name with a space with a tab on the ---/+++ lines.
    let label = |name: &str| {
        if name.contains(' ') {
            format!("{name}\t")
        } else {
            name.to_string()
        }
    };
    let mut patch = format!("diff --git {old_name} {new_name}\n");
    if kind == FileKind::Added && old_total == 0 {
        patch.push_str(&format!(
            "new file mode {mode}\n--- /dev/null\n+++ {}\n",
            label(&new_name)
        ));
    } else if kind == FileKind::Deleted && new_total == 0 {
        patch.push_str(&format!(
            "deleted file mode {mode}\n--- {}\n+++ /dev/null\n",
            label(&old_name)
        ));
    } else {
        patch.push_str(&format!(
            "--- {}\n+++ {}\n",
            label(&old_name),
            label(&new_name)
        ));
    }
    let mut bytes = patch.into_bytes();
    bytes.extend(body);
    bytes
}

/// Quotes a patch file name the way git does, for names with quotes,
/// backslashes or control characters.
fn quote_path(prefix: &str, path: &str) -> String {
    let name = format!("{prefix}{path}");
    let special = |c: char| c == '"' || c == '\\' || (c as u32) < 0x20 || c == '\u{7f}';
    if !name.chars().any(special) {
        return name;
    }
    let mut quoted = String::from("\"");
    for c in name.chars() {
        match c {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\u{7}' => quoted.push_str("\\a"),
            '\u{8}' => quoted.push_str("\\b"),
            '\t' => quoted.push_str("\\t"),
            '\n' => quoted.push_str("\\n"),
            '\u{b}' => quoted.push_str("\\v"),
            '\u{c}' => quoted.push_str("\\f"),
            '\r' => quoted.push_str("\\r"),
            c if special(c) => quoted.push_str(&format!("\\{:03o}", c as u32)),
            c => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

/// Runs git with `input` on stdin and returns its stdout.
fn git_with_input(project_root: &Path, args: &[&str], input: &[u8]) -> Result<Vec<u8>> {
    let mut child = git(project_root)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    // Written from a thread so a full stdout pipe cannot deadlock the write.
    let writer = child.stdin.take().map(|mut stdin| {
        let input = input.to_vec();
        std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        })
    });
    let output = child.wait_with_output()?;
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    if !output.status.success() {
        return Err(git_failure(args, &output));
    }
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(project: &Path, args: &[&str]) -> String {
        git_stdout(project, args).unwrap()
    }

    fn init_repo(project: &Path, files: &[(&str, &str)]) {
        std::fs::create_dir_all(project).unwrap();
        sh(project, &["init", "-q"]);
        for (key, value) in [
            ("user.name", "test"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            sh(project, &["config", key, value]);
        }
        for (name, content) in files {
            std::fs::write(project.join(name), content).unwrap();
        }
        sh(project, &["add", "-A", "--", "."]);
        sh(project, &["commit", "-q", "--allow-empty", "-m", "init"]);
    }

    fn repo(files: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        init_repo(&project, files);
        (temp, project)
    }

    /// The index version of a path.
    fn staged_text(project: &Path, path: &str) -> String {
        String::from_utf8(git_bytes(project, &["cat-file", "blob", &format!(":0:{path}")]).unwrap())
            .unwrap()
    }

    fn read(project: &Path, path: &str) -> String {
        std::fs::read_to_string(project.join(path)).unwrap()
    }

    /// The ids of the changed lines whose text is one of `texts`.
    fn ids(diff: &GitHunkDiff, texts: &[&str]) -> Vec<u32> {
        diff.hunks
            .iter()
            .flat_map(|hunk| &hunk.lines)
            .filter(|line| {
                line.kind != GitDiffLineKind::Context && texts.contains(&line.text.as_str())
            })
            .map(|line| line.id)
            .collect()
    }

    fn apply(project: &Path, path: &str, staged: bool, action: &str, texts: &[&str]) {
        let diff = project_file_hunks(project, path, staged, 3, false).unwrap();
        assert!(diff.blocked.is_none(), "blocked: {:?}", diff.blocked);
        let chosen = ids(&diff, texts);
        assert_eq!(
            chosen.len(),
            texts.len(),
            "every text names one changed line"
        );
        git_apply_lines(project, path, staged, action, 3, &diff.fingerprint, &chosen).unwrap();
    }

    #[test]
    fn parses_hunks_with_line_numbers_and_newline_markers() {
        let output = b"diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@ fn main\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n";
        let diff = parse_diff(output).unwrap();
        assert_eq!(diff.kind, FileKind::Modified);
        assert!(diff.blocked.is_none());
        let hunk = &diff.hunks[0];
        assert_eq!(hunk.section, b"fn main");
        let kinds: Vec<_> = hunk
            .lines
            .iter()
            .map(|line| (line.kind, line.no_newline))
            .collect();
        assert_eq!(
            kinds,
            vec![
                (GitDiffLineKind::Context, false),
                (GitDiffLineKind::Del, true),
                (GitDiffLineKind::Add, true),
            ]
        );
    }

    #[test]
    fn blank_context_lines_without_their_space_are_read() {
        let output = b"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n";
        let diff = parse_diff(output).unwrap();
        assert_eq!(diff.hunks[0].lines.len(), 4);
        assert_eq!(diff.hunks[0].lines[1].content, b"");
    }

    #[test]
    fn symlinks_submodules_and_combined_diffs_are_blocked() {
        let symlink = b"diff --git a/l b/l\nindex 1..2 120000\n--- a/l\n+++ b/l\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n";
        assert_eq!(parse_diff(symlink).unwrap().blocked, Some("symlink"));
        let submodule = b"diff --git a/s b/s\nindex 1..2 160000\n--- a/s\n+++ b/s\n@@ -1 +1 @@\n-Subproject commit 1\n+Subproject commit 2\n";
        assert_eq!(parse_diff(submodule).unwrap().blocked, Some("submodule"));
        let combined = b"diff --cc f\nindex 1,2..3\n";
        assert_eq!(parse_diff(combined).unwrap().blocked, Some("conflict"));
    }

    #[test]
    fn paths_are_quoted_like_git_does() {
        assert_eq!(quote_path("a/", "plain name.txt"), "a/plain name.txt");
        assert_eq!(
            quote_path("a/", "tab\there\".txt"),
            "\"a/tab\\there\\\".txt\""
        );
        assert_eq!(quote_path("b/", "ümlaut.txt"), "b/ümlaut.txt");
    }

    #[test]
    fn stages_single_added_and_removed_lines() {
        let (_temp, project) = repo(&[("f.txt", "one\ntwo\nthree\nfour\n")]);
        std::fs::write(project.join("f.txt"), "one\nTWO\nthree\nfour\nfive\n").unwrap();

        apply(&project, "f.txt", false, "stage", &["five"]);
        assert_eq!(
            staged_text(&project, "f.txt"),
            "one\ntwo\nthree\nfour\nfive\n"
        );

        apply(&project, "f.txt", false, "stage", &["two"]);
        assert_eq!(staged_text(&project, "f.txt"), "one\nthree\nfour\nfive\n");
        // The work tree is never touched by staging.
        assert_eq!(read(&project, "f.txt"), "one\nTWO\nthree\nfour\nfive\n");

        let unstaged = project_file_hunks(&project, "f.txt", false, 3, false).unwrap();
        assert_eq!((unstaged.additions, unstaged.deletions), (1, 0));
    }

    #[test]
    fn stages_part_of_a_change_block_across_hunks() {
        let original: String = (1..=30).map(|n| format!("line {n}\n")).collect();
        let (_temp, project) = repo(&[("f.txt", &original)]);
        let changed = original
            .replace("line 2\n", "line 2 changed\n")
            .replace("line 25\n", "line 25\nline 25b\nline 25c\n");
        std::fs::write(project.join("f.txt"), &changed).unwrap();

        let diff = project_file_hunks(&project, "f.txt", false, 3, false).unwrap();
        assert_eq!(diff.hunks.len(), 2);
        apply(&project, "f.txt", false, "stage", &["line 25c"]);
        assert_eq!(
            staged_text(&project, "f.txt"),
            original.replace("line 25\n", "line 25\nline 25c\n")
        );
        apply(
            &project,
            "f.txt",
            false,
            "stage",
            &["line 2", "line 2 changed"],
        );
        assert_eq!(
            staged_text(&project, "f.txt"),
            original
                .replace("line 2\n", "line 2 changed\n")
                .replace("line 25\n", "line 25\nline 25c\n")
        );
    }

    #[test]
    fn unstages_single_lines_and_keeps_the_rest_staged() {
        let (_temp, project) = repo(&[("f.txt", "a\nb\nc\n")]);
        std::fs::write(project.join("f.txt"), "a\nB\nc\nd\n").unwrap();
        sh(&project, &["add", "--", "f.txt"]);

        apply(&project, "f.txt", true, "unstage", &["d"]);
        assert_eq!(staged_text(&project, "f.txt"), "a\nB\nc\n");
        apply(&project, "f.txt", true, "unstage", &["B"]);
        assert_eq!(staged_text(&project, "f.txt"), "a\nc\n");
        assert_eq!(read(&project, "f.txt"), "a\nB\nc\nd\n");
    }

    #[test]
    fn discards_single_lines_from_the_work_tree_only() {
        let (_temp, project) = repo(&[("f.txt", "a\nb\nc\n")]);
        std::fs::write(project.join("f.txt"), "a\nb\nc\nstaged\n").unwrap();
        sh(&project, &["add", "--", "f.txt"]);
        std::fs::write(project.join("f.txt"), "x\na\nc\nstaged\ny\n").unwrap();

        apply(&project, "f.txt", false, "discard", &["y", "b"]);
        assert_eq!(read(&project, "f.txt"), "x\na\nb\nc\nstaged\n");
        assert_eq!(staged_text(&project, "f.txt"), "a\nb\nc\nstaged\n");
    }

    #[test]
    fn choosing_every_change_runs_the_whole_file_action() {
        let (_temp, project) = repo(&[("f.txt", "a\n")]);
        std::fs::write(project.join("f.txt"), "b\n").unwrap();
        apply(&project, "f.txt", false, "discard", &["a", "b"]);
        assert_eq!(read(&project, "f.txt"), "a\n");
        assert!(project_git_status_clean(&project));
    }

    fn project_git_status_clean(project: &Path) -> bool {
        sh(project, &["status", "--porcelain"]).is_empty()
    }

    #[test]
    fn untracked_files_stage_and_discard_chosen_lines() {
        let (_temp, project) = repo(&[]);
        std::fs::write(project.join("new.txt"), "one\ntwo\nthree").unwrap();

        let diff = project_file_hunks(&project, "new.txt", false, 3, false).unwrap();
        assert_eq!(diff.status, "A");
        assert_eq!(diff.additions, 3);
        assert!(diff.hunks[0].lines[2].no_newline);

        apply(&project, "new.txt", false, "stage", &["one", "three"]);
        assert_eq!(staged_text(&project, "new.txt"), "one\nthree");
        assert_eq!(read(&project, "new.txt"), "one\ntwo\nthree");

        let (_temp, project) = repo(&[]);
        std::fs::write(project.join("new.txt"), "one\ntwo\nthree\n").unwrap();
        apply(&project, "new.txt", false, "discard", &["two"]);
        assert_eq!(read(&project, "new.txt"), "one\nthree\n");
        apply(&project, "new.txt", false, "discard", &["one", "three"]);
        assert!(!project.join("new.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn untracked_executables_keep_their_mode() {
        use std::os::unix::fs::PermissionsExt;
        let (_temp, project) = repo(&[]);
        std::fs::write(project.join("run.sh"), "#!/bin/sh\necho hi\n").unwrap();
        std::fs::set_permissions(
            project.join("run.sh"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        apply(&project, "run.sh", false, "stage", &["#!/bin/sh"]);
        assert!(sh(&project, &["ls-files", "-s", "--", "run.sh"]).starts_with("100755 "));
    }

    #[test]
    fn staged_new_and_deleted_files_unstage_single_lines() {
        let (_temp, project) = repo(&[("gone.txt", "x\ny\nz\n")]);
        std::fs::write(project.join("new.txt"), "a\nb\n").unwrap();
        sh(&project, &["add", "--", "new.txt"]);
        apply(&project, "new.txt", true, "unstage", &["b"]);
        assert_eq!(staged_text(&project, "new.txt"), "a\n");

        sh(&project, &["rm", "-q", "--", "gone.txt"]);
        apply(&project, "gone.txt", true, "unstage", &["y"]);
        assert_eq!(staged_text(&project, "gone.txt"), "y\n");
    }

    #[test]
    fn deleted_files_stage_and_discard_single_lines() {
        let (_temp, project) = repo(&[("gone.txt", "x\ny\nz\n")]);
        std::fs::remove_file(project.join("gone.txt")).unwrap();
        apply(&project, "gone.txt", false, "stage", &["x"]);
        assert_eq!(staged_text(&project, "gone.txt"), "y\nz\n");
        apply(&project, "gone.txt", false, "discard", &["z"]);
        assert_eq!(read(&project, "gone.txt"), "z\n");
    }

    #[test]
    fn missing_newlines_at_the_end_are_kept_consistent() {
        // The old last line has no newline; an appended line forces one.
        let (_temp, project) = repo(&[("f.txt", "a\nlast")]);
        std::fs::write(project.join("f.txt"), "a\nlast\nmore\n").unwrap();
        apply(&project, "f.txt", false, "stage", &["more"]);
        assert_eq!(staged_text(&project, "f.txt"), "a\nlast\nmore\n");

        let (_temp, project) = repo(&[("f.txt", "a\nlast\n")]);
        std::fs::write(project.join("f.txt"), "a\nLAST").unwrap();
        apply(&project, "f.txt", false, "stage", &["LAST"]);
        assert_eq!(staged_text(&project, "f.txt"), "a\nlast\nLAST");

        let (_temp, project) = repo(&[("f.txt", "a\nlast")]);
        std::fs::write(project.join("f.txt"), "a\nlast\nmore\n").unwrap();
        sh(&project, &["add", "--", "f.txt"]);
        apply(&project, "f.txt", true, "unstage", &["more"]);
        assert_eq!(staged_text(&project, "f.txt"), "a\nlast\n");
    }

    #[test]
    fn crlf_lines_are_staged_byte_for_byte() {
        let (_temp, project) = repo(&[("f.txt", "a\r\nb\r\n")]);
        std::fs::write(project.join("f.txt"), "a\r\nb\r\nc\r\nd\r\n").unwrap();
        let diff = project_file_hunks(&project, "f.txt", false, 3, false).unwrap();
        assert!(diff.hunks[0]
            .lines
            .iter()
            .all(|line| !line.text.ends_with('\r')));
        apply(&project, "f.txt", false, "stage", &["d"]);
        assert_eq!(staged_text(&project, "f.txt"), "a\r\nb\r\nd\r\n");
    }

    #[test]
    fn names_with_spaces_and_quotes_are_patched() {
        let (_temp, project) = repo(&[("my \"file\".txt", "a\n")]);
        std::fs::write(project.join("my \"file\".txt"), "a\nb\nc\n").unwrap();
        apply(&project, "my \"file\".txt", false, "stage", &["c"]);
        assert_eq!(staged_text(&project, "my \"file\".txt"), "a\nc\n");
    }

    #[test]
    fn a_changed_file_is_refused_as_stale() {
        let (_temp, project) = repo(&[("f.txt", "a\n")]);
        std::fs::write(project.join("f.txt"), "a\nb\n").unwrap();
        let diff = project_file_hunks(&project, "f.txt", false, 3, false).unwrap();
        std::fs::write(project.join("f.txt"), "a\nb\nc\n").unwrap();
        let error = git_apply_lines(
            &project,
            "f.txt",
            false,
            "stage",
            3,
            &diff.fingerprint,
            &ids(&diff, &["b"]),
        )
        .unwrap_err()
        .to_string();
        assert!(error.starts_with(STALE_DIFF), "{error}");
        assert_eq!(staged_text(&project, "f.txt"), "a\n");
    }

    #[test]
    fn whitespace_views_conflicts_and_binaries_block_line_actions() {
        let (_temp, project) = repo(&[("f.txt", "a\n"), ("bin", "\0x")]);
        std::fs::write(project.join("f.txt"), "a \nb\n").unwrap();
        let diff = project_file_hunks(&project, "f.txt", false, 3, true).unwrap();
        assert_eq!(diff.blocked.as_deref(), Some("whitespace"));
        assert_eq!(
            ids(&diff, &["a "]).len(),
            0,
            "whitespace-only changes are hidden"
        );

        std::fs::write(project.join("bin"), "\0y").unwrap();
        let diff = project_file_hunks(&project, "bin", false, 3, false).unwrap();
        assert!(diff.binary);
        assert_eq!(diff.blocked.as_deref(), Some("binary"));

        let error = git_apply_lines(&project, "f.txt", false, "unstage", 3, "x", &[0]).unwrap_err();
        assert!(error.to_string().contains("cannot unstage"));
    }

    #[test]
    fn conflicted_paths_are_blocked() {
        let (_temp, project) = repo(&[("f.txt", "base\n")]);
        let main = sh(&project, &["rev-parse", "--abbrev-ref", "HEAD"]);
        sh(&project, &["checkout", "-q", "-b", "other"]);
        std::fs::write(project.join("f.txt"), "theirs\n").unwrap();
        sh(&project, &["commit", "-q", "-am", "theirs"]);
        sh(&project, &["checkout", "-q", &main]);
        std::fs::write(project.join("f.txt"), "ours\n").unwrap();
        sh(&project, &["commit", "-q", "-am", "ours"]);
        assert!(git_bytes(&project, &["merge", "other"]).is_err());

        let diff = project_file_hunks(&project, "f.txt", false, 3, false).unwrap();
        assert_eq!(diff.blocked.as_deref(), Some("conflict"));
        assert!(diff.hunks.is_empty());
    }

    #[test]
    fn whole_file_context_returns_one_hunk() {
        let original: String = (1..=40).map(|n| format!("line {n}\n")).collect();
        let (_temp, project) = repo(&[("f.txt", &original)]);
        let changed = original
            .replace("line 5\n", "line five\n")
            .replace("line 35\n", "");
        std::fs::write(project.join("f.txt"), changed).unwrap();
        let diff = project_file_hunks(&project, "f.txt", false, MAX_CONTEXT, false).unwrap();
        assert_eq!(diff.hunks.len(), 1);
        assert_eq!(diff.hunks[0].lines.len(), 41);
        let diff = project_file_hunks(&project, "f.txt", false, u32::MAX, false).unwrap();
        assert_eq!(diff.hunks.len(), 1);
        let chosen = ids(&diff, &["line 35"]);
        git_apply_lines(
            &project,
            "f.txt",
            false,
            "stage",
            u32::MAX,
            &diff.fingerprint,
            &chosen,
        )
        .unwrap();
        assert_eq!(
            staged_text(&project, "f.txt"),
            original.replace("line 35\n", "")
        );
    }
}
