//! The agent's `screenshot` tool: shows the user a picture in the chat, so a
//! change to a user interface can be looked at and answered right there.
//!
//! The picture is stored with the tool result as an attachment, like the
//! images a user attaches to a prompt. It therefore lives and dies with the
//! chat's messages, and is never sent to the model: the model gets a line of
//! text and what the page logged to the browser console.

use crate::broker::PermissionOperation;
use crate::models::Attachment;
use crate::permissions;
use crate::processes::kill_tree;
use crate::tools::{
    arg_str, ensure_path_access, ensure_website_access, relative_display, ToolOutcome,
    ToolRuntime, WebsiteAccess,
};
use base64::Engine;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use uuid::Uuid;

const DEFAULT_WIDTH: u64 = 1280;
const DEFAULT_HEIGHT: u64 = 800;
/// Largest picture a chat stores, in bytes.
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
/// How long the browser gets to load and render a page.
const RENDER_TIMEOUT: Duration = Duration::from_secs(30);
/// Time the page's own timers and requests get to settle, in milliseconds of
/// the page's clock. The browser runs it fast-forward.
const PAGE_SETTLE_MS: u64 = 5_000;
/// Console lines of the page handed to the agent, and how long each may be.
const MAX_CONSOLE_LINES: usize = 15;
const MAX_CONSOLE_COLUMNS: usize = 300;

const NO_BROWSER: &str = "No browser was found to render the page (looked for Playwright's Chromium, Google Chrome, Chromium and Microsoft Edge). Take the picture another way, for example with the project's own end-to-end test tooling, save it to the scratch folder and call screenshot with path.";

