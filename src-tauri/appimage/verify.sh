#!/usr/bin/env bash
# Inspects built AppImages and fails when WebKitGTK would be left without a
# working GStreamer, which silently breaks pumr's notification sounds (WebAudio,
# decodeAudioData() and <audio> all go through GStreamer on Linux).
#
#   src-tauri/appimage/verify.sh path/to/pumr.AppImage [...]
#
# Tauri's AppImage launcher (AppRun.wrapped, AppImageKit's AppRun.c) always
# exports GST_PLUGIN_SYSTEM_PATH_1_0=$APPDIR/usr/lib/gstreamer-1.0, even without
# bundleMediaFramework (tauri-apps/tauri#15665). Without that directory GStreamer
# finds no plugins at all, and the GStreamer core bundled in the AppImage cannot
# load the host's plugins either, so the plugins listed in gstreamer-plugins.txt
# must be bundled and must load.
#
# Each AppImage is extracted and its launcher chain (AppRun, apprun-hooks,
# AppRun.wrapped) is run the way the AppImage runtime runs it, with the app
# replaced by a probe that checks the environment it was given and loads the
# bundled GStreamer with it. Needs python3; no FUSE, display or sound device.

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
  echo "usage: $0 path/to/pumr.AppImage [...]" >&2
  exit 2
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/probe.py" <<'PY'
import ctypes
import os
import sys

appdir, plugins, elements = sys.argv[1], sys.argv[2].split(), sys.argv[3].split()
bundled_dir = os.path.join(appdir, "usr/lib/gstreamer-1.0")
failures = []


def fail(message):
    failures.append(message)
    print("  FAIL " + message)


def inside(path):
    return os.path.realpath(path).startswith(os.path.realpath(appdir) + os.sep)


def effective(name):
    # GStreamer 1.x prefers NAME_1_0 over NAME; set-but-empty still counts.
    for key in (name + "_1_0", name):
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

# verify <AppImage> <scratch dir>
verify() {
  local appimage work appdir exe
  appimage="$(realpath "$1")"
  work="$2"
  mkdir -p "$work/home"

  [ -x "$appimage" ] || chmod u+x "$appimage"
  if ! (cd "$work" && "$appimage" --appimage-extract >/dev/null); then
    echo "  FAIL cannot extract the AppImage"
    return 1
  fi
  appdir="$work/squashfs-root"

  exe="$(sed -n 's/^Exec=\([^ ]*\).*/\1/p' "$appdir"/*.desktop | head -n 1)"
  if [ -z "$exe" ] || [ ! -f "$appdir/usr/bin/$exe" ]; then
    echo "  FAIL cannot find the app binary from the .desktop Exec= line"
    return 1
  fi
  # AppRun.wrapped also points PYTHONHOME into the AppImage, which only
  # matters to the host python3 running the probe.
  cat > "$appdir/usr/bin/$exe" <<'SH'
#!/bin/sh
unset PYTHONHOME PYTHONPATH
exec python3 "$VERIFY_PROBE" "$VERIFY_APPDIR" "$VERIFY_PLUGINS" "$VERIFY_ELEMENTS"
SH

  # A clean environment plus what the AppImage runtime sets before it starts
  # AppRun; a private HOME and registry keep the caller's caches untouched.
  env -i PATH="$PATH" HOME="$work/home" LANG=C.UTF-8 \
    APPDIR="$appdir" APPIMAGE="$appimage" ARGV0="$appimage" OWD="$PWD" \
    GST_REGISTRY_1_0="$work/registry.bin" \
    VERIFY_PROBE="$tmp/probe.py" VERIFY_APPDIR="$appdir" \
    VERIFY_PLUGINS="$plugins" VERIFY_ELEMENTS="$elements" \
    "$appdir/AppRun"
}

failed=0
index=0
for appimage in "$@"; do
  index=$((index + 1))
  echo "verify.sh: $appimage"
  if verify "$appimage" "$tmp/$index"; then
    echo "verify.sh: OK"
  else
    echo "verify.sh: FAILED" >&2
    failed=1
  fi
  rm -rf "${tmp:?}/$index"
done
exit "$failed"
