//! Keeps WebKitGTK rendering on Linux graphics setups that kill it at startup.
//!
//! WebKitGTK hands its frames to the compositor as GPU buffers. On some
//! driver and compositor combinations the compositor rejects them, and GDK
//! then ends the whole process before a window appears:
//! `Error 71 (Protocol error) dispatching to Wayland display`. On X11 the same
//! buffers leave the window blank or its text blurry instead. Three layers
//! keep pumr starting and sharp anyway:
//!
//! - X11 sessions use WebKitGTK's renderer without GPU buffers from the start.
//! - The proprietary NVIDIA driver on Wayland is the known case. Turning the
//!   driver's explicit sync off avoids the error and keeps GPU rendering.
//! - Any other setup is caught after the fact. A marker in the cache directory
//!   records a start that has not settled yet; finding it on the next start
//!   means the last one died early, and pumr falls back to WebKitGTK's slower
//!   renderer without GPU buffers from then on. Deleting the marker
//!   (`~/.cache/<identifier>/webkit-startup`) makes pumr try the fast one again.
//!
//! macOS and Windows use other webviews and are left alone.

use crate::appimage::xdg_cache_home;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

const DISABLE_EXPLICIT_SYNC: &str = "__NV_DISABLE_EXPLICIT_SYNC";
const DISABLE_DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
const DISABLE_COMPOSITING: &str = "WEBKIT_DISABLE_COMPOSITING_MODE";
const STARTING: &str = "starting";
const FALLBACK: &str = "fallback";
/// How long a start has to survive to count as working. The protocol error
/// ends the process with the first rendered frame.
const SETTLE: Duration = Duration::from_secs(20);

/// Tracks whether this start gets as far as a working window.
#[derive(Clone)]
pub struct StartupGuard {
    marker: Option<PathBuf>,
}

impl StartupGuard {
    /// Records that this start worked, so the next one renders the same way.
    pub fn settled(&self) {
        if let Some(marker) = &self.marker {
            settle(marker);
        }
    }
}

/// Picks the rendering environment for this start and begins watching it.
/// Must run before any thread or webview exists, as the web process inherits
/// the environment.
pub fn prepare(identifier: &str) -> StartupGuard {
    let inert = StartupGuard { marker: None };
    if !cfg!(target_os = "linux") {
        return inert;
    }
    let var = |key: &str| std::env::var_os(key);
    let nvidia = ["/proc/driver/nvidia/version", "/sys/module/nvidia"]
        .iter()
        .any(|path| Path::new(path).exists());
    if needs_explicit_sync_off(nvidia, var) {
        std::env::set_var(DISABLE_EXPLICIT_SYNC, "1");
    }
    // A renderer the user picked is theirs to keep, working or not.
    if var(DISABLE_DMABUF).is_some() {
        return inert;
    }
    if !on_wayland(var) {
        std::env::set_var(DISABLE_DMABUF, "1");
        return inert;
    }
    let Some(cache) = xdg_cache_home(var) else {
        return inert;
    };
    let marker = cache.join(identifier).join("webkit-startup");
    if begin(&marker) {
        std::env::set_var(DISABLE_DMABUF, "1");
    }
    let guard = StartupGuard {
        marker: Some(marker),
    };
    let settling = guard.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SETTLE);
        settling.settled();
    });
    guard
}

/// Whether the webview paints on the CPU, without GPU compositing: the
/// renderer [`prepare`] picks for X11 and falls back to on Wayland. Every
/// repaint then runs on the page's own thread, so the interface keeps them
/// small and rare (`data-renderer` in `styles.css`). Call after [`prepare`].
pub fn software() -> bool {
    cfg!(target_os = "linux") && paints_on_cpu(|key| std::env::var_os(key))
}

/// WebKitGTK reads both switches the same way: set to anything but `0`.
fn paints_on_cpu(var: impl Fn(&str) -> Option<OsString>) -> bool {
    [DISABLE_DMABUF, DISABLE_COMPOSITING]
        .iter()
        .any(|key| var(key).is_some_and(|value| value != "0"))
}

fn needs_explicit_sync_off(nvidia: bool, var: impl Fn(&str) -> Option<OsString>) -> bool {
    nvidia && on_wayland(&var) && var(DISABLE_EXPLICIT_SYNC).is_none()
}

/// Whether the window talks to a Wayland compositor rather than an X server.
fn on_wayland(var: impl Fn(&str) -> Option<OsString>) -> bool {
    // GDK_BACKEND=x11 runs the window through XWayland.
    let forced_x11 = var("GDK_BACKEND").is_some_and(|backend| backend == "x11");
    wayland_session(&var) && !forced_x11
}

