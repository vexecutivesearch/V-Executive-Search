#!/usr/bin/env bash
# One-shot Mac worker setup (Mac mini / MacBook). Run from repo: ./worker/scripts/setup_mac.sh
set -euo pipefail

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

cd "$WORKER_ROOT"

if [[ ! -d .venv ]]; then
  echo "→ Creating Python venv..."
  python3 -m venv .venv
fi

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
echo "  launchctl bootout gui/\$(id -u)/com.vexecsearch.contactout-keepalive"
echo ""
echo "See DEPLOY.md for MacBook vs Mac mini and new-machine setup."
echo ""
read -r -p "Install launchd schedule (6 AM + 6 PM daily, poll every 5 min, keepalive every 5h)? [y/N] " REPLY
if [[ "${REPLY,,}" == "y" || "${REPLY,,}" == "yes" ]]; then
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
