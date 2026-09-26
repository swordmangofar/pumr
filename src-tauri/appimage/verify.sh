#!/usr/bin/env bash
# Checks that a built AppImage came out of our linuxdeploy-plugin-gtk.sh: no
# bundled libwayland, and a GTK hook that leaves GDK_BACKEND to GTK instead of
# forcing x11. Fails when the bundler used the stock plugin instead.
# Usage: verify.sh path/to/pumr.AppImage
set -euo pipefail

appimage="$(readlink -f "${1:?usage: verify.sh <AppImage>}")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$work"
"$appimage" --appimage-extract > /dev/null
root="$work/squashfs-root"
name="$(basename "$appimage")"
status=0

bundled="$(find "$root"/usr/lib* -name 'libwayland-*.so*' 2> /dev/null || true)"
if [ -n "$bundled" ]; then
    echo "::error::$name bundles libwayland:" >&2
    echo "$bundled" >&2
    status=1
fi

hook="$root/apprun-hooks/linuxdeploy-plugin-gtk.sh"
if ! grep -q '# PUMR:' "$hook" || grep -q '^export GDK_BACKEND=' "$hook"; then
    echo "::error::$name was built with the stock GTK hook, which forces GDK_BACKEND:" >&2
    grep -n GDK_BACKEND "$hook" >&2 || true
    status=1
fi

for lib in libgtk-3.so.0 libwebkit2gtk-4.1.so.0; do
    if [ -z "$(find "$root"/usr/lib* -name "$lib" -print -quit 2> /dev/null)" ]; then
        echo "::error::$name is missing $lib" >&2
        status=1
    fi
done

if [ "$status" -eq 0 ]; then
    echo "ok: $name ships no libwayland and does not force GDK_BACKEND"
fi
exit "$status"
