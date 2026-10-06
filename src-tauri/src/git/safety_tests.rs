//! What the git commands must never do to a user's repository: lose work that
//! was not named, write where they only read, act on another repository or
//! leave a trace when they fail. The tests build real repositories in a
//! temporary folder and compare their complete state before and after.

use super::*;
use crate::models::{GitDiffLineKind, GitHunkDiff};
use std::collections::BTreeMap;
use std::time::{Duration, SystemTime};

const NOTHING: [&str; 0] = [];

/// Runs a raw git command in a test repository and returns trimmed stdout.
fn sh(project: &Path, args: &[&str]) -> String {
    git_stdout(project, args).unwrap()
}

/// A temporary folder by its real path, which is how git reports paths.
fn temp() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    (temp, base)
}

fn text(path: &Path) -> &str {
    path.to_str().unwrap()
}

fn paths(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| name.to_string()).collect()
}

/// What the tests rely on, so the host's git configuration and hooks cannot
/// change their outcome.
const TEST_CONFIG: &str = "
[user]
	name = test
	email = test@example.com
[commit]
	gpgsign = false
	cleanup = default
[tag]
	gpgsign = false
[core]
	autocrlf = false
	hooksPath = .git/hooks
[merge]
	ff = true
	autoStash = false
[pull]
	ff = true
[push]
	default = simple
[rebase]
	autoStash = false
";

/// Pins [`TEST_CONFIG`] for a repository, in one write rather than a git
/// process per setting.
fn identify(project: &Path) {
    use std::io::Write;
    let mut git_dir = project.join(".git");
    if !git_dir.is_dir() {
        // A submodule keeps its repository in the one it belongs to.
        git_dir = PathBuf::from(sh(project, &["rev-parse", "--absolute-git-dir"]));
    }
    std::fs::OpenOptions::new()
        .append(true)
        .open(git_dir.join("config"))
        .unwrap()
        .write_all(TEST_CONFIG.as_bytes())
        .unwrap();
}

/// A repository on `main` with `tracked.txt` committed.
fn init(project: &Path) {
    std::fs::create_dir_all(project).unwrap();
    sh(project, &["init", "-q", "-b", "main", "--template="]);
    identify(project);
    write(project, "tracked.txt", "one\n");
    commit_all(project, "init");
}

fn write(project: &Path, path: &str, content: &str) {
    let file = project.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, content).unwrap();
}

fn read(project: &Path, path: &str) -> String {
    std::fs::read_to_string(project.join(path)).unwrap()
}

/// Commits the whole work tree.
fn commit_all(project: &Path, message: &str) {
    sh(project, &["add", "-A", "--", "."]);
    sh(project, &["commit", "-q", "-m", message]);
}

/// Commits the whole work tree and returns the new commit.
fn commit(project: &Path, message: &str) -> String {
    commit_all(project, message);
    sh(project, &["rev-parse", "HEAD"])
}

fn status(project: &Path) -> GitStatus {
    project_git_status(project).unwrap()
}

fn listed(changes: &[FileChange]) -> Vec<String> {
    let mut names: Vec<String> = changes.iter().map(|change| change.path.clone()).collect();
    names.sort();
    names
}

/// A repository holding every kind of local work: staged and unstaged edits,
/// a file with both, a staged new file, a deleted file, an untracked file and
/// ignored ones.
fn busy(project: &Path) {
    init(project);
    add_local_work(project);
}

/// The local work of [`busy`], for a repository that already exists.
fn add_local_work(project: &Path) {
    write(project, ".gitignore", "ignored.txt\nsecret/\n");
    write(project, "staged.txt", "staged\n");
    write(project, "both.txt", "both\n");
    write(project, "removed.txt", "removed\n");
    write(project, "dir/deep/file.txt", "deep\n");
    commit_all(project, "files");
    write(project, "tracked.txt", "one\nunstaged edit\n");
    write(project, "staged.txt", "staged\nstaged edit\n");
    write(project, "both.txt", "both\nstaged edit\n");
    write(project, "new-staged.txt", "new and staged\n");
    sh(
        project,
        &["add", "--", "staged.txt", "both.txt", "new-staged.txt"],
    );
    write(project, "both.txt", "both\nstaged edit\nunstaged edit\n");
    std::fs::remove_file(project.join("removed.txt")).unwrap();
    write(project, "untracked.txt", "untracked\n");
    write(project, "ignored.txt", "ignored\n");
    write(project, "secret/key.txt", "secret\n");
}

const BUSY_STAGED: [&str; 3] = ["both.txt", "new-staged.txt", "staged.txt"];
const BUSY_UNSTAGED: [&str; 4] = ["both.txt", "removed.txt", "tracked.txt", "untracked.txt"];

/// Everything a command could change: where HEAD is, every ref, the stashes,
/// the index and each file of the work tree, ignored ones included.
#[derive(Debug, Clone, PartialEq, Eq)]
struct State {
    head: String,
    branch: String,
    refs: String,
    stashes: String,
    index: String,
    operation: Option<String>,
    files: BTreeMap<String, String>,
}

fn state(project: &Path) -> State {
    let query = |args: &[&str]| git_stdout(project, args).unwrap_or_default();
    let all_refs = query(&["for-each-ref", "--format=%(objectname) %(refname)"]);
    let git_dir = project.join(".git");
    // Where git keeps HEAD and the stashes in plain files, reading them saves
    // a process each; a snapshot is taken a few hundred times.
    let in_files = git_dir.join("HEAD").is_file() && !git_dir.join("reftable").exists();
    let (head, branch, stashes) = if in_files {
        let read = |name: &str| std::fs::read_to_string(git_dir.join(name)).unwrap_or_default();
        let pointer = read("HEAD").trim().to_string();
        // `ref: refs/heads/main`, or a commit when no branch is checked out.
        match pointer.strip_prefix("ref: ") {
            Some(branch) => {
                let tip = all_refs
                    .lines()
                    .find_map(|line| line.strip_suffix(branch)?.strip_suffix(' '));
                (
                    tip.unwrap_or_default().to_string(),
                    branch.to_string(),
                    read("logs/refs/stash"),
                )
            }
            None => (pointer, String::new(), read("logs/refs/stash")),
        }
    } else {
        (
            query(&["rev-parse", "-q", "--verify", "HEAD"]),
            query(&["symbolic-ref", "-q", "HEAD"]),
            query(&["stash", "list", "--format=%H"]),
        )
    };
    let refs = all_refs
        .lines()
        .filter(|line| !line.ends_with(" refs/stash"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut files = BTreeMap::new();
    collect_files(project, project, &mut files);
    State {
        head,
        branch,
        refs,
        stashes,
        index: query(&["ls-files", "-s"]),
        operation: git_operation(project),
        files,
    }
}

fn collect_files(root: &Path, directory: &Path, files: &mut BTreeMap<String, String>) {
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        let name = path
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let metadata = std::fs::symlink_metadata(&path).unwrap();
        if path.file_name() == Some(OsStr::new(".git")) {
            // A repository's own data changes with every command; a nested
            // one is only recorded as being there.
            if directory != root {
                files.insert(name, "<repository>".to_string());
            }
        } else if metadata.file_type().is_symlink() {
            let target = std::fs::read_link(&path).unwrap();
            files.insert(name, format!("-> {}", target.display()));
        } else if metadata.is_dir() {
            collect_files(root, &path, files);
        } else {
            let content = std::fs::read(&path).unwrap();
            files.insert(name, String::from_utf8_lossy(&content).into_owned());
        }
    }
}

/// Names what differs between two states: `HEAD`, `branch`, `refs`, `stash`,
/// `index`, `operation` and `file:<path>` for each file of the work tree.
fn changed(before: &State, after: &State) -> Vec<String> {
    let mut parts = Vec::new();
    for (label, differs) in [
        ("HEAD", before.head != after.head),
        ("branch", before.branch != after.branch),
        ("refs", before.refs != after.refs),
        ("stash", before.stashes != after.stashes),
        ("index", before.index != after.index),
        ("operation", before.operation != after.operation),
    ] {
        if differs {
            parts.push(label.to_string());
        }
    }
    let names: BTreeSet<&String> = before.files.keys().chain(after.files.keys()).collect();
    for name in names {
        if before.files.get(name) != after.files.get(name) {
            parts.push(format!("file:{name}"));
        }
    }
    parts
}

/// Gives a file an old modification time without changing its content, so the
/// index has outdated file times for it.
fn age(file: &Path) {
    std::fs::File::options()
        .write(true)
        .open(file)
        .unwrap()
        .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000))
        .unwrap();
}

#[cfg(unix)]
fn install_hook(project: &Path, name: &str, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    let hook = project.join(".git/hooks").join(name);
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(&hook, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// A project whose `main` tracks `origin/main` in a bare repository, and a
/// second clone for commits somebody else pushes.
fn cloned(base: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let origin = base.join("origin.git");
    sh(
        base,
        &[
            "init",
            "-q",
            "--bare",
            "-b",
            "main",
            "--template=",
            text(&origin),
        ],
    );
    let project = base.join("project");
    init(&project);
    sh(&project, &["remote", "add", "origin", text(&origin)]);
    sh(&project, &["push", "-q", "-u", "origin", "main"]);
    let other = base.join("other");
    sh(
        base,
        &["clone", "-q", "--template=", text(&origin), text(&other)],
    );
    identify(&other);
    (origin, project, other)
}

/// Commits `content` to `path` in the other clone and pushes it.
fn push_from_other(other: &Path, path: &str, content: &str) -> String {
    write(other, path, content);
    let pushed = commit(other, &format!("their {path}"));
    sh(other, &["push", "-q", "origin", "main"]);
    pushed
}

fn branches_and_tags(repository: &Path) -> String {
    sh(
        repository,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads",
            "refs/tags",
        ],
    )
}

/// The ids of the changed lines of a diff whose text is one of `texts`.
fn line_ids(diff: &GitHunkDiff, texts: &[&str]) -> Vec<u32> {
    diff.hunks
        .iter()
        .flat_map(|hunk| &hunk.lines)
        .filter(|line| line.kind != GitDiffLineKind::Context && texts.contains(&line.text.as_str()))
        .map(|line| line.id)
        .collect()
}

fn apply_lines(project: &Path, path: &str, staged: bool, action: &str, texts: &[&str]) {
    let diff = project_file_hunks(project, path, staged, 3, false).unwrap();
    let ids = line_ids(&diff, texts);
    assert_eq!(ids.len(), texts.len(), "every text names one changed line");
    git_apply_lines(project, path, staged, action, 3, &diff.fingerprint, &ids).unwrap();
}

fn staged_text(project: &Path, path: &str) -> String {
    let blob = git_bytes(project, &["cat-file", "blob", &format!(":0:{path}")]).unwrap();
    String::from_utf8(blob).unwrap()
}

// --- reading --------------------------------------------------------------

#[test]
fn queries_leave_the_repository_exactly_as_it_was() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    sh(&project, &["tag", "v1"]);
    sh(&project, &["branch", "other"]);
    write(&project, "tracked.txt", "one\nstashed\n");
    git_stash_push(&project, Some("saved"), false).unwrap();
    add_local_work(&project);
    // Outdated file times are what makes git want to refresh the index.
    age(&project.join("dir/deep/file.txt"));
    let before = state(&project);
    let index = std::fs::read(project.join(".git/index")).unwrap();

    let current = status(&project);
    assert_eq!(listed(&current.staged), BUSY_STAGED);
    assert_eq!(listed(&current.unstaged), BUSY_UNSTAGED);
    project_git_refs(&project).unwrap();
    project_git_info(&project);
    let commits = project_commits(&project, None, None, 0, 50).unwrap();
    project_commits(&project, Some("files"), None, 0, 50).unwrap();
    project_commits(&project, None, Some("tracked.txt"), 0, 50).unwrap();
    project_commit_detail(&project, &commits[0].hash).unwrap();
    project_commit_detail(&project, "HEAD").unwrap();
    project_commit_file_diff(&project, &commits[0].hash, "staged.txt").unwrap();
    for (changes, staged) in [(&current.staged, true), (&current.unstaged, false)] {
        for change in changes {
            project_file_diff(&project, &change.path, staged).unwrap();
            project_file_hunks(&project, &change.path, staged, 3, false).unwrap();
            project_file_hunks(&project, &change.path, staged, 3, true).unwrap();
        }
    }
    project_file_hunks(&project, "dir/deep/file.txt", false, 3, false).unwrap();
    project_blame(&project, "tracked.txt").unwrap();
    staged_summary(&project, 10_000).unwrap();
    project_rebase_commits(&project, "other").unwrap();
    ignored_paths(&project, &[project.join("ignored.txt")]);
    let probe = GitProbe {
        project_root: &project,
        shadow: None,
    };
    assert!(probe.is_ignored("secret/key.txt"));

    assert_eq!(changed(&before, &state(&project)), NOTHING);
    assert!(
        std::fs::read(project.join(".git/index")).unwrap() == index,
        "a query rewrote the index, which takes its lock"
    );
    assert!(!project.join(".git/index.lock").exists());
}

