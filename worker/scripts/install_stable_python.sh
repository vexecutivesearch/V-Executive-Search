#!/usr/bin/env bash
# Install a relocated, frozen CPython under a stable user-owned path.
#
# Why this exists
# ---------------
# outreach_pump.py reads ~/Library/Messages/chat.db to ingest inbound texts.
# macOS TCC judges Full Disk Access against the binary that actually opens the
# file — the interpreter, not caffeinate and not the venv symlink (TCC resolves
# symlinks to the real binary). The stored requirement is a bare
# `cdhash H"..."` keyed to an absolute path, so the grant is bound to
# (path, exact bytes).
#
# Pointing that at Homebrew means the grant is keyed to
#   /opt/homebrew/Cellar/python@3.12/<version>/.../bin/python3.12
# and `brew upgrade python@3.12` relocates the binary, silently voiding the
# grant. Inbound SMS then dies with "chat.db scan failed: unable to open
# database file" and nothing else breaks, so it goes unnoticed.
#
# Copying the framework to a path Homebrew never touches freezes both the path
# and the bytes, so one FDA grant survives every future `brew upgrade`.
#
# Idempotent by design: if a working runtime is already installed this exits
# without touching it. Rewriting the binary would change its cdhash and void
# the FDA grant, so replacement requires an explicit --force.
set -euo pipefail

PY_SERIES="${VSEARCH_PYTHON_SERIES:-3.12}"
RUNTIME_HOME="${VSEARCH_PYTHON_HOME:-$HOME/.vsearch/python}"
HOMEBREW_PREFIX="${HOMEBREW_PREFIX:-/opt/homebrew}"

FRAMEWORK="$RUNTIME_HOME/Python.framework"
VERSION_ROOT="$FRAMEWORK/Versions/$PY_SERIES"
STABLE_PYTHON="$VERSION_ROOT/bin/python$PY_SERIES"
STABLE_DYLIB="$VERSION_ROOT/Python"

