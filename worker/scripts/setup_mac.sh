#!/usr/bin/env bash
# One-shot Mac worker setup (Mac mini / MacBook). Run from repo: ./worker/scripts/setup_mac.sh
set -euo pipefail

# Homebrew Python on macOS 26 (Tahoe): pyexpat expects newer libexpat symbols than /usr/lib provides.
if [[ "$(uname -s)" == "Darwin" ]]; then
  EXPAT_LIB="${HOMEBREW_PREFIX:-/opt/homebrew}/opt/expat/lib"
  if [[ -d "$EXPAT_LIB" ]]; then
    export DYLD_LIBRARY_PATH="${EXPAT_LIB}${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
  fi
fi

WORKER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$WORKER_ROOT/.." && pwd)"

echo "═══════════════════════════════════════════════════════════"
echo "  V Executive Search — Mac worker setup"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Repo:   $REPO_ROOT"
echo "Worker: $WORKER_ROOT"
echo ""

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found. Install Xcode CLI tools: xcode-select --install"
  exit 1
fi

# Prefer Homebrew Python 3.10+ (system Python on macOS is often 3.9).
PYTHON=""
for candidate in \
  "${HOMEBREW_PREFIX:-/opt/homebrew}/bin/python3.12" \
  "${HOMEBREW_PREFIX:-/opt/homebrew}/bin/python3.11" \
  "${HOMEBREW_PREFIX:-/opt/homebrew}/bin/python3" \
  python3.12 python3.11 python3; do
  if [[ -x "$candidate" ]] || command -v "$candidate" >/dev/null 2>&1; then
    ver="$("$candidate" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo 0)"
    major="${ver%%.*}"
    minor="${ver#*.}"
    if [[ "$major" -ge 3 && "$minor" -ge 10 ]]; then
      PYTHON="$candidate"
      break
    fi
  fi
done

if [[ -z "$PYTHON" ]]; then
  echo "ERROR: Python 3.10+ required. Install with: brew install python@3.12"
  exit 1
fi

echo "→ Using Python: $PYTHON ($($PYTHON --version))"
cd "$WORKER_ROOT"

if [[ ! -d .venv ]]; then
  echo "→ Creating Python venv..."
  "$PYTHON" -m venv .venv
fi

# Persist Homebrew expat fix for interactive `source .venv/bin/activate` sessions.
EXPAT_LIB="${HOMEBREW_PREFIX:-/opt/homebrew}/opt/expat/lib"
if [[ -d "$EXPAT_LIB" ]] && [[ -f .venv/bin/activate ]]; then
  if ! grep -q 'opt/expat/lib' .venv/bin/activate 2>/dev/null; then
    cat >> .venv/bin/activate <<EOF

# Homebrew Python on macOS 26+: pyexpat needs Homebrew libexpat.
export DYLD_LIBRARY_PATH="${EXPAT_LIB}\${DYLD_LIBRARY_PATH:+:\$DYLD_LIBRARY_PATH}"
EOF
  fi
fi

echo "→ Upgrading pip/setuptools..."
"$WORKER_ROOT/.venv/bin/python" -m pip install -q --upgrade pip setuptools wheel

echo "→ Installing worker package..."
"$WORKER_ROOT/.venv/bin/pip" install -q -e .

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo ""
  echo "→ Created worker/.env from .env.example"
  echo "  Edit these before the pipeline can run:"
  echo "    APOLLO_API_KEY   — Apollo.io API key"
  echo "    CRM_API_URL      — https://v-executive-search.vercel.app"
  echo "    CRM_API_KEY      — same as WORKER_API_KEY on Vercel"
  echo "    ALERT_EMAIL      — your email for failure alerts"
  echo "    RESEND_API_KEY   — Resend.com API key (daily report)"
  echo "    REPORT_FROM_EMAIL — sender address (Resend verified domain)"
  echo ""
  echo "  Open: $WORKER_ROOT/.env"
  echo ""
else
  echo "→ Using existing worker/.env"
fi

mkdir -p logs

echo "→ Running health check (no Apollo credits)..."
if "$WORKER_ROOT/.venv/bin/python" scripts/health_check.py; then
  echo "  Health check passed."
else
  echo ""
  echo "  Health check failed — usually missing/invalid .env values."
  echo "  Fix worker/.env, then re-run: ./scripts/health_check.py"
  echo ""
fi

echo ""
echo "IMPORTANT: Only ONE Mac should run the scheduled worker."
echo "If another machine already has launchd loaded, unload it there first:"
echo "  launchctl bootout gui/\$(id -u)/com.vexecsearch.daily"
echo "  launchctl bootout gui/\$(id -u)/com.vexecsearch.poll"
echo ""
echo "See DEPLOY.md for MacBook vs Mac mini and new-machine setup."
echo ""
read -r -p "Install launchd schedule (6 AM + 6 PM daily, poll every 5 min)? [y/N] " REPLY
REPLY_LC="$(printf '%s' "$REPLY" | tr '[:upper:]' '[:lower:]')"
if [[ "$REPLY_LC" == "y" || "$REPLY_LC" == "yes" ]]; then
  chmod +x scripts/install_launchd.sh
  ./scripts/install_launchd.sh
else
  echo "Skipped launchd. Install later with: ./scripts/install_launchd.sh"
fi

echo ""
echo "Done. Manual test (no credits):"
echo "  cd worker && source .venv/bin/activate"
echo "  python scripts/run_daily.py --dry-run"
echo ""