#[test]
fn snapshots_never_touch_the_projects_own_repository() {
    let (_temp, base) = temp();
    let project = base.join("project");
    busy(&project);
    let before = state(&project);
    let index = std::fs::read(project.join(".git/index")).unwrap();
    let config = read(&project, ".git/config");

    let shadow = ShadowRepo::open(&base.join("data"), "project-1", &project).unwrap();
    let snapshot = shadow.snapshot("before a turn").unwrap();
    write(&project, "tracked.txt", "rewritten by a turn\n");
    write(&project, "turn.txt", "made by a turn\n");
    std::fs::remove_file(project.join("untracked.txt")).unwrap();
    assert_eq!(shadow.changes_since(&snapshot).unwrap().len(), 3);
    shadow.snapshot("after the turn").unwrap();
    shadow.restore_to(&snapshot).unwrap();

    // The work tree is back, and the project's repository never noticed.
    assert_eq!(changed(&before, &state(&project)), NOTHING);
    assert!(std::fs::read(project.join(".git/index")).unwrap() == index);
    assert_eq!(read(&project, ".git/config"), config);
}

// --- staging --------------------------------------------------------------

#[test]
fn staging_and_unstaging_change_nothing_but_the_index() {
    let (_temp, base) = temp();
    let project = base.join("project");
    busy(&project);
    let before = state(&project);

    git_stage(&project, Some("tracked.txt")).unwrap();
    assert_eq!(changed(&before, &state(&project)), ["index"]);
    git_stage_paths(&project, &paths(&["untracked.txt", "removed.txt"])).unwrap();
    git_stage(&project, None).unwrap();
    assert_eq!(changed(&before, &state(&project)), ["index"]);
    assert!(status(&project).unstaged.is_empty());

    git_unstage_paths(&project, &paths(&["untracked.txt", "both.txt"])).unwrap();
    git_unstage(&project, Some("tracked.txt")).unwrap();
    git_unstage(&project, None).unwrap();
    assert_eq!(changed(&before, &state(&project)), ["index"]);
    let current = status(&project);
    assert!(current.staged.is_empty());
    assert_eq!(
        listed(&current.unstaged),
        [
            "both.txt",
            "new-staged.txt",
            "removed.txt",
            "staged.txt",
            "tracked.txt",
            "untracked.txt"
        ]
    );
}

/// Names git would read as options, patterns or pathspec magic if they were
/// not passed as plain file names.
#[cfg(unix)]
const ODD_NAMES: [&str; 12] = [
    "-dash.txt",
    "--help",
    "*.txt",
    "?.txt",
    "[ab].txt",
    ":(top)magic.txt",
    ":!excluded.txt",
    "sp ace.txt",
    "tab\there.txt",
    "new\nline.txt",
    "quote\"s.txt",
    "ünï-çødé.txt",
];

/// The paths with staged changes, sorted.
#[cfg(unix)]
fn staged_names(project: &Path) -> Vec<String> {
    let output = git_bytes(project, &["diff", "--cached", "--name-only", "-z"]).unwrap();
    let mut names: Vec<String> = nul_entries(&output).collect();
    names.sort();
    names
}

#[cfg(unix)]
#[test]
fn odd_file_names_only_ever_mean_themselves() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    // `a.txt` and `b.txt` are what the patterns among the names would match.
    let bystanders = ["a.txt", "b.txt"];
    let mut sorted = ODD_NAMES.to_vec();
    sorted.sort();
    for name in ODD_NAMES.iter().chain(&bystanders) {
        write(&project, name, "new\n");
    }

    // Untracked: each name stages and unstages only itself.
    for name in ODD_NAMES {
        git_stage(&project, Some(name)).unwrap();
        assert_eq!(staged_names(&project), [name], "stage {name:?}");
        git_unstage(&project, Some(name)).unwrap();
        let diff = project_file_hunks(&project, name, false, 3, false).unwrap();
        assert_eq!((diff.status.as_str(), diff.additions), ("A", 1), "{name:?}");
        let diff = project_file_diff(&project, name, false).unwrap();
        assert_eq!(diff.new_content, "new\n", "{name:?}");
    }
    git_stage_paths(&project, &paths(&ODD_NAMES)).unwrap();
    assert_eq!(staged_names(&project), sorted);
    git_unstage_paths(&project, &paths(&ODD_NAMES)).unwrap();
    assert_eq!(staged_names(&project), NOTHING);

    // Tracked, with two new lines each.
    commit_all(&project, "odd names");
    for name in ODD_NAMES.iter().chain(&bystanders) {
        write(&project, name, "new\nfirst\nsecond\n");
    }
    for (index, name) in ODD_NAMES.into_iter().enumerate() {
        // One line goes through a patch that names the file.
        apply_lines(&project, name, false, "stage", &["second"]);
        assert_eq!(staged_text(&project, name), "new\nsecond\n", "{name:?}");
        assert_eq!(staged_names(&project), [name], "stage a line of {name:?}");
        git_unstage(&project, Some(name)).unwrap();
        assert_eq!(project_blame(&project, name).unwrap().len(), 3, "{name:?}");
        let history = project_commits(&project, None, Some(name), 0, 10).unwrap();
        assert_eq!(history.len(), 1, "history of {name:?}");

        git_discard_paths(&project, &paths(&[name])).unwrap();
        // Exactly the files discarded so far are back to what was committed.
        for (other, file) in ODD_NAMES.iter().chain(&bystanders).enumerate() {
            let expected = if other <= index {
                "new\n"
            } else {
                "new\nfirst\nsecond\n"
            };
            assert_eq!(read(&project, file), expected, "{file:?} after {name:?}");
        }
    }
    assert_eq!(staged_names(&project), NOTHING);

    // Untracked again: discarding deletes exactly the file that is named.
    let mut untrack = vec!["rm", "-q", "--cached", "--"];
    untrack.extend(ODD_NAMES);
    sh(&project, &untrack);
    sh(&project, &["commit", "-q", "-m", "untrack them"]);
    for (index, name) in ODD_NAMES.into_iter().enumerate() {
        git_discard_paths(&project, &paths(&[name])).unwrap();
        for (other, file) in ODD_NAMES.iter().enumerate() {
            assert_eq!(
                project.join(file).exists(),
                other > index,
                "{file:?} after deleting {name:?}"
            );
        }
    }
    for name in bystanders {
        assert_eq!(read(&project, name), "new\nfirst\nsecond\n");
    }
}

// --- discarding -----------------------------------------------------------

#[test]
fn discard_changes_only_the_paths_it_is_given() {
    let (_temp, base) = temp();
    let project = base.join("project");
    busy(&project);

    for path in BUSY_UNSTAGED {
        let before = state(&project);
        git_discard_paths(&project, &paths(&[path])).unwrap();
        assert_eq!(
            changed(&before, &state(&project)),
            [format!("file:{path}")],
            "discard {path}"
        );
    }
    assert_eq!(read(&project, "tracked.txt"), "one\n");
    assert_eq!(read(&project, "removed.txt"), "removed\n");
    // A file with staged and unstaged edits goes back to what is staged.
    assert_eq!(read(&project, "both.txt"), "both\nstaged edit\n");
    assert!(!project.join("untracked.txt").exists());
    let current = status(&project);
    assert_eq!(listed(&current.staged), BUSY_STAGED);
    assert!(current.unstaged.is_empty());
    // Ignored files never show up as changes and are never discarded.
    assert_eq!(read(&project, "ignored.txt"), "ignored\n");
    assert_eq!(read(&project, "secret/key.txt"), "secret\n");
}

#[test]
fn discard_keeps_nested_repositories_and_worktrees() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    // A repository that was cloned or created inside the project ...
    let nested = project.join("vendor/lib");
    init(&nested);
    write(&nested, "unpushed.txt", "the only copy\n");
    // ... and a linked worktree with uncommitted work in it.
    sh(
        &project,
        &["worktree", "add", "-q", "-b", "wt", ".worktrees/wt"],
    );
    write(&project.join(".worktrees/wt"), "wip.txt", "uncommitted\n");
    write(&project, "plain.txt", "untracked\n");

    // Git lists each of them as a single untracked entry.
    let unstaged = listed(&status(&project).unstaged);
    assert_eq!(unstaged, [".worktrees/wt/", "plain.txt", "vendor/lib/"]);
    let before = state(&project);

    let error = git_discard_paths(&project, &unstaged)
        .unwrap_err()
        .to_string();
    assert!(error.contains("vendor/lib/"), "{error}");
    assert!(error.contains(".worktrees/wt/"), "{error}");
    // What else was named is discarded; the repositories stay.
    assert_eq!(changed(&before, &state(&project)), ["file:plain.txt"]);
    assert_eq!(sh(&nested, &["log", "--format=%s"]), "init");
    assert_eq!(read(&nested, "unpushed.txt"), "the only copy\n");
    assert_eq!(read(&project, ".worktrees/wt/wip.txt"), "uncommitted\n");

    let before = state(&project);
    assert!(git_discard_paths(&project, &paths(&["vendor/lib/"])).is_err());
    assert!(git_discard_paths(&project, &paths(&["vendor/lib"])).is_err());
    assert!(git_discard_paths(&project, &paths(&["vendor"])).is_err());
    assert_eq!(changed(&before, &state(&project)), NOTHING);
}

