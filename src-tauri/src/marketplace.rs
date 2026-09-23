//! Remote catalogs for MCP servers and Agent Skills.
//!
//! MCP servers come from the official registry (registry.modelcontextprotocol.io),
//! whose namespaced names (`io.github.owner/server`) tie every entry to a verified
//! domain or GitHub owner. Agent Skills come from Claude Code style plugin
//! marketplaces: a git repo with `.claude-plugin/marketplace.json` at the root.
//!
//! Everything here is metadata plus on-disk installs; nothing is trusted until the
//! user reviews the resulting config. See `docs/PLUGINS.md` for the security model.
//!
//! Verified by default: MCP results are filtered to registry-verified entries and
//! skills can only be installed from marketplaces the user has added or from
//! curated sources whose checkout matches a pinned commit. Callers opt out of the
//! filter explicitly when the user turns off `marketplace_verified_only`.

use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const REGISTRY_BASE: &str = "https://registry.modelcontextprotocol.io/v0";
const DEFAULT_LIMIT: u32 = 50;

/// Build with Claude's MCP directory (buildwithclaude.com). It aggregates the
/// official registry plus Docker Hub and community catalogs and adds GitHub star
/// counts, categories and ready-made install commands the official registry does
/// not expose. Read-only discovery: the user always copies a config themselves.
const DIRECTORY_BASE: &str = "https://buildwithclaude.com/api/mcp-servers";

/// Marketplace names Anthropic reserves, mirrored here so a third-party catalog
/// can never present itself as an official source. Kept in sync with the
/// Claude Code plugin-marketplace docs.
const RESERVED_MARKETPLACE_NAMES: &[&str] = &[
    "claude-code-marketplace",
    "claude-code-plugins",
    "claude-plugins-official",
    "claude-plugins-community",
    "claude-community",
    "anthropic-marketplace",
    "anthropic-plugins",
    "agent-skills",
    "anthropic-agent-skills",
    "knowledge-work-plugins",
    "life-sciences",
    "claude-for-legal",
    "claude-for-financial-services",
    "financial-services-plugins",
    "first-party-plugins",
    "claude-tag-plugins",
    "healthcare",
];

/// Marketplaces we ship as known-good defaults. Add an entry here once the
/// catalog is reviewed; users can always add their own with `add_skill_marketplace`.
///
/// A reviewed marketplace is pinned to an exact commit. The entry only counts as
/// verified when the local checkout's HEAD matches the pin, so a compromised or
/// force-pushed upstream cannot silently swap the skills the user installs.
pub struct CuratedMarketplace {
    pub url: &'static str,
    pub commit: &'static str,
}

/// Intentionally empty until a catalog is reviewed end to end. To curate a
/// marketplace, add its clone URL and the full 40-character commit SHA to review.
const CURATED_MARKETPLACES: &[CuratedMarketplace] = &[];

fn is_curated(url: &str) -> bool {
    CURATED_MARKETPLACES.iter().any(|entry| entry.url == url)
}

/// True when `url` is curated and the checkout is at the pinned commit.
fn verify_pin(url: &str, commit: Option<&str>, pins: &[CuratedMarketplace]) -> bool {
    let Some(commit) = commit else {
        return false;
    };
    pins.iter()
        .any(|entry| entry.url == url && entry.commit == commit)
}

/// HEAD commit of a git checkout, or `None` when it is not a repository.
fn head_commit(dir: &Path) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["-C"])
        .arg(dir)
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let commit = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!commit.is_empty()).then_some(commit)
}

// ---------------------------------------------------------------------------
// Official MCP Registry
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct RegistryResponse {
    #[serde(default)]
    servers: Vec<RegistryEntry>,
    #[serde(default)]
    #[allow(dead_code)]
    metadata: Option<RegistryMetadata>,
}

