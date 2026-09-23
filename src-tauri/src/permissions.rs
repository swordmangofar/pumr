use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;

/// Directories that hold generated or third-party content.
pub const GENERATED_DIRS: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "target",
    ".next",
    ".nuxt",
    "out",
    "coverage",
    ".cache",
    "tmp",
    ".turbo",
    ".parcel-cache",
    "__pycache__",
    ".venv",
    "venv",
    "vendor",
    ".svelte-kit",
    ".angular",
    ".gradle",
    "Pods",
    "DerivedData",
    ".dart_tool",
    ".tox",
    ".eggs",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
];

/// Generated files (logs, compiled output, caches) that the agent skips while
/// `scan_generated_files` is off.
const GENERATED_FILE_SUFFIXES: &[&str] = &[
    ".log",
    ".pyc",
    ".pyo",
    ".class",
    ".o",
    ".obj",
    ".dll",
    ".so",
    ".dylib",
    ".exe",
    ".map",
    ".min.js",
    ".min.css",
    ".eslintcache",
    ".stylelintcache",
];

const DATABASE_EXTENSIONS: &[&str] = &[
    ".db",
    ".db3",
    ".sqlite",
    ".sqlite3",
    ".sqlite-wal",
    ".sqlite-shm",
    ".realm",
    ".mdb",
    ".accdb",
    ".ldb",
    ".dbf",
    ".duckdb",
    ".mdf",
];

const ENV_EXAMPLE_MARKERS: &[&str] = &["example", "sample", "template", "dist", "defaults"];

/// File endings that usually carry secrets, credentials or local databases.
const SENSITIVE_SUFFIXES: &[&str] = &[
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".jks",
    ".keystore",
    ".der",
    ".ppk",
    ".asc",
    ".gpg",
    ".kdbx",
    ".keychain",
    ".ovpn",
    ".mobileconfig",
    ".db",
    ".sqlite",
    ".sqlite3",
    ".sqlite-wal",
    ".sqlite-shm",
    ".realm",
    ".mdb",
    ".accdb",
    ".ldb",
    ".dbf",
    ".duckdb",
    ".mdf",
    ".tfvars",
    ".tfstate",
];

/// File name prefixes that mark private keys or credential bundles.
const SENSITIVE_PREFIXES: &[&str] = &[
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "id_dsa",
    "gha-creds-",
];

/// Substrings that are a strong hint of secrets regardless of extension.
const SENSITIVE_NAME_PARTS: &[&str] = &[
    "credential",
    "secret",
    "serviceaccount",
    "service-account",
    "password",
    "tfstate",
];

/// Well-known credential or token files.
const SENSITIVE_NAMES: &[&str] = &[
    ".npmrc",
    ".pypirc",
    ".netrc",
    "_netrc",
    ".git-credentials",
    ".htpasswd",
    ".pgpass",
    ".vault-token",
    ".sentryclirc",
    "token.json",
    "secrets.json",
    "secrets.yaml",
    "secrets.yml",
];

/// Directories that hold credentials or repository internals.
const SENSITIVE_DIRS: &[&str] = &[
    ".ssh", ".aws", ".gnupg", ".git", ".gcloud", ".azure", ".kube", ".docker",
];

const READ_ONLY_PROGRAMS: &[&str] = &[
    "ls", "pwd", "cat", "head", "tail", "wc", "file", "stat", "tree", "find", "grep", "rg", "ag",
    "fd", "which", "whoami", "date", "du", "df", "env", "printenv", "sort", "uniq", "cut", "awk",
    "sed", "jq", "echo", "printf", "basename", "dirname", "realpath", "readlink", "diff", "cmp",
    "node", "python", "python3", "cargo", "rustc", "go", "java", "tsc", "git",
];

const READ_ONLY_GIT_SUBCOMMANDS: &[&str] = &[
    "status",
    "log",
    "diff",
    "show",
    "branch",
    "remote",
    "rev-parse",
    "ls-files",
    "blame",
    "describe",
    "shortlog",
    "tag",
    "config",
    "check-ignore",
];

const DANGEROUS_PROGRAMS: &[&str] = &[
    "rm",
    "rmdir",
    "unlink",
    "shred",
    "dd",
    "mkfs",
    "fdisk",
    "diskutil",
    "sudo",
    "su",
    "doas",
    "shutdown",
    "reboot",
    "halt",
    "kill",
    "pkill",
    "killall",
    "chmod",
    "chown",
    "chgrp",
    "mv",
    "truncate",
    "launchctl",
    "systemctl",
    "defaults",
    "nvram",
    "csrutil",
];