#[test]
fn discard_does_not_empty_a_folder_that_took_a_files_place() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    write(&project, ".gitignore", ".env\n");
    write(&project, "config", "the old file\n");
    commit_all(&project, "config file");
    std::fs::remove_file(project.join("config")).unwrap();
    write(&project, "config/app.yml", "new work\n");
    write(&project, "config/.env", "never listed\n");
    assert_eq!(
        listed(&status(&project).unstaged),
        ["config", "config/app.yml"]
    );
    let before = state(&project);

    // Git would restore `config` by deleting the folder and all that is in it.
    let error = git_discard_paths(&project, &paths(&["config"]))
        .unwrap_err()
        .to_string();
    assert!(error.contains("config"), "{error}");
    assert_eq!(changed(&before, &state(&project)), NOTHING);

    // Discarding the new file too leaves the ignored one, which no list showed.
    assert!(git_discard_paths(&project, &paths(&["config", "config/app.yml"])).is_err());
    assert_eq!(changed(&before, &state(&project)), ["file:config/app.yml"]);
    assert_eq!(read(&project, "config/.env"), "never listed\n");

    // With nothing left in the folder, the file comes back.
    std::fs::remove_file(project.join("config/.env")).unwrap();
    git_discard_paths(&project, &paths(&["config"])).unwrap();
    assert_eq!(read(&project, "config"), "the old file\n");
}

#[test]
fn discard_does_not_delete_a_file_that_took_a_folders_place() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    write(&project, "lib/mod.txt", "module\n");
    write(&project, "lib/deep/inner.txt", "inner\n");
    commit_all(&project, "lib folder");
    std::fs::remove_dir_all(project.join("lib")).unwrap();
    write(&project, "lib", "a new file\n");
    assert_eq!(
        listed(&status(&project).unstaged),
        ["lib", "lib/deep/inner.txt", "lib/mod.txt"]
    );
    let before = state(&project);

    for path in ["lib/mod.txt", "lib/deep/inner.txt"] {
        assert!(git_discard_paths(&project, &paths(&[path])).is_err());
        assert_eq!(changed(&before, &state(&project)), NOTHING, "{path}");
    }

    // Discarding the new file as well makes room for the folder.
    git_discard_paths(
        &project,
        &paths(&["lib/mod.txt", "lib", "lib/deep/inner.txt"]),
    )
    .unwrap();
    assert_eq!(read(&project, "lib/mod.txt"), "module\n");
    assert_eq!(read(&project, "lib/deep/inner.txt"), "inner\n");
    assert!(status(&project).unstaged.is_empty());
}

#[cfg(unix)]
#[test]
fn discard_removes_a_link_and_never_what_it_points_to() {
    use std::os::unix::fs::symlink;
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    let outside = base.join("outside");
    write(&outside, "keep.txt", "keep\n");
    symlink(outside.join("keep.txt"), project.join("file-link")).unwrap();
    symlink(&outside, project.join("folder-link")).unwrap();
    assert_eq!(
        listed(&status(&project).unstaged),
        ["file-link", "folder-link"]
    );

    git_discard_paths(&project, &paths(&["file-link", "folder-link"])).unwrap();
    assert!(std::fs::symlink_metadata(project.join("file-link")).is_err());
    assert!(std::fs::symlink_metadata(project.join("folder-link")).is_err());
    assert_eq!(read(&outside, "keep.txt"), "keep\n");

    // A path below a linked folder leads out of the project.
    symlink(&outside, project.join("folder-link")).unwrap();
    for path in ["folder-link/keep.txt", "folder-link/new.txt"] {
        assert!(git_discard_paths(&project, &paths(&[path])).is_err());
        assert!(project_file_diff(&project, path, false).is_err());
        assert!(project_file_hunks(&project, path, false, 3, false).is_err());
    }
    assert_eq!(read(&outside, "keep.txt"), "keep\n");
}

#[test]
fn the_repositorys_own_data_is_never_a_target() {
    let (_temp, base) = temp();
    let project = base.join("project");
    busy(&project);
    let before = state(&project);
    let config = read(&project, ".git/config");

    for path in [
        ".git",
        ".git/config",
        "./.git",
        ".git/",
        ".GIT/config",
        "dir/.git/x",
    ] {
        let refused = [
            (
                "discard",
                git_discard_paths(&project, &paths(&[path])).is_err(),
            ),
            ("stage", git_stage(&project, Some(path)).is_err()),
            ("unstage", git_unstage(&project, Some(path)).is_err()),
            ("ignore", git_ignore(&project, path).is_err()),
            ("diff", project_file_diff(&project, path, false).is_err()),
            (
                "hunks",
                project_file_hunks(&project, path, false, 3, false).is_err(),
            ),
            (
                "lines",
                git_apply_lines(&project, path, false, "discard", 3, "x", &[0]).is_err(),
            ),
        ];
        for (command, refused) in refused {
            assert!(refused, "{command} accepted {path:?}");
        }
    }
    assert_eq!(read(&project, ".git/config"), config);
    assert_eq!(changed(&before, &state(&project)), NOTHING);
    assert_eq!(listed(&status(&project).staged), BUSY_STAGED);
}

#[test]
fn paths_outside_the_project_are_refused_by_every_command() {
    let (_temp, base) = temp();
    let project = base.join("project");
    busy(&project);
    write(&base, "outside.txt", "keep\n");
    let head = sh(&project, &["rev-parse", "HEAD"]);
    let before = state(&project);
    let absolute = base.join("outside.txt");

    for path in [
        "../outside.txt",
        "dir/../../outside.txt",
        text(&absolute),
        "",
    ] {
        let named = paths(&[path]);
        let mut refused = vec![
            ("stage", git_stage(&project, Some(path)).is_err()),
            ("unstage", git_unstage(&project, Some(path)).is_err()),
            ("stage paths", git_stage_paths(&project, &named).is_err()),
            (
                "unstage paths",
                git_unstage_paths(&project, &named).is_err(),
            ),
            ("discard", git_discard_paths(&project, &named).is_err()),
            ("blame", project_blame(&project, path).is_err()),
            ("ignore", git_ignore(&project, path).is_err()),
            (
                "resolve",
                git_resolve_conflict(&project, path, "ours").is_err(),
            ),
            ("diff", project_file_diff(&project, path, false).is_err()),
            (
                "hunks",
                project_file_hunks(&project, path, false, 3, false).is_err(),
            ),
            (
                "lines",
                git_apply_lines(&project, path, false, "stage", 3, "x", &[0]).is_err(),
            ),
            (
                "commit diff",
                project_commit_file_diff(&project, &head, path).is_err(),
            ),
        ];
        // An empty path means "no path" for these two.
        if !path.is_empty() {
            refused.push((
                "history",
                project_commits(&project, None, Some(path), 0, 10).is_err(),
            ));
            refused.push((
                "submodule",
                git_submodule_update(&project, Some(path)).is_err(),
            ));
        }
        for (command, refused) in refused {
            assert!(refused, "{command} accepted {path:?}");
        }
    }
    assert_eq!(read(&base, "outside.txt"), "keep\n");
    assert_eq!(changed(&before, &state(&project)), NOTHING);
}

// --- committing -----------------------------------------------------------

#[test]
fn a_commit_contains_exactly_what_was_staged() {
    let (_temp, base) = temp();
    let project = base.join("project");
    busy(&project);
    let staged_tree = sh(&project, &["write-tree"]);
    let before = state(&project);

    git_commit(&project, "commit the staged work", false).unwrap();

    assert_eq!(changed(&before, &state(&project)), ["HEAD", "refs"]);
    assert_eq!(sh(&project, &["rev-parse", "HEAD^{tree}"]), staged_tree);
    assert_eq!(sh(&project, &["rev-parse", "HEAD^"]), before.head);
    let current = status(&project);
    assert!(current.staged.is_empty());
    assert_eq!(listed(&current.unstaged), BUSY_UNSTAGED);
}

#[test]
fn amending_keeps_work_that_was_not_staged() {
    let (_temp, base) = temp();
    let project = base.join("project");
    busy(&project);
    let parent = sh(&project, &["rev-parse", "HEAD^"]);
    let before = state(&project);

    git_commit(&project, "files, amended", true).unwrap();

    assert_eq!(changed(&before, &state(&project)), ["HEAD", "refs"]);
    assert_eq!(sh(&project, &["rev-parse", "HEAD^"]), parent);
    assert_eq!(
        sh(&project, &["log", "-1", "--format=%s"]),
        "files, amended"
    );
    assert_eq!(listed(&status(&project).unstaged), BUSY_UNSTAGED);
}

#[test]
fn a_commit_that_fails_leaves_no_trace() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    write(&project, "tracked.txt", "one\nnot staged\n");
    let before = state(&project);
    assert!(git_commit(&project, "nothing is staged", false).is_err());
    assert!(git_commit(&project, " \n\t", false).is_err());
    assert_eq!(changed(&before, &state(&project)), NOTHING);

    #[cfg(unix)]
    {
        install_hook(&project, "pre-commit", "echo 'checks failed' >&2\nexit 1");
        git_stage(&project, None).unwrap();
        let before = state(&project);
        let error = git_commit(&project, "rejected by a hook", false).unwrap_err();
        assert!(error.to_string().contains("checks failed"), "{error}");
        assert_eq!(changed(&before, &state(&project)), NOTHING);
        assert_eq!(listed(&status(&project).staged), ["tracked.txt"]);
    }
}

#[test]
fn commit_messages_are_stored_as_typed() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    let message = "-m looks like an option\n\n# not a comment\n\"double\" 'single' $HOME `id` %s\n\ttabbed ünïcode";
    write(&project, "tracked.txt", "one\ntwo\n");
    git_stage(&project, None).unwrap();

    git_commit(&project, message, false).unwrap();
    assert_eq!(sh(&project, &["log", "-1", "--format=%B"]), message);

    write(&project, "tracked.txt", "one\ntwo\nthree\n");
    git_stage(&project, None).unwrap();
    git_commit(&project, "--amend --no-verify", true).unwrap();
    assert_eq!(
        sh(&project, &["log", "-1", "--format=%B"]),
        "--amend --no-verify"
    );
    assert_eq!(sh(&project, &["rev-list", "--count", "HEAD"]), "2");
}

#[cfg(unix)]
#[test]
fn hooks_read_pathspecs_the_way_they_do_in_a_terminal() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    // The usual shape of a hook: look at the staged files of one kind.
    install_hook(
        &project,
        "pre-commit",
        "git diff --cached --name-only -- '*.txt' > .git/hook-saw",
    );
    write(&project, "notes.txt", "notes\n");
    git_stage(&project, Some("notes.txt")).unwrap();

    git_commit(&project, "with a hook", false).unwrap();
    assert_eq!(read(&project, ".git/hook-saw"), "notes.txt\n");
}

// --- branches and tags ----------------------------------------------------

