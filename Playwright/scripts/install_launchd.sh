#!/usr/bin/env bash
# Optional launchd agents for ContactOut dashboard automation (Playwright folder only).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
LABEL_KEEP="com.vexecsearch.contactout-keepalive"
LABEL_SYNC="com.vexecsearch.contactout-dashboard-sync"

PYTHON="$ROOT/.venv/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  echo "Missing venv — run: cd Playwright && ./scripts/setup.sh"
  exit 1
fi

mkdir -p "$ROOT/logs" "$LAUNCH_AGENTS"

write_plist() {
  local label="$1" script="$2" interval="$3" out="$4" err="$5"
  cat > "$LAUNCH_AGENTS/${label}.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${PYTHON}</string><string>${script}</string></array>
  <key>StartInterval</key><integer>${interval}</integer>
  <key>StandardOutPath</key><string>${out}</string>
  <key>StandardErrorPath</key><string>${err}</string>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>TZ</key><string>America/New_York</string>
  </dict>
</dict>
</plist>
EOF
  echo "Wrote $LAUNCH_AGENTS/${label}.plist"
}

write_plist "$LABEL_KEEP" "$ROOT/scripts/contactout_keepalive.py" 18000 \
  "$ROOT/logs/keepalive_stdout.log" "$ROOT/logs/keepalive_stderr.log"
write_plist "$LABEL_SYNC" "$ROOT/scripts/contactout_dashboard_sync.py" 300 \
  "$ROOT/logs/dashboard_sync_stdout.log" "$ROOT/logs/dashboard_sync_stderr.log"

for label in "$LABEL_KEEP" "$LABEL_SYNC"; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS/${label}.plist"
  launchctl enable "gui/$(id -u)/$label"
done

echo "Loaded optional ContactOut Playwright agents (NOT part of production worker)."
