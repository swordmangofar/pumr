use crate::config::{clamp_zoom, WindowSettings, WINDOW_TOGGLE_MINIMIZE};
use crate::state::AppState;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, PhysicalPosition};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

/// Reconciles the webview zoom and the system-wide window-toggle shortcut with
/// the current settings.
///
/// Any previously registered shortcut is dropped first so changing the key or
/// disabling the feature never leaves a stale registration behind.
pub fn apply(app: &AppHandle, settings: &WindowSettings) {
    apply_zoom(app, settings.zoom);
    let shortcuts = app.global_shortcut();
    if let Err(error) = shortcuts.unregister_all() {
        log::warn!("could not clear global shortcuts: {error}");
    }
    if !settings.window_toggle_enabled {
        log::info!("window toggle shortcut disabled");
        return;
    }
    let hotkey = settings.window_toggle_hotkey.trim();
    if hotkey.is_empty() {
        return;
    }
    match shortcuts.register(hotkey) {
        Ok(()) => log::info!("registered window toggle shortcut \"{hotkey}\""),
        Err(error) => log::warn!("could not register window toggle shortcut \"{hotkey}\": {error}"),
    }
}

/// Interface zoom last requested through the settings, kept so it can be
/// re-applied when the desktop font DPI changes.
static REQUESTED_ZOOM: Mutex<f64> = Mutex::new(1.0);

/// Applies the interface zoom to the main webview.
pub fn apply_zoom(app: &AppHandle, zoom: f64) {
    let zoom = clamp_zoom(zoom);
    *REQUESTED_ZOOM.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = zoom;
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    #[cfg(target_os = "linux")]
    {
        // The desktop font DPI is GTK state, readable on the main thread only.
        let target = window.clone();
        let result = window.run_on_main_thread(move || {
            set_webview_zoom(&target, zoom * linux_dpi::zoom_correction());
        });
        if let Err(error) = result {
            log::warn!("could not schedule webview zoom: {error}");
        }
    }
    #[cfg(not(target_os = "linux"))]
    set_webview_zoom(&window, zoom);
}

fn set_webview_zoom(window: &tauri::WebviewWindow, zoom: f64) {
    if let Err(error) = window.set_zoom(zoom) {
        log::warn!("could not set webview zoom to {zoom}: {error}");
    }
}

/// Makes Xlib safe to use from more than one thread. The toolkit talks to the
/// X server on the main thread while the window library listens for raw key
/// events on a thread of its own. libX11 before 1.8 (Ubuntu 22.04, Pop!_OS
/// 22.04) does not lock between them unless asked to, and aborts the process
/// with "Unknown sequence number while processing queue" once they collide;
/// later releases do this on their own. Must run before any other Xlib call.
#[cfg(target_os = "linux")]
pub fn init_x11_threads() {
    if let Ok(xlib) = x11_dl::xlib::Xlib::open() {
        // SAFETY: no arguments, and nothing has used Xlib yet.
        unsafe { (xlib.XInitThreads)() };
    }
}

/// Re-applies the interface zoom whenever the desktop font DPI changes, so the
/// correction in [`linux_dpi`] follows the desktop's text scaling. Must be
/// called on the main thread.
#[cfg(target_os = "linux")]
pub fn follow_desktop_dpi(app: &AppHandle) {
    use gtk::prelude::GtkSettingsExt;

    let Some(settings) = gtk::Settings::default() else {
        return;
    };
    let app = app.clone();
    settings.connect_gtk_xft_dpi_notify(move |_| {
        let zoom = *REQUESTED_ZOOM.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        apply_zoom(&app, zoom);
    });
}

