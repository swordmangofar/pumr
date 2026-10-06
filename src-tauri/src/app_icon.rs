//! Shows the logo picked in the settings as the app icon while pumr runs: the
//! Dock icon on macOS, the window and taskbar icon on Windows and Linux.
//!
//! The icon inside the bundle is fixed at build time, so Finder, the installer
//! and the Dock entry of a closed app keep the default logo. Wayland takes the
//! icon from the desktop entry and ignores the window icon as well.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::image::Image;
use tauri::{AppHandle, Manager};

/// The logo the bundle icon is built from, `DEFAULT_MARK` in scripts/icon.mjs.
const BUNDLED: &str = "mascot";

/// Set once the bundle icon has been replaced. Until then the default logo
/// needs no work, which also leaves the DEV badge of a dev build alone.
static REPLACED: AtomicBool = AtomicBool::new(false);

/// Maps a saved logo id to one this build has an icon for. The ids are the
/// ones in `LOGOS` (src/app/core/logos.ts); an unknown id means the default
/// logo there too.
fn known(logo: &str) -> &'static str {
    match logo {
        "classic" => "classic",
        "shaded" => "shaded",
        "tailup" => "tailup",
        _ => BUNDLED,
    }
}

/// The plates are written by scripts/icon-build.mjs.
fn window_icon(logo: &str) -> Image<'static> {
    match logo {
        "classic" => tauri::include_image!("./icons/logos/classic-256.png"),
        "shaded" => tauri::include_image!("./icons/logos/shaded-256.png"),
        "tailup" => tauri::include_image!("./icons/logos/tailup-256.png"),
        _ => tauri::include_image!("./icons/logos/mascot-256.png"),
    }
}

#[cfg(target_os = "macos")]
fn dock_icon(logo: &str) -> &'static [u8] {
    match logo {
        "classic" => include_bytes!("../icons/logos/classic.png"),
        "shaded" => include_bytes!("../icons/logos/shaded.png"),
        "tailup" => include_bytes!("../icons/logos/tailup.png"),
        _ => include_bytes!("../icons/logos/mascot.png"),
    }
}

pub fn apply(app: &AppHandle, logo: &str) {
    let logo = known(logo);
    if logo == BUNDLED && !REPLACED.load(Ordering::Relaxed) {
        return;
    }
    REPLACED.store(true, Ordering::Relaxed);

    // A no-op on macOS, where windows carry no icon of their own.
    for window in app.webview_windows().values() {
        if let Err(error) = window.set_icon(window_icon(logo)) {
            log::warn!("could not set the window icon: {error}");
        }
    }

    #[cfg(target_os = "macos")]
    set_dock_icon(app, dock_icon(logo));
}

#[cfg(target_os = "macos")]
fn set_dock_icon(app: &AppHandle, png: &'static [u8]) {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let result = app.run_on_main_thread(move || {
        let Some(main_thread) = MainThreadMarker::new() else {
            return;
        };
        let data = NSData::with_bytes(png);
        let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
            log::warn!("could not decode the Dock icon");
            return;
        };
        // SAFETY: AppKit is only touched on the main thread, and the image
        // stays alive for the call; the application retains it afterwards.
        unsafe {
            NSApplication::sharedApplication(main_thread).setApplicationIconImage(Some(&image));
        }
    });
    if let Err(error) = result {
        log::warn!("could not schedule the Dock icon change: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_logos_fall_back_to_the_bundled_one() {
        assert_eq!(known("classic"), "classic");
        assert_eq!(known("shaded"), "shaded");
        assert_eq!(known("tailup"), "tailup");
        assert_eq!(known("mascot"), BUNDLED);
        assert_eq!(known("removed-logo"), BUNDLED);
        assert_eq!(known(""), BUNDLED);
    }

    #[test]
    fn every_logo_has_a_square_window_icon() {
        for logo in [BUNDLED, "classic", "shaded", "tailup"] {
            let icon = window_icon(logo);
            assert_eq!((icon.width(), icon.height()), (256, 256));
        }
    }
}