pub async fn take(runtime: &mut ToolRuntime, arguments: &Value) -> ToolOutcome {
    let text = |key: &str| {
        arguments
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let caption = text("caption");
    let size = |key: &str, default: u64, max: u64| {
        arguments
            .get(key)
            .and_then(Value::as_u64)
            .unwrap_or(default)
            .clamp(240, max)
    };
    let (width, height) = (
        size("width", DEFAULT_WIDTH, 2_560),
        size("height", DEFAULT_HEIGHT, 6_000),
    );

    if let Some(url) = text("url") {
        let parsed = match reqwest::Url::parse(&url) {
            Ok(parsed) => parsed,
            Err(error) => return ToolOutcome::error(format!("Invalid URL: {error}")),
        };
        if !matches!(parsed.scheme(), "http" | "https") {
            return ToolOutcome::error(
                "Only http(s) URLs can be rendered. Pass a file with path instead.",
            );
        }
        // The project's own dev server needs no approval; any other site
        // goes through the website rules like a fetch.
        if !is_local(&parsed) {
            match ensure_website_access(runtime, parsed.as_str(), "web").await {
                WebsiteAccess::Allowed => {}
                WebsiteAccess::DeniedByRule(reason) => {
                    return ToolOutcome::error(format!("Blocked: {reason}"))
                }
                WebsiteAccess::Refused(decision) => return ToolOutcome::refused(&decision),
            }
        }
        let label = caption.unwrap_or_else(|| url.clone());
        return render(runtime, parsed.as_str(), &label, width, height).await;
    }

    let path = match arg_str(arguments, "path") {
        Ok(path) => path,
        Err(_) => {
            return ToolOutcome::error(
                "Give the page to render as url, or an image or HTML file as path.",
            )
        }
    };
    let absolute = permissions::resolve_path(&runtime.project_root, &path);
    if let Err(outcome) =
        ensure_path_access(runtime, &absolute, "file", PermissionOperation::Read).await
    {
        return outcome;
    }
    let relative = relative_display(runtime, &absolute);
    if !absolute.is_file() {
        return ToolOutcome::error(format!("{relative} is not a file."));
    }
    let extension = absolute
        .extension()
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let label = caption.unwrap_or_else(|| relative.clone());
    if matches!(extension.as_str(), "html" | "htm" | "svg") {
        let Ok(page) = reqwest::Url::from_file_path(&absolute) else {
            return ToolOutcome::error(format!("{relative} cannot be opened as a page."));
        };
        return render(runtime, page.as_str(), &label, width, height).await;
    }
    let Some(mime_type) = image_type(&extension) else {
        return ToolOutcome::error(format!(
            "{relative} is neither an image (png, jpg, webp, gif) nor an HTML file."
        ));
    };
    let bytes = match tokio::fs::read(&absolute).await {
        Ok(bytes) => bytes,
        Err(error) => return ToolOutcome::error(format!("Cannot read {relative}: {error}")),
    };
    match picture(&label, mime_type, &bytes) {
        Ok(attachment) => shown(format!("Shown to the user in the chat: {label}."), attachment),
        Err(reason) => ToolOutcome::error(reason),
    }
}

fn image_type(extension: &str) -> Option<&'static str> {
    match extension {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

/// Whether `url` points at this machine: a dev server of the project.
fn is_local(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    match host.parse::<std::net::IpAddr>() {
        Ok(address) => address.is_loopback(),
        Err(_) => host == "localhost" || host.ends_with(".localhost"),
    }
}

fn picture(label: &str, mime_type: &str, bytes: &[u8]) -> std::result::Result<Attachment, String> {
    if bytes.is_empty() {
        return Err("The picture is empty.".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "The picture is {} MB, more than the {} MB a chat stores. Use a smaller viewport or image.",
            bytes.len() / (1024 * 1024),
            MAX_IMAGE_BYTES / (1024 * 1024)
        ));
    }
    Ok(Attachment {
        id: Uuid::new_v4().to_string(),
        name: label.chars().take(200).collect(),
        mime_type: mime_type.to_string(),
        size: bytes.len() as i64,
        kind: "image".to_string(),
        lines: None,
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

fn shown(result: String, attachment: Attachment) -> ToolOutcome {
    let mut outcome = ToolOutcome::ok(format!(
        "{result}\nYou do not see the picture yourself. If you need the user's verdict on it, ask with the question tool."
    ));
    outcome.attachments = vec![attachment];
    outcome
}

/// Renders `page` in a headless browser and shows the picture.
async fn render(
    runtime: &mut ToolRuntime,
    page: &str,
    label: &str,
    width: u64,
    height: u64,
) -> ToolOutcome {
    let Some(browser) = find_browser() else {
        return ToolOutcome::error(NO_BROWSER);
    };
    let name: String = runtime
        .call_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .collect();
    let folder = runtime
        .permissions
        .ensure_scratch_dir(&runtime.conversation_id)
        .unwrap_or_else(std::env::temp_dir);
    let profile = folder.join(format!("browser-{name}"));
    let image = folder.join(format!("screenshot-{name}.png"));

    let mut command = Command::new(&browser.path);
    if !browser.headless_shell {
        command.arg("--headless=new");
    }
    command
        .args([
            "--disable-gpu",
            "--hide-scrollbars",
            "--mute-audio",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-sync",
            "--disable-background-networking",
            "--disable-component-update",
            "--enable-logging=stderr",
            "--v=0",
        ])
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(format!("--window-size={width},{height}"))
        .arg(format!("--virtual-time-budget={PAGE_SETTLE_MS}"))
        .arg(format!("--screenshot={}", image.display()))
        .arg(page)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return ToolOutcome::error(format!(
                "Cannot start {}: {error}",
                browser.path.display()
            ))
        }
    };
    let pid = child.id();
    let log = tokio::spawn({
        let mut stderr = child.stderr.take();
        async move {
            let mut bytes = Vec::new();
            if let Some(stderr) = stderr.as_mut() {
                let _ = stderr.read_to_end(&mut bytes).await;
            }
            String::from_utf8_lossy(&bytes).into_owned()
        }
    });

    enum End {
        Exited,
        TimedOut,
        Cancelled,
    }
    let end = tokio::select! {
        _ = child.wait() => End::Exited,
        _ = tokio::time::sleep(RENDER_TIMEOUT) => End::TimedOut,
        _ = runtime.cancel.cancelled() => End::Cancelled,
    };
    if !matches!(end, End::Exited) {
        kill_tree(&mut child, pid);
        let _ = child.wait().await;
    }
    let log = tokio::time::timeout(Duration::from_secs(2), log)
        .await
        .ok()
        .and_then(|joined| joined.ok())
        .unwrap_or_default();
    let bytes = tokio::fs::read(&image).await;
    let _ = tokio::fs::remove_file(&image).await;
    let _ = tokio::fs::remove_dir_all(&profile).await;

    if matches!(end, End::Cancelled) {
        return ToolOutcome::cancelled();
    }
    let console = console_lines(&log);
    let attachment = match bytes {
        Ok(bytes) => match picture(label, "image/png", &bytes) {
            Ok(attachment) => attachment,
            Err(reason) => return ToolOutcome::error(reason),
        },
        Err(_) => {
            let cause = if matches!(end, End::TimedOut) {
                format!(
                    "the browser did not finish within {}s",
                    RENDER_TIMEOUT.as_secs()
                )
            } else {
                "the browser wrote no picture".to_string()
            };
            let mut reason = format!("Could not render {page}: {cause}. Check that the page is being served.");
            if !console.is_empty() {
                reason.push_str(&format!(
                    "\nThe page logged to the console:\n{}",
                    console.join("\n")
                ));
            }
            return ToolOutcome::error(reason);
        }
    };
    let logged = if console.is_empty() {
        "The page logged nothing to the browser console.".to_string()
    } else {
        format!(
            "The page logged to the browser console:\n{}",
            console.join("\n")
        )
    };
    shown(
        format!("Shown to the user in the chat: {label} ({width}×{height}).\n{logged}"),
        attachment,
    )
}

/// What the page wrote to the browser console, from the browser's own log:
/// its `console.*` calls and uncaught errors, the newest last.
fn console_lines(log: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for line in log.lines() {
        let Some(at) = line.find(":CONSOLE") else {
            continue;
        };
        let Some(message) = line[at..].split_once("] ").map(|(_, message)| message.trim()) else {
            continue;
        };
        let mut entry: String = message.chars().take(MAX_CONSOLE_COLUMNS).collect();
        if message.chars().count() > MAX_CONSOLE_COLUMNS {
            entry.push('…');
        }
        let entry = format!("- {entry}");
        if lines.last() != Some(&entry) {
            lines.push(entry);
        }
    }
    if lines.len() > MAX_CONSOLE_LINES {
        let dropped = lines.len() - MAX_CONSOLE_LINES;
        lines.drain(..dropped);
        lines.insert(0, format!("- … ({dropped} earlier lines left out)"));
    }
    lines
}

struct Browser {
    path: PathBuf,
    /// Playwright's `chrome-headless-shell`, which is headless as it is.
    headless_shell: bool,
}

/// A Chromium-based browser that renders a page to a picture from the command
/// line: Playwright's headless shell when the machine has one, otherwise an
/// installed Chrome, Chromium or Edge. `PUMR_BROWSER` names one outright.
fn find_browser() -> Option<Browser> {
    if let Some(path) = std::env::var_os("PUMR_BROWSER").map(PathBuf::from) {
        if path.is_file() {
            let headless_shell = is_headless_shell(&path);
            return Some(Browser {
                path,
                headless_shell,
            });
        }
    }
    if let Some(path) = playwright_shell() {
        return Some(Browser {
            path,
            headless_shell: true,
        });
    }
    installed_browsers()
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| Browser {
            path,
            headless_shell: false,
        })
}

fn is_headless_shell(path: &Path) -> bool {
    path.file_stem()
        .map(|name| name.to_string_lossy().replace('_', "-"))
        .is_some_and(|name| name.ends_with("headless-shell"))
}

/// The newest headless shell among the browsers Playwright has downloaded.
fn playwright_shell() -> Option<PathBuf> {
    let root = std::env::var_os("PLAYWRIGHT_BROWSERS_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(playwright_cache)?;
    let mut revisions: Vec<(u64, PathBuf)> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let revision = name.strip_prefix("chromium_headless_shell-")?.parse().ok()?;
            Some((revision, entry.path()))
        })
        .collect();
    revisions.sort();
    revisions.into_iter().rev().find_map(|(_, folder)| {
        std::fs::read_dir(folder)
            .ok()?
            .flatten()
            .flat_map(|platform| std::fs::read_dir(platform.path()).into_iter().flatten())
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.is_file() && is_headless_shell(path))
    })
}