/// WebKitGTK 2.46 and later zoom the whole page by the desktop font DPI / 96,
/// so GNOME's text scaling (which X11 desktops such as Pop!_OS use for
/// fractional display scaling) blows the entire interface up, squeezes the
/// layout and rasterizes it at a fractional scale, which looks blurry. pumr
/// undoes the fractional part of that zoom; its own zoom setting is the way to
/// size the interface. Whole multiples (Xft.dpi 192 for HiDPI) render crisply
/// and are kept.
#[cfg(target_os = "linux")]
mod linux_dpi {
    /// Factor to multiply the webview zoom by. Main thread only.
    pub fn zoom_correction() -> f64 {
        // SAFETY: plain version getters without arguments or preconditions.
        let (major, minor) = unsafe {
            (
                webkit2gtk_sys::webkit_get_major_version(),
                webkit2gtk_sys::webkit_get_minor_version(),
            )
        };
        // Earlier releases scale only the text, which no page zoom can undo.
        if (major, minor) < (2, 45) {
            return 1.0;
        }
        let font_dpi = gtk::gdk::Screen::default().map_or(-1.0, |screen| screen.resolution());
        correction_for(font_dpi)
    }

    pub(super) fn correction_for(font_dpi: f64) -> f64 {
        if !(font_dpi > 0.0) {
            return 1.0;
        }
        let scale = font_dpi / 96.0;
        // Within 2% of a whole scale counts as that scale; WebKit itself
        // ignores DPI changes that small.
        let whole = scale.round().max(1.0);
        if (scale / whole - 1.0).abs() <= 0.02 {
            return 1.0;
        }
        scale.floor().max(1.0) / scale
    }
}

/// Releases any registered window-toggle shortcut without forgetting the
/// configured value. Used while the settings recorder is listening, so the
/// currently registered combination can be captured again instead of being
/// swallowed by the operating system.
pub fn suspend(app: &AppHandle) {
    log::info!("suspending window toggle shortcut");
    if let Err(error) = app.global_shortcut().unregister_all() {
        log::warn!("could not suspend window toggle shortcut: {error}");
    }
}

/// Summons pumr to the screen under the cursor, or hides/minimizes it when it
/// is already the focused window.
pub fn toggle(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("window toggle fired but no \"main\" window exists");
        return;
    };

    let visible = window.is_visible().unwrap_or(true);
    let minimized = window.is_minimized().unwrap_or(false);
    // A window that is not on screen cannot be the one in use. On X11 a hidden
    // window still counts as active when no other window took the focus, and
    // the shortcut would hide it again instead of bringing it back.
    let focused = visible && !minimized && is_frontmost(&window);
    log::info!(
        "window toggle fired (focused={focused}, visible={visible}, minimized={minimized})"
    );

    let settings = app.state::<AppState>().settings();
    if focused {
        let action = settings.window.window_toggle_action.clone();
        if action == WINDOW_TOGGLE_MINIMIZE {
            let _ = window.minimize();
        } else {
            let _ = window.hide();
        }
        return;
    }

    let maximize = settings.window.window_toggle_maximize;

    // Restore first so the window can be moved to the active monitor before it
    // is maximized there.
    if maximize {
        let _ = window.unmaximize();
    }
    center_on_active_monitor(&window);
    let _ = window.unminimize();
    let _ = window.show();
    bring_to_front(&window);
    if maximize {
        let _ = window.maximize();
    }
}

/// Whether pumr is the window the user is working in.
///
/// On X11 the global shortcut is a key grab, which takes keyboard focus away
/// from pumr while the key is down, so GTK reports the window as inactive at
/// exactly the moment the shortcut fires. The window manager's active window is
/// unaffected by the grab.
#[cfg(target_os = "linux")]
fn is_frontmost(window: &tauri::WebviewWindow) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    let target = window.clone();
    let scheduled = window.run_on_main_thread(move || {
        let _ = tx.send(is_active_in_window_manager(&target));
    });
    match scheduled {
        Ok(()) => rx.recv().unwrap_or(false),
        Err(_) => window.is_focused().unwrap_or(false),
    }
}

#[cfg(not(target_os = "linux"))]
fn is_frontmost(window: &tauri::WebviewWindow) -> bool {
    window.is_focused().unwrap_or(false)
}

