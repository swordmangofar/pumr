//! The operating system's sandbox around the agent's commands.
//!
//! The permission rules judge a command by reading its command line, and a
//! line can be misjudged: `make test` says nothing about what the Makefile
//! runs. The sandbox is the second layer for that case. Whatever a `bash`
//! command starts may write only to the project, the folders the user
//! allowed, the chat's scratch folder, temp folders and the caches of build
//! tools; it cannot read the folders that hold keys; and, when the user asks
//! for it, it reaches no network but this machine.
//!
//! macOS confines the command with `sandbox-exec` (Seatbelt), Linux with
//! Landlock, which is part of the kernel. Windows has nothing comparable
//! that build tools survive, so commands run there as before. The rules and
//! prompts in front of a command are the same with and without the sandbox.
//!
//! This file depends on nothing else of pumr, so the Linux half can be built
//! and run on its own in a container.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::process::Command;

/// How far commands are confined.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mode {
    #[default]
    Off,
    /// Writes and key folders.
    Files,
    /// The same, and no network beyond this machine.
    FilesAndNetwork,
}

impl Mode {
    /// The mode a stored setting names; an unknown one confines files.
    pub fn from_setting(setting: &str) -> Self {
        match setting {
            "off" => Self::Off,
            "filesAndNetwork" => Self::FilesAndNetwork,
            _ => Self::Files,
        }
    }
}

/// The user's sandbox settings.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Config {
    pub mode: Mode,
    /// Folders outside the project that commands may still write to.
    pub writable: Vec<String>,
    /// Folders and files commands may not read.
    pub unreadable: Vec<String>,
    /// Commands that run outside the sandbox, as patterns of the whole line.
    pub excluded: Vec<String>,
}

/// Where build tools keep what they download and compile. Without these a
/// build inside the sandbox fails on its first cache write.
pub fn default_writable() -> Vec<String> {
    let mut folders = vec![
        "~/.cargo",
        "~/.rustup",
        "~/.npm",
        "~/.pnpm-store",
        "~/.yarn",
        "~/.bun",
        "~/.deno",
        "~/.gradle",
        "~/.m2",
        "~/go",
        "~/.cache",
        "~/.local/share/pnpm",
        "~/.local/state",
    ];
    if cfg!(target_os = "macos") {
        folders.extend(["~/Library/Caches", "~/Library/pnpm", "~/Library/Developer"]);
    }
    folders.into_iter().map(str::to_string).collect()
}

/// Where keys and tokens live that a build has no business reading.
pub fn default_unreadable() -> Vec<String> {
    [
        "~/.ssh",
        "~/.aws",
        "~/.gnupg",
        "~/.kube",
        "~/.azure",
        "~/.config/gcloud",
        "~/.config/gh",
        "~/.netrc",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

/// Programs that work with keys of their own, and the entries of
/// `default_unreadable` they keep reading: `git fetch` over SSH would
/// otherwise fail on the user's own key.
const KEY_USERS: &[(&[&str], &[&str])] = &[
    (
        &["git"],
        &["~/.ssh", "~/.gnupg", "~/.netrc", "~/.config/gh"],
    ),
    (
        &["ssh", "scp", "sftp", "rsync", "ssh-add", "ssh-keygen"],
        &["~/.ssh"],
    ),
    (&["gpg", "gpg2"], &["~/.gnupg"]),
    (&["gh"], &["~/.config/gh", "~/.ssh"]),
    (&["aws", "sam", "cdk"], &["~/.aws"]),
    (&["kubectl", "helm", "k9s"], &["~/.kube"]),
    (&["az"], &["~/.azure"]),
    (&["gcloud", "gsutil", "bq"], &["~/.config/gcloud"]),
    (&["curl", "wget"], &["~/.netrc"]),
];

/// What one command may do.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Policy {
    /// Folders the command may write to, with everything below them.
    pub writable: Vec<PathBuf>,
    /// Folders and files the command may not read.
    pub unreadable: Vec<PathBuf>,
    /// Whether it may reach other machines.
    pub network: bool,
}

/// The command a policy is made for.
pub struct Call<'a> {
    pub command: &'a str,
    pub project_root: &'a Path,
    /// The folders the user allowed next to the project, the chat's scratch
    /// folder among them.
    pub folders: &'a [PathBuf],
    /// Folders whose sensitive files the user released for commands.
    pub released: &'a [PathBuf],
    /// The hosts this command contacts are allowed, by a rule or by the
    /// user's answer to its prompt.
    pub network_approved: bool,
}

/// What the sandbox can do on this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Support {
    pub files: bool,
    pub network: bool,
}