/// Dangerous programs whose risk is limited to the file paths they receive.
/// When every path is inside the project and none is sensitive, they are
/// allowed without asking. Everything else dangerous always asks.
///
/// Note `find` and `xargs` are deliberately absent: their danger comes from
/// flags (`-delete`, `-exec`, `rm`), not from the paths they touch, so they
/// must go through the flag-aware `danger_reason` check instead.
const PATH_DANGEROUS_PROGRAMS: &[&str] = &[
    "rm", "rmdir", "unlink", "shred", "chmod", "chown", "chgrp", "mv", "truncate",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandDecision {
    Allow,
    Ask {
        reason: String,
        suggested_rule: String,
    },
}

impl CommandDecision {
    #[allow(dead_code)]
    pub fn is_ask(&self) -> bool {
        matches!(self, Self::Ask { .. })
    }
}

/// Shared, live permission configuration. Running turns read from this so a
/// rule, folder or website granted with "allow always" applies immediately,
/// including to subagents that are already in flight.
#[derive(Debug, Default)]
pub struct LivePermissions {
    command_rules: RwLock<Vec<String>>,
    extra_folders: RwLock<Vec<String>>,
    /// Folders granted with "allow once" on a folder prompt. These live for the
    /// current app session only and are never written to settings, so they
    /// disappear on restart.
    session_folders: RwLock<Vec<String>>,
    allowed_websites: RwLock<Vec<String>>,
    denied_websites: RwLock<Vec<String>>,
}

impl LivePermissions {
    pub fn new(
        command_rules: Vec<String>,
        extra_folders: Vec<String>,
        allowed_websites: Vec<String>,
        denied_websites: Vec<String>,
    ) -> Self {
        Self {
            command_rules: RwLock::new(command_rules),
            extra_folders: RwLock::new(extra_folders),
            session_folders: RwLock::new(Vec::new()),
            allowed_websites: RwLock::new(allowed_websites),
            denied_websites: RwLock::new(denied_websites),
        }
    }

    pub fn replace(
        &self,
        command_rules: Vec<String>,
        extra_folders: Vec<String>,
        allowed_websites: Vec<String>,
        denied_websites: Vec<String>,
    ) {
        *self.command_rules.write().unwrap() = command_rules;
        *self.extra_folders.write().unwrap() = extra_folders;
        // Session-only folders deliberately survive a settings save: they were
        // granted for the whole app session, not persisted to disk.
        *self.allowed_websites.write().unwrap() = allowed_websites;
        *self.denied_websites.write().unwrap() = denied_websites;
    }

    pub fn command_rules(&self) -> Vec<String> {
        self.command_rules.read().unwrap().clone()
    }

    /// Grants a folder for the current app session only. Used when the user
    /// picks "allow once" on a folder prompt: the folder and everything under
    /// it stay available until the app restarts.
    pub fn add_session_folder(&self, folder: &str) {
        let folder = folder.trim();
        if folder.is_empty() {
            return;
        }
        let mut session = self.session_folders.write().unwrap();
        if !session.iter().any(|entry| entry == folder) {
            session.push(folder.to_string());
        }
    }

    pub fn extra_folders(&self) -> Vec<PathBuf> {
        let mut folders: Vec<PathBuf> = self
            .extra_folders
            .read()
            .unwrap()
            .iter()
            .map(PathBuf::from)
            .collect();
        for folder in self.session_folders.read().unwrap().iter() {
            let path = PathBuf::from(folder);
            if !folders.contains(&path) {
                folders.push(path);
            }
        }
        folders
    }

    pub fn allowed_websites(&self) -> Vec<String> {
        self.allowed_websites.read().unwrap().clone()
    }

    pub fn denied_websites(&self) -> Vec<String> {
        self.denied_websites.read().unwrap().clone()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebsiteDecision {
    Allow,
    Deny {
        reason: String,
    },
    Ask {
        reason: String,
        suggested_rule: String,
    },
}

impl WebsiteDecision {
    #[allow(dead_code)]
    pub fn is_ask(&self) -> bool {
        matches!(self, Self::Ask { .. })
    }
}

/// Decide whether the agent may contact a website. Deny rules always win, then
/// allow rules, otherwise the user is asked. Rules are globs matched against the
/// host (e.g. `example.com`, `*.example.com`, `docs.*`).
pub fn evaluate_website(host: &str, allowed: &[String], denied: &[String]) -> WebsiteDecision {
    let host = host.trim().trim_end_matches('.').to_lowercase();
    if host.is_empty() {
        return WebsiteDecision::Deny {
            reason: "The URL does not contain a valid host.".to_string(),
        };
    }
    if domain_matches_any(&host, denied) {
        return WebsiteDecision::Deny {
            reason: format!("{host} is on the always-deny list."),
        };
    }
    if domain_matches_any(&host, allowed) {
        return WebsiteDecision::Allow;
    }
    WebsiteDecision::Ask {
        reason: format!("The assistant wants to visit {host}."),
        suggested_rule: host,
    }
}

fn domain_matches_any(host: &str, rules: &[String]) -> bool {
    rules.iter().any(|rule| domain_matches(host, rule))
}

fn domain_matches(host: &str, rule: &str) -> bool {
    let rule = rule.trim().to_lowercase();
    if rule.is_empty() {
        return false;
    }
    if glob_matches(host, &rule) {
        return true;
    }
    // A plain `example.com` rule also covers its subdomains.
    if !rule.contains('*') && !host.is_empty() {
        return glob_matches(host, &format!("*.{rule}"));
    }
    false
}

fn glob_matches(value: &str, pattern: &str) -> bool {
    Glob::new(pattern)
        .map(|glob| glob.compile_matcher().is_match(value))
        .unwrap_or(false)
}

pub fn evaluate_command(
    command: &str,
    project_root: &Path,
    extra_folders: &[PathBuf],
    rules: &[String],
) -> CommandDecision {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return CommandDecision::Allow;
    }
    let tokens = shell_words::split(trimmed).unwrap_or_default();
    if tokens.is_empty() {
        return CommandDecision::Allow;
    }
    let program = base_name(&tokens[0]);
    let danger = danger_reason(trimmed, &tokens);
    let dangerous = danger.is_some();
    let suggested_rule = suggest_rule(trimmed, &program);

    if !dangerous && matches_rules(trimmed, rules) {
        return CommandDecision::Allow;
    }

    let path_tokens = candidate_paths(&tokens, dangerous);
    let mut outside: Vec<String> = Vec::new();
    let mut sensitive: Vec<String> = Vec::new();

    for token in &path_tokens {
        let absolute = resolve_path(project_root, token);
        if !path_is_inside(&absolute, project_root, extra_folders) {
            outside.push(token.clone());
            continue;
        }
        let relative = relative_path(&absolute, project_root, extra_folders);
        if is_sensitive(&absolute) {
            sensitive.push(relative);
        }
    }

    if !outside.is_empty() {
        return ask(
            format!(
                "Command touches paths outside the project: {}",
                preview(&outside)
            ),
            suggested_rule,
        );
    }
    if !sensitive.is_empty() {
        return ask(
            format!("Command touches sensitive files: {}", preview(&sensitive)),
            suggested_rule,
        );
    }

    if dangerous {
        if PATH_DANGEROUS_PROGRAMS.contains(&program.as_str()) && !path_tokens.is_empty() {
            return CommandDecision::Allow;
        }
        return ask(
            danger.unwrap_or_else(|| "Command needs approval".to_string()),
            suggested_rule,
        );
    }
    if is_read_only(&program, &tokens) {
        return CommandDecision::Allow;
    }
    ask(
        danger.unwrap_or_else(|| format!("Command '{program}' requires approval")),
        suggested_rule,
    )
}

fn ask(reason: String, suggested_rule: String) -> CommandDecision {
    CommandDecision::Ask {
        reason,
        suggested_rule,
    }
}

pub fn matches_rules(command: &str, rules: &[String]) -> bool {
    let mut builder = GlobSetBuilder::new();
    let mut any = false;
    for rule in rules {
        let rule = rule.trim();
        if rule.is_empty() {
            continue;
        }
        if let Ok(glob) = Glob::new(rule) {
            builder.add(glob);
            any = true;
        }
    }
    if !any {
        return false;
    }
    builder
        .build()
        .map(|set| set.is_match(command))
        .unwrap_or(false)
}

pub fn suggest_rule(command: &str, program: &str) -> String {
    let trimmed = command.trim();
    if trimmed.chars().count() <= 40 && !trimmed.contains('\n') {
        return trimmed.to_string();
    }
    format!("{program} *")
}

fn base_name(program: &str) -> String {
    Path::new(program)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| program.to_string())
}

fn danger_reason(command: &str, tokens: &[String]) -> Option<String> {
    let program = base_name(&tokens[0]);
    if DANGEROUS_PROGRAMS.contains(&program.as_str()) {
        return Some(format!("'{program}' can delete or damage files"));
    }
    match program.as_str() {
        "git" => {
            let sub = tokens.get(1).map(String::as_str).unwrap_or("");
            let rest = tokens.get(2..).unwrap_or(&[]);
            let has = |flag: &str| rest.iter().any(|token| token == flag);
            match sub {
                "reset" if has("--hard") => Some("git reset --hard discards changes".to_string()),
                "clean" => Some("git clean deletes untracked files".to_string()),
                "push" if has("-f") || has("--force") || has("--force-with-lease") => {
                    Some("force push rewrites remote history".to_string())
                }
                "checkout" if has("--") || has("-f") => {
                    Some("git checkout discards working tree changes".to_string())
                }
                "restore" => Some("git restore discards working tree changes".to_string()),
                "branch" if has("-D") || has("-d") => {
                    Some("git branch deletes a branch".to_string())
                }
                "filter-branch" => Some("git filter-branch rewrites history".to_string()),
                "stash" if has("drop") || has("clear") => {
                    Some("git stash drops changes".to_string())
                }
                _ => None,
            }
        }
        "find" => {
            if tokens
                .iter()
                .any(|token| token == "-delete" || token.starts_with("-exec"))
            {
                Some("find with -delete/-exec can remove or run arbitrary commands".to_string())
            } else {
                None
            }
        }
        "xargs" => {
            if tokens.iter().any(|token| token == "rm" || token == "rmdir") {
                Some("xargs rm deletes files".to_string())
            } else {
                None
            }
        }
        "npm" | "pnpm" | "yarn" | "bun" => {
            if tokens.get(1).map(String::as_str) == Some("publish") {
                Some("publishing a package is irreversible".to_string())
            } else {
                None
            }
        }
        "docker" => match tokens.get(1).map(String::as_str) {
            Some("rm") | Some("rmi") | Some("prune") | Some("system") => {
                Some("docker removal commands delete containers/images".to_string())
            }
            _ => None,
        },
        "kubectl" if tokens.get(1).map(String::as_str) == Some("delete") => {
            Some("kubectl delete removes cluster resources".to_string())
        }
        "dropdb" => Some("dropdb deletes a database".to_string()),
        "mysql" | "psql" | "mongo" | "mongosh" | "redis-cli" => {
            let lower = command.to_lowercase();
            if lower.contains("drop ") || lower.contains("drop table") || lower.contains("flushall")
            {
                Some("database drop/flush commands destroy data".to_string())
            } else {
                None
            }
        }
        _ => {
            let lower = command.to_lowercase();
            if lower.contains("| sh")
                || lower.contains("| bash")
                || lower.contains("| zsh")
                || lower.contains("| python")
                || lower.contains("| node")
            {
                return Some(
                    "piping output into an interpreter can execute arbitrary code".to_string(),
                );
            }
            None
        }
    }
}

fn is_read_only(program: &str, tokens: &[String]) -> bool {
    if !READ_ONLY_PROGRAMS.contains(&program) {
        return false;
    }
    match program {
        "git" => tokens
            .get(1)
            .map(|sub| READ_ONLY_GIT_SUBCOMMANDS.contains(&sub.as_str()))
            .unwrap_or(false),
        "find" => !tokens
            .iter()
            .any(|token| token == "-delete" || token.starts_with("-exec")),
        "sed" => !tokens.iter().any(|token| token == "-i"),
        "node" | "python" | "python3" | "tsc" | "cargo" | "go" | "java" | "rustc" => false,
        _ => true,
    }
}

fn candidate_paths(tokens: &[String], dangerous: bool) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];
        if token == ">" || token == ">>" || token == "<" {
            if let Some(next) = tokens.get(index + 1) {
                paths.push(next.clone());
                index += 2;
                continue;
            }
        }
        if let Some(target) = token
            .strip_prefix(">>")
            .or_else(|| token.strip_prefix('>'))
            .or_else(|| token.strip_prefix('<'))
        {
            if !target.is_empty() {
                paths.push(target.to_string());
            }
        }
        index += 1;
    }

    for token in tokens.iter().skip(1) {
        if token.starts_with('-') || token.starts_with('$') {
            continue;
        }
        let looks_like_path =
            token.contains('/') || token.starts_with('~') || token.starts_with('.') || dangerous;
        if looks_like_path {
            paths.push(token.clone());
        }
    }
    paths
}