/// Main thread only.
#[cfg(target_os = "linux")]
fn is_active_in_window_manager(window: &tauri::WebviewWindow) -> bool {
    use gtk::glib::translate::{from_glib_full, ToGlibPtr};
    use gtk::prelude::{GtkWindowExt, WidgetExt};

    let Ok(gtk_window) = window.gtk_window() else {
        return false;
    };
    if let Some(screen) = gtk::gdk::Screen::default() {
        // SAFETY: returns a new reference to the _NET_ACTIVE_WINDOW, or NULL.
        let active: Option<gtk::gdk::Window> = unsafe {
            from_glib_full(gtk::gdk::ffi::gdk_screen_get_active_window(
                screen.to_glib_none().0,
            ))
        };
        if let Some(active) = active {
            return gtk_window.window().is_some_and(|own| own == active);
        }
    }
    // Wayland, or a window manager without _NET_ACTIVE_WINDOW.
    gtk_window.is_active()
}

/// Raises the window and gives it keyboard focus.
///
/// On X11 `set_focus` presents the window with GTK's last user timestamp for
/// pumr, which predates the global shortcut, so the window manager's
/// focus-stealing prevention (GNOME/Mutter, KWin, ...) keeps the window behind
/// and at most flags it as needing attention. Presenting it with the current X
/// server time instead marks the request as new, as a keypress would.
#[cfg(target_os = "linux")]
fn bring_to_front(window: &tauri::WebviewWindow) {
    use gtk::prelude::{Cast, GtkWindowExt, WidgetExt};

    let target = window.clone();
    let result = window.run_on_main_thread(move || {
        let Ok(gtk_window) = target.gtk_window() else {
            let _ = target.set_focus();
            return;
        };
        let x11_window = gtk_window
            .window()
            .and_then(|gdk_window| gdk_window.downcast::<gdkx11::X11Window>().ok());
        match x11_window {
            Some(x11_window) => {
                gtk_window.present_with_time(gdkx11::functions::x11_get_server_time(&x11_window))
            }
            // Wayland has no global timestamp to refresh.
            None => gtk_window.present(),
        }
    });
    if let Err(error) = result {
        log::warn!("could not bring window to front: {error}");
    }
}

#[cfg(not(target_os = "linux"))]
fn bring_to_front(window: &tauri::WebviewWindow) {
    let _ = window.set_focus();
}

/// Moves the window to the monitor that currently contains the mouse cursor and
/// centers it there. The cursor is the best proxy we have for the "active"
/// screen; a missing monitor or unsupported platform simply leaves the window
/// where it is.
fn center_on_active_monitor(window: &tauri::WebviewWindow) {
    let point = match window.cursor_position() {
        Ok(point) => point,
        Err(_) => return,
    };
    let monitor = match window.monitor_from_point(point.x, point.y) {
        Ok(Some(monitor)) => monitor,
        _ => return,
    };
    let window_size = match window.outer_size() {
        Ok(size) => size,
        Err(_) => return,
    };

    let monitor_pos = monitor.position();
    let monitor_size = monitor.size();
    let x = monitor_pos.x + (monitor_size.width as i32 - window_size.width as i32) / 2;
    let y = monitor_pos.y + (monitor_size.height as i32 - window_size.height as i32) / 2;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::linux_dpi::correction_for;

    fn assert_close(actual: f64, expected: f64) {
        assert!((actual - expected).abs() < 1e-9, "{actual} != {expected}");
    }

    #[test]
    fn fractional_text_scaling_is_undone() {
        assert_close(correction_for(120.0), 0.8);
        assert_close(correction_for(144.0), 1.0 / 1.5);
        // 2.5x keeps the crisp 2x and undoes the rest.
        assert_close(correction_for(240.0), 0.8);
    }

    #[test]
    fn whole_scales_and_unknown_dpi_are_kept() {
        for dpi in [96.0, 97.0, 190.0, 192.0, 288.0, -1.0, 0.0, f64::NAN] {
            assert_close(correction_for(dpi), 1.0);
        }
    }
}
