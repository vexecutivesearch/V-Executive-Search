#!/usr/bin/env bash
# Repoint an existing venv at the frozen interpreter from install_stable_python.sh.
#
# bootstrap_release.sh already builds new release venvs against the stable
# interpreter. This is for switching a venv that is already live without
# rebuilding it: it rewrites two symlinks and pyvenv.cfg, takes about a second,
# and leaves installed packages alone (same 3.12.x, same ABI). That matters
# because the poll job runs every 5 minutes and a rebuild would drop a tick.
#
# The switch changes which binary macOS TCC judges, so Full Disk Access must
# already be granted to the stable interpreter BEFORE running this — otherwise
# inbound SMS ingestion stops. Verify first:
#   worker/scripts/check_full_disk_access.py, run under launchd (ppid 1).
#
# --revert puts the venv back on the interpreter it was built from, for when the
# grant is not in place yet and inbound texts need to keep flowing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PY_SERIES="${VSEARCH_PYTHON_SERIES:-3.12}"

VENV=""
REVERT=false
for arg in "$@"; do
  case "$arg" in
    --revert) REVERT=true ;;
    -h|--help)
      echo "Usage: $0 [--revert] <path-to-venv>"
      exit 0
      ;;
    *) VENV="$arg" ;;
  esac
done

if [[ -z "$VENV" ]]; then
  echo "Usage: $0 [--revert] <path-to-venv>" >&2
  exit 2
fi
VENV="$(cd "$VENV" && pwd)"
CFG="$VENV/pyvenv.cfg"
if [[ ! -f "$CFG" ]]; then
  echo "Not a venv (no pyvenv.cfg): $VENV" >&2
  exit 1
fi

if [[ "$REVERT" == "true" ]]; then
  TARGET="${HOMEBREW_PREFIX:-/opt/homebrew}/opt/python@$PY_SERIES/bin/python$PY_SERIES"
  LABEL="Homebrew"
else
  TARGET="$(bash "$SCRIPT_DIR/install_stable_python.sh" --path)"
  LABEL="stable"
fi

if [[ ! -x "$TARGET" ]]; then
  echo "Target interpreter not found: $TARGET" >&2
  [[ "$REVERT" == "true" ]] || echo "Run: bash $SCRIPT_DIR/install_stable_python.sh" >&2
  exit 1
fi

CURRENT="$(readlink -f "$VENV/bin/python" 2>/dev/null || echo none)"
TARGET_REAL="$(readlink -f "$TARGET")"
echo "venv    : $VENV"
echo "current : $CURRENT"
echo "target  : $TARGET_REAL ($LABEL)"

if [[ "$CURRENT" == "$TARGET_REAL" ]]; then
  echo "Already pointed there — nothing to do."
  exit 0
fi

# Refuse to cross a minor version: the venv's site-packages contain compiled
# extension modules built for one ABI, and swapping under them breaks imports.
CURRENT_VER="$("$CURRENT" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo unknown)"
TARGET_VER="$("$TARGET_REAL" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo unknown)"
if [[ "$CURRENT_VER" != "$TARGET_VER" ]]; then
  echo "Refusing to repoint across Python versions ($CURRENT_VER -> $TARGET_VER)." >&2
  echo "Rebuild the venv instead: worker/scripts/bootstrap_release.sh" >&2
  exit 1
fi

ln -sfn "$TARGET" "$VENV/bin/python$PY_SERIES"
ln -sfn "python$PY_SERIES" "$VENV/bin/python"
ln -sfn "python$PY_SERIES" "$VENV/bin/python3"

python_home="$(dirname "$TARGET")"
tmp_cfg="$(mktemp)"
while IFS= read -r line; do
  case "$line" in
    home\ =*)       echo "home = $python_home" ;;
    executable\ =*) echo "executable = $TARGET_REAL" ;;
    *)              echo "$line" ;;
  esac
done < "$CFG" > "$tmp_cfg"
mv "$tmp_cfg" "$CFG"

echo "→ Repointed. Verifying..."
"$VENV/bin/python" -c "
import sys, sqlite3, ssl, pyexpat
print('  sys.executable :', sys.executable)
print('  base_prefix    :', sys.base_prefix)
print('  version        :', sys.version.split()[0])
print('  sqlite3/ssl/pyexpat import OK')
"
echo "  TCC judges     : $(readlink -f "$VENV/bin/python")"
echo ""
echo "Reload launchd so the change takes effect:"
echo "  launchctl kickstart -k gui/\$UID/com.vexecsearch.poll"