pub fn support() -> Support {
    static SUPPORT: OnceLock<Support> = OnceLock::new();
    *SUPPORT.get_or_init(platform::support)
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

/// A path of the settings: absolute, or below the home folder with `~`.
fn expand(setting: &str, home: Option<&Path>) -> Option<PathBuf> {
    let setting = setting.trim();
    if setting == "~" {
        return home.map(Path::to_path_buf);
    }
    if let Some(rest) = setting.strip_prefix("~/") {
        return home.map(|home| home.join(rest));
    }
    let path = Path::new(setting);
    path.is_absolute().then(|| path.to_path_buf())
}

/// The path with its symbolic links resolved, next to the path as given: the
/// kernel judges a file by where it really is (`/tmp` is `/private/tmp`).
fn with_real(path: PathBuf, into: &mut Vec<PathBuf>) {
    let real = path.canonicalize().ok();
    if !into.contains(&path) {
        into.push(path.clone());
    }
    if let Some(real) = real.filter(|real| !into.contains(real)) {
        into.push(real);
    }
}

/// The repository a linked worktree belongs to keeps its objects outside the
/// worktree; `git commit` in the project writes there.
fn git_folders(project_root: &Path) -> Vec<PathBuf> {
    let Ok(pointer) = std::fs::read_to_string(project_root.join(".git")) else {
        return Vec::new();
    };
    let Some(folder) = pointer.trim().strip_prefix("gitdir:") else {
        return Vec::new();
    };
    let folder = project_root.join(folder.trim());
    let mut folders = vec![folder.clone()];
    if let Ok(common) = std::fs::read_to_string(folder.join("commondir")) {
        folders.push(folder.join(common.trim()));
    }
    folders
}

/// Tools that do what their command line says and nothing else: what they
/// read is named on the line, where the permission rules judge it. A line may
/// chain them to a program that keeps its keys, or to a command kept out of
/// the sandbox, without changing how the line is confined.
const PLAIN_TOOLS: &[&str] = &[
    "cd", "pushd", "popd", "echo", "printf", "true", "false", "test", "[", "pwd", "export",
    "unset", "wait", "sleep", "cat", "head", "tail", "grep", "wc", "sort", "uniq", "cut", "tr",
    "tee", "ls", "mkdir", "date",
];

/// Words that only introduce the program after them.
const INTRODUCERS: &[&str] = &["command", "time", "nohup", "exec", "env"];

/// `line` without the bodies of the heredocs whose delimiter is quoted
/// (`<<'EOF'`): the shell hands those on as they are written, so nothing in
/// them runs. A body under a bare delimiter stays, since the shell runs the
/// substitutions in it.
fn without_literal_heredocs(line: &str) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let mut ends: Vec<(String, bool)> = Vec::new();
    for text in line.split('\n') {
        if let Some((end, tabs)) = ends.first() {
            let candidate = if *tabs { text.trim_start_matches('\t') } else { text };
            if candidate.trim_end_matches('\r') == end {
                ends.remove(0);
            }
            continue;
        }
        kept.push(text);
        let mut rest = text;
        while let Some(at) = rest.find("<<") {
            rest = &rest[at + 2..];
            if rest.starts_with('<') {
                // A here-string (`<<<word`) has no body.
                rest = rest.trim_start_matches('<');
                continue;
            }
            let tabs = rest.starts_with('-');
            let word = rest.trim_start_matches('-').trim_start();
            let Some(quote) = word.chars().next().filter(|first| matches!(first, '\'' | '"'))
            else {
                continue;
            };
            if let Some((end, _)) = word[1..].split_once(quote) {
                ends.push((end.to_string(), tabs));
            }
        }
    }
    kept.join("\n")
}

/// The simple commands of a command line: what stands between `;`, `|`, `&&`,
/// line ends and the brackets of subshells and substitutions. A rough reading
/// that errs towards more commands: text in quotes stays together, but a
/// substitution inside double quotes is a command of its own.
fn commands(line: &str) -> Vec<&str> {
    let mut found: Vec<&str> = Vec::new();
    let mut start = 0;
    let mut quote: Option<char> = None;
    let mut previous = ' ';
    let mut characters = line.char_indices().peekable();
    while let Some((index, character)) = characters.next() {
        let ends = match (quote, character) {
            (Some('\''), '\'') | (Some('"'), '"') => {
                quote = None;
                false
            }
            (Some('\''), _) => false,
            (_, '\\') => {
                characters.next();
                false
            }
            (None, '\'' | '"') => {
                quote = Some(character);
                false
            }
            (_, '`') => true,
            (Some(_), '(') => previous == '$',
            (Some(_), ')') => true,
            (Some(_), _) => false,
            (None, ';' | '|' | '\n' | '(' | ')') => true,
            // `2>&1` and `&>log` redirect; any other `&` ends a command.
            (None, '&') => {
                !matches!(previous, '>' | '<')
                    && characters.peek().map_or(true, |(_, next)| *next != '>')
            }
            (None, _) => false,
        };
        if ends {
            found.push(&line[start..index]);
            start = index + character.len_utf8();
        }
        previous = character;
    }
    found.push(&line[start..]);
    found
        .into_iter()
        .map(str::trim)
        .filter(|command| command.chars().any(char::is_alphanumeric))
        .collect()
}

/// Whether `word` sets a variable for the command after it (`CI=1 pnpm e2e`).
fn is_assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| {
        !name.is_empty()
            && !name.starts_with(|first: char| first.is_ascii_digit())
            && name
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
    })
}

/// A simple command from the program it runs on, without the variables set
/// in front of it.
fn bare(command: &str) -> &str {
    let mut rest = command.trim_start();
    while let Some(word) = rest.split_whitespace().next().filter(|word| is_assignment(word)) {
        rest = rest[word.len()..].trim_start();
    }
    rest
}