pub fn resolve_path(project_root: &Path, token: &str) -> PathBuf {
    let cleaned = token.trim_matches(|character| character == '"' || character == '\'');
    let path = if let Some(rest) = cleaned.strip_prefix('~') {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home).join(rest.trim_start_matches('/'))
    } else {
        PathBuf::from(cleaned)
    };
    let absolute = if path.is_absolute() {
        path
    } else {
        project_root.join(path)
    };
    normalize(&absolute)
}

fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            other => result.push(other.as_os_str()),
        }
    }
    result
}

pub fn path_is_inside(path: &Path, project_root: &Path, extra_folders: &[PathBuf]) -> bool {
    path.starts_with(project_root) || extra_folders.iter().any(|folder| path.starts_with(folder))
}

fn relative_path(path: &Path, project_root: &Path, extra_folders: &[PathBuf]) -> String {
    let base = if path.starts_with(project_root) {
        Some(project_root)
    } else {
        extra_folders
            .iter()
            .find(|folder| path.starts_with(folder.as_path()))
            .map(|folder| folder.as_path())
    };
    match base.and_then(|base| path.strip_prefix(base).ok()) {
        Some(relative) => relative.to_string_lossy().replace('\\', "/"),
        None => path.to_string_lossy().replace('\\', "/"),
    }
}