fn playwright_cache() -> Option<PathBuf> {
    let cache = if cfg!(target_os = "macos") {
        PathBuf::from(std::env::var_os("HOME")?).join("Library/Caches")
    } else if cfg!(windows) {
        PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
    } else {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| Some(PathBuf::from(std::env::var_os("HOME")?).join(".cache")))?
    };
    Some(cache.join("ms-playwright")).filter(|path| path.is_dir())
}

/// Where Chrome, Chromium and Edge are installed on this platform.
fn installed_browsers() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        let apps = [
            "Google Chrome.app/Contents/MacOS/Google Chrome",
            "Chromium.app/Contents/MacOS/Chromium",
            "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ];
        let home = std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Applications"));
        for root in std::iter::once(PathBuf::from("/Applications")).chain(home) {
            candidates.extend(apps.iter().map(|app| root.join(app)));
        }
    } else if cfg!(windows) {
        let apps = [
            "Google\\Chrome\\Application\\chrome.exe",
            "Chromium\\Application\\chrome.exe",
            "Microsoft\\Edge\\Application\\msedge.exe",
        ];
        for variable in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(root) = std::env::var_os(variable).map(PathBuf::from) {
                candidates.extend(apps.iter().map(|app| root.join(app)));
            }
        }
    } else {
        let names = [
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
            "microsoft-edge",
            "microsoft-edge-stable",
        ];
        let folders: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|path| std::env::split_paths(&path).collect())
            .unwrap_or_default();
        for name in names {
            candidates.extend(folders.iter().map(|folder| folder.join(name)));
        }
    }
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::tests::test_runtime;
    use serde_json::json;

    #[test]
    fn only_this_machine_counts_as_local() {
        let local = |url: &str| is_local(&reqwest::Url::parse(url).unwrap());
        assert!(local("http://localhost:4200/settings"));
        assert!(local("http://app.localhost:3000/"));
        assert!(local("http://127.0.0.1:8080/"));
        assert!(local("http://[::1]:8080/"));
        assert!(!local("http://192.168.1.20:8080/"));
        assert!(!local("https://example.com/"));
        assert!(!local("https://localhost.example.com/"));
    }

    #[test]
    fn console_lines_are_taken_from_the_browser_log() {
        let log = r#"[1003/185434.784572:WARNING:net/dns/address_sorter_posix.cc:559] FromSockAddr failed
[1003/185434.784572:INFO:CONSOLE:2] "plain log", source: http://localhost:4200/main.js (2)
[1003/185434.784595:INFO:CONSOLE:2] "plain log", source: http://localhost:4200/main.js (2)
[3209:20056235:1003/185247.894869:INFO:CONSOLE(7)] "Uncaught ReferenceError: nope is not defined", source: http://localhost:4200/main.js (7)
9268 bytes written to file /tmp/out.png"#;
        assert_eq!(
            console_lines(log),
            vec![
                r#"- "plain log", source: http://localhost:4200/main.js (2)"#.to_string(),
                r#"- "Uncaught ReferenceError: nope is not defined", source: http://localhost:4200/main.js (7)"#
                    .to_string(),
            ]
        );
    }

    #[test]
    fn a_long_console_keeps_its_newest_lines() {
        let log: String = (0..40)
            .map(|index| format!("[1:INFO:CONSOLE:1] \"line {index}\", source: a (1)\n"))
            .collect();
        let lines = console_lines(&log);
        assert_eq!(lines.len(), MAX_CONSOLE_LINES + 1);
        assert!(lines[0].contains("25 earlier lines"));
        assert!(lines.last().unwrap().contains("line 39"));
    }

    #[test]
    fn the_headless_shell_is_told_from_a_browser() {
        assert!(is_headless_shell(Path::new("/x/chrome-headless-shell")));
        assert!(is_headless_shell(Path::new("C:/x/chrome-headless-shell.exe")));
        assert!(is_headless_shell(Path::new("/x/headless_shell")));
        assert!(!is_headless_shell(Path::new("/x/Google Chrome")));
    }

    #[tokio::test]
    async fn an_image_file_is_shown_as_an_attachment() {
        let project = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("shot.png"), b"\x89PNG fake").unwrap();
        let mut runtime = test_runtime(project.path(), data.path());

        let outcome = take(
            &mut runtime,
            &json!({ "path": "shot.png", "caption": "Settings page" }),
        )
        .await;
        assert_eq!(outcome.status, "ok", "{}", outcome.result);
        assert!(outcome.result.contains("Settings page"));
        assert_eq!(outcome.attachments.len(), 1);
        let attachment = &outcome.attachments[0];
        assert_eq!(attachment.kind, "image");
        assert_eq!(attachment.mime_type, "image/png");
        assert_eq!(attachment.name, "Settings page");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&attachment.data)
                .unwrap(),
            b"\x89PNG fake"
        );
    }

    #[tokio::test]
    async fn what_is_no_picture_is_refused() {
        let project = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("notes.txt"), "text").unwrap();
        let mut runtime = test_runtime(project.path(), data.path());

        let outcome = take(&mut runtime, &json!({ "path": "notes.txt" })).await;
        assert_eq!(outcome.status, "error");
        assert!(outcome.attachments.is_empty());

        let outcome = take(&mut runtime, &json!({})).await;
        assert_eq!(outcome.status, "error");

        let outcome = take(&mut runtime, &json!({ "url": "ftp://localhost/x" })).await;
        assert_eq!(outcome.status, "error");
    }

    /// Renders a real page. Needs a browser, so it only runs on request:
    /// `cargo test -- --ignored renders_a_page`.
    #[tokio::test]
    #[ignore]
    async fn renders_a_page() {
        let project = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        std::fs::write(
            project.path().join("page.html"),
            "<h1>Hello</h1><script>console.log('rendered'); nope()</script>",
        )
        .unwrap();
        let mut runtime = test_runtime(project.path(), data.path());

        let outcome = take(&mut runtime, &json!({ "path": "page.html" })).await;
        assert_eq!(outcome.status, "ok", "{}", outcome.result);
        assert!(outcome.result.contains("rendered"), "{}", outcome.result);
        assert!(outcome.result.contains("nope is not defined"), "{}", outcome.result);
        let picture = base64::engine::general_purpose::STANDARD
            .decode(&outcome.attachments[0].data)
            .unwrap();
        assert!(picture.starts_with(b"\x89PNG"));
    }
}