/// The name of the program a simple command runs.
fn program(command: &str) -> Option<&str> {
    command
        .split_whitespace()
        .find(|word| !is_assignment(word) && !INTRODUCERS.contains(word))
        .map(|word| word.rsplit('/').next().unwrap_or(word))
}

/// The names of the programs a command line runs, one for each of its simple
/// commands. A rough reading is enough here: where it is wrong it names a
/// program too many, and the line is confined the more for it.
fn programs(line: &str) -> Vec<&str> {
    commands(line).into_iter().filter_map(program).collect()
}

/// The entries of `KEY_USERS` that stay readable for a line that runs
/// `programs`: those that every program on the line works with. Next to
/// anything else (`git status && npm test`) none is kept, or whatever the
/// other program starts would read the keys along with it.
fn kept_keys(programs: &[&str]) -> Vec<&'static str> {
    let uses = |program: &str, folder: &str| {
        KEY_USERS
            .iter()
            .any(|(users, folders)| users.contains(&program) && folders.contains(&folder))
    };
    let mut kept: Vec<&'static str> = Vec::new();
    for folder in KEY_USERS.iter().flat_map(|(_, folders)| folders.iter().copied()) {
        let used = programs.iter().any(|program| uses(program, folder));
        let shared = programs
            .iter()
            .all(|program| uses(program, folder) || PLAIN_TOOLS.contains(program));
        if used && shared && !kept.contains(&folder) {
            kept.push(folder);
        }
    }
    kept
}

/// Whether `command` is one the user keeps out of the sandbox: a pattern
/// names one of its simple commands, and the others are plain tools or named
/// as well (`cd app && pnpm e2e 2>&1 | tail -20`). A pattern with `*` has to
/// cover a whole simple command; one without names how it begins. Anything
/// else chained to it (`pnpm e2e && make install`) keeps the line confined.
fn excluded(patterns: &[String], command: &str) -> bool {
    let command = command.trim();
    let patterns: Vec<&str> = patterns
        .iter()
        .map(|pattern| pattern.trim())
        .filter(|pattern| !pattern.is_empty())
        .collect();
    // A line written out in full is the user's word for exactly that line.
    if patterns.contains(&command) {
        return true;
    }
    let named = |command: &str| {
        let command = bare(command);
        patterns.iter().any(|pattern| {
            if pattern.contains('*') {
                globset::Glob::new(pattern)
                    .is_ok_and(|glob| glob.compile_matcher().is_match(command))
            } else {
                command == *pattern
                    || command
                        .strip_prefix(pattern)
                        .is_some_and(|rest| rest.starts_with(char::is_whitespace))
            }
        })
    };
    let line = without_literal_heredocs(command);
    let commands = commands(&line);
    commands.iter().any(|command| named(command))
        && commands.iter().all(|command| {
            named(command) || program(command).is_some_and(|name| PLAIN_TOOLS.contains(&name))
        })
}

impl Config {
    /// What `call` may do, or `None` when it runs unconfined: the sandbox is
    /// off, this machine has none, or the user excluded the command.
    pub fn policy(&self, call: &Call<'_>) -> Option<Policy> {
        if self.mode == Mode::Off || !support().files || excluded(&self.excluded, call.command) {
            return None;
        }
        let home = home();
        let home = home.as_deref();

        let mut writable: Vec<PathBuf> = Vec::new();
        with_real(call.project_root.to_path_buf(), &mut writable);
        for folder in call.folders.iter().cloned().chain(git_folders(call.project_root)) {
            with_real(folder, &mut writable);
        }
        for folder in self.writable.iter().filter_map(|entry| expand(entry, home)) {
            with_real(folder, &mut writable);
        }
        for folder in platform::temp_folders() {
            with_real(folder, &mut writable);
        }

        let line = without_literal_heredocs(call.command);
        let kept: Vec<PathBuf> = kept_keys(&programs(&line))
            .into_iter()
            .filter_map(|folder| expand(folder, home))
            .collect();
        let mut unreadable: Vec<PathBuf> = Vec::new();
        for entry in self.unreadable.iter().filter_map(|entry| expand(entry, home)) {
            let released = call
                .released
                .iter()
                .any(|folder| entry.starts_with(folder) || folder.starts_with(&entry));
            // What the command may write to, it may read.
            let written = writable.iter().any(|folder| entry.starts_with(folder));
            if !released && !written && !kept.contains(&entry) {
                with_real(entry, &mut unreadable);
            }
        }

        Some(Policy {
            writable,
            unreadable,
            network: self.mode != Mode::FilesAndNetwork
                || call.network_approved
                || !support().network,
        })
    }
}

/// Whether what a failed command printed looks like the sandbox stopped it.
pub fn looks_blocked(output: &str, policy: &Policy) -> bool {
    let files = ["Operation not permitted", "Permission denied", "EPERM", "EACCES"];
    let network = [
        "resolve host",
        "ENOTFOUND",
        "EAI_AGAIN",
        "Network is unreachable",
        "Connection refused",
        "network",
    ];
    // A program that brings a sandbox of its own cannot enter it from inside
    // this one, and says so in its own words: a browser loses its helper
    // processes and closes.
    let own_sandbox = [
        "sandbox",
        "gpu process isn't usable",
        "browser has been closed",
    ];
    let lowered = output.to_lowercase();
    files.iter().any(|sign| output.contains(sign))
        || own_sandbox.iter().any(|sign| lowered.contains(sign))
        || (!policy.network && network.iter().any(|sign| output.contains(sign)))
}