/// A branch `other` with one commit that `main` lacks, made by `change`.
fn branch_other(project: &Path, change: impl FnOnce()) -> String {
    sh(project, &["checkout", "-q", "-b", "other"]);
    change();
    let other = commit(project, "work on other");
    sh(project, &["checkout", "-q", "main"]);
    other
}

#[test]
fn switching_branches_carries_uncommitted_work_along() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    branch_other(&project, || write(&project, "other.txt", "other\n"));
    write(&project, "tracked.txt", "one\nnot committed\n");
    write(&project, "new-staged.txt", "staged\n");
    git_stage(&project, Some("new-staged.txt")).unwrap();
    write(&project, "untracked.txt", "untracked\n");

    git_checkout(&project, "other", false, None).unwrap();
    assert_eq!(project_current_branch(&project).as_deref(), Some("other"));
    assert_eq!(read(&project, "other.txt"), "other\n");
    assert_eq!(read(&project, "tracked.txt"), "one\nnot committed\n");
    assert_eq!(read(&project, "untracked.txt"), "untracked\n");
    let current = status(&project);
    assert_eq!(listed(&current.staged), ["new-staged.txt"]);
    assert_eq!(listed(&current.unstaged), ["tracked.txt", "untracked.txt"]);
}

#[test]
fn creating_a_branch_leaves_uncommitted_work_as_it_is() {
    let (_temp, base) = temp();
    let project = base.join("project");
    busy(&project);
    let before = state(&project);

    // Without switching to it, a new branch is one more ref.
    git_branch_create(&project, "later", None, false).unwrap();
    assert_eq!(changed(&before, &state(&project)), ["refs"]);

    // Switching to it takes the staged and the unstaged work along.
    git_branch_create(&project, "feature/login", None, true).unwrap();
    let after = state(&project);
    assert_eq!(changed(&before, &after), ["branch", "refs"]);
    assert_eq!(
        project_current_branch(&project).as_deref(),
        Some("feature/login")
    );
    let current = status(&project);
    assert_eq!(listed(&current.staged), BUSY_STAGED);
    assert_eq!(listed(&current.unstaged), BUSY_UNSTAGED);

    // A name that is taken, or is not a branch name, changes nothing.
    for name in [
        "main",
        "later",
        "feature/login",
        "feature",
        "two words",
        "a..b",
    ] {
        assert!(
            git_branch_create(&project, name, None, true).is_err(),
            "{name}"
        );
        assert!(
            git_branch_create(&project, name, None, false).is_err(),
            "{name}"
        );
    }
    assert_eq!(changed(&after, &state(&project)), NOTHING);

    // Before the first commit there is nothing to branch from, only the name
    // of the branch to be.
    let fresh = base.join("fresh");
    std::fs::create_dir_all(&fresh).unwrap();
    sh(&fresh, &["init", "-q", "-b", "main", "--template="]);
    write(&fresh, "first.txt", "first\n");
    git_branch_create(&fresh, "trunk", None, true).unwrap();
    assert_eq!(project_current_branch(&fresh).as_deref(), Some("trunk"));
    assert!(git_branch_create(&fresh, "other", None, false).is_err());
    assert_eq!(read(&fresh, "first.txt"), "first\n");
}

#[test]
fn switching_branches_is_refused_when_it_would_overwrite_work() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    let other = branch_other(&project, || {
        write(&project, "tracked.txt", "changed on other\n");
        write(&project, "collide.txt", "tracked on other\n");
    });

    // An edit to a file the other branch changed.
    write(&project, "tracked.txt", "one\nnot committed\n");
    let before = state(&project);
    assert!(git_checkout(&project, "other", false, None).is_err());
    assert!(git_checkout_commit(&project, &other).is_err());
    assert_eq!(changed(&before, &state(&project)), NOTHING);

    // An untracked file the other branch has as well.
    sh(&project, &["checkout", "-q", "--", "tracked.txt"]);
    write(&project, "collide.txt", "untracked here\n");
    let before = state(&project);
    assert!(git_checkout(&project, "other", false, None).is_err());
    assert!(git_checkout_commit(&project, &other).is_err());
    assert_eq!(changed(&before, &state(&project)), NOTHING);
}

#[test]
fn branches_and_tags_never_overwrite_one_another() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    let first = sh(&project, &["rev-parse", "HEAD"]);
    git_branch_create(&project, "feature", None, false).unwrap();
    git_tag_create(&project, "v1", None, None).unwrap();
    write(&project, "tracked.txt", "one\ntwo\n");
    commit_all(&project, "second");
    write(&project, "tracked.txt", "one\ntwo\nnot committed\n");
    let before = state(&project);

    assert!(git_branch_create(&project, "feature", None, false).is_err());
    assert!(git_branch_create(&project, "main", Some("feature"), true).is_err());
    assert!(git_branch_rename(&project, "feature", "main").is_err());
    assert!(git_branch_rename(&project, "missing", "new").is_err());
    assert!(git_tag_create(&project, "v1", None, None).is_err());
    assert!(git_tag_create(&project, "v1", Some("HEAD"), Some("again")).is_err());
    // The branch that is checked out cannot be deleted, forced or not.
    assert!(git_branch_delete(&project, "main", false, false).is_err());
    assert!(git_branch_delete(&project, "main", false, true).is_err());
    assert!(git_tag_delete(&project, "missing").is_err());

    assert_eq!(changed(&before, &state(&project)), NOTHING);
    assert_eq!(sh(&project, &["rev-parse", "feature"]), first);
    assert_eq!(sh(&project, &["rev-parse", "v1"]), first);
}

#[test]
fn deleting_a_branch_or_tag_removes_only_that_ref() {
    let (_temp, base) = temp();
    let project = base.join("project");
    busy(&project);
    sh(&project, &["branch", "gone"]);
    sh(&project, &["branch", "stays"]);
    sh(&project, &["tag", "gone"]);
    sh(&project, &["tag", "stays"]);
    let before = state(&project);

    git_branch_delete(&project, "gone", false, false).unwrap();
    git_tag_delete(&project, "gone").unwrap();

    assert_eq!(changed(&before, &state(&project)), ["refs"]);
    assert_eq!(
        branches_and_tags(&project),
        "refs/heads/main\nrefs/heads/stays\nrefs/tags/stays"
    );
}

// --- remotes --------------------------------------------------------------

#[test]
fn fetch_only_moves_remote_tracking_refs() {
    let (_temp, base) = temp();
    let (_origin, project, other) = cloned(&base);
    let theirs = push_from_other(&other, "theirs.txt", "theirs\n");
    write(&project, "tracked.txt", "one\nnot committed\n");
    let before = state(&project);

    git_fetch(&project).unwrap();

    assert_eq!(changed(&before, &state(&project)), ["refs"]);
    assert_eq!(sh(&project, &["rev-parse", "origin/main"]), theirs);
    let current = status(&project);
    assert_eq!((current.ahead, current.behind), (0, 1));
}

#[test]
fn pull_fast_forwards_around_uncommitted_work() {
    let (_temp, base) = temp();
    let (_origin, project, other) = cloned(&base);
    let theirs = push_from_other(&other, "theirs.txt", "theirs\n");
    write(&project, "tracked.txt", "one\nnot committed\n");
    write(&project, "untracked.txt", "untracked\n");
    let before = state(&project);

    git_pull(&project, None).unwrap();

    assert_eq!(
        changed(&before, &state(&project)),
        ["HEAD", "refs", "index", "file:theirs.txt"]
    );
    assert_eq!(sh(&project, &["rev-parse", "HEAD"]), theirs);
    assert_eq!(read(&project, "tracked.txt"), "one\nnot committed\n");
}

#[test]
fn pull_never_overwrites_or_rewrites_local_work() {
    let (_temp, base) = temp();
    let (_origin, project, other) = cloned(&base);
    push_from_other(&other, "tracked.txt", "theirs\n");

    // Uncommitted work in a file the pull would update.
    write(&project, "tracked.txt", "one\nnot committed\n");
    let before = state(&project);
    for strategy in [None, Some("merge"), Some("rebase")] {
        assert!(git_pull(&project, strategy).is_err(), "{strategy:?}");
        // Only the remote-tracking branch moved.
        assert_eq!(changed(&before, &state(&project)), ["refs"], "{strategy:?}");
    }

    // A local commit: the default never merges or rebases on its own.
    let mine = commit(&project, "mine");
    let before = state(&project);
    assert!(git_pull(&project, None).is_err());
    assert_eq!(changed(&before, &state(&project)), NOTHING);
    assert_eq!(sh(&project, &["rev-parse", "HEAD"]), mine);
}

#[test]
fn a_conflicting_pull_can_be_aborted_back_to_where_it_started() {
    for (strategy, operation) in [("merge", "merge"), ("rebase", "rebase")] {
        let (_temp, base) = temp();
        let (_origin, project, other) = cloned(&base);
        push_from_other(&other, "tracked.txt", "theirs\n");
        write(&project, "tracked.txt", "mine\n");
        commit_all(&project, "mine");
        write(&project, "untracked.txt", "untracked\n");
        sh(&project, &["fetch", "-q", "origin"]);
        let before = state(&project);

        assert!(git_pull(&project, Some(strategy)).is_err());
        let current = status(&project);
        assert_eq!(current.operation.as_deref(), Some(operation));
        assert_eq!(current.conflicted, ["tracked.txt"]);

        git_operation_abort(&project, operation).unwrap();
        assert_eq!(changed(&before, &state(&project)), NOTHING, "{strategy}");
    }
}

#[test]
fn push_never_forces_and_leaves_the_project_alone() {
    let (_temp, base) = temp();
    let (origin, project, other) = cloned(&base);
    let theirs = push_from_other(&other, "theirs.txt", "theirs\n");
    write(&project, "mine.txt", "mine\n");
    commit_all(&project, "mine");
    write(&project, "tracked.txt", "one\nnot committed\n");
    let before = state(&project);

    assert!(git_push(&project).is_err());
    assert!(git_push_branch(&project, "main", "origin", false).is_err());
    assert!(git_push_branch(&project, "main", "origin", true).is_err());
    assert_eq!(sh(&origin, &["rev-parse", "main"]), theirs);
    assert_eq!(changed(&before, &state(&project)), NOTHING);

    // Once the histories are joined, the push goes through.
    sh(&project, &["stash", "push", "-q"]);
    git_pull(&project, Some("merge")).unwrap();
    let before = state(&project);
    git_push(&project).unwrap();
    assert_eq!(sh(&origin, &["rev-parse", "main"]), before.head);
    assert_eq!(changed(&before, &state(&project)), ["refs"]);
}