FORCE=false
QUIET=false
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    --quiet) QUIET=true ;;
    --path) echo "$STABLE_PYTHON"; exit 0 ;;
    -h|--help)
      echo "Usage: $0 [--force] [--quiet] [--path]"
      echo "  --force  Rebuild even if installed. VOIDS THE EXISTING FDA GRANT."
      echo "  --path   Print the stable interpreter path and exit."
      exit 0
      ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say() { [[ "$QUIET" == "true" ]] || echo "$@"; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "install_stable_python.sh is macOS-only (TCC/Full Disk Access)." >&2
  exit 1
fi

# Everything the worker imports at runtime. Run against the relocated copy so a
# broken relocation fails here instead of at 3am in the pump.
SELF_TEST=$(cat <<'PYEOF'
import sys, sysconfig
mods = [
    "sqlite3", "ssl", "lzma", "bz2", "zlib", "decimal", "ctypes", "hashlib",
    "socket", "select", "readline", "pyexpat", "email", "json", "csv",
    "xml.etree.ElementTree", "unicodedata", "multiprocessing", "venv",
]
for m in mods:
    __import__(m)
home = sys.argv[1]
for label, value in (("prefix", sys.prefix), ("stdlib", sysconfig.get_paths()["stdlib"])):
    if not value.startswith(home):
        raise SystemExit(f"{label} escaped the stable runtime: {value}")
import sqlite3
sqlite3.connect(":memory:").execute("select 1")
print(f"OK {sys.version.split()[0]} | sqlite {sqlite3.sqlite_version} | {len(mods)} modules")
PYEOF
)

self_test() {
  env -u DYLD_LIBRARY_PATH -u PYTHONHOME -u PYTHONPATH "$1" -c "$SELF_TEST" "$RUNTIME_HOME" 2>&1
}

if [[ -x "$STABLE_PYTHON" && "$FORCE" != "true" ]]; then
  if result="$(self_test "$STABLE_PYTHON")"; then
    say "Stable Python already installed — leaving it untouched."
    say "  $STABLE_PYTHON"
    say "  $result"
    say "  cdhash: $(codesign -d --verbose=4 "$STABLE_PYTHON" 2>&1 | awk -F'=' '/^CDHash/{print $2}')"
    say ""
    say "Re-run with --force ONLY if you accept re-granting Full Disk Access."
    exit 0
  fi
  echo "Existing runtime at $STABLE_PYTHON failed its self-test:" >&2
  echo "$result" >&2
  echo "Re-run with --force to rebuild (this voids the existing FDA grant)." >&2
  exit 1
fi

if [[ -x "$STABLE_PYTHON" && "$FORCE" == "true" ]]; then
  echo "!! --force: rebuilding $STABLE_PYTHON"
  echo "!! Its cdhash will change, so the existing Full Disk Access grant WILL"
  echo "!! stop applying and inbound texts will stop until it is re-granted."
  echo ""
fi

# Resolve the Homebrew framework to copy from. Deliberately resolved through
# realpath so we snapshot a concrete Cellar version rather than a moving symlink.
SOURCE_PREFIX="$HOMEBREW_PREFIX/opt/python@$PY_SERIES"
if command -v brew >/dev/null 2>&1; then
  SOURCE_PREFIX="$(brew --prefix "python@$PY_SERIES" 2>/dev/null || echo "$SOURCE_PREFIX")"
fi
SOURCE_FRAMEWORK="$(realpath "$SOURCE_PREFIX/Frameworks/Python.framework" 2>/dev/null || true)"
if [[ -z "$SOURCE_FRAMEWORK" || ! -d "$SOURCE_FRAMEWORK" ]]; then
  echo "Cannot find Homebrew Python framework for python@$PY_SERIES." >&2
  echo "Install it first: brew install python@$PY_SERIES" >&2
  exit 1
fi
SOURCE_PYTHON="$SOURCE_FRAMEWORK/Versions/$PY_SERIES/bin/python$PY_SERIES"
SOURCE_VERSION="$("$SOURCE_PYTHON" -c 'import sys; print(sys.version.split()[0])')"

say "→ Source:      $SOURCE_FRAMEWORK ($SOURCE_VERSION)"
say "→ Destination: $FRAMEWORK"

rm -rf "$RUNTIME_HOME"
mkdir -p "$RUNTIME_HOME"
cp -R "$SOURCE_FRAMEWORK" "$FRAMEWORK"
chmod -R u+w "$FRAMEWORK"

# The copy is self-contained except for three Mach-O files that hardcode the
# versioned Cellar path. Left alone, `brew upgrade` deletes what they load and
# the relocated interpreter dies. Everything else already links through
# /opt/homebrew/opt/<formula> symlinks, which upgrades keep stable.
SOURCE_DYLIB="$SOURCE_FRAMEWORK/Versions/$PY_SERIES/Python"
say "→ Rewriting install names onto the stable path"
install_name_tool -id "$STABLE_DYLIB" "$STABLE_DYLIB" 2>/dev/null
install_name_tool -change "$SOURCE_DYLIB" "$STABLE_DYLIB" "$STABLE_PYTHON" 2>/dev/null
APP_STUB="$VERSION_ROOT/Resources/Python.app/Contents/MacOS/Python"
[[ -f "$APP_STUB" ]] && install_name_tool -change "$SOURCE_DYLIB" "$STABLE_DYLIB" "$APP_STUB" 2>/dev/null

# Homebrew's pyexpat links /usr/lib/libexpat.1.dylib but needs symbols only
# Homebrew's libexpat exports, so it (and therefore pip) only imports when
# DYLD_LIBRARY_PATH is set. Bind it directly instead: the stable interpreter
# then works from launchd, a bare shell, or anywhere else without that env var.
PYEXPAT="$VERSION_ROOT/lib/python$PY_SERIES/lib-dynload/pyexpat.cpython-${PY_SERIES//./}-darwin.so"
BREW_EXPAT="$HOMEBREW_PREFIX/opt/expat/lib/libexpat.1.dylib"
if [[ -f "$PYEXPAT" && -f "$BREW_EXPAT" ]]; then
  say "→ Binding pyexpat to Homebrew libexpat (removes the DYLD_LIBRARY_PATH dependency)"
  install_name_tool -change /usr/lib/libexpat.1.dylib "$BREW_EXPAT" "$PYEXPAT" 2>/dev/null
  codesign -f -s - "$PYEXPAT" >/dev/null 2>&1
fi

# install_name_tool invalidates the ad-hoc signature it was built with. TCC
# validates the cdhash, so an unsigned/invalid binary cannot hold a grant.
say "→ Re-signing ad-hoc"
codesign -f -s - "$STABLE_DYLIB" >/dev/null 2>&1
codesign -f -s - "$STABLE_PYTHON" >/dev/null 2>&1
[[ -f "$APP_STUB" ]] && codesign -f -s - "$APP_STUB" >/dev/null 2>&1

say "→ Verifying nothing still points into the versioned Cellar"
leaked="$(cd "$FRAMEWORK" && find . -type f \( -name '*.so' -o -name '*.dylib' -o -name 'Python' -o -name "python$PY_SERIES" \) -print0 \
  | xargs -0 -n1 otool -L 2>/dev/null \
  | grep -F "Cellar/python@$PY_SERIES" || true)"
if [[ -n "$leaked" ]]; then
  echo "Relocation incomplete — these still reference the Cellar:" >&2
  echo "$leaked" >&2
  exit 1
fi

# Deliberately run with DYLD_LIBRARY_PATH/PYTHONHOME/PYTHONPATH stripped: the
# stable runtime has to stand on its own under launchd, not lean on the
# caller's environment.
say "→ Self-test"
if ! result="$(env -u DYLD_LIBRARY_PATH -u PYTHONHOME -u PYTHONPATH "$STABLE_PYTHON" -c "$SELF_TEST" "$RUNTIME_HOME" 2>&1)"; then
  echo "Relocated interpreter failed its self-test:" >&2
  echo "$result" >&2
  exit 1
fi
say "   $result"

if ! codesign -v "$STABLE_PYTHON" 2>/dev/null; then
  echo "Relocated interpreter has an invalid code signature — TCC cannot hold a grant on it." >&2
  exit 1
fi

CDHASH="$(codesign -d --verbose=4 "$STABLE_PYTHON" 2>&1 | awk -F'=' '/^CDHash/{print $2}')"

cat > "$RUNTIME_HOME/PROVENANCE" <<EOF
# Frozen copy of Homebrew CPython, relocated so the Full Disk Access grant
# needed for ~/Library/Messages/chat.db survives \`brew upgrade python@$PY_SERIES\`.
# Managed by worker/scripts/install_stable_python.sh — do not edit in place.
installed_at   = $(date -u '+%Y-%m-%dT%H:%M:%SZ')
python_version = $SOURCE_VERSION
source         = $SOURCE_FRAMEWORK
interpreter    = $STABLE_PYTHON
cdhash         = $CDHASH
EOF

say ""
say "Installed stable interpreter:"
say "  $STABLE_PYTHON"
say "  cdhash $CDHASH"
say ""
say "This path is outside Homebrew, so \`brew upgrade python@$PY_SERIES\` cannot move"
say "or rewrite it, and the Full Disk Access grant keyed to it stays valid."
say ""
say "ONE-TIME grant required (Full Disk Access is keyed to this exact binary):"
say "  1. Finder → Cmd+Shift+G → paste:"
say "       $VERSION_ROOT/bin"
say "  2. System Settings → Privacy & Security → Full Disk Access"
say "  3. Drag 'python$PY_SERIES' from the Finder window onto the Full Disk Access list"
say "     (the '+' button cannot select a bare unix binary; drag-and-drop can)"
say "  4. Make sure its toggle is ON"