/// A shell that runs `script`, confined by `policy` when there is one.
pub fn shell(script: &str, policy: Option<&Policy>) -> Command {
    if cfg!(windows) {
        let mut process = Command::new("cmd");
        process.arg("/C").arg(script);
        return process;
    }
    match policy {
        Some(policy) => platform::shell(script, policy),
        None => {
            let mut process = Command::new("/bin/sh");
            process.arg("-c").arg(script);
            process
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

    pub fn support() -> Support {
        let present = Path::new(SANDBOX_EXEC).is_file();
        Support {
            files: present,
            network: present,
        }
    }

    /// `/tmp`, and the user's own temp and cache folder: `TMPDIR` is its `T`
    /// folder, and compilers keep their caches in the `C` folder next to it.
    pub fn temp_folders() -> Vec<PathBuf> {
        let mut folders = vec![PathBuf::from("/tmp"), PathBuf::from("/var/tmp")];
        let temp = std::env::temp_dir();
        match temp.parent() {
            Some(user) if temp.file_name().is_some_and(|name| name == "T") => {
                folders.push(user.to_path_buf())
            }
            _ => folders.push(temp),
        }
        folders
    }

    fn quoted(path: &Path) -> String {
        format!(
            "\"{}\"",
            path.to_string_lossy()
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
        )
    }

    /// The Seatbelt profile for `policy`. Later rules win over earlier ones,
    /// so each part first denies and then names what stays allowed.
    pub fn profile(policy: &Policy) -> String {
        let mut profile = String::from("(version 1)\n(allow default)\n(deny file-write*)\n");
        profile.push_str("(allow file-write*\n");
        for folder in &policy.writable {
            profile.push_str(&format!("  (subpath {})\n", quoted(folder)));
        }
        // What every program expects of `/dev`: the null device, its own
        // terminal and file descriptors, and new pseudo-terminals.
        profile.push_str(
            "  (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/dtracehelper\")\n  (literal \"/dev/stdout\") (literal \"/dev/stderr\") (literal \"/dev/ptmx\")\n  (regex #\"^/dev/fd/\") (regex #\"^/dev/tty\") (regex #\"^/dev/pty\"))\n",
        );
        if !policy.unreadable.is_empty() {
            profile.push_str("(deny file-read*\n");
            for entry in &policy.unreadable {
                profile.push_str(&format!("  (subpath {})\n", quoted(entry)));
            }
            profile.push_str(")\n");
        }
        if !policy.network {
            // This machine stays reachable, for a dev server and its tests.
            // Names are looked up by a system service behind a socket, which
            // would carry anything out in the names asked for.
            profile.push_str(
                "(deny network*)\n(allow network-outbound (remote ip \"localhost:*\") (remote unix-socket))\n(allow network-inbound (local ip \"localhost:*\") (local unix-socket))\n(allow network-bind (local ip \"localhost:*\") (local unix-socket))\n(deny network-outbound (remote unix-socket (path-literal \"/private/var/run/mDNSResponder\")))\n",
            );
        }
        profile
    }

    pub fn shell(script: &str, policy: &Policy) -> Command {
        let mut process = Command::new(SANDBOX_EXEC);
        process
            .arg("-p")
            .arg(profile(policy))
            .arg("/bin/sh")
            .arg("-c")
            .arg(script);
        process
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;

    // The kernel's Landlock interface (linux/landlock.h).
    const CREATE_RULESET_VERSION: u32 = 1;
    const RULE_PATH_BENEATH: libc::c_int = 1;

    const WRITE_FILE: u64 = 1 << 1;
    const READ_FILE: u64 = 1 << 2;
    const REMOVE_DIR: u64 = 1 << 4;
    const REMOVE_FILE: u64 = 1 << 5;
    const MAKE_CHAR: u64 = 1 << 6;
    const MAKE_DIR: u64 = 1 << 7;
    const MAKE_REG: u64 = 1 << 8;
    const MAKE_SOCK: u64 = 1 << 9;
    const MAKE_FIFO: u64 = 1 << 10;
    const MAKE_BLOCK: u64 = 1 << 11;
    const MAKE_SYM: u64 = 1 << 12;
    /// Moving a file to another folder. Since ABI 2; before it, a sandboxed
    /// program could not do that at all.
    const REFER: u64 = 1 << 13;
    /// Since ABI 3.
    const TRUNCATE: u64 = 1 << 14;

    /// The oldest interface the sandbox works with (Linux 5.19): build tools
    /// move files between folders all the time.
    const MIN_ABI: i64 = 2;

    #[repr(C)]
    struct RulesetAttr {
        handled_access_fs: u64,
    }

    #[repr(C, packed)]
    struct PathBeneathAttr {
        allowed_access: u64,
        parent_fd: libc::c_int,
    }

    /// The version of the kernel's Landlock interface, or 0 without it.
    fn abi() -> i64 {
        // SAFETY: with a null attribute, size 0 and this flag the call only
        // reports the version.
        let version = unsafe {
            libc::syscall(
                libc::SYS_landlock_create_ruleset,
                std::ptr::null::<RulesetAttr>(),
                0usize,
                CREATE_RULESET_VERSION,
            )
        };
        version.max(0)
    }

    pub fn support() -> Support {
        Support {
            files: abi() >= MIN_ABI,
            // Landlock tells TCP ports apart, not this machine from others.
            network: false,
        }
    }

    pub fn temp_folders() -> Vec<PathBuf> {
        let mut folders = vec![
            PathBuf::from("/tmp"),
            PathBuf::from("/var/tmp"),
            // POSIX shared memory and semaphores.
            PathBuf::from("/dev/shm"),
            std::env::temp_dir(),
        ];
        // Sockets of the user's session services (gpg-agent, D-Bus).
        if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR").filter(|dir| !dir.is_empty()) {
            folders.push(PathBuf::from(runtime));
        }
        folders
    }

    /// What may be written, by the interface version.
    fn write_rights(abi: i64) -> u64 {
        let mut rights = WRITE_FILE
            | REMOVE_DIR
            | REMOVE_FILE
            | MAKE_CHAR
            | MAKE_DIR
            | MAKE_REG
            | MAKE_SOCK
            | MAKE_FIFO
            | MAKE_BLOCK
            | MAKE_SYM
            | REFER;
        if abi >= 3 {
            rights |= TRUNCATE;
        }
        rights
    }

    /// The rights that apply to a file that is no folder.
    const FILE_RIGHTS: u64 = WRITE_FILE | READ_FILE | TRUNCATE;

    /// A ruleset being put together, with the rights it rules on. A rule may
    /// only name rights among those, or the kernel refuses it.
    struct Rules {
        ruleset: OwnedFd,
        handled: u64,
    }

    fn allow(rules: &Rules, path: &Path, rights: u64) {
        let ruleset = &rules.ruleset;
        let rights = rights & rules.handled;
        let Ok(name) = CString::new(path.as_os_str().as_bytes()) else {
            return;
        };
        // SAFETY: `name` is a valid C string for the duration of the call.
        let opened = unsafe { libc::open(name.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
        if opened < 0 {
            // Not there (a cache folder of a tool that is not installed).
            return;
        }
        // SAFETY: `opened` is a file descriptor this function owns.
        let opened = unsafe { OwnedFd::from_raw_fd(opened) };
        let rights = if path.is_dir() {
            rights
        } else {
            rights & FILE_RIGHTS
        };
        if rights == 0 {
            return;
        }
        let rule = PathBeneathAttr {
            allowed_access: rights,
            parent_fd: opened.as_raw_fd(),
        };
        // SAFETY: `rule` matches the kernel's `landlock_path_beneath_attr`
        // and both descriptors are open.
        unsafe {
            libc::syscall(
                libc::SYS_landlock_add_rule,
                ruleset.as_raw_fd(),
                RULE_PATH_BENEATH,
                &rule as *const PathBeneathAttr,
                0u32,
            );
        }
    }

    /// Landlock only knows what is allowed. To keep `unreadable` closed,
    /// reading is allowed for everything next to it: a folder with nothing
    /// unreadable below it as a whole, any other entry by entry.
    fn allow_reading_around(rules: &Rules, folder: &Path, unreadable: &[PathBuf]) {
        if !unreadable.iter().any(|entry| entry.starts_with(folder)) {
            allow(rules, folder, READ_FILE);
            return;
        }
        let Ok(entries) = std::fs::read_dir(folder) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            // The kernel judges a file by where it really is, and this walk
            // gets there too: a link needs no rule of its own, and gets none
            // that would open what it points at.
            if kind.is_symlink() || unreadable.iter().any(|closed| path.starts_with(closed)) {
                continue;
            }
            if kind.is_dir() {
                allow_reading_around(rules, &path, unreadable);
            } else {
                allow(rules, &path, READ_FILE);
            }
        }
    }

    /// The Landlock ruleset for `policy`, ready to be entered by a child.
    fn ruleset(policy: &Policy) -> std::io::Result<OwnedFd> {
        let abi = abi();
        let write = write_rights(abi);
        let closes_reading = !policy.unreadable.is_empty();
        let handled = write | if closes_reading { READ_FILE } else { 0 };
        let attr = RulesetAttr {
            handled_access_fs: handled,
        };
        // SAFETY: `attr` matches the start of the kernel's
        // `landlock_ruleset_attr`, and the size passed is its own.
        let created = unsafe {
            libc::syscall(
                libc::SYS_landlock_create_ruleset,
                &attr as *const RulesetAttr,
                std::mem::size_of::<RulesetAttr>(),
                0u32,
            )
        };
        if created < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: the kernel returned a new descriptor that nothing else owns.
        let ruleset = unsafe { OwnedFd::from_raw_fd(created as libc::c_int) };
        let rules = Rules { ruleset, handled };

        if closes_reading {
            allow_reading_around(&rules, Path::new("/"), &policy.unreadable);
        }
        for folder in &policy.writable {
            allow(&rules, folder, write | READ_FILE);
        }
        // Devices are files to write to, not folders to fill; `/proc` holds
        // a program's own settings.
        allow(&rules, Path::new("/dev"), WRITE_FILE);
        allow(&rules, Path::new("/proc"), WRITE_FILE);
        Ok(rules.ruleset)
    }

    pub fn shell(script: &str, policy: &Policy) -> Command {
        let mut process = Command::new("/bin/sh");
        process.arg("-c").arg(script);
        let ruleset = ruleset(policy);
        // SAFETY: the closure runs in the child between fork and exec and
        // makes two system calls, with nothing allocated or locked.
        unsafe {
            process.pre_exec(move || {
                let ruleset = match &ruleset {
                    Ok(ruleset) => ruleset.as_raw_fd(),
                    // A command that should be confined does not run
                    // unconfined.
                    Err(error) => return Err(std::io::Error::from(error.kind())),
                };
                if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
                    || libc::syscall(libc::SYS_landlock_restrict_self, ruleset, 0u32) != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        process
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod platform {
    use super::*;

    pub fn support() -> Support {
        Support {
            files: false,
            network: false,
        }
    }

    pub fn temp_folders() -> Vec<PathBuf> {
        Vec::new()
    }

    pub fn shell(script: &str, _policy: &Policy) -> Command {
        super::shell(script, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(mode: Mode) -> Config {
        Config {
            mode,
            writable: Vec::new(),
            unreadable: Vec::new(),
            excluded: Vec::new(),
        }
    }

    fn call<'a>(command: &'a str, project_root: &'a Path) -> Call<'a> {
        Call {
            command,
            project_root,
            folders: &[],
            released: &[],
            network_approved: false,
        }
    }

    #[test]
    fn a_stored_setting_names_its_mode() {
        assert_eq!(Mode::from_setting("off"), Mode::Off);
        assert_eq!(Mode::from_setting("filesAndNetwork"), Mode::FilesAndNetwork);
        assert_eq!(Mode::from_setting("files"), Mode::Files);
        // A value from a newer version confines rather than not.
        assert_eq!(Mode::from_setting("strict"), Mode::Files);
    }

    #[test]
    fn settings_paths_are_absolute_or_below_home() {
        let home = Path::new("/home/puma");
        assert_eq!(expand("~/.ssh", Some(home)), Some(home.join(".ssh")));
        assert_eq!(expand(" ~ ", Some(home)), Some(home.to_path_buf()));
        assert_eq!(expand("/opt/cache", Some(home)), Some(PathBuf::from("/opt/cache")));
        assert_eq!(expand("relative/cache", Some(home)), None);
        assert_eq!(expand("~/.ssh", None), None);
    }

    #[test]
    fn a_command_line_names_its_programs() {
        assert_eq!(
            programs("cd app && /usr/bin/git fetch | tee log; (ssh host)"),
            ["cd", "git", "tee", "ssh"]
        );
        // A word that only looks like a program is none: an argument, a
        // variable set for the command, text in quotes.
        assert_eq!(programs("ls src/git"), ["ls"]);
        assert_eq!(
            programs("CI=1 env FOO=bar pnpm e2e 2>&1 | tail -20"),
            ["pnpm", "tail"]
        );
        assert_eq!(programs("echo 'git; ssh' \"a | b\" &"), ["echo"]);
        // What a substitution runs is a program of the line, also in quotes.
        assert_eq!(
            programs("echo \"$(make test)\" `id`"),
            ["echo", "make", "id"]
        );
    }

    #[test]
    fn only_a_literal_heredoc_body_is_left_out_of_the_reading() {
        let commit = "git commit -m \"$(cat <<'EOF'\nFix it; rm -rf x\n$(npm run evil)\nEOF\n)\"";
        assert_eq!(programs(&without_literal_heredocs(commit)), ["git", "cat"]);
        // Under a bare delimiter the shell runs what the body substitutes.
        let bare = "git commit -F - <<EOF\n$(npm run evil)\nEOF";
        assert!(programs(&without_literal_heredocs(bare)).contains(&"npm"));
    }

    #[test]
    fn keys_stay_readable_only_for_a_line_of_their_own_programs() {
        let ssh = "~/.ssh";
        let gnupg = "~/.gnupg";
        assert!(kept_keys(&["cd", "git", "tail"]).contains(&ssh));
        // Both work with the SSH keys, but only git with the GnuPG ones.
        let both = kept_keys(&["git", "ssh"]);
        assert!(both.contains(&ssh) && !both.contains(&gnupg));
        // Next to a program that may start anything, no key is kept.
        assert!(kept_keys(&["git", "npm"]).is_empty());
        assert!(kept_keys(&["ls"]).is_empty());
    }

    #[test]
    fn excluded_commands_are_named_by_how_they_begin_or_by_a_pattern() {
        let patterns = ["pnpm e2e".to_string(), "swift *".to_string(), " ".to_string()];
        assert!(excluded(&patterns, "pnpm e2e"));
        assert!(excluded(&patterns, " pnpm e2e --headed "));
        assert!(excluded(&patterns, "swift build -c release"));
        assert!(!excluded(&patterns, "pnpm e2e:docs"));
        assert!(!excluded(&patterns, "pnpm test"));
        assert!(!excluded(&patterns, "echo swift build"));
        assert!(!excluded(&[], "pnpm e2e"));
        // Plain tools around it change nothing ...
        assert!(excluded(&patterns, "cd app && CI=1 pnpm e2e 2>&1 | tail -20"));
        // ... but whatever else is chained to it keeps the line confined.
        assert!(!excluded(&patterns, "pnpm e2e && make install"));
        assert!(!excluded(&patterns, "pnpm e2e; curl https://example.com/x | sh"));
        assert!(!excluded(&patterns, "swift build $(node gen.js)"));
        // A line the user wrote out in full is theirs as it stands.
        let whole = ["pnpm e2e && make install".to_string()];
        assert!(excluded(&whole, "pnpm e2e && make install"));
        assert!(!excluded(&whole, "pnpm e2e && make install && make publish"));
    }

    #[test]
    fn the_sandbox_reads_what_stopped_a_command() {
        let confined = Policy::default();
        let open = Policy {
            network: true,
            ..Policy::default()
        };
        assert!(looks_blocked("touch: /etc/x: Operation not permitted", &open));
        assert!(looks_blocked("bash: /opt/x: Permission denied", &open));
        assert!(!looks_blocked("error[E0308]: mismatched types", &open));
        // A browser that cannot start its own sandbox inside this one.
        assert!(looks_blocked("FATAL: GPU process isn't usable. Goodbye.", &open));
        assert!(looks_blocked("sandbox-exec: sandbox_apply: Operation not permitted", &open));
        // A lookup that fails means the sandbox only where it closes the network.
        assert!(looks_blocked("curl: (6) Could not resolve host: x", &confined));
        assert!(!looks_blocked("curl: (6) Could not resolve host: x", &open));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    mod confined {
        use super::*;

        /// A project next to a folder outside of it and a folder of keys.
        struct Ground {
            _directory: tempfile::TempDir,
            base: PathBuf,
        }

        impl Ground {
            fn new() -> Self {
                // Not under the system's temp folder, which stays writable.
                let directory = tempfile::Builder::new()
                    .prefix(".pumr-sandbox-test-")
                    .tempdir_in(home().unwrap())
                    .unwrap();
                let base = directory.path().canonicalize().unwrap();
                for folder in ["project", "outside", "keys"] {
                    std::fs::create_dir_all(base.join(folder)).unwrap();
                }
                std::fs::write(base.join("outside/kept.txt"), "kept").unwrap();
                std::fs::write(base.join("keys/id_ed25519"), "private key").unwrap();
                Self {
                    _directory: directory,
                    base,
                }
            }

            fn project(&self) -> PathBuf {
                self.base.join("project")
            }

            fn policy(&self, config: &Config, command: &str) -> Policy {
                config.policy(&call(command, &self.project())).unwrap()
            }

            /// Runs `script` in the project under `policy`; its exit code and
            /// what it printed.
            async fn run(&self, script: &str, policy: Option<&Policy>) -> (i32, String) {
                let output = shell(script, policy)
                    .current_dir(self.project())
                    .output()
                    .await
                    .unwrap();
                let printed = format!(
                    "{}{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                (output.status.code().unwrap_or(-1), printed)
            }
        }

        #[tokio::test]
        async fn a_command_writes_inside_the_project_and_nowhere_else() {
            if !support().files {
                return;
            }
            let ground = Ground::new();
            let policy = ground.policy(&config(Mode::Files), "make test");
            assert!(policy.network);

            let (code, printed) = ground
                .run("mkdir -p src && echo done > src/out.txt && cat src/out.txt", Some(&policy))
                .await;
            assert_eq!((code, printed.as_str()), (0, "done\n"));
            let (code, _) = ground
                .run("echo ok > \"${TMPDIR:-/tmp}/pumr-sandbox-probe\" && rm \"${TMPDIR:-/tmp}/pumr-sandbox-probe\" && echo x > /dev/null", Some(&policy))
                .await;
            assert_eq!(code, 0);

            for script in [
                "echo changed > ../outside/kept.txt",
                "rm ../outside/kept.txt",
                "echo new > ../outside/new.txt",
                "mv src/out.txt ../outside/out.txt",
                "touch ~/.pumr-sandbox-must-not-exist",
            ] {
                let (code, printed) = ground.run(script, Some(&policy)).await;
                assert_ne!(code, 0, "{script}: {printed}");
                assert!(looks_blocked(&printed, &policy), "{script}: {printed}");
            }
            assert_eq!(
                std::fs::read_to_string(ground.base.join("outside/kept.txt")).unwrap(),
                "kept"
            );
            assert!(!ground.base.join("outside/new.txt").exists());
            assert!(!home().unwrap().join(".pumr-sandbox-must-not-exist").exists());
            // Reading outside the project stays possible.
            let (code, printed) = ground.run("cat ../outside/kept.txt", Some(&policy)).await;
            assert_eq!((code, printed.as_str()), (0, "kept"));
        }

        #[tokio::test]
        async fn a_command_cannot_read_a_folder_of_keys() {
            if !support().files {
                return;
            }
            let ground = Ground::new();
            let keys = ground.base.join("keys");
            let mut config = config(Mode::Files);
            config.unreadable = vec![keys.display().to_string()];

            let policy = ground.policy(&config, "npm test");
            let (code, printed) = ground.run("cat ../keys/id_ed25519", Some(&policy)).await;
            assert_ne!(code, 0, "{printed}");
            assert!(!printed.contains("private key"), "{printed}");
            // What lies next to the keys is read as before.
            let (code, printed) = ground.run("cat ../outside/kept.txt", Some(&policy)).await;
            assert_eq!((code, printed.as_str()), (0, "kept"));

            // A folder the user released for commands is open again.
            let released = [keys.clone()];
            let open = config
                .policy(&Call {
                    released: &released,
                    ..call("npm test", &ground.project())
                })
                .unwrap();
            assert!(open.unreadable.is_empty());
            let (code, printed) = ground.run("cat ../keys/id_ed25519", Some(&open)).await;
            assert_eq!((code, printed.as_str()), (0, "private key"));
        }

        #[test]
        fn git_and_ssh_keep_the_keys_they_work_with() {
            if !support().files {
                return;
            }
            let ground = Ground::new();
            let mut config = config(Mode::Files);
            config.unreadable = default_unreadable();
            let ssh = home().unwrap().join(".ssh");
            let aws = home().unwrap().join(".aws");

            let build = ground.policy(&config, "npm run build");
            assert!(build.unreadable.contains(&ssh) && build.unreadable.contains(&aws));
            let fetch = ground.policy(&config, "cd app && git fetch origin");
            assert!(!fetch.unreadable.contains(&ssh));
            assert!(fetch.unreadable.contains(&aws));
            let deploy = ground.policy(&config, "aws s3 sync dist s3://bucket");
            assert!(!deploy.unreadable.contains(&aws));
            assert!(deploy.unreadable.contains(&ssh));
        }

        #[tokio::test]
        async fn the_extra_folders_and_tool_caches_stay_writable() {
            if !support().files {
                return;
            }
            let ground = Ground::new();
            let cache = ground.base.join("outside");
            let mut config = config(Mode::Files);
            config.writable = vec![cache.display().to_string()];
            let policy = ground.policy(&config, "cargo build");
            let (code, printed) = ground.run("echo crate > ../outside/new.txt", Some(&policy)).await;
            assert_eq!(code, 0, "{printed}");

            let folders = [ground.base.join("keys")];
            let policy = config
                .policy(&Call {
                    folders: &folders,
                    ..call("cargo build", &ground.project())
                })
                .unwrap();
            let (code, printed) = ground.run("echo note > ../keys/note.txt", Some(&policy)).await;
            assert_eq!(code, 0, "{printed}");
        }

        #[tokio::test]
        async fn what_a_command_starts_is_confined_with_it() {
            if !support().files {
                return;
            }
            let ground = Ground::new();
            let policy = ground.policy(&config(Mode::Files), "make test");
            std::fs::write(
                ground.project().join("script.sh"),
                "#!/bin/sh\n(echo late > ../outside/late.txt) &\nwait\n",
            )
            .unwrap();
            let (_, printed) = ground.run("sh script.sh", Some(&policy)).await;
            assert!(!ground.base.join("outside/late.txt").exists(), "{printed}");
        }

        #[test]
        fn off_and_excluded_commands_run_unconfined() {
            let ground = Ground::new();
            let project = ground.project();
            assert_eq!(config(Mode::Off).policy(&call("make", &project)), None);
            let mut config = config(Mode::Files);
            config.excluded = vec!["pnpm e2e".to_string()];
            assert_eq!(config.policy(&call("pnpm e2e --ui", &project)), None);
            assert_eq!(config.policy(&call("pnpm test", &project)).is_some(), support().files);
        }

        #[cfg(target_os = "macos")]
        #[tokio::test]
        async fn the_network_mode_leaves_only_this_machine_reachable() {
            let ground = Ground::new();
            let confined = ground.policy(&config(Mode::FilesAndNetwork), "npm test");
            assert!(!confined.network);
            // A server on this machine answers; nothing is asked of the
            // network to find that out.
            let (code, printed) = ground
                .run(
                    "python3 -m http.server 48631 --bind 127.0.0.1 >/dev/null 2>&1 & sleep 1; curl -s -m 3 -o /dev/null -w '%{http_code}' http://localhost:48631/; kill $!",
                    Some(&confined),
                )
                .await;
            assert_eq!((code, printed.as_str()), (0, "200"));
            // An address elsewhere is refused without a packet leaving.
            let (code, printed) = ground
                .run("curl -s -m 3 -o /dev/null http://192.0.2.1/ ; echo $?", Some(&confined))
                .await;
            assert_eq!(code, 0);
            assert_eq!(printed.trim(), "7", "{printed}");
            let profile = platform::profile(&confined);
            assert!(profile.contains("(deny network*)"));

            // A command whose hosts are allowed keeps the network.
            let approved = config(Mode::FilesAndNetwork)
                .policy(&Call {
                    network_approved: true,
                    ..call("curl https://example.com", &ground.project())
                })
                .unwrap();
            assert!(approved.network);
            assert!(!platform::profile(&approved).contains("network"));
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn a_path_with_a_quote_cannot_leave_its_place_in_the_profile() {
            let policy = Policy {
                writable: vec![PathBuf::from("/tmp/a\"b\\c")],
                unreadable: Vec::new(),
                network: true,
            };
            assert!(platform::profile(&policy).contains("(subpath \"/tmp/a\\\"b\\\\c\")"));
        }
    }
}