#[test]
fn fast_forward_refuses_branches_that_have_work_of_their_own() {
    let (_temp, base) = temp();
    let (_origin, project, other) = cloned(&base);
    sh(
        &project,
        &["checkout", "-q", "--track", "-b", "side", "origin/main"],
    );
    write(&project, "side.txt", "side\n");
    let side = commit(&project, "work on side");
    push_from_other(&other, "theirs.txt", "theirs\n");

    // Checked out ...
    assert!(git_fast_forward(&project, "side").is_err());
    assert_eq!(sh(&project, &["rev-parse", "side"]), side);
    // ... and from another branch.
    sh(&project, &["checkout", "-q", "main"]);
    let before = state(&project);
    assert!(git_fast_forward(&project, "side").is_err());
    assert_eq!(sh(&project, &["rev-parse", "side"]), side);
    assert_eq!(read(&project, "tracked.txt"), before.files["tracked.txt"]);
    assert!(git_fast_forward(&project, "no-such-branch").is_err());
}

#[test]
fn pushing_a_tag_sends_only_the_tag() {
    let (_temp, base) = temp();
    let (origin, project, _other) = cloned(&base);
    write(&project, "tracked.txt", "one\ntwo\n");
    let tagged = commit(&project, "not pushed");
    git_tag_create(&project, "v1", None, Some("first release")).unwrap();
    let origin_main = sh(&origin, &["rev-parse", "main"]);

    git_tag_push(&project, "origin", "v1").unwrap();

    assert_eq!(branches_and_tags(&origin), "refs/heads/main\nrefs/tags/v1");
    assert_eq!(sh(&origin, &["rev-parse", "v1^{commit}"]), tagged);
    assert_eq!(sh(&origin, &["rev-parse", "main"]), origin_main);
    // Deleting the tag here does not delete it on the remote.
    git_tag_delete(&project, "v1").unwrap();
    assert_eq!(branches_and_tags(&origin), "refs/heads/main\nrefs/tags/v1");
}

#[test]
fn deleting_a_remote_branch_deletes_that_branch_and_nothing_else() {
    let (_temp, base) = temp();
    let (origin, project, _other) = cloned(&base);
    // A branch and a tag that share a name, next to a second branch.
    sh(
        &project,
        &[
            "push",
            "-q",
            "origin",
            "HEAD:refs/heads/v1",
            "HEAD:refs/heads/keep",
            "HEAD:refs/tags/v1",
        ],
    );
    sh(&project, &["fetch", "-q", "origin"]);
    write(&project, "tracked.txt", "one\nnot committed\n");
    let before = state(&project);

    git_branch_delete(&project, "origin/v1", true, false).unwrap();

    assert_eq!(
        branches_and_tags(&origin),
        "refs/heads/keep\nrefs/heads/main\nrefs/tags/v1"
    );
    assert_eq!(changed(&before, &state(&project)), ["refs"]);
    assert!(git_branch_delete(&project, "nowhere/v1", true, false).is_err());
    assert_eq!(
        branches_and_tags(&origin),
        "refs/heads/keep\nrefs/heads/main\nrefs/tags/v1"
    );

    // A branch somebody else already deleted is only forgotten here.
    sh(&origin, &["update-ref", "-d", "refs/heads/keep"]);
    assert_eq!(sh(&project, &["rev-parse", "origin/keep"]), before.head);
    git_branch_delete(&project, "origin/keep", true, false).unwrap();
    assert!(git_stdout(&project, &["rev-parse", "-q", "--verify", "origin/keep"]).is_err());
    assert_eq!(branches_and_tags(&origin), "refs/heads/main\nrefs/tags/v1");
}

// --- history --------------------------------------------------------------

#[test]
fn reset_loses_only_what_its_mode_says() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    let first = sh(&project, &["rev-parse", "HEAD"]);
    write(&project, ".gitignore", "ignored.txt\n");
    write(&project, "tracked.txt", "one\ntwo\n");
    let second = commit(&project, "second");
    write(&project, "tracked.txt", "one\ntwo\nnot committed\n");
    write(&project, "untracked.txt", "untracked\n");
    write(&project, "ignored.txt", "ignored\n");
    let before = state(&project);

    for mode in ["soft", "mixed"] {
        git_reset(&project, &first, mode).unwrap();
        let after = state(&project);
        assert_eq!(after.head, first);
        assert_eq!(after.files, before.files, "{mode} keeps the work tree");
        git_reset(&project, &second, mode).unwrap();
    }

    git_reset(&project, &first, "hard").unwrap();
    assert_eq!(read(&project, "tracked.txt"), "one\n");
    // Files git does not track are not part of what a hard reset throws away.
    assert_eq!(read(&project, "untracked.txt"), "untracked\n");
    assert_eq!(read(&project, "ignored.txt"), "ignored\n");
    // The commits it left behind stay reachable through the reflog.
    assert_eq!(sh(&project, &["rev-parse", "HEAD@{1}"]), second);
}

#[test]
fn picking_and_reverting_work_around_uncommitted_changes() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    let feature = branch_other(&project, || write(&project, "feature.txt", "feature\n"));
    write(&project, "tracked.txt", "one\nnot committed\n");
    write(&project, "untracked.txt", "untracked\n");

    git_cherry_pick(&project, &feature).unwrap();
    assert_eq!(read(&project, "feature.txt"), "feature\n");
    let picked = sh(&project, &["rev-parse", "HEAD"]);
    git_revert(&project, &picked).unwrap();
    assert!(!project.join("feature.txt").exists());

    assert_eq!(read(&project, "tracked.txt"), "one\nnot committed\n");
    assert_eq!(read(&project, "untracked.txt"), "untracked\n");
    assert_eq!(
        listed(&status(&project).unstaged),
        ["tracked.txt", "untracked.txt"]
    );
}

#[test]
fn picking_and_reverting_refuse_to_overwrite_uncommitted_changes() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    let feature = branch_other(&project, || write(&project, "tracked.txt", "feature\n"));
    write(&project, "tracked.txt", "one\ntwo\n");
    let second = commit(&project, "second");
    write(&project, "tracked.txt", "one\ntwo\nnot committed\n");
    let before = state(&project);

    assert!(git_cherry_pick(&project, &feature).is_err());
    assert!(git_revert(&project, &second).is_err());
    assert_eq!(changed(&before, &state(&project)), NOTHING);
}

#[test]
fn a_conflicting_pick_or_revert_can_be_aborted() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    let feature = branch_other(&project, || write(&project, "tracked.txt", "feature\n"));
    write(&project, "tracked.txt", "first\n");
    let first = commit(&project, "first");
    write(&project, "tracked.txt", "second\n");
    commit_all(&project, "second");
    write(&project, "untracked.txt", "untracked\n");
    let before = state(&project);

    assert!(git_cherry_pick(&project, &feature).is_err());
    assert_eq!(status(&project).operation.as_deref(), Some("cherry-pick"));
    git_operation_abort(&project, "cherry-pick").unwrap();
    assert_eq!(changed(&before, &state(&project)), NOTHING);

    assert!(git_revert(&project, &first).is_err());
    assert_eq!(status(&project).operation.as_deref(), Some("revert"));
    git_operation_abort(&project, "revert").unwrap();
    assert_eq!(changed(&before, &state(&project)), NOTHING);

    // An operation that is not running cannot be aborted or continued.
    for operation in [
        "merge",
        "rebase",
        "cherry-pick",
        "revert",
        "bisect",
        "--abort",
    ] {
        assert!(git_operation_abort(&project, operation).is_err());
        assert!(git_operation_continue(&project, operation).is_err());
    }
    assert_eq!(changed(&before, &state(&project)), NOTHING);
}

/// `topic` branches off `main` before `main` gained a commit; each side
/// commits what its closure writes. Ends on `topic`.
fn diverged(project: &Path, on_main: impl FnOnce(), on_topic: impl FnOnce()) {
    init(project);
    write(project, "notes.txt", "notes\n");
    commit_all(project, "notes");
    sh(project, &["checkout", "-q", "-b", "topic"]);
    on_topic();
    commit_all(project, "topic work");
    sh(project, &["checkout", "-q", "main"]);
    on_main();
    commit_all(project, "main work");
    sh(project, &["checkout", "-q", "topic"]);
}

#[test]
fn rebase_brings_uncommitted_work_along() {
    let (_temp, base) = temp();
    let project = base.join("project");
    diverged(
        &project,
        || write(&project, "main.txt", "main\n"),
        || write(&project, "topic.txt", "topic\n"),
    );
    write(&project, "notes.txt", "notes\nnot committed\n");
    write(&project, "untracked.txt", "untracked\n");

    git_rebase(&project, "main").unwrap();

    assert_eq!(
        sh(&project, &["log", "--format=%s", "-3"]),
        "topic work\nmain work\nnotes"
    );
    assert_eq!(read(&project, "notes.txt"), "notes\nnot committed\n");
    assert_eq!(read(&project, "untracked.txt"), "untracked\n");
    assert_eq!(
        listed(&status(&project).unstaged),
        ["notes.txt", "untracked.txt"]
    );
    // The work was put back, not left behind in a stash.
    assert!(project_git_refs(&project).unwrap().stashes.is_empty());
}

#[test]
fn a_conflicting_rebase_can_be_aborted_with_uncommitted_work_intact() {
    let (_temp, base) = temp();
    let project = base.join("project");
    diverged(
        &project,
        || write(&project, "tracked.txt", "main\n"),
        || write(&project, "tracked.txt", "topic\n"),
    );
    write(&project, "notes.txt", "notes\nnot committed\n");
    write(&project, "untracked.txt", "untracked\n");
    let before = state(&project);

    assert!(git_rebase(&project, "main").is_err());
    let current = status(&project);
    assert_eq!(current.operation.as_deref(), Some("rebase"));
    assert_eq!(current.conflicted, ["tracked.txt"]);

    git_operation_abort(&project, "rebase").unwrap();
    assert_eq!(changed(&before, &state(&project)), NOTHING);
}

#[test]
fn a_resolved_rebase_continues_and_returns_uncommitted_work() {
    let (_temp, base) = temp();
    let project = base.join("project");
    diverged(
        &project,
        || write(&project, "tracked.txt", "main\n"),
        || write(&project, "tracked.txt", "topic\n"),
    );
    write(&project, "notes.txt", "notes\nnot committed\n");

    assert!(git_rebase(&project, "main").is_err());
    git_resolve_conflict(&project, "tracked.txt", "theirs").unwrap();
    git_operation_continue(&project, "rebase").unwrap();

    assert!(status(&project).operation.is_none());
    assert_eq!(read(&project, "tracked.txt"), "topic\n");
    assert_eq!(read(&project, "notes.txt"), "notes\nnot committed\n");
    assert_eq!(
        sh(&project, &["log", "--format=%s", "-2"]),
        "topic work\nmain work"
    );
    assert!(project_git_refs(&project).unwrap().stashes.is_empty());
}

/// Three commits `a`, `b` and `c` on top of `init`, each adding a file, and
/// the todo entries for them in that order.
fn three_commits(project: &Path) -> (String, Vec<String>) {
    init(project);
    let onto = sh(project, &["rev-parse", "HEAD"]);
    for name in ["a", "b", "c"] {
        write(project, &format!("{name}.txt"), name);
        commit_all(project, name);
    }
    let hashes = project_rebase_commits(project, &onto)
        .unwrap()
        .into_iter()
        .map(|commit| commit.hash)
        .collect();
    (onto, hashes)
}