/// A single built-in ignore rule that can be toggled in the advanced settings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreCatalogEntry {
    pub id: String,
    pub group: String,
    pub pattern: String,
}

/// The full built-in ignore catalog, grouped for the settings UI.
pub fn ignore_catalog() -> Vec<IgnoreCatalogEntry> {
    let mut entries = Vec::new();
    for name in GENERATED_DIRS {
        entries.push(IgnoreCatalogEntry {
            id: format!("dir:{name}"),
            group: "generatedFolders".to_string(),
            pattern: format!("{name}/"),
        });
    }
    for suffix in GENERATED_FILE_SUFFIXES {
        entries.push(IgnoreCatalogEntry {
            id: format!("file:{suffix}"),
            group: "generatedFiles".to_string(),
            pattern: format!("*{suffix}"),
        });
    }
    entries.push(IgnoreCatalogEntry {
        id: "env".to_string(),
        group: "environment".to_string(),
        pattern: ".env*".to_string(),
    });
    for extension in DATABASE_EXTENSIONS {
        entries.push(IgnoreCatalogEntry {
            id: format!("db:{extension}"),
            group: "databases".to_string(),
            pattern: format!("*{extension}"),
        });
    }
    for suffix in SENSITIVE_SUFFIXES {
        entries.push(IgnoreCatalogEntry {
            id: format!("creds:ext:{suffix}"),
            group: "credentials".to_string(),
            pattern: format!("*{suffix}"),
        });
    }
    for prefix in SENSITIVE_PREFIXES {
        entries.push(IgnoreCatalogEntry {
            id: format!("creds:prefix:{prefix}"),
            group: "credentials".to_string(),
            pattern: format!("{prefix}*"),
        });
    }
    for part in SENSITIVE_NAME_PARTS {
        entries.push(IgnoreCatalogEntry {
            id: format!("creds:part:{part}"),
            group: "credentials".to_string(),
            pattern: format!("*{part}*"),
        });
    }
    for name in SENSITIVE_NAMES {
        entries.push(IgnoreCatalogEntry {
            id: format!("creds:name:{name}"),
            group: "credentials".to_string(),
            pattern: (*name).to_string(),
        });
    }
    for name in SENSITIVE_DIRS {
        entries.push(IgnoreCatalogEntry {
            id: format!("creds:dir:{name}"),
            group: "credentials".to_string(),
            pattern: format!("{name}/"),
        });
    }
    entries
}

