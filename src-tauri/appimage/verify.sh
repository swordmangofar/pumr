#!/usr/bin/env bash
# Checks built AppImages and fails when one would break on users' machines:
#
# * It must come out of our linuxdeploy-plugin-gtk.sh and -gstreamer.sh: no
#   bundled libwayland, and a GTK hook that leaves GDK_BACKEND to GTK instead of
#   forcing x11.
# * WebKitGTK must find a working GStreamer, or pumr's notification sounds
#   (WebAudio, decodeAudioData() and <audio>) are silent. Tauri's launcher
#   (AppRun.wrapped, AppImageKit's AppRun.c) always exports
#   GST_PLUGIN_SYSTEM_PATH_1_0=$APPDIR/usr/lib/gstreamer-1.0 (tauri-apps/tauri#15665)
#   and the GStreamer core bundled in the AppImage cannot load the host's
#   plugins, so the plugins in gstreamer-plugins.txt must be bundled and load.
#   To check that, the launcher chain (AppRun, apprun-hooks, AppRun.wrapped)
#   runs the way the AppImage runtime runs it, with the app replaced by a
#   python3 probe that loads the bundled GStreamer with the environment it gets.
#
# Usage: verify.sh path/to/pumr.AppImage [...]
# Needs python3; no FUSE, display or sound device.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugins="$(sed 's/#.*//' "$here/gstreamer-plugins.txt")"
# Elements WebKitGTK (traced with 2.52) creates to play pumr's sounds: WebAudio
# output, decodeAudioData() for custom sound files, and the <audio> fallback
# (playbin3 with GStreamer >= 1.22, playbin before).
elements="audioconvert audioresample autoaudiosink pulsesink appsrc appsink
  giostreamsrc deinterleave decodebin decodebin3 parsebin playbin playbin3
  uridecodebin uridecodebin3 urisourcebin typefind wavparse volume scaletempo
  queue queue2 multiqueue tee identity clocksync capsfilter fakesink"

if [ "$#" -eq 0 ]; then
  echo "usage: verify.sh path/to/pumr.AppImage [...]" >&2
  exit 2
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/probe.py" <<'PY'
import ctypes
import os
import sys

name, appdir, plugins, elements = sys.argv[1], sys.argv[2], sys.argv[3].split(), sys.argv[4].split()
bundled_dir = os.path.join(appdir, "usr/lib/gstreamer-1.0")
failures = []


def fail(message):
    failures.append(message)
    print(f"::error::{name}: {message}")


def inside(path):
    return os.path.realpath(path).startswith(os.path.realpath(appdir) + os.sep)


def effective(var):
    # GStreamer 1.x prefers VAR_1_0 over VAR; set-but-empty still counts.
    for key in (var + "_1_0", var):
        if key in os.environ:
            return key, os.environ[key]
    return None, None


# 1. Plugin search paths exported by the launcher.
key, value = effective("GST_PLUGIN_SYSTEM_PATH")
if key is None:
    fail("the launcher leaves GST_PLUGIN_SYSTEM_PATH_1_0 unset, so the bundled "
         "GStreamer falls back to host plugins it cannot load")
    value = ""
entries = [os.path.realpath(e) for e in value.split(":") if e]
if key and os.path.realpath(bundled_dir) not in entries:
    fail(f"{key} does not include {bundled_dir}")
for key, value in (effective("GST_PLUGIN_SYSTEM_PATH"), effective("GST_PLUGIN_PATH")):
    if key is None:
        continue
    print(f"  {key}={value}")
    for entry in filter(None, value.split(":")):
        if not inside(entry):
            fail(f"{key} entry {entry} is outside the AppImage; host plugins "
                 "cannot load into the bundled GStreamer")
        elif not os.path.isdir(entry):
            fail(f"{key} entry {entry} does not exist in the AppImage")

key, scanner = effective("GST_PLUGIN_SCANNER")
if key is None:
    print("  warn: GST_PLUGIN_SCANNER_1_0 is unset, GStreamer uses the host's scanner")
elif not (inside(scanner) and os.access(scanner, os.X_OK)):
    fail(f"{key}={scanner} is not an executable inside the AppImage")

# 2. The GStreamer core as the dynamic loader resolves it for the app.
try:
    gst = ctypes.CDLL("libgstreamer-1.0.so.0")
except OSError as error:
    fail(f"cannot load libgstreamer-1.0.so.0: {error}")
    sys.exit(1)
with open("/proc/self/maps") as maps:
    loaded = {line.split()[-1] for line in maps if "libgstreamer-1.0.so" in line}
for path in loaded:
    if not inside(path):
        fail(f"libgstreamer-1.0 resolved outside the AppImage: {path}")