fn todo(entries: &[(&str, &String)]) -> Vec<(String, String)> {
    entries
        .iter()
        .map(|(action, hash)| (action.to_string(), hash.to_string()))
        .collect()
}

#[test]
fn interactive_rebase_squashes_without_changing_the_files() {
    let (_temp, base) = temp();
    let project = base.join("project");
    let (onto, hashes) = three_commits(&project);
    let tree = sh(&project, &["rev-parse", "HEAD^{tree}"]);
    write(&project, "tracked.txt", "one\nnot committed\n");
    write(&project, "untracked.txt", "untracked\n");
    let before = state(&project);

    let entries = todo(&[
        ("pick", &hashes[0]),
        ("squash", &hashes[1]),
        ("fixup", &hashes[2]),
    ]);
    git_rebase_interactive(&project, &onto, &entries).unwrap();

    let after = state(&project);
    assert_eq!(after.files, before.files);
    assert_eq!(sh(&project, &["rev-parse", "HEAD^{tree}"]), tree);
    assert_eq!(sh(&project, &["rev-parse", "HEAD^"]), onto);
    // A squash keeps both messages, a fixup only the first.
    assert_eq!(sh(&project, &["log", "-1", "--format=%B"]), "a\n\nb");
    assert_eq!(
        listed(&status(&project).unstaged),
        ["tracked.txt", "untracked.txt"]
    );
    assert!(project_git_refs(&project).unwrap().stashes.is_empty());
    // The old tip is still in the reflog.
    assert_eq!(sh(&project, &["rev-parse", "main@{1}"]), before.head);
}

#[test]
fn a_conflicting_interactive_rebase_can_be_aborted() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    let onto = sh(&project, &["rev-parse", "HEAD"]);
    write(&project, "tracked.txt", "first\n");
    commit_all(&project, "first");
    write(&project, "tracked.txt", "second\n");
    commit_all(&project, "second");
    let hashes: Vec<String> = project_rebase_commits(&project, &onto)
        .unwrap()
        .into_iter()
        .map(|commit| commit.hash)
        .collect();
    write(&project, "untracked.txt", "untracked\n");
    let before = state(&project);

    // Swapped, the second commit no longer applies.
    let entries = todo(&[("pick", &hashes[1]), ("pick", &hashes[0])]);
    assert!(git_rebase_interactive(&project, &onto, &entries).is_err());
    assert_eq!(status(&project).operation.as_deref(), Some("rebase"));

    git_operation_abort(&project, "rebase").unwrap();
    assert_eq!(changed(&before, &state(&project)), NOTHING);
}

#[test]
fn an_interactive_rebase_that_is_refused_leaves_no_trace() {
    let (_temp, base) = temp();
    let project = base.join("project");
    let (onto, hashes) = three_commits(&project);
    write(&project, "tracked.txt", "one\nnot committed\n");
    let before = state(&project);

    let refused = [
        // A commit is missing, so it would be dropped without being named.
        todo(&[("pick", &hashes[0]), ("pick", &hashes[1])]),
        // A commit is listed twice.
        todo(&[
            ("pick", &hashes[0]),
            ("pick", &hashes[0]),
            ("pick", &hashes[2]),
        ]),
        // A commit that is not part of the branch.
        todo(&[("pick", &hashes[0]), ("pick", &hashes[1]), ("pick", &onto)]),
        todo(&[
            ("edit", &hashes[0]),
            ("pick", &hashes[1]),
            ("pick", &hashes[2]),
        ]),
        todo(&[
            ("fixup", &hashes[0]),
            ("pick", &hashes[1]),
            ("pick", &hashes[2]),
        ]),
    ];
    for entries in refused {
        assert!(git_rebase_interactive(&project, &onto, &entries).is_err());
        assert_eq!(changed(&before, &state(&project)), NOTHING, "{entries:?}");
    }
    // Abbreviated hashes are not accepted either.
    let short = hashes[0][..12].to_string();
    let entries = todo(&[("pick", &short), ("pick", &hashes[1]), ("pick", &hashes[2])]);
    assert!(git_rebase_interactive(&project, &onto, &entries).is_err());
    assert_eq!(changed(&before, &state(&project)), NOTHING);
}

// --- stashes --------------------------------------------------------------

#[test]
fn stashing_untracked_files_takes_them_away_and_brings_them_back() {
    let (_temp, base) = temp();
    let project = base.join("project");
    busy(&project);
    write(&project, "dir/new/untracked.txt", "nested untracked\n");
    let before = state(&project);

    git_stash_push(&project, Some("everything"), true).unwrap();

    let current = status(&project);
    assert!(current.staged.is_empty(), "{:?}", current.staged);
    assert!(current.unstaged.is_empty(), "{:?}", current.unstaged);
    assert!(!project.join("untracked.txt").exists());
    assert!(!project.join("dir/new/untracked.txt").exists());
    assert_eq!(read(&project, "tracked.txt"), "one\n");
    // Ignored files are not part of a stash.
    assert_eq!(read(&project, "ignored.txt"), "ignored\n");
    assert_eq!(read(&project, "secret/key.txt"), "secret\n");

    let stash = project_git_refs(&project).unwrap().stashes.remove(0);
    assert!(stash.message.ends_with("everything"), "{}", stash.message);
    git_stash_pop(&project, &stash.name, &stash.hash).unwrap();

    let after = state(&project);
    assert_eq!(after.files, before.files);
    assert_eq!(after.head, before.head);
    assert!(after.stashes.is_empty());
}

#[test]
fn stashing_without_untracked_files_leaves_them_in_place() {
    let (_temp, base) = temp();
    let project = base.join("project");
    busy(&project);
    let before = state(&project);

    git_stash_push(&project, None, false).unwrap();
    assert_eq!(read(&project, "untracked.txt"), "untracked\n");
    assert_eq!(read(&project, "tracked.txt"), "one\n");
    assert_eq!(listed(&status(&project).unstaged), ["untracked.txt"]);

    // Applying keeps the stash, so it can be applied again elsewhere.
    let stash = project_git_refs(&project).unwrap().stashes.remove(0);
    git_stash_apply(&project, &stash.name, &stash.hash).unwrap();
    let after = state(&project);
    assert_eq!(after.files, before.files);
    assert_eq!(project_git_refs(&project).unwrap().stashes.len(), 1);
}

#[test]
fn stashing_with_nothing_to_stash_creates_no_entry() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    write(&project, "untracked.txt", "untracked\n");
    let before = state(&project);

    git_stash_push(&project, Some("nothing"), false).unwrap();
    assert_eq!(changed(&before, &state(&project)), NOTHING);
}

#[test]
fn a_stash_that_does_not_apply_is_kept() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    write(&project, "tracked.txt", "stashed\n");
    git_stash_push(&project, Some("mine"), false).unwrap();
    let stash = project_git_refs(&project).unwrap().stashes.remove(0);

    // Uncommitted work in the same file: nothing is applied at all.
    write(&project, "tracked.txt", "not committed\n");
    let before = state(&project);
    assert!(git_stash_pop(&project, &stash.name, &stash.hash).is_err());
    assert!(git_stash_apply(&project, &stash.name, &stash.hash).is_err());
    assert_eq!(changed(&before, &state(&project)), NOTHING);

    // A commit that conflicts: the pop stops and the stash stays.
    commit_all(&project, "conflicting commit");
    assert!(git_stash_pop(&project, &stash.name, &stash.hash).is_err());
    let stashes = project_git_refs(&project).unwrap().stashes;
    assert_eq!(stashes.len(), 1);
    assert_eq!(stashes[0].hash, stash.hash);
    assert_eq!(status(&project).conflicted, ["tracked.txt"]);
}

#[test]
fn stash_actions_only_touch_the_entry_that_was_picked() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    for content in ["first\n", "second\n", "third\n"] {
        write(&project, "tracked.txt", content);
        git_stash_push(&project, Some(content.trim()), false).unwrap();
    }
    let stashes = project_git_refs(&project).unwrap().stashes;
    let hashes: Vec<&str> = stashes.iter().map(|stash| stash.hash.as_str()).collect();
    let before = state(&project);

    // Every name with the hash of another entry is refused.
    for (index, stash) in stashes.iter().enumerate() {
        let other = hashes[(index + 1) % hashes.len()];
        assert!(git_stash_drop(&project, &stash.name, other).is_err());
        assert!(git_stash_pop(&project, &stash.name, other).is_err());
        assert!(git_stash_apply(&project, &stash.name, other).is_err());
    }
    assert!(git_stash_drop(&project, "stash@{7}", hashes[0]).is_err());
    assert_eq!(changed(&before, &state(&project)), NOTHING);

    // Dropping the middle entry keeps the other two.
    git_stash_drop(&project, &stashes[1].name, &stashes[1].hash).unwrap();
    let left: Vec<String> = project_git_refs(&project)
        .unwrap()
        .stashes
        .into_iter()
        .map(|stash| stash.hash)
        .collect();
    assert_eq!(left, [hashes[0], hashes[2]]);
}

// --- conflicts ------------------------------------------------------------

/// A merge of `other` into `main` that conflicts in `a.txt` and `b.txt`.
fn conflicting_merge(project: &Path) {
    init(project);
    write(project, "a.txt", "base\n");
    write(project, "b.txt", "base\n");
    commit_all(project, "base");
    branch_other(project, || {
        write(project, "a.txt", "theirs\n");
        write(project, "b.txt", "theirs\n");
        write(project, "added.txt", "added on other\n");
    });
    write(project, "a.txt", "ours\n");
    write(project, "b.txt", "ours\n");
    commit_all(project, "ours");
    write(project, "untracked.txt", "untracked\n");
}

#[test]
fn aborting_a_merge_restores_the_state_before_it() {
    let (_temp, base) = temp();
    let project = base.join("project");
    conflicting_merge(&project);
    let before = state(&project);

    assert!(git_merge(&project, "other").is_err());
    let current = status(&project);
    assert_eq!(current.operation.as_deref(), Some("merge"));
    assert_eq!(current.conflicted, ["a.txt", "b.txt"]);

    git_operation_abort(&project, "merge").unwrap();
    assert_eq!(changed(&before, &state(&project)), NOTHING);
}

#[test]
fn resolving_one_conflict_leaves_the_others_alone() {
    let (_temp, base) = temp();
    let project = base.join("project");
    conflicting_merge(&project);
    assert!(git_merge(&project, "other").is_err());
    let before = state(&project);

    git_resolve_conflict(&project, "a.txt", "ours").unwrap();

    assert_eq!(changed(&before, &state(&project)), ["index", "file:a.txt"]);
    assert_eq!(read(&project, "a.txt"), "ours\n");
    assert!(read(&project, "b.txt").contains("<<<<<<<"));
    let current = status(&project);
    assert_eq!(current.conflicted, ["b.txt"]);
    assert_eq!(current.operation.as_deref(), Some("merge"));
    // A merge with conflicts left cannot be concluded.
    assert!(git_operation_continue(&project, "merge").is_err());
    assert!(git_commit(&project, "too early", false).is_err());
    assert_eq!(status(&project).conflicted, ["b.txt"]);

    git_resolve_conflict(&project, "b.txt", "theirs").unwrap();
    git_operation_continue(&project, "merge").unwrap();
    assert_eq!(read(&project, "b.txt"), "theirs\n");
    assert_eq!(read(&project, "added.txt"), "added on other\n");
    assert_eq!(read(&project, "untracked.txt"), "untracked\n");
    assert_eq!(
        sh(&project, &["rev-list", "--count", "--merges", "HEAD"]),
        "1"
    );
}