/// File access rules derived from the user's Agent settings. These apply to the
/// discovery and read tools so the agent does not touch files the user marked as
/// off-limits. User exemptions always win over every other rule.
#[derive(Debug, Clone)]
pub struct FileIgnoreConfig {
    pub respect_gitignore: bool,
    pub scan_generated_files: bool,
    pub ignore_local_databases: bool,
    pub ignore_env_files: bool,
    exemptions: GlobSet,
    /// Rules turned off despite their group default.
    disabled: HashSet<String>,
    /// Rules turned on despite their group default.
    enabled: HashSet<String>,
}

impl Default for FileIgnoreConfig {
    fn default() -> Self {
        Self {
            respect_gitignore: true,
            scan_generated_files: false,
            ignore_local_databases: false,
            ignore_env_files: true,
            exemptions: empty_globset(),
            disabled: HashSet::new(),
            enabled: HashSet::new(),
        }
    }
}

impl FileIgnoreConfig {
    pub fn new(
        respect_gitignore: bool,
        scan_generated_files: bool,
        ignore_local_databases: bool,
        ignore_env_files: bool,
        exemptions: &[String],
    ) -> Self {
        Self {
            respect_gitignore,
            scan_generated_files,
            ignore_local_databases,
            ignore_env_files,
            exemptions: build_exemptions(exemptions),
            disabled: HashSet::new(),
            enabled: HashSet::new(),
        }
    }

    pub fn with_overrides(mut self, disabled: &[String], enabled: &[String]) -> Self {
        self.disabled = disabled.iter().cloned().collect();
        self.enabled = enabled.iter().cloned().collect();
        self
    }

    pub fn from_settings(settings: &crate::config::Settings) -> Self {
        Self::new(
            settings.permissions.ignore_gitignored,
            settings.permissions.scan_generated_files,
            settings.permissions.ignore_local_databases,
            settings.permissions.ignore_env_files,
            &settings.permissions.file_ignore_exemptions,
        )
        .with_overrides(
            &settings.permissions.file_ignore_disabled,
            &settings.permissions.file_ignore_enabled,
        )
    }

    /// A user exemption overrides every ignore rule.
    pub fn is_exempt(&self, relative: &str) -> bool {
        !relative.is_empty() && self.exemptions.is_match(relative)
    }

    /// Whether the user configured any exemptions.
    pub fn has_exemptions(&self) -> bool {
        !self.exemptions.is_empty()
    }

    /// Resolve a rule against its group default plus the user overrides.
    fn rule_on(&self, base: bool, id: &str) -> bool {
        if self.disabled.contains(id) {
            false
        } else if self.enabled.contains(id) {
            true
        } else {
            base
        }
    }

    /// Pure detection of generated/build directories or files.
    pub fn is_generated_path(&self, path: &Path) -> bool {
        self.generated_rule_id(path).is_some()
    }

    /// True when the matching generated rule was explicitly turned off.
    pub fn generated_rule_disabled(&self, path: &Path) -> bool {
        self.generated_rule_id(path)
            .map(|id| !self.rule_on(!self.scan_generated_files, &id))
            .unwrap_or(false)
    }

    fn generated_rule_id(&self, path: &Path) -> Option<String> {
        for component in path.components() {
            let value = component.as_os_str().to_string_lossy();
            if GENERATED_DIRS.contains(&value.as_ref()) {
                return Some(format!("dir:{value}"));
            }
        }
        if let Some(name) = path.file_name().map(|name| name.to_string_lossy().to_lowercase()) {
            for suffix in GENERATED_FILE_SUFFIXES {
                if name.ends_with(suffix) {
                    return Some(format!("file:{suffix}"));
                }
            }
        }
        None
    }

    fn database_rule_id(&self, name: &str) -> Option<String> {
        DATABASE_EXTENSIONS
            .iter()
            .find(|extension| name.ends_with(**extension))
            .map(|extension| format!("db:{extension}"))
    }

    /// True when a category rule is turned off, so `.gitignore` must not hide it.
    fn explicitly_allowed(&self, path: &Path) -> bool {
        if let Some(name) = path.file_name().map(|name| name.to_string_lossy()) {
            let lowered = name.to_lowercase();
            if is_env_file(&lowered)
                && !is_env_example(&lowered)
                && !self.rule_on(self.ignore_env_files, "env")
            {
                return true;
            }
            if let Some(id) = self.database_rule_id(&lowered) {
                if !self.rule_on(self.ignore_local_databases, &id) {
                    return true;
                }
            }
        }
        if let Some(id) = self.generated_rule_id(path) {
            if !self.rule_on(!self.scan_generated_files, &id) {
                return true;
            }
        }
        false
    }