#[derive(Debug, Deserialize)]
struct RegistryMetadata {
    #[serde(default, rename = "nextCursor")]
    #[allow(dead_code)]
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RegistryEntry {
    server: RegistryServer,
    #[serde(default, rename = "_meta")]
    meta: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct RegistryServer {
    name: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    remotes: Vec<RegistryRemote>,
    #[serde(default)]
    packages: Vec<RegistryPackage>,
    #[serde(default)]
    repository: Option<RegistryRepository>,
}

#[derive(Debug, Deserialize)]
struct RegistryRemote {
    #[serde(rename = "type", default)]
    transport: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RegistryPackage {
    #[serde(default, rename = "registryType")]
    registry_type: Option<String>,
    #[serde(default)]
    identifier: Option<String>,
    #[serde(default, rename = "runtimeHint")]
    runtime_hint: Option<String>,
    #[serde(default, rename = "environmentVariables")]
    environment_variables: Vec<RegistryEnvVar>,
}

#[derive(Debug, Deserialize)]
struct RegistryEnvVar {
    #[serde(default)]
    name: Option<String>,
    #[serde(default, rename = "isRequired")]
    is_required: Option<bool>,
    #[serde(default, rename = "isSecret")]
    is_secret: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct RegistryRepository {
    #[serde(default)]
    url: Option<String>,
}

/// One search result, flattened into the shape the installer needs: an optional
/// URL, an optional command line, and where it came from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceServer {
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub version: Option<String>,
    /// `"remote"` (streamable HTTP) or `"package"` (stdio command).
    pub kind: String,
    pub transport: Option<String>,
    pub url: Option<String>,
    pub command: Option<String>,
    pub args: Vec<String>,
    /// Env vars the server declares, so the user sees them before install.
    pub env: Vec<RegistryEnv>,
    pub repository: Option<String>,
    /// Registry namespace ownership was verified (domain or GitHub owner).
    pub verified: bool,
    pub published_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEnv {
    pub name: String,
    pub required: bool,
    pub secret: bool,
}

fn meta_field(meta: &Option<serde_json::Value>, key: &str) -> Option<String> {
    meta.as_ref()?
        .get("io.modelcontextprotocol.registry/official")?
        .get(key)?
        .as_str()
        .map(str::to_string)
}

fn map_server(entry: RegistryEntry) -> MarketplaceServer {
    let server = entry.server;
    let official = meta_field(&entry.meta, "status");
    let is_active = official.as_deref() == Some("active");

    let remote = server.remotes.into_iter().next();
    let package = server.packages.into_iter().next();

    let (kind, transport, url, command, args, env) = if let Some(remote) = remote {
        (
            "remote".to_string(),
            remote.transport.clone(),
            remote.url,
            None,
            Vec::new(),
            Vec::new(),
        )
    } else if let Some(package) = package {
        let (command, args) = package_command(&package);
        (
            "package".to_string(),
            Some("stdio".to_string()),
            None,
            command,
            args,
            package
                .environment_variables
                .into_iter()
                .filter_map(|variable| {
                    let name = variable.name?;
                    Some(RegistryEnv {
                        name,
                        required: variable.is_required.unwrap_or(false),
                        secret: variable.is_secret.unwrap_or(false),
                    })
                })
                .collect(),
        )
    } else {
        ("package".to_string(), None, None, None, Vec::new(), Vec::new())
    };

    // Namespaced names encode ownership (`io.github.owner/server`), which is what
    // the registry verifies. Local-only entries have no namespace.
    let verified = is_active && server.name.contains('/');

    MarketplaceServer {
        name: server.name,
        title: server.title,
        description: server.description,
        version: server.version,
        kind,
        transport,
        url,
        command,
        args,
        env,
        repository: server.repository.and_then(|repo| repo.url),
        verified,
        published_at: meta_field(&entry.meta, "publishedAt"),
        updated_at: meta_field(&entry.meta, "updatedAt"),
    }
}

/// Turns a registry package into a launch command. We only build commands we can
/// run without a global install, and we never add a `-y`/force flag the user
/// hasn't seen.
fn package_command(package: &RegistryPackage) -> (Option<String>, Vec<String>) {
    let Some(identifier) = package.identifier.clone() else {
        return (None, Vec::new());
    };
    let runtime = package
        .runtime_hint
        .clone()
        .unwrap_or_else(|| package.registry_type.clone().unwrap_or_default());
    match runtime.as_str() {
        "npx" => (
            Some("npx".to_string()),
            vec!["-y".to_string(), identifier, "mcp".to_string()],
        ),
        "uvx" => (Some("uvx".to_string()), vec![identifier]),
        "docker" => (
            Some("docker".to_string()),
            vec!["run".to_string(), "-i".to_string(), "--rm".to_string(), identifier],
        ),
        // Unknown runtime: surface the command the author asked for, verbatim.
        _ => (
            Some(package
                .runtime_hint
                .clone()
                .unwrap_or_else(|| "npx".to_string())),
            vec![identifier],
        ),
    }
}

// ---------------------------------------------------------------------------
// Build with Claude MCP directory
// ---------------------------------------------------------------------------

/// `null` is treated like a missing field so `Vec`/`Option` fields that the API
/// serialises as `null` (`packages`, `remotes`, `environmentVariables`) parse.
fn deserialize_null_default<'de, D, T>(deserializer: D) -> std::result::Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryResponse {
    #[serde(default)]
    servers: Vec<DirectoryEntry>,
    #[serde(default)]
    total: u32,
    #[serde(default)]
    limit: u32,
    #[serde(default)]
    offset: u32,
    #[serde(default)]
    has_more: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryEntry {
    name: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    server_type: Option<String>,
    #[serde(default)]
    logo_url: Option<String>,
    #[serde(default)]
    source_registry: Option<String>,
    #[serde(default)]
    github_url: Option<String>,
    #[serde(default)]
    docker_url: Option<String>,
    #[serde(default)]
    npm_url: Option<String>,
    #[serde(default)]
    documentation_url: Option<String>,
    #[serde(default)]
    github_stars: u64,
    #[serde(default)]
    docker_pulls: u64,
    #[serde(default)]
    npm_downloads: u64,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    packages: Vec<DirectoryPackage>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    remotes: Vec<DirectoryRemote>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    environment_variables: Vec<DirectoryEnvVar>,
    #[serde(default)]
    verification_status: Option<String>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    installation_methods: Vec<DirectoryInstallMethod>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryPackage {
    #[serde(default)]
    registry_type: Option<String>,
    #[serde(default)]
    identifier: Option<String>,
    #[serde(default)]
    runtime_hint: Option<String>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    package_arguments: Vec<DirectoryArgument>,
}

#[derive(Debug, Deserialize)]
struct DirectoryArgument {
    #[serde(default)]
    value: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DirectoryRemote {
    #[serde(rename = "type", default)]
    transport: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DirectoryEnvVar {
    name: String,
    #[serde(default)]
    required: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryInstallMethod {
    #[serde(rename = "type", default)]
    #[allow(dead_code)]
    kind: Option<String>,
    #[serde(default)]
    recommended: bool,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    claude_code: Option<String>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    requirements: Vec<String>,
}

/// Flattened for the settings browser: everything a card shows plus the bits
/// needed to build an `mcpServers` config or a copyable install command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryServer {
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub version: Option<String>,
    pub category: String,
    pub server_type: Option<String>,
    pub logo_url: Option<String>,
    pub source_registry: String,
    pub github_url: Option<String>,
    pub docker_url: Option<String>,
    pub npm_url: Option<String>,
    pub documentation_url: Option<String>,
    pub github_stars: u64,
    pub docker_pulls: u64,
    pub npm_downloads: u64,
    pub verification_status: String,
    pub env: Vec<RegistryEnv>,
    pub install: DirectoryInstall,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryInstall {
    /// stdio launch command, when the entry ships a package.
    pub command: Option<String>,
    pub args: Vec<String>,
    /// Remote endpoint, when the entry ships a streamable-HTTP remote.
    pub url: Option<String>,
    pub transport: Option<String>,
    /// Ready-to-run CLI from the author (`claude mcp add ...`, `docker ...`).
    pub cli: Option<String>,
    pub requirements: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryPage {
    pub servers: Vec<DirectoryServer>,
    pub total: u32,
    pub limit: u32,
    pub offset: u32,
    pub has_more: bool,
}

/// Maps a directory package to a launch command using the arguments the author
/// declared, so the copied config runs exactly what the catalog shows.
fn directory_package_command(package: &DirectoryPackage) -> (Option<String>, Vec<String>) {
    let Some(identifier) = package.identifier.clone() else {
        return (None, Vec::new());
    };
    let runtime = package
        .runtime_hint
        .clone()
        .unwrap_or_else(|| package.registry_type.clone().unwrap_or_default());
    let extra: Vec<String> = package
        .package_arguments
        .iter()
        .filter_map(|argument| argument.value.clone())
        .collect();
    let mut args = vec![identifier];
    args.extend(extra);
    match runtime.as_str() {
        "npx" => {
            args.insert(0, "-y".to_string());
            (Some("npx".to_string()), args)
        }
        "uvx" => (Some("uvx".to_string()), args),
        "docker" => {
            let mut docker = vec!["run".to_string(), "-i".to_string(), "--rm".to_string()];
            docker.extend(args);
            (Some("docker".to_string()), docker)
        }
        _ => (Some(runtime), args),
    }
}

fn map_directory(entry: DirectoryEntry) -> DirectoryServer {
    let env = entry
        .environment_variables
        .iter()
        .map(|variable| RegistryEnv {
            name: variable.name.clone(),
            required: variable.required,
            secret: false,
        })
        .collect();

    let recommended = entry
        .installation_methods
        .iter()
        .find(|method| method.recommended)
        .or_else(|| entry.installation_methods.first());
    let cli = recommended.and_then(|method| method.claude_code.clone().or_else(|| method.command.clone()));
    let requirements = recommended
        .map(|method| method.requirements.clone())
        .unwrap_or_default();

    let install = if let Some(remote) = entry.remotes.first() {
        DirectoryInstall {
            command: None,
            args: Vec::new(),
            url: remote.url.clone(),
            transport: remote.transport.clone(),
            cli,
            requirements,
        }
    } else if let Some(package) = entry.packages.first() {
        let (command, args) = directory_package_command(package);
        DirectoryInstall {
            command,
            args,
            url: None,
            transport: Some("stdio".to_string()),
            cli,
            requirements,
        }
    } else {
        DirectoryInstall {
            command: None,
            args: Vec::new(),
            url: None,
            transport: None,
            cli,
            requirements,
        }
    };

    let name = entry.name;
    let display_name = entry.display_name.filter(|value| !value.is_empty()).unwrap_or_else(|| name.clone());

    DirectoryServer {
        display_name,
        name,
        description: entry.description,
        version: entry.version,
        category: entry.category.unwrap_or_default(),
        server_type: entry.server_type,
        logo_url: entry.logo_url,
        source_registry: entry.source_registry.unwrap_or_else(|| "community".to_string()),
        github_url: entry.github_url,
        docker_url: entry.docker_url,
        npm_url: entry.npm_url,
        documentation_url: entry.documentation_url,
        github_stars: entry.github_stars,
        docker_pulls: entry.docker_pulls,
        npm_downloads: entry.npm_downloads,
        verification_status: entry
            .verification_status
            .unwrap_or_else(|| "community".to_string()),
        env,
        install,
    }
}

// ---------------------------------------------------------------------------
// Agent Skill marketplaces
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
struct MarketplaceManifest {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    owner: Option<ManifestOwner>,
    #[serde(default)]
    plugins: Vec<ManifestPlugin>,
    #[serde(default)]
    metadata: Option<ManifestMetadata>,
}

#[derive(Debug, Clone, Deserialize)]
struct ManifestOwner {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ManifestMetadata {
    #[serde(default, rename = "pluginRoot")]
    plugin_root: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ManifestPlugin {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    source: Option<serde_json::Value>,
    #[serde(default)]
    repository: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    keywords: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMarketplace {
    pub name: String,
    pub description: Option<String>,
    pub owner: Option<String>,
    pub url: Option<String>,
    /// Local checkout, when the marketplace is materialized on disk.
    pub path: Option<String>,
    /// `"curated"`, `"custom"`, or `"local"`.
    pub source: String,
    /// Checkout matched a curated pinned commit.
    pub verified: bool,
    /// The user explicitly added this marketplace, so they have opted in to it.
    pub trusted: bool,
    /// HEAD commit of the checkout, when available.
    pub commit: Option<String>,
    /// True when the name collides with a marketplace name Anthropic reserves.
    pub spoofed_name: bool,
    pub plugins: Vec<MarketplacePlugin>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplacePlugin {
    pub name: String,
    pub description: Option<String>,
    pub version: Option<String>,
    pub repository: Option<String>,
    pub homepage: Option<String>,
    /// Marketplace-provided grouping, shown as a tag and used to filter the list.
    pub category: Option<String>,
    pub keywords: Vec<String>,
    /// Skill directory names found under the plugin, when checked out.
    pub skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkill {
    pub name: String,
    pub marketplace: String,
    pub description: Option<String>,
    pub path: String,
}

fn is_reserved(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    RESERVED_MARKETPLACE_NAMES.contains(&lower.as_str())
}

/// Parses a checked-out marketplace into a catalog entry.
fn read_manifest(root: &Path, url: Option<String>, source: &str) -> Result<SkillMarketplace> {
    let manifest_path = root.join(".claude-plugin/marketplace.json");
    let raw = std::fs::read_to_string(&manifest_path).map_err(|_| {
        AppError::msg(format!(
            "no .claude-plugin/marketplace.json in {}",
            root.display()
        ))
    })?;
    let manifest: MarketplaceManifest = serde_json::from_str(&raw)?;

    let plugin_root = manifest
        .metadata
        .and_then(|metadata| metadata.plugin_root)
        .unwrap_or_else(|| "./".to_string());

    let plugins = manifest
        .plugins
        .into_iter()
        .map(|plugin| {
            let skills = plugin_source_path(root, &plugin_root, &plugin.source)
                .map(|path| skill_dir_names(&path))
                .unwrap_or_default();
            MarketplacePlugin {
                name: plugin.name,
                description: plugin.description,
                version: plugin.version,
                repository: plugin.repository,
                homepage: plugin.homepage,
                category: plugin.category,
                keywords: plugin.keywords,
                skills,
            }
        })
        .collect();

    let commit = head_commit(root);
    let verified = url
        .as_deref()
        .map(|url| verify_pin(url, commit.as_deref(), CURATED_MARKETPLACES))
        .unwrap_or(false);
    let spoofed_name = is_reserved(&manifest.name);

    Ok(SkillMarketplace {
        spoofed_name,
        verified,
        trusted: false,
        commit,
        owner: manifest.owner.and_then(|owner| owner.name),
        name: manifest.name,
        description: manifest.description,
        url,
        path: Some(root.to_string_lossy().to_string()),
        source: if verified {
            "curated".to_string()
        } else {
            source.to_string()
        },
        plugins,
    })
}

/// Rejects a single path component (directory/file name) that could escape the
/// intended directory: empty, `.`/`..`, separators or absolute paths.
fn safe_component(value: &str) -> Result<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || Path::new(trimmed).is_absolute()
    {
        return Err(AppError::msg(format!(
            "invalid path component: \"{value}\""
        )));
    }
    Ok(trimmed)
}

/// Resolves a plugin `source` to a local directory. Relative sources (`./x`, or a
/// bare name under `metadata.pluginRoot`) resolve inside the marketplace; anything
/// else (github/npm/archive) is not a local checkout. The result is canonicalised
/// and confined to the marketplace checkout so `..` or symlinks cannot escape it.
fn plugin_source_path(
    root: &Path,
    plugin_root: &str,
    source: &Option<serde_json::Value>,
) -> Option<PathBuf> {
    let source = source.as_ref()?;
    let raw = source.as_str()?;
    let relative: String = if let Some(stripped) = raw.strip_prefix("./") {
        stripped.to_string()
    } else if !raw.contains('/') && !raw.contains('\\') {
        format!("{}/{}", plugin_root.trim_end_matches('/'), raw)
    } else {
        return None;
    };
    let candidate = root.join(relative);
    let canonical_root = root.canonicalize().ok()?;
    let canonical = candidate.canonicalize().ok()?;
    canonical.starts_with(&canonical_root).then_some(canonical)
}

/// Skill directories under a plugin: `<name>/SKILL.md`, plus the plugin root
/// itself when it is a single skill.
fn skill_dir_names(plugin_dir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    let search = [plugin_dir.join("skills"), plugin_dir.to_path_buf()];
    for dir in search {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.join("SKILL.md").is_file() {
                if let Some(name) = path.file_name() {
                    names.push(name.to_string_lossy().to_string());
                }
            }
        }
    }
    names.sort();
    names.dedup();
    names
}

// ---------------------------------------------------------------------------
// Marketplace service
// ---------------------------------------------------------------------------

pub struct MarketplaceService {
    http: reqwest::Client,
    /// `~/.local/share/.../marketplaces`: one checkout per marketplace.
    cache_dir: PathBuf,
}

/// Registry query parameters: always `limit`, plus `search` when the user typed
/// a term. `search` is the registry's server-side filter over names and
/// descriptions; reqwest URL-encodes the values.
fn registry_params(limit: u32, query: Option<&str>) -> Vec<(&'static str, String)> {
    let mut params = vec![("limit", limit.to_string())];
    if let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) {
        params.push(("search", query.to_string()));
    }
    params
}

impl MarketplaceService {
    pub fn new(http: reqwest::Client, cache_dir: PathBuf) -> Self {
        Self { http, cache_dir }
    }

    fn checkout_dir(&self, url: &str) -> PathBuf {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        url.hash(&mut hasher);
        self.cache_dir.join(format!("{:016x}", hasher.finish()))
    }

    /// Searches the official registry. The term is sent as the registry's own
    /// `search` parameter, which matches names and descriptions server-side;
    /// filtering a single alphabetically-paginated page locally would miss every
    /// server that does not happen to start with the page's first letter.
    pub async fn search_mcp(
        &self,
        query: Option<&str>,
        limit: Option<u32>,
        include_unverified: bool,
    ) -> Result<Vec<MarketplaceServer>> {
        let limit = limit.unwrap_or(DEFAULT_LIMIT).min(100);
        let response: RegistryResponse = self
            .http
            .get(format!("{REGISTRY_BASE}/servers"))
            .query(&registry_params(limit, query))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        let mut servers: Vec<MarketplaceServer> = response
            .servers
            .into_iter()
            .map(map_server)
            .filter(|server| include_unverified || server.verified)
            .collect();

        // Verified entries first, then alphabetical, so curation reads clearly.
        servers.sort_by(|a, b| {
            b.verified
                .cmp(&a.verified)
                .then_with(|| a.name.cmp(&b.name))
        });
        Ok(servers)
    }

    /// Browses the Build with Claude MCP directory. All filtering, sorting and
    /// pagination happen server-side so totals stay correct, and every call is
    /// read-only discovery for the settings browser.
    pub async fn browse_directory(
        &self,
        query: Option<&str>,
        category: Option<&str>,
        source: Option<&str>,
        sort: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<DirectoryPage> {
        let limit = limit.clamp(1, 100);
        let mut params: Vec<(&str, String)> = vec![
            ("limit", limit.to_string()),
            ("offset", offset.to_string()),
        ];
        for (key, value) in [
            ("search", query),
            ("category", category),
            ("source", source.filter(|value| *value != "all")),
            ("sort", sort),
        ] {
            if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
                params.push((key, value.to_string()));
            }
        }

        let response: DirectoryResponse = self
            .http
            .get(format!("{DIRECTORY_BASE}/list"))
            .query(&params)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        Ok(DirectoryPage {
            servers: response.servers.into_iter().map(map_directory).collect(),
            total: response.total,
            limit: if response.limit == 0 { limit } else { response.limit },
            offset: response.offset,
            has_more: response.has_more,
        })
    }

    /// The built-in curated catalogs plus everything the user has added. Only
    /// marketplaces that are already checked out can be described, so curated
    /// entries appear once the user fetches them.
    pub fn list_marketplaces(&self) -> Result<Vec<SkillMarketplace>> {
        let custom = self.custom_marketplace_urls()?;
        let mut urls: Vec<String> = CURATED_MARKETPLACES
            .iter()
            .map(|entry| entry.url.to_string())
            .collect();
        for url in &custom {
            if !urls.contains(url) {
                urls.push(url.clone());
            }
        }
        let mut marketplaces = Vec::new();
        for url in urls {
            let dir = self.checkout_dir(&url);
            if !dir.is_dir() {
                continue;
            }
            match read_manifest(&dir, Some(url.clone()), "custom") {
                Ok(mut marketplace) => {
                    marketplace.trusted = custom.contains(&url);
                    marketplaces.push(marketplace);
                }
                Err(error) => {
                    log::warn!("skipping marketplace {url}: {error}");
                }
            }
        }
        Ok(marketplaces)
    }

    /// Registers a marketplace URL and clones it into the cache. Returns the
    /// parsed catalog so the caller can show what was added.
    pub async fn add_marketplace(&self, url: &str) -> Result<SkillMarketplace> {
        let url = url.trim();
        if url.is_empty() {
            return Err(AppError::msg("a marketplace URL is required"));
        }
        let dir = self.checkout_dir(url);
        std::fs::create_dir_all(&self.cache_dir)?;
        self.clone_or_update(url, &dir).await?;
        let mut marketplace = read_manifest(&dir, Some(url.to_string()), "custom")?;
        if marketplace.spoofed_name {
            return Err(AppError::msg(format!(
                "marketplace name \"{}\" is reserved for official use",
                marketplace.name
            )));
        }
        let mut urls = self.custom_marketplace_urls()?;
        if !urls.iter().any(|existing| existing == url) {
            urls.push(url.to_string());
            self.write_custom_marketplace_urls(&urls)?;
        }
        // Adding a marketplace is an explicit trust decision by the user.
        marketplace.trusted = true;
        Ok(marketplace)
    }

    /// Forgets a marketplace and deletes its checkout. Plugin installs are left
    /// on disk so the user doesn't silently lose skills they rely on.
    pub fn remove_marketplace(&self, url: &str) -> Result<()> {
        let mut urls = self.custom_marketplace_urls()?;
        urls.retain(|existing| existing != url);
        self.write_custom_marketplace_urls(&urls)?;
        let dir = self.checkout_dir(url);
        if dir.is_dir() {
            std::fs::remove_dir_all(&dir)?;
        }
        Ok(())
    }

    /// Copies a plugin's skills out of the marketplace checkout into the pumr
    /// skills dir, so the agent can use them without the marketplace present.
    ///
    /// Secure by default: skills can only be installed from a marketplace the
    /// user has added, or from a curated marketplace whose checkout matches its
    /// pinned commit. `include_unverified` lifts that gate when the user turns
    /// off `marketplace_verified_only`.
    pub async fn install_skills(
        &self,
        url: &str,
        plugin: &str,
        include_unverified: bool,
    ) -> Result<Vec<InstalledSkill>> {
        let trusted = self
            .custom_marketplace_urls()?
            .iter()
            .any(|entry| entry == url);
        let dir = self.checkout_dir(url);
        if !dir.is_dir() {
            if !trusted && !is_curated(url) && !include_unverified {
                return Err(AppError::msg(
                    "This marketplace has not been added. Add it before installing its skills.",
                ));
            }
            self.clone_or_update(url, &dir).await?;
        }
        let manifest = read_manifest(&dir, Some(url.to_string()), "custom")?;
        if !manifest.verified && !trusted && !include_unverified {
            return Err(AppError::msg(
                "This marketplace is not verified. Add it to trust it, or allow unverified sources.",
            ));
        }
        let entry = manifest
            .plugins
            .iter()
            .find(|candidate| candidate.name == plugin)
            .ok_or_else(|| AppError::msg(format!("no plugin named \"{plugin}\" in this marketplace")))?;

        let manifest_path = dir.join(".claude-plugin/marketplace.json");
        let raw = std::fs::read_to_string(&manifest_path)?;
        let parsed: MarketplaceManifest = serde_json::from_str(&raw)?;
        let plugin_root = parsed
            .metadata
            .and_then(|metadata| metadata.plugin_root)
            .unwrap_or_else(|| "./".to_string());
        let source = parsed
            .plugins
            .into_iter()
            .find(|candidate| candidate.name == plugin)
            .and_then(|candidate| candidate.source);
        let plugin_dir = plugin_source_path(&dir, &plugin_root, &source)
            .ok_or_else(|| AppError::msg("plugin source is not a local directory in this marketplace"))?;

        let target_root = self
            .skills_dir()
            .join(safe_component(&manifest.name)?)
            .join(safe_component(&entry.name)?);
        let mut installed = Vec::new();
        for name in skill_dir_names(&plugin_dir) {
            let from = find_skill_dir(&plugin_dir, &name)
                .ok_or_else(|| AppError::msg(format!("could not locate skill \"{name}\"")))?;
            let to = target_root.join(safe_component(&name)?);
            copy_dir(&from, &to)?;
            installed.push(InstalledSkill {
                name,
                marketplace: manifest.name.clone(),
                description: entry.description.clone(),
                path: to.to_string_lossy().to_string(),
            });
        }
        if installed.is_empty() {
            return Err(AppError::msg(format!(
                "plugin \"{plugin}\" contains no skills"
            )));
        }
        Ok(installed)
    }

    pub fn list_installed(&self) -> Result<Vec<InstalledSkill>> {
        let root = self.skills_dir();
        let mut installed = Vec::new();
        let Ok(marketplaces) = std::fs::read_dir(&root) else {
            return Ok(installed);
        };
        for marketplace in marketplaces.flatten() {
            if !marketplace.path().is_dir() {
                continue;
            }
            let marketplace_name = marketplace.file_name().to_string_lossy().to_string();
            let Ok(plugins) = std::fs::read_dir(marketplace.path()) else {
                continue;
            };
            for plugin in plugins.flatten() {
                if !plugin.path().is_dir() {
                    continue;
                }
                let Ok(skills) = std::fs::read_dir(plugin.path()) else {
                    continue;
                };
                for skill in skills.flatten() {
                    let path = skill.path();
                    if !path.join("SKILL.md").is_file() {
                        continue;
                    }
                    installed.push(InstalledSkill {
                        name: skill.file_name().to_string_lossy().to_string(),
                        marketplace: marketplace_name.clone(),
                        description: skill_description(&path),
                        path: path.to_string_lossy().to_string(),
                    });
                }
            }
        }
        installed.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(installed)
    }

    pub fn uninstall_skills(&self, marketplace: &str, skill: &str) -> Result<()> {
        let root = self.skills_dir();
        let marketplace = safe_component(marketplace)?;
        let skill = safe_component(skill)?;
        let mut matches: Vec<PathBuf> = Vec::new();
        if let Ok(plugins) = std::fs::read_dir(root.join(marketplace)) {
            for plugin in plugins.flatten() {
                let candidate = plugin.path().join(skill);
                if candidate.join("SKILL.md").is_file() {
                    matches.push(candidate);
                }
            }
        }
        if matches.is_empty() {
            return Err(AppError::msg(format!(
                "no installed skill named \"{skill}\" from \"{marketplace}\""
            )));
        }
        for path in matches {
            std::fs::remove_dir_all(path)?;
        }
        Ok(())
    }

    pub fn skills_dir(&self) -> PathBuf {
        self.cache_dir.join("..").join("skills")
    }

    /// Directories of every installed skill (`<marketplace>/<plugin>/<skill>`),
    /// so the discovery layer can offer them to the agent without knowing the
    /// on-disk layout. One directory per skill, each containing `SKILL.md`.
    pub fn installed_skill_dirs(&self) -> Vec<PathBuf> {
        self.list_installed()
            .map(|entries| {
                entries
                    .into_iter()
                    .map(|entry| PathBuf::from(entry.path))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn custom_marketplace_urls(&self) -> Result<Vec<String>> {
        let path = self.cache_dir.join("marketplaces.json");
        if !path.is_file() {
            return Ok(Vec::new());
        }
        let raw = std::fs::read_to_string(path)?;
        Ok(serde_json::from_str(&raw).unwrap_or_default())
    }

    fn write_custom_marketplace_urls(&self, urls: &[String]) -> Result<()> {
        std::fs::create_dir_all(&self.cache_dir)?;
        let path = self.cache_dir.join("marketplaces.json");
        std::fs::write(path, serde_json::to_string_pretty(urls)?)?;
        Ok(())
    }

    /// Clones or fast-forwards a marketplace checkout. Uses git, matching how
    /// Claude Code distributes marketplaces.
    async fn clone_or_update(&self, url: &str, dir: &Path) -> Result<()> {
        let output = if dir.is_dir() {
            tokio::process::Command::new("git")
                .args(["-C"])
                .arg(dir)
                .args(["pull", "--ff-only", "--depth", "1"])
                .output()
                .await?
        } else {
            tokio::process::Command::new("git")
                .args(["clone", "--depth", "1", "--"])
                .arg(url)
                .arg(dir)
                .output()
                .await?
        };
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::msg(format!("git failed: {}", stderr.trim())));
        }
        Ok(())
    }
}

fn find_skill_dir(plugin_dir: &Path, name: &str) -> Option<PathBuf> {
    for base in [plugin_dir.join("skills"), plugin_dir.to_path_buf()] {
        let candidate = base.join(name);
        if candidate.join("SKILL.md").is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Pulls the `description` from a skill's YAML frontmatter, for listings.
fn skill_description(skill_dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(skill_dir.join("SKILL.md")).ok()?;
    for line in raw.lines().take(30) {
        if let Some(rest) = line.trim().strip_prefix("description:") {
            let value = rest.trim().trim_matches('"').trim_matches('\'').trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)?.flatten() {
        let path = entry.path();
        let file_type = entry.file_type()?;
        // Never follow symlinks: a marketplace checkout could otherwise point at
        // files outside it (e.g. `~/.ssh`) and copy their contents into a skill.
        if file_type.is_symlink() {
            continue;
        }
        let target = to.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir(&path, &target)?;
        } else {
            std::fs::copy(&path, &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn registry_params_add_search_only_for_a_term() {
        assert_eq!(registry_params(50, None), vec![("limit", "50".to_string())]);
        assert_eq!(
            registry_params(50, Some("  github  ")),
            vec![
                ("limit", "50".to_string()),
                ("search", "github".to_string())
            ]
        );
        assert_eq!(registry_params(50, Some("   ")), vec![("limit", "50".to_string())]);
    }

    #[test]
    fn maps_remote_server_and_verifies_namespace() {
        let entry = RegistryEntry {
            server: RegistryServer {
                name: "io.github.acme/weather".to_string(),
                title: Some("Weather".to_string()),
                description: Some("Forecasts".to_string()),
                version: Some("1.0.0".to_string()),
                remotes: vec![RegistryRemote {
                    transport: Some("streamable-http".to_string()),
                    url: Some("https://weather.example/mcp".to_string()),
                }],
                packages: Vec::new(),
                repository: None,
            },
            meta: Some(serde_json::json!({
                "io.modelcontextprotocol.registry/official": {
                    "status": "active",
                    "publishedAt": "2026-01-01T00:00:00Z"
                }
            })),
        };
        let server = map_server(entry);
        assert_eq!(server.kind, "remote");
        assert_eq!(server.url.as_deref(), Some("https://weather.example/mcp"));
        assert!(server.verified);
    }

    #[test]
    fn unnamespaced_server_is_not_verified() {
        let entry = RegistryEntry {
            server: RegistryServer {
                name: "localonly".to_string(),
                title: None,
                description: None,
                version: None,
                remotes: Vec::new(),
                packages: Vec::new(),
                repository: None,
            },
            meta: None,
        };
        assert!(!map_server(entry).verified);
    }

    #[test]
    fn maps_npx_package_to_command() {
        let entry = RegistryEntry {
            server: RegistryServer {
                name: "io.github.acme/files".to_string(),
                title: None,
                description: None,
                version: None,
                remotes: Vec::new(),
                packages: vec![RegistryPackage {
                    registry_type: Some("npm".to_string()),
                    identifier: Some("@acme/files".to_string()),
                    runtime_hint: Some("npx".to_string()),
                    environment_variables: vec![RegistryEnvVar {
                        name: Some("ACME_TOKEN".to_string()),
                        is_required: Some(true),
                        is_secret: Some(true),
                    }],
                }],
                repository: None,
            },
            meta: None,
        };
        let server = map_server(entry);
        assert_eq!(server.command.as_deref(), Some("npx"));
        assert_eq!(server.args, vec!["-y", "@acme/files", "mcp"]);
        assert_eq!(server.env.len(), 1);
        assert!(server.env[0].required && server.env[0].secret);
    }

    #[test]
    fn reserved_marketplace_names_are_flagged() {
        assert!(is_reserved("Agent-Skills"));
        assert!(!is_reserved("acme-tools"));
    }

    #[test]
    fn pinned_commit_verifies_only_on_exact_match() {
        let pins = [CuratedMarketplace {
            url: "https://github.com/acme/marketplace",
            commit: "abc123",
        }];
        assert!(verify_pin(
            "https://github.com/acme/marketplace",
            Some("abc123"),
            &pins
        ));
        assert!(!verify_pin(
            "https://github.com/acme/marketplace",
            Some("deadbeef"),
            &pins
        ));
        assert!(!verify_pin(
            "https://github.com/other/marketplace",
            Some("abc123"),
            &pins
        ));
        assert!(!verify_pin("https://github.com/acme/marketplace", None, &pins));
    }

    #[test]
    fn maps_directory_remote_with_cli_and_stars() {
        let entry: DirectoryEntry = serde_json::from_value(serde_json::json!({
            "name": "browser-use",
            "displayName": "Browser Use",
            "description": "Control a real Chrome browser",
            "category": "browser-automation",
            "sourceRegistry": "official-mcp",
            "githubStars": 111682,
            "githubUrl": "https://github.com/browser-use/browser-use",
            "packages": null,
            "remotes": [{ "type": "streamable-http", "url": "https://example.com/mcp" }],
            "environmentVariables": null,
            "installationMethods": [{
                "type": "remote",
                "recommended": true,
                "command": "https://example.com/mcp",
                "claudeCode": "claude mcp add --transport http browser-use https://example.com/mcp"
            }]
        }))
        .unwrap();

        let server = map_directory(entry);
        assert_eq!(server.display_name, "Browser Use");
        assert_eq!(server.category, "browser-automation");
        assert_eq!(server.github_stars, 111_682);
        assert_eq!(server.install.url.as_deref(), Some("https://example.com/mcp"));
        assert!(server.install.command.is_none());
        assert!(server.install.cli.unwrap().starts_with("claude mcp add"));
    }

    #[test]
    fn maps_directory_package_to_runtime_command() {
        let package: DirectoryPackage = serde_json::from_value(serde_json::json!({
            "registryType": "pypi",
            "identifier": "browser-use",
            "runtimeHint": "uvx",
            "packageArguments": [{ "value": "--cli-mcp", "type": "positional" }]
        }))
        .unwrap();
        let (command, args) = directory_package_command(&package);
        assert_eq!(command.as_deref(), Some("uvx"));
        assert_eq!(args, vec!["browser-use", "--cli-mcp"]);

        let npm: DirectoryPackage = serde_json::from_value(serde_json::json!({
            "registryType": "npm",
            "identifier": "@acme/files",
            "runtimeHint": "npx"
        }))
        .unwrap();
        let (command, args) = directory_package_command(&npm);
        assert_eq!(command.as_deref(), Some("npx"));
        assert_eq!(args, vec!["-y", "@acme/files"]);
    }

    #[test]
    fn maps_directory_and_falls_back_to_name() {
        let entry: DirectoryEntry = serde_json::from_value(serde_json::json!({
            "name": "signatures",
            "sourceRegistry": "docker",
            "dockerPulls": 18858,
            "installationMethods": [{
                "type": "docker",
                "recommended": true,
                "command": "docker mcp server enable signatures",
                "requirements": ["Docker Desktop"]
            }]
        }))
        .unwrap();

        let server = map_directory(entry);
        assert_eq!(server.display_name, "signatures");
        assert_eq!(server.category, "");
        assert_eq!(server.docker_pulls, 18_858);
        assert!(server.install.url.is_none());
        assert!(server.install.command.is_none());
        assert_eq!(
            server.install.cli.as_deref(),
            Some("docker mcp server enable signatures")
        );
    }

    #[test]
    fn reads_manifest_and_finds_skills() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".claude-plugin")).unwrap();
        fs::write(
            root.join(".claude-plugin/marketplace.json"),
            r#"{
                "name": "acme-tools",
                "owner": { "name": "Acme" },
                "plugins": [{
                    "name": "review",
                    "source": "./plugins/review",
                    "category": "Development & Code",
                    "repository": "https://github.com/acme/review"
                }]
            }"#,
        )
        .unwrap();
        fs::create_dir_all(root.join("plugins/review/skills/quality-review")).unwrap();
        fs::write(
            root.join("plugins/review/skills/quality-review/SKILL.md"),
            "---\ndescription: Review code\n---\nBody",
        )
        .unwrap();

        let marketplace = read_manifest(root, None, "custom").unwrap();
        assert_eq!(marketplace.name, "acme-tools");
        assert_eq!(marketplace.plugins[0].skills, vec!["quality-review"]);
        assert_eq!(
            marketplace.plugins[0].category.as_deref(),
            Some("Development & Code")
        );
        assert_eq!(
            marketplace.plugins[0].repository.as_deref(),
            Some("https://github.com/acme/review")
        );
        assert!(!marketplace.verified);
        assert!(!marketplace.spoofed_name);
    }

    #[test]
    fn lists_installed_skill_dirs_for_discovery() {
        let dir = tempfile::tempdir().unwrap();
        let service = MarketplaceService::new(reqwest::Client::new(), dir.path().join("marketplaces"));
        let skill = service
            .skills_dir()
            .join("acme-tools")
            .join("review")
            .join("quality-review");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), "---\ndescription: Review code\n---\n").unwrap();

        let dirs = service.installed_skill_dirs();
        assert_eq!(dirs, vec![skill]);

        let installed = service.list_installed().unwrap();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].name, "quality-review");
        assert_eq!(installed[0].description.as_deref(), Some("Review code"));
    }
}