// --- the wrong repository -------------------------------------------------

#[test]
fn a_folder_inside_a_repository_is_not_that_repository() {
    let (_temp, base) = temp();
    let parent = base.join("parent");
    busy(&parent);
    write(&parent, "apps/web/index.ts", "export {};\n");
    commit_all_keeping_work(&parent, "apps/web/index.ts");
    write(&parent, "apps/web/index.ts", "export {};\n// edited\n");
    write(&parent, "apps/web/new.ts", "// new\n");
    sh(&parent, &["branch", "other"]);
    sh(&parent, &["tag", "v1"]);
    let head = sh(&parent, &["rev-parse", "HEAD"]);
    // The project is a plain folder of the surrounding repository.
    let folder = parent.join("apps/web");
    let stash = "0123456789abcdef0123456789abcdef01234567";
    let before = state(&parent);

    assert!(!status(&folder).is_repo);
    let info = project_git_info(&folder);
    assert_eq!((info.is_repo, info.branch, info.head), (false, None, None));
    assert_eq!(project_current_branch(&folder), None);
    assert!(project_git_refs(&folder).unwrap().branches.is_empty());

    let named = paths(&["index.ts"]);
    let refused = [
        ("stage", git_stage(&folder, None).is_err()),
        ("stage path", git_stage(&folder, Some("index.ts")).is_err()),
        ("stage paths", git_stage_paths(&folder, &named).is_err()),
        ("unstage", git_unstage(&folder, None).is_err()),
        ("unstage paths", git_unstage_paths(&folder, &named).is_err()),
        ("discard", git_discard_paths(&folder, &named).is_err()),
        (
            "hunks",
            project_file_hunks(&folder, "index.ts", false, 3, false).is_err(),
        ),
        (
            "commit",
            git_commit(&folder, "in the parent", false).is_err(),
        ),
        ("amend", git_commit(&folder, "", true).is_err()),
        ("stash", git_stash_push(&folder, None, true).is_err()),
        (
            "stash drop",
            git_stash_drop(&folder, "stash@{0}", stash).is_err(),
        ),
        (
            "checkout",
            git_checkout(&folder, "other", false, None).is_err(),
        ),
        ("detach", git_checkout_commit(&folder, &head).is_err()),
        ("reset", git_reset(&folder, &head, "hard").is_err()),
        ("merge", git_merge(&folder, "other").is_err()),
        ("rebase", git_rebase(&folder, "other").is_err()),
        ("pick", git_cherry_pick(&folder, &head).is_err()),
        ("revert", git_revert(&folder, &head).is_err()),
        (
            "branch",
            git_branch_create(&folder, "new", None, false).is_err(),
        ),
        (
            "branch delete",
            git_branch_delete(&folder, "other", false, true).is_err(),
        ),
        (
            "branch rename",
            git_branch_rename(&folder, "other", "renamed").is_err(),
        ),
        ("tag", git_tag_create(&folder, "v2", None, None).is_err()),
        ("tag delete", git_tag_delete(&folder, "v1").is_err()),
        ("fetch", git_fetch(&folder).is_err()),
        ("pull", git_pull(&folder, None).is_err()),
        ("push", git_push(&folder).is_err()),
        ("abort", git_operation_abort(&folder, "merge").is_err()),
        (
            "history",
            project_commits(&folder, None, None, 0, 10).is_err(),
        ),
        ("blame", project_blame(&folder, "index.ts").is_err()),
    ];
    for (command, refused) in refused {
        assert!(refused, "{command} ran in the surrounding repository");
    }
    assert_eq!(changed(&before, &state(&parent)), NOTHING);

    // Nor is it when the project is opened through a link to the folder.
    #[cfg(unix)]
    {
        let link = base.join("link");
        std::os::unix::fs::symlink(&folder, &link).unwrap();
        assert_eq!(project_current_branch(&link), None);
        assert!(git_stage(&link, None).is_err());
        assert!(git_stash_push(&link, None, true).is_err());
        assert_eq!(changed(&before, &state(&parent)), NOTHING);
        // A repository behind a link still is one.
        let linked_repository = base.join("linked-repository");
        std::os::unix::fs::symlink(&parent, &linked_repository).unwrap();
        assert_eq!(
            project_current_branch(&linked_repository).as_deref(),
            Some("main")
        );
        assert_eq!(listed(&status(&linked_repository).staged), BUSY_STAGED);
    }
}

/// Commits one path and leaves the rest of the work tree and index as it is.
fn commit_all_keeping_work(project: &Path, path: &str) {
    sh(project, &["add", "--", path]);
    sh(project, &["commit", "-q", "-m", "one file", "--", path]);
}

#[test]
fn init_makes_a_repository_of_its_own_inside_another() {
    let (_temp, base) = temp();
    let parent = base.join("parent");
    busy(&parent);
    let folder = parent.join("apps/web");
    write(&folder, "index.ts", "export {};\n");
    let before = state(&parent);

    git_init(&folder).unwrap();

    assert!(status(&folder).is_repo);
    assert!(folder.join(".git").is_dir());
    assert_eq!(listed(&status(&folder).unstaged), ["index.ts"]);
    let after = state(&parent);
    assert_eq!(changed(&before, &after), ["file:apps/web/.git"]);
    // Commands in the new repository stay in it.
    identify(&folder);
    git_stage(&folder, None).unwrap();
    git_commit(&folder, "first", false).unwrap();
    assert_eq!(changed(&after, &state(&parent)), NOTHING);
}

#[test]
fn init_on_a_repository_keeps_everything_in_it() {
    let (_temp, base) = temp();
    let project = base.join("project");
    busy(&project);
    let before = state(&project);
    let config = read(&project, ".git/config");

    git_init(&project).unwrap();

    assert_eq!(changed(&before, &state(&project)), NOTHING);
    assert_eq!(read(&project, ".git/config"), config);
}

#[test]
fn inherited_repository_variables_do_not_reach_git() {
    let (_temp, base) = temp();
    let project = base.join("project");
    std::fs::create_dir_all(&project).unwrap();
    let shadow = ShadowRepo::open(&base.join("data"), "project-1", &project).unwrap();
    let removed = |command: &Command| -> HashSet<String> {
        command
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect()
    };

    for (kind, command) in [("project", git(&project)), ("shadow", shadow.command())] {
        let removed = removed(&command);
        for name in REPOSITORY_ENV {
            assert!(removed.contains(name), "{kind} git inherits {name}");
        }
    }
    // Git knows which variables tie a command to a repository; the two that
    // only carry `-c` settings are left to the user.
    let known = sh(&base, &["rev-parse", "--local-env-vars"]);
    for name in known.lines() {
        assert!(
            REPOSITORY_ENV.contains(&name)
                || ["GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"].contains(&name),
            "git treats {name} as tied to a repository; add it to REPOSITORY_ENV"
        );
    }
    // Looking for a repository stops at the project folder.
    let ceiling = git(&project)
        .get_envs()
        .find(|(name, _)| *name == "GIT_CEILING_DIRECTORIES")
        .and_then(|(_, value)| value.map(PathBuf::from));
    assert_eq!(ceiling.as_deref(), Some(base.as_path()));
}

// --- names that look like something else ----------------------------------

#[test]
fn option_like_names_are_refused_by_every_command() {
    let (_temp, base) = temp();
    let project = base.join("project");
    busy(&project);
    sh(&project, &["branch", "other"]);
    sh(&project, &["tag", "v1"]);
    let head = sh(&project, &["rev-parse", "HEAD"]);
    let written = base.join("written-by-git");
    let output = format!("--output={}", written.display());
    let before = state(&project);
    let entries = vec![("pick".to_string(), head.clone())];

    for name in [
        "--force",
        "-f",
        "-",
        output.as_str(),
        "line\nbreak",
        "tab\tname",
        "",
    ] {
        let mut refused = vec![
            (
                "checkout",
                git_checkout(&project, name, false, None).is_err(),
            ),
            ("merge", git_merge(&project, name).is_err()),
            ("rebase", git_rebase(&project, name).is_err()),
            (
                "rebase list",
                project_rebase_commits(&project, name).is_err(),
            ),
            (
                "interactive rebase",
                git_rebase_interactive(&project, name, &entries).is_err(),
            ),
            (
                "interactive rebase without entries",
                git_rebase_interactive(&project, name, &[]).is_err(),
            ),
            (
                "branch",
                git_branch_create(&project, name, None, false).is_err(),
            ),
            (
                "branch and checkout",
                git_branch_create(&project, name, None, true).is_err(),
            ),
            (
                "rename from",
                git_branch_rename(&project, name, "renamed").is_err(),
            ),
            (
                "rename to",
                git_branch_rename(&project, "other", name).is_err(),
            ),
            (
                "delete",
                git_branch_delete(&project, name, false, true).is_err(),
            ),
            (
                "delete remote",
                git_branch_delete(&project, name, true, false).is_err(),
            ),
            (
                "upstream of",
                git_set_upstream(&project, name, "main").is_err(),
            ),
            (
                "upstream",
                git_set_upstream(&project, "other", name).is_err(),
            ),
            (
                "push branch",
                git_push_branch(&project, name, "origin", false).is_err(),
            ),
            (
                "push to",
                git_push_branch(&project, "main", name, true).is_err(),
            ),
            ("fast-forward", git_fast_forward(&project, name).is_err()),
            ("tag", git_tag_create(&project, name, None, None).is_err()),
            ("tag delete", git_tag_delete(&project, name).is_err()),
            ("tag push", git_tag_push(&project, "origin", name).is_err()),
            ("tag push to", git_tag_push(&project, name, "v1").is_err()),
            (
                "pull request",
                git_pull_request_url(&project, "origin", name).is_err(),
            ),
            (
                "pull request on",
                git_pull_request_url(&project, name, "main").is_err(),
            ),
            ("commit", project_commit_detail(&project, name).is_err()),
            // Commits are only ever named by their hash.
            ("pick", git_cherry_pick(&project, name).is_err()),
            ("revert", git_revert(&project, name).is_err()),
            ("reset", git_reset(&project, name, "hard").is_err()),
            ("detach", git_checkout_commit(&project, name).is_err()),
            (
                "commit diff",
                project_commit_file_diff(&project, name, "tracked.txt").is_err(),
            ),
            // The remaining ones take one of a few fixed words.
            ("reset mode", git_reset(&project, &head, name).is_err()),
            (
                "conflict side",
                git_resolve_conflict(&project, "tracked.txt", name).is_err(),
            ),
            ("abort", git_operation_abort(&project, name).is_err()),
            ("continue", git_operation_continue(&project, name).is_err()),
            (
                "line action",
                git_apply_lines(&project, "tracked.txt", false, name, 3, "x", &[0]).is_err(),
            ),
            ("stash", git_stash_drop(&project, name, &head).is_err()),
            (
                "stash hash",
                git_stash_drop(&project, "stash@{0}", name).is_err(),
            ),
        ];
        // Left empty, these mean "the default".
        if !name.is_empty() {
            refused.push((
                "start point",
                git_branch_create(&project, "new", Some(name), false).is_err(),
            ));
            refused.push((
                "tag target",
                git_tag_create(&project, "v2", Some(name), None).is_err(),
            ));
            refused.push((
                "tracking branch",
                git_checkout(&project, "other", true, Some(name)).is_err(),
            ));
        }
        for (command, refused) in refused {
            assert!(refused, "{command} accepted {name:?}");
        }
    }
    assert!(!written.exists());
    assert_eq!(changed(&before, &state(&project)), NOTHING);
    // A commit is named by its hash, never by a ref or an expression.
    for word in ["HEAD", "main", "v1", "HEAD~1", "@{-1}", "stash@{0}"] {
        assert!(git_cherry_pick(&project, word).is_err(), "{word}");
        assert!(git_reset(&project, word, "hard").is_err(), "{word}");
    }
    assert_eq!(changed(&before, &state(&project)), NOTHING);
}

