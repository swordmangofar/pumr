//! Keeps the Linux AppImage's GStreamer plugin registry to itself.
//!
//! The AppImage bundles its own GStreamer core and plugins for WebKitGTK audio
//! (`bundle.linux.appimage.bundleMediaFramework`). GStreamer caches what it
//! finds in `~/.cache/gstreamer-1.0/registry.<arch>.bin`, which every other
//! GStreamer application shares, and the AppImage is mounted at a new path on
//! each launch. Every start would therefore rescan the bundled plugins and
//! replace the shared registry with one only this process can use, so the other
//! applications would have to rescan theirs in turn.

use std::ffi::OsString;
use std::path::PathBuf;

/// Points GStreamer at a registry of pumr's own when running from an AppImage
/// that bundles GStreamer plugins; a no-op for every other install. Must run
/// before any thread or webview exists, as the web process inherits the
/// environment.
pub fn isolate_gstreamer_registry(identifier: &str) {
    if let Some(path) = private_registry(identifier, |key| std::env::var_os(key)) {
        std::env::set_var("GST_REGISTRY_1_0", path);
    }
}

fn private_registry(identifier: &str, var: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let appdir = PathBuf::from(var("APPDIR")?);
    if !appdir.join("usr/lib/gstreamer-1.0").is_dir()
        || var("GST_REGISTRY_1_0").is_some()
        || var("GST_REGISTRY").is_some()
    {
        return None;
    }
    // The XDG cache directory, resolved the way GStreamer resolves its own.
    let cache = var("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| var("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .filter(|path| path.is_absolute())?;
    Some(
        cache
            .join(identifier)
            .join("gstreamer-1.0")
            .join(format!("registry.{}.bin", std::env::consts::ARCH)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn lookup(vars: Vec<(&'static str, OsString)>) -> impl Fn(&str) -> Option<OsString> {
        move |key| vars.iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone())
    }

    fn registry_in(cache: &Path) -> PathBuf {
        cache
            .join("dev.pumr.app/gstreamer-1.0")
            .join(format!("registry.{}.bin", std::env::consts::ARCH))
    }

    #[test]
    fn appimage_with_bundled_plugins_gets_a_private_registry() {
        let appdir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(appdir.path().join("usr/lib/gstreamer-1.0")).unwrap();
        let home = std::env::temp_dir().join("home");
        let xdg_cache = std::env::temp_dir().join("xdg-cache");

        let from_home = lookup(vec![
            ("APPDIR", appdir.path().into()),
            ("HOME", home.clone().into()),
        ]);
        assert_eq!(
            private_registry("dev.pumr.app", from_home),
            Some(registry_in(&home.join(".cache")))
        );

        let from_xdg = lookup(vec![
            ("APPDIR", appdir.path().into()),
            ("HOME", home.clone().into()),
            ("XDG_CACHE_HOME", xdg_cache.clone().into()),
        ]);
        assert_eq!(
            private_registry("dev.pumr.app", from_xdg),
            Some(registry_in(&xdg_cache))
        );

        let relative_xdg = lookup(vec![
            ("APPDIR", appdir.path().into()),
            ("HOME", home.clone().into()),
            ("XDG_CACHE_HOME", "cache".into()),
        ]);
        assert_eq!(
            private_registry("dev.pumr.app", relative_xdg),
            Some(registry_in(&home.join(".cache")))
        );
    }

    #[test]
    fn other_installs_and_existing_registry_choices_are_left_alone() {
        let home: OsString = std::env::temp_dir().join("home").into();
        let with_plugins = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(with_plugins.path().join("usr/lib/gstreamer-1.0")).unwrap();
        let without_plugins = tempfile::tempdir().unwrap();

        // .deb/.rpm installs and development builds are not in an AppImage.
        let not_appimage = lookup(vec![("HOME", home.clone())]);
        assert_eq!(private_registry("dev.pumr.app", not_appimage), None);

        // An AppImage without bundled plugins uses no GStreamer registry of its own.
        let no_plugins = lookup(vec![
            ("APPDIR", without_plugins.path().into()),
            ("HOME", home.clone()),
        ]);
        assert_eq!(private_registry("dev.pumr.app", no_plugins), None);

        for key in ["GST_REGISTRY_1_0", "GST_REGISTRY"] {
            let user_choice = lookup(vec![
                ("APPDIR", with_plugins.path().into()),
                ("HOME", home.clone()),
                (key, "/tmp/registry.bin".into()),
            ]);
            assert_eq!(private_registry("dev.pumr.app", user_choice), None, "{key}");
        }
    }
}