    /// Reasons to hide a path that are independent of `.gitignore`.
    pub fn category_reason(&self, path: &Path) -> Option<&'static str> {
        if path
            .components()
            .any(|component| component.as_os_str() == ".git")
        {
            return Some("it is part of the git internals");
        }
        if let Some(name) = path.file_name().map(|name| name.to_string_lossy()) {
            let lowered = name.to_lowercase();
            if is_env_file(&lowered)
                && !is_env_example(&lowered)
                && self.rule_on(self.ignore_env_files, "env")
            {
                return Some("it is an environment file");
            }
            if let Some(id) = self.database_rule_id(&lowered) {
                if self.rule_on(self.ignore_local_databases, &id) {
                    return Some("it is a local database");
                }
            }
        }
        if let Some(id) = self.generated_rule_id(path) {
            if self.rule_on(!self.scan_generated_files, &id) {
                return Some("it is inside a generated or dependency directory");
            }
        }
        None
    }

    /// Reason a sensitive file (keys, credentials, tokens) should be guarded.
    pub fn sensitive_reason(&self, path: &Path) -> Option<&'static str> {
        let matched = sensitive_match(path)?;
        self.rule_on(true, &matched.rule_id).then_some(matched.reason)
    }

    /// Full reason a path should be hidden, combining `.gitignore` status.
    pub fn ignore_reason(
        &self,
        path: &Path,
        relative: &str,
        gitignored: bool,
    ) -> Option<&'static str> {
        if self.is_exempt(relative) {
            return None;
        }
        if let Some(reason) = self.category_reason(path) {
            return Some(reason);
        }
        if self.respect_gitignore && gitignored {
            if self.scan_generated_files && self.is_generated_path(path) {
                return None;
            }
            if self.explicitly_allowed(path) {
                return None;
            }
            return Some("it is ignored by .gitignore");
        }
        None
    }
}

fn empty_globset() -> GlobSet {
    GlobSetBuilder::new().build().unwrap_or_default()
}

fn build_exemptions(patterns: &[String]) -> GlobSet {
    let mut builder = GlobSetBuilder::new();
    let mut any = false;
    for pattern in patterns {
        let pattern = pattern.trim();
        if pattern.is_empty() {
            continue;
        }
        if let Ok(glob) = Glob::new(pattern) {
            builder.add(glob);
            any = true;
        }
        // A bare file name should also match at any depth.
        if !pattern.contains('/') {
            if let Ok(glob) = Glob::new(&format!("**/{pattern}")) {
                builder.add(glob);
                any = true;
            }
        }
    }
    if any {
        builder.build().unwrap_or_else(|_| empty_globset())
    } else {
        empty_globset()
    }
}

pub fn is_env_file(name: &str) -> bool {
    let name = name.to_lowercase();
    name == ".env" || name.starts_with(".env.") || name.ends_with(".env")
}

pub fn is_env_example(name: &str) -> bool {
    let name = name.to_lowercase();
    ENV_EXAMPLE_MARKERS
        .iter()
        .any(|marker| name.contains(marker))
}

/// First credential/secret pattern a path matches, with the per-rule toggle id
/// that governs it. Shared by the command gate (`is_sensitive`) and the file
/// gate (`FileIgnoreConfig::sensitive_reason`) so the two can never drift.
struct SensitiveMatch {
    reason: &'static str,
    rule_id: String,
}

fn sensitive_match(path: &Path) -> Option<SensitiveMatch> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    for suffix in SENSITIVE_SUFFIXES {
        if name.ends_with(suffix) {
            return Some(SensitiveMatch {
                reason: "it looks like a key, certificate or credential file",
                rule_id: format!("creds:ext:{suffix}"),
            });
        }
    }
    for prefix in SENSITIVE_PREFIXES {
        if name.starts_with(prefix) {
            return Some(SensitiveMatch {
                reason: "it looks like a private key",
                rule_id: format!("creds:prefix:{prefix}"),
            });
        }
    }
    for part in SENSITIVE_NAME_PARTS {
        if name.contains(part) {
            return Some(SensitiveMatch {
                reason: "it looks like it contains credentials or secrets",
                rule_id: format!("creds:part:{part}"),
            });
        }
    }
    if SENSITIVE_NAMES.contains(&name.as_str()) {
        return Some(SensitiveMatch {
            reason: "it is a well-known credential file",
            rule_id: format!("creds:name:{name}"),
        });
    }
    for component in path.components() {
        let value = component.as_os_str().to_string_lossy();
        if SENSITIVE_DIRS.contains(&value.as_ref()) {
            return Some(SensitiveMatch {
                reason: "it is stored in a credentials directory",
                rule_id: format!("creds:dir:{value}"),
            });
        }
    }
    None
}

pub fn is_sensitive(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    is_env_file(&name) || sensitive_match(path).is_some()
}