#[test]
fn files_named_like_revisions_are_not_mistaken_for_them() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    for name in ["HEAD", "main", "other", "v1"] {
        write(&project, name, "a file\n");
    }
    commit_all(&project, "files named like refs");
    branch_other(&project, || write(&project, "other.txt", "other\n"));
    sh(&project, &["tag", "v1"]);

    assert_eq!(
        project_commit_detail(&project, "HEAD").unwrap().subject,
        "files named like refs"
    );
    assert_eq!(project_rebase_commits(&project, "other").unwrap().len(), 0);
    git_branch_create(&project, "copy", Some("other"), false).unwrap();
    git_tag_create(&project, "v2", Some("v1"), None).unwrap();
    git_checkout(&project, "other", false, None).unwrap();
    assert_eq!(project_current_branch(&project).as_deref(), Some("other"));
    assert_eq!(read(&project, "other"), "a file\n");
    git_checkout(&project, "main", false, None).unwrap();
    git_merge(&project, "other").unwrap();
    assert_eq!(read(&project, "other.txt"), "other\n");
    git_rebase(&project, "copy").unwrap();
    assert_eq!(read(&project, "main"), "a file\n");
}

// --- the user's configuration ----------------------------------------------

#[cfg(unix)]
#[test]
fn signatures_stay_out_of_the_history() {
    let (_temp, base) = temp();
    let key = base.join("signing-key");
    let generated = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f"])
        .arg(&key)
        .stdin(Stdio::null())
        .status();
    if !generated.is_ok_and(|status| status.success()) {
        eprintln!("skipped: ssh-keygen is not available to sign with");
        return;
    }
    let project = base.join("project");
    init(&project);
    for (name, value) in [
        ("gpg.format", "ssh"),
        ("user.signingkey", text(&key.with_extension("pub"))),
        // Prints what it finds out about a signature before each commit.
        ("log.showSignature", "true"),
    ] {
        sh(&project, &["config", name, value]);
    }
    write(&project, "tracked.txt", "one\nsigned\n");
    sh(&project, &["add", "-A"]);
    if git_stdout(&project, &["commit", "-q", "-S", "-m", "signed"]).is_err() {
        eprintln!("skipped: this git cannot sign with ssh keys");
        return;
    }
    let head = sh(&project, &["rev-parse", "HEAD"]);
    let first = sh(&project, &["rev-parse", "HEAD^"]);

    let commits = project_commits(&project, None, None, 0, 10).unwrap();
    assert_eq!(commits[0].hash, head);
    assert_eq!(commits[0].subject, "signed");
    assert_eq!(commits[0].parents, [first.clone()]);
    let found = project_commits(&project, Some("signed"), None, 0, 10).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].hash, head);
    let history = project_commits(&project, None, Some("tracked.txt"), 0, 10).unwrap();
    assert_eq!(history[0].hash, head);

    let detail = project_commit_detail(&project, &head).unwrap();
    assert_eq!(detail.hash, head);
    assert_eq!(detail.changes.len(), 1);
    assert_eq!(
        (
            detail.changes[0].status.as_str(),
            detail.changes[0].additions
        ),
        ("M", 1)
    );
    let rebased = project_rebase_commits(&project, &first).unwrap();
    assert_eq!(rebased.len(), 1);
    assert_eq!(rebased[0].hash, head);

    write(&project, "tracked.txt", "one\nsigned\nmore\n");
    git_stage(&project, None).unwrap();
    let summary = staged_summary(&project, 1000).unwrap();
    assert_eq!(summary.recent_subjects, ["signed", "init"]);
}

#[test]
fn line_staging_ignores_diff_prefixes_from_the_users_configuration() {
    for setting in ["diff.noprefix", "diff.mnemonicPrefix"] {
        let (_temp, base) = temp();
        let project = base.join("project");
        init(&project);
        sh(&project, &["config", setting, "true"]);
        write(&project, "tracked.txt", "one\ntwo\nthree\n");

        apply_lines(&project, "tracked.txt", false, "stage", &["three"]);
        assert_eq!(
            staged_text(&project, "tracked.txt"),
            "one\nthree\n",
            "{setting}"
        );
        apply_lines(&project, "tracked.txt", true, "unstage", &["three"]);
        assert_eq!(staged_text(&project, "tracked.txt"), "one\n", "{setting}");
        write(&project, "tracked.txt", "one\ntwo\nthree\nfour\n");
        apply_lines(&project, "tracked.txt", false, "discard", &["two", "four"]);
        assert_eq!(read(&project, "tracked.txt"), "one\nthree\n", "{setting}");
    }
}

#[test]
fn line_actions_work_when_git_converts_line_endings() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    // The default on Windows: line feeds in the repository, CRLF on disk.
    sh(&project, &["config", "core.autocrlf", "true"]);
    write(&project, "tracked.txt", "one\r\ntwo\r\nthree\r\nfour\r\n");

    apply_lines(&project, "tracked.txt", false, "stage", &["three"]);
    assert_eq!(staged_text(&project, "tracked.txt"), "one\nthree\n");
    assert_eq!(
        read(&project, "tracked.txt"),
        "one\r\ntwo\r\nthree\r\nfour\r\n"
    );

    apply_lines(&project, "tracked.txt", false, "discard", &["four"]);
    assert_eq!(read(&project, "tracked.txt"), "one\r\ntwo\r\nthree\r\n");
    assert_eq!(staged_text(&project, "tracked.txt"), "one\nthree\n");

    apply_lines(&project, "tracked.txt", true, "unstage", &["three"]);
    assert_eq!(staged_text(&project, "tracked.txt"), "one\n");
    assert_eq!(read(&project, "tracked.txt"), "one\r\ntwo\r\nthree\r\n");
}

/// The id of the removed or added line with this text.
fn line_id(diff: &GitHunkDiff, kind: GitDiffLineKind, text: &str) -> u32 {
    let mut lines = diff.hunks.iter().flat_map(|hunk| &hunk.lines);
    lines
        .find(|line| line.kind == kind && line.text == text)
        .map(|line| line.id)
        .unwrap()
}

#[test]
fn undoing_part_of_a_change_at_a_missing_last_newline_keeps_lines_apart() {
    use GitDiffLineKind::{Add, Del};
    // The file ends without a newline and gains a line: git shows the old last
    // line as removed and added again, with its newline.
    let (old, new) = ("a\nb", "a\nb\nc");
    let selections: [(&[(GitDiffLineKind, &str)], &str); 3] = [
        (&[(Del, "b")], "a\nb\nb\nc"),
        (&[(Del, "b"), (Add, "b")], "a\nb\nc"),
        (&[(Del, "b"), (Add, "c")], "a\nb\nb\n"),
    ];
    let (_temp, base) = temp();
    let project = base.join("project");
    init(&project);
    write(&project, "tracked.txt", old);
    commit_all(&project, "no newline at the end");

    for (action, staged) in [("discard", false), ("unstage", true)] {
        for (selection, expected) in selections {
            write(&project, "tracked.txt", new);
            if staged {
                git_stage(&project, Some("tracked.txt")).unwrap();
            }
            let diff = project_file_hunks(&project, "tracked.txt", staged, 3, false).unwrap();
            let ids: Vec<u32> = selection
                .iter()
                .map(|(kind, text)| line_id(&diff, *kind, text))
                .collect();

            git_apply_lines(
                &project,
                "tracked.txt",
                staged,
                action,
                3,
                &diff.fingerprint,
                &ids,
            )
            .unwrap();

            let index = staged_text(&project, "tracked.txt");
            let on_disk = read(&project, "tracked.txt");
            // Discarding changes the file and unstaging the index, never both.
            let (result, other, untouched) = if staged {
                (index, on_disk, new)
            } else {
                (on_disk, index, old)
            };
            assert_eq!(result, expected, "{action} {selection:?}");
            assert_eq!(other, untouched, "{action} {selection:?}");
        }
    }
}

// --- submodules -----------------------------------------------------------

#[test]
fn a_submodule_is_checked_out_again_by_its_path() {
    let (_temp, base) = temp();
    let library = base.join("library");
    init(&library);
    let project = base.join("project");
    init(&project);
    // Cloning from a local folder is something git only does when told to.
    let added = git(&project)
        .args(["-c", "protocol.file.allow=always"])
        .args(["submodule", "add", "-q", text(&library), "libs/shared code"])
        .output()
        .unwrap();
    assert!(added.status.success(), "{added:?}");
    commit_all(&project, "add the library");
    assert_eq!(
        project_git_refs(&project).unwrap().submodules,
        ["libs/shared code"]
    );
    // Deinitialised, the folder is empty but its repository is still stored.
    sh(
        &project,
        &["submodule", "deinit", "-q", "-f", "--", "libs/shared code"],
    );
    assert!(!project.join("libs/shared code/tracked.txt").exists());

    git_submodule_update(&project, Some("libs/shared code")).unwrap();
    assert_eq!(read(&project, "libs/shared code/tracked.txt"), "one\n");

    // A submodule's new commits are listed, and discarding leaves it alone.
    let inner = project.join("libs/shared code");
    identify(&inner);
    write(&inner, "tracked.txt", "one\nlocal commit\n");
    let local = commit(&inner, "local work in the submodule");
    assert_eq!(listed(&status(&project).unstaged), ["libs/shared code"]);
    git_discard_paths(&project, &paths(&["libs/shared code"])).unwrap();
    assert_eq!(sh(&inner, &["rev-parse", "HEAD"]), local);
    assert_eq!(read(&inner, "tracked.txt"), "one\nlocal commit\n");

    sh(
        &project,
        &["submodule", "deinit", "-q", "-f", "--", "libs/shared code"],
    );
    git_submodule_update(&project, None).unwrap();
    assert_eq!(read(&project, "libs/shared code/tracked.txt"), "one\n");
}