/// Whether the desktop is a Wayland one, whichever way pumr's own window
/// reaches it.
pub(crate) fn wayland_session(var: impl Fn(&str) -> Option<OsString>) -> bool {
    var("WAYLAND_DISPLAY").is_some()
        || var("XDG_SESSION_TYPE").is_some_and(|kind| kind == "wayland")
}

/// Marks a start as under way and reports whether it has to use the fallback
/// renderer: an earlier start left its marker behind, or already fell back.
fn begin(marker: &Path) -> bool {
    let fallback = marker.exists();
    if let Some(dir) = marker.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(marker, if fallback { FALLBACK } else { STARTING });
    fallback
}

/// Clears the marker of a start that worked. A fallback marker stays, as the
/// renderer it replaced would fail again.
fn settle(marker: &Path) {
    if std::fs::read_to_string(marker).is_ok_and(|state| state == STARTING) {
        let _ = std::fs::remove_file(marker);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup(vars: Vec<(&'static str, &'static str)>) -> impl Fn(&str) -> Option<OsString> {
        move |key| vars.iter().find(|(k, _)| *k == key).map(|(_, v)| v.into())
    }

    #[test]
    fn nvidia_on_wayland_turns_explicit_sync_off() {
        assert!(needs_explicit_sync_off(
            true,
            lookup(vec![("WAYLAND_DISPLAY", "wayland-0")])
        ));
        assert!(needs_explicit_sync_off(
            true,
            lookup(vec![("XDG_SESSION_TYPE", "wayland")])
        ));
    }

    #[test]
    fn other_sessions_and_existing_choices_keep_explicit_sync() {
        // Other GPU drivers do not hit the protocol error this way.
        assert!(!needs_explicit_sync_off(
            false,
            lookup(vec![("WAYLAND_DISPLAY", "wayland-0")])
        ));
        // X11 sessions, native or forced through XWayland.
        assert!(!needs_explicit_sync_off(
            true,
            lookup(vec![("XDG_SESSION_TYPE", "x11")])
        ));
        assert!(!needs_explicit_sync_off(
            true,
            lookup(vec![("WAYLAND_DISPLAY", "wayland-0"), ("GDK_BACKEND", "x11")])
        ));
        // The user's own setting wins, including "0".
        assert!(!needs_explicit_sync_off(
            true,
            lookup(vec![
                ("WAYLAND_DISPLAY", "wayland-0"),
                (DISABLE_EXPLICIT_SYNC, "0")
            ])
        ));
    }

    #[test]
    fn cpu_painting_follows_the_webkit_switches() {
        assert!(paints_on_cpu(lookup(vec![(DISABLE_DMABUF, "1")])));
        assert!(paints_on_cpu(lookup(vec![(DISABLE_COMPOSITING, "1")])));
        // WebKitGTK takes any value but "0" as a yes, the empty one included.
        assert!(paints_on_cpu(lookup(vec![(DISABLE_DMABUF, "")])));
        assert!(!paints_on_cpu(lookup(vec![(DISABLE_DMABUF, "0")])));
        assert!(!paints_on_cpu(lookup(vec![("WAYLAND_DISPLAY", "wayland-0")])));
    }

    #[test]
    fn x11_sessions_are_told_apart_from_wayland() {
        assert!(on_wayland(lookup(vec![("WAYLAND_DISPLAY", "wayland-0")])));
        assert!(!on_wayland(lookup(vec![
            ("DISPLAY", ":0"),
            ("XDG_SESSION_TYPE", "x11")
        ])));
        assert!(!on_wayland(lookup(vec![
            ("WAYLAND_DISPLAY", "wayland-0"),
            ("GDK_BACKEND", "x11")
        ])));
        assert!(!on_wayland(lookup(vec![])));
        // The session stays a Wayland one when the window goes through XWayland.
        assert!(wayland_session(lookup(vec![
            ("WAYLAND_DISPLAY", "wayland-0"),
            ("GDK_BACKEND", "x11")
        ])));
        assert!(!wayland_session(lookup(vec![("XDG_SESSION_TYPE", "x11")])));
    }

    #[test]
    fn a_start_that_settles_leaves_the_next_one_on_the_fast_renderer() {
        let cache = tempfile::tempdir().unwrap();
        let marker = cache.path().join("dev.pumr.app/webkit-startup");

        assert!(!begin(&marker));
        settle(&marker);
        assert!(!marker.exists());
        assert!(!begin(&marker));
    }

    #[test]
    fn a_start_that_died_early_puts_later_ones_on_the_fallback_renderer() {
        let cache = tempfile::tempdir().unwrap();
        let marker = cache.path().join("dev.pumr.app/webkit-startup");

        // The first start never settles: the process was gone by then.
        assert!(!begin(&marker));

        // Every later one falls back, also after one of them worked.
        assert!(begin(&marker));
        settle(&marker);
        assert!(begin(&marker));
    }
}