fn preview(paths: &[String]) -> String {
    let mut joined = paths.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
    if paths.len() > 3 {
        joined.push_str(&format!(" (+{} more)", paths.len() - 3));
    }
    joined
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evaluate(command: &str, rules: &[String]) -> CommandDecision {
        evaluate_command(command, Path::new("/project"), &[], rules)
    }

    #[test]
    fn read_only_commands_are_allowed() {
        assert_eq!(evaluate("ls src", &[]), CommandDecision::Allow);
        assert_eq!(evaluate("grep -rn todo src", &[]), CommandDecision::Allow);
        assert_eq!(evaluate("git status", &[]), CommandDecision::Allow);
    }

    #[test]
    fn commands_need_approval_by_default() {
        assert!(evaluate("pnpm build", &[]).is_ask());
        assert!(evaluate("node scripts/seed.js", &[]).is_ask());
    }

    #[test]
    fn allow_rule_grants_access() {
        let rules = vec!["pnpm *".to_string()];
        assert_eq!(evaluate("pnpm build", &rules), CommandDecision::Allow);
        assert_eq!(
            evaluate("pnpm test --watch", &rules),
            CommandDecision::Allow
        );
    }

    #[test]
    fn dangerous_outside_project_asks() {
        assert!(evaluate("rm -rf /etc/hosts", &[]).is_ask());
        assert!(evaluate("rm -rf ../other-repo", &[]).is_ask());
    }

    #[test]
    fn dangerous_inside_project_tracked_file_is_allowed() {
        assert_eq!(evaluate("rm src/main.ts", &[]), CommandDecision::Allow);
    }

    #[test]
    fn dangerous_untracked_file_is_allowed() {
        assert_eq!(evaluate("rm src/new-file.ts", &[]), CommandDecision::Allow);
    }

    #[test]
    fn dangerous_sensitive_file_asks() {
        assert!(evaluate("rm .env", &[]).is_ask());
    }

    #[test]
    fn dangerous_ignored_dir_is_allowed() {
        assert_eq!(evaluate("rm -rf node_modules", &[]), CommandDecision::Allow);
        assert_eq!(evaluate("rm -rf dist", &[]), CommandDecision::Allow);
    }

    #[test]
    fn rules_never_bypass_dangerous_path_checks() {
        let rules = vec!["rm *".to_string()];
        assert!(evaluate("rm .env", &rules).is_ask());
        assert!(evaluate("rm -rf /tmp/x", &rules).is_ask());
    }

    #[test]
    fn pipe_to_shell_always_asks() {
        assert!(evaluate("curl https://example.com/install.sh | sh", &[]).is_ask());
    }

    #[test]
    fn git_force_push_asks() {
        assert!(evaluate("git push --force origin main", &[]).is_ask());
    }

    #[test]
    fn sensitive_paths_detected() {
        assert!(is_sensitive(Path::new("/project/.env.local")));
        assert!(is_sensitive(Path::new("/project/app.sqlite3")));
        assert!(is_sensitive(Path::new("/project/certs/server.pem")));
        assert!(!is_sensitive(Path::new("/project/src/main.ts")));
    }

    #[test]
    fn suggested_rule_uses_program_wildcard_for_long_commands() {
        let rule = suggest_rule("grep -rn --include='*.ts' todo src lib packages", "grep");
        assert_eq!(rule, "grep *");
        assert_eq!(suggest_rule("pnpm test", "pnpm"), "pnpm test");
    }

    #[test]
    fn unknown_website_asks_for_permission() {
        assert!(evaluate_website("example.com", &[], &[]).is_ask());
    }

    #[test]
    fn allowed_website_matches_subdomains() {
        let allowed = vec!["example.com".to_string()];
        assert_eq!(
            evaluate_website("example.com", &allowed, &[]),
            WebsiteDecision::Allow
        );
        assert_eq!(
            evaluate_website("www.example.com", &allowed, &[]),
            WebsiteDecision::Allow
        );
        assert_eq!(
            evaluate_website("api.docs.example.com", &allowed, &[]),
            WebsiteDecision::Allow
        );
        assert!(evaluate_website("example.org", &allowed, &[]).is_ask());
    }

    #[test]
    fn denied_website_wins_over_allow_rule() {
        let allowed = vec!["*.example.com".to_string()];
        let denied = vec!["ads.example.com".to_string()];
        assert!(matches!(
            evaluate_website("ads.example.com", &allowed, &denied),
            WebsiteDecision::Deny { .. }
        ));
    }

    #[test]
    fn website_glob_rules_match() {
        let allowed = vec!["*.github.io".to_string()];
        assert_eq!(
            evaluate_website("foo.github.io", &allowed, &[]),
            WebsiteDecision::Allow
        );
        assert!(evaluate_website("github.io", &allowed, &[]).is_ask());
    }

    #[test]
    fn env_files_are_ignored_but_examples_are_not() {
        let config = FileIgnoreConfig::new(true, false, false, true, &[]);
        assert!(config.category_reason(Path::new("/project/.env")).is_some());
        assert!(config
            .category_reason(Path::new("/project/.env.local"))
            .is_some());
        assert!(config.category_reason(Path::new("/project/example.env")).is_none());
        assert!(config
            .category_reason(Path::new("/project/.env.example"))
            .is_none());
    }

    #[test]
    fn databases_are_only_ignored_when_enabled() {
        let off = FileIgnoreConfig::new(true, false, false, true, &[]);
        assert!(off.category_reason(Path::new("/project/data.sqlite")).is_none());
        let on = FileIgnoreConfig::new(true, false, true, true, &[]);
        assert!(on.category_reason(Path::new("/project/data.sqlite")).is_some());
    }

    #[test]
    fn generated_files_follow_scan_setting() {
        let no_scan = FileIgnoreConfig::new(true, false, false, true, &[]);
        assert!(no_scan
            .ignore_reason(
                Path::new("/project/node_modules/pkg/index.js"),
                "node_modules/pkg/index.js",
                true,
            )
            .is_some());
        let scan = FileIgnoreConfig::new(true, true, false, true, &[]);
        assert!(scan
            .ignore_reason(
                Path::new("/project/node_modules/pkg/index.js"),
                "node_modules/pkg/index.js",
                true,
            )
            .is_none());
    }

    #[test]
    fn exemptions_override_every_rule() {
        let config = FileIgnoreConfig::new(
            true,
            false,
            true,
            true,
            &["config/local.env".to_string()],
        );
        assert!(config
            .ignore_reason(Path::new("/project/config/local.env"), "config/local.env", true)
            .is_none());
        assert!(config
            .ignore_reason(Path::new("/project/config/other.env"), "config/other.env", true)
            .is_some());
    }

    #[test]
    fn additional_sensitive_formats_detected() {
        for path in [
            "/project/.npmrc",
            "/project/.aws/credentials",
            "/project/.kube/config",
            "/project/secrets.yaml",
            "/project/service-account.json",
            "/project/server.jks",
            "/project/terraform.tfstate.backup",
            "/project/id_ecdsa",
            "/project/.vault-token",
        ] {
            assert!(is_sensitive(Path::new(path)), "{path} should be sensitive");
        }
        assert!(!is_sensitive(Path::new("/project/src/main.ts")));
        assert!(!is_sensitive(Path::new("/project/src/tokenizer.ts")));
    }

    #[test]
    fn generated_artifact_files_follow_scan_setting() {
        let no_scan = FileIgnoreConfig::new(true, false, false, true, &[]);
        assert!(no_scan
            .ignore_reason(Path::new("/project/app.min.js"), "app.min.js", false)
            .is_some());
        assert!(no_scan
            .ignore_reason(Path::new("/project/notes.log"), "notes.log", false)
            .is_some());
        let scan = FileIgnoreConfig::new(true, true, false, true, &[]);
        assert!(scan
            .ignore_reason(Path::new("/project/app.min.js"), "app.min.js", false)
            .is_none());
    }

    #[test]
    fn overrides_can_enable_and_disable_individual_rules() {
        let config = FileIgnoreConfig::new(true, false, false, true, &[])
            .with_overrides(&[], &["db:.sqlite".to_string()]);
        assert!(config.category_reason(Path::new("/p/data.sqlite")).is_some());
        assert!(config.category_reason(Path::new("/p/data.db")).is_none());

        let config = FileIgnoreConfig::new(true, false, false, true, &[])
            .with_overrides(&["dir:node_modules".to_string()], &[]);
        assert!(config
            .category_reason(Path::new("/p/node_modules/x.js"))
            .is_none());
        assert!(config.category_reason(Path::new("/p/dist/x.js")).is_some());
        assert!(config
            .ignore_reason(Path::new("/p/node_modules/x.js"), "node_modules/x.js", true)
            .is_none());

        let config = FileIgnoreConfig::new(true, false, false, true, &[])
            .with_overrides(&["creds:ext:.pem".to_string()], &[]);
        assert!(config.sensitive_reason(Path::new("/p/cert.pem")).is_none());
        assert!(config.sensitive_reason(Path::new("/p/id_rsa")).is_some());
    }

    #[test]
    fn session_folder_covers_every_file_and_subfolder_below_it() {
        let permissions = LivePermissions::new(Vec::new(), Vec::new(), Vec::new(), Vec::new());
        permissions.add_session_folder("/test/test2");
        let folders = permissions.extra_folders();
        assert!(path_is_inside(
            Path::new("/test/test2/a.txt"),
            Path::new("/project"),
            &folders
        ));
        assert!(path_is_inside(
            Path::new("/test/test2/deep/nested/b.txt"),
            Path::new("/project"),
            &folders
        ));
        assert!(!path_is_inside(
            Path::new("/test/test3/c.txt"),
            Path::new("/project"),
            &folders
        ));
    }

    #[test]
    fn session_folders_survive_a_settings_save() {
        let permissions = LivePermissions::new(Vec::new(), Vec::new(), Vec::new(), Vec::new());
        permissions.add_session_folder("/test/test2");
        permissions.replace(
            Vec::new(),
            vec!["/persisted".to_string()],
            Vec::new(),
            Vec::new(),
        );
        let folders = permissions.extra_folders();
        assert!(folders.contains(&PathBuf::from("/persisted")));
        assert!(folders.contains(&PathBuf::from("/test/test2")));
    }
}