gst.gst_init(None, None)
gst.gst_version_string.restype = ctypes.c_char_p
print("  " + gst.gst_version_string().decode())


class GError(ctypes.Structure):
    _fields_ = [("domain", ctypes.c_uint32), ("code", ctypes.c_int),
                ("message", ctypes.c_char_p)]


# 3. Every listed plugin is bundled and loads.
gst.gst_plugin_load_file.restype = ctypes.c_void_p
gst.gst_plugin_load_file.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.POINTER(GError))]
absent = []
for plugin in plugins:
    path = os.path.join(bundled_dir, plugin)
    if not os.path.isfile(path):
        absent.append(plugin)
        continue
    error = ctypes.POINTER(GError)()
    if not gst.gst_plugin_load_file(path.encode(), ctypes.byref(error)):
        reason = error.contents.message.decode() if error else "unknown error"
        fail(f"{plugin} does not load: {reason}")
if absent:
    fail("not bundled in usr/lib/gstreamer-1.0: " + " ".join(absent))

# 4. The elements WebKit needs resolve through the plugin registry.
gst.gst_element_factory_make.restype = ctypes.c_void_p
gst.gst_element_factory_make.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
gst.gst_object_ref_sink.restype = ctypes.c_void_p
gst.gst_object_ref_sink.argtypes = [ctypes.c_void_p]
gst.gst_object_unref.argtypes = [ctypes.c_void_p]
missing = []
for element in elements:
    instance = gst.gst_element_factory_make(element.encode(), None)
    if instance:
        gst.gst_object_unref(gst.gst_object_ref_sink(instance))
    else:
        missing.append(element)
if missing:
    fail("GStreamer elements not found: " + " ".join(missing))

print(f"  checked {len(plugins)} plugins and {len(elements)} elements")
sys.exit(1 if failures else 0)
PY

# Our linuxdeploy plugins: no bundled libwayland, GDK_BACKEND left to GTK, GTK
# and WebKit present. Fails when the bundler used the stock plugins instead.
check_gtk() {
  local root="$1" name="$2" status=0 bundled hook lib

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
  return "$status"
}

# GStreamer as WebKit gets it: the launcher chain runs with the app replaced by
# the probe, in a clean environment plus what the AppImage runtime sets before
# it starts AppRun; a private HOME and registry keep the caller's caches untouched.
check_gstreamer() {
  local root="$1" name="$2" appimage="$3" work="$4" exe

  exe="$(sed -n 's/^Exec=\([^ ]*\).*/\1/p' "$root"/*.desktop | head -n 1)"
  if [ -z "$exe" ] || [ ! -f "$root/usr/bin/$exe" ]; then
    echo "::error::$name: cannot find the app binary from the .desktop Exec= line" >&2
    return 1
  fi
  # AppRun.wrapped also points PYTHONHOME into the AppImage, which only
  # matters to the host python3 running the probe.
  cat > "$root/usr/bin/$exe" <<'SH'
#!/bin/sh
unset PYTHONHOME PYTHONPATH
exec python3 "$VERIFY_PROBE" "$VERIFY_NAME" "$VERIFY_APPDIR" "$VERIFY_PLUGINS" "$VERIFY_ELEMENTS"
SH

  mkdir -p "$work/home"
  env -i PATH="$PATH" HOME="$work/home" LANG=C.UTF-8 \
    APPDIR="$root" APPIMAGE="$appimage" ARGV0="$appimage" OWD="$PWD" \
    GST_REGISTRY_1_0="$work/registry.bin" \
    VERIFY_PROBE="$tmp/probe.py" VERIFY_NAME="$name" VERIFY_APPDIR="$root" \
    VERIFY_PLUGINS="$plugins" VERIFY_ELEMENTS="$elements" \
    "$root/AppRun"
}

failed=0
index=0
for arg in "$@"; do
  index=$((index + 1))
  appimage="$(readlink -f "$arg")"
  name="$(basename "$appimage")"
  work="$tmp/$index"
  mkdir -p "$work"
  echo "verify.sh: $name"

  [ -x "$appimage" ] || chmod u+x "$appimage"
  if ! (cd "$work" && "$appimage" --appimage-extract > /dev/null); then
    echo "::error::$name cannot be extracted" >&2
    failed=1
    continue
  fi
  root="$work/squashfs-root"

  status=0
  check_gtk "$root" "$name" || status=1
  check_gstreamer "$root" "$name" "$appimage" "$work" || status=1
  if [ "$status" -eq 0 ]; then
    echo "ok: $name ships no libwayland, does not force GDK_BACKEND and has a working GStreamer"
  else
    failed=1
  fi
  rm -rf "${work:?}"
done
exit "$failed"
