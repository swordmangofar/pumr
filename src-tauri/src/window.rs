use crate::config::{clamp_zoom, WindowSettings, WINDOW_TOGGLE_MINIMIZE};
use crate::state::AppState;
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

/// Applies the persisted interface zoom to the main webview.
fn apply_zoom(app: &AppHandle, zoom: f64) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let zoom = clamp_zoom(zoom);
    if let Err(error) = window.set_zoom(zoom) {
        log::warn!("could not set webview zoom to {zoom}: {error}");
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

    let focused = window.is_focused().unwrap_or(false);
    let visible = window.is_visible().unwrap_or(true);
    log::info!("window toggle fired (focused={focused}, visible={visible})");

    if focused {
        let action = app.state::<AppState>().settings().window.window_toggle_action;
        if action == WINDOW_TOGGLE_MINIMIZE {
            let _ = window.minimize();
        } else {
            let _ = window.hide();
        }
        return;
    }

    center_on_active_monitor(&window);
    let _ = window.unminimize();
    let _ = window.show();
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
