#!/usr/bin/env bash
# Install launchd agents for JIT pipeline stages and admin poll (every 5 min).
set -euo pipefail

WORKER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

PYTHON="$WORKER_ROOT/.venv/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  echo "Missing venv at $PYTHON — run: cd worker && python3 -m venv .venv && pip install -e ."
  exit 1
fi

mkdir -p "$WORKER_ROOT/logs" "$LAUNCH_AGENTS"

write_calendar_plist() {
  local label="$1"
  local script_args="$2"
  local hour="$3"
  local minute="$4"
  local out_log="$5"
  local err_log="$6"

  local plist_path="$LAUNCH_AGENTS/${label}.plist"

  # script_args is space-separated: e.g. "run_daily.py --scrape-only"
  read -r -a args <<< "$script_args"

  cat > "$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/caffeinate</string>
        <string>-s</string>
        <string>${PYTHON}</string>
EOF

  for arg in "${args[@]}"; do
    echo "        <string>${arg}</string>" >> "$plist_path"
  done

  cat >> "$plist_path" <<EOF
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${hour}</integer>
        <key>Minute</key>
        <integer>${minute}</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>${out_log}</string>
    <key>StandardErrorPath</key>
    <string>${err_log}</string>
    <key>WorkingDirectory</key>
    <string>${WORKER_ROOT}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>TZ</key>
        <string>America/New_York</string>
    </dict>
</dict>
</plist>
EOF

  echo "Wrote $plist_path"
}

write_interval_plist() {
  local label="$1"
  local script="$2"
  local seconds="$3"
  local out_log="$4"
  local err_log="$5"

  local plist_path="$LAUNCH_AGENTS/${label}.plist"

  cat > "$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/caffeinate</string>
        <string>-s</string>
        <string>${PYTHON}</string>
        <string>${script}</string>
    </array>
    <key>StartInterval</key>
    <integer>${seconds}</integer>
    <key>StandardOutPath</key>
    <string>${out_log}</string>
    <key>StandardErrorPath</key>
    <string>${err_log}</string>
    <key>WorkingDirectory</key>
    <string>${WORKER_ROOT}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>TZ</key>
        <string>America/New_York</string>
    </dict>
</dict>
</plist>
EOF

  echo "Wrote $plist_path"
}

# JIT pipeline schedule (Eastern Time via TZ=America/New_York)
write_calendar_plist "com.vexecsearch.hygiene" \
  "scripts/run_daily.py --hygiene-only" \
  2 15 \
  "$WORKER_ROOT/logs/hygiene_stdout.log" \
  "$WORKER_ROOT/logs/hygiene_stderr.log"

write_calendar_plist "com.vexecsearch.scrape" \
  "scripts/run_daily.py --scrape-only" \
  2 0 \
  "$WORKER_ROOT/logs/scrape_stdout.log" \
  "$WORKER_ROOT/logs/scrape_stderr.log"

write_calendar_plist "com.vexecsearch.rescore" \
  "scripts/run_daily.py --rescore-only" \
  2 30 \
  "$WORKER_ROOT/logs/rescore_stdout.log" \
  "$WORKER_ROOT/logs/rescore_stderr.log"

write_calendar_plist "com.vexecsearch.enrich" \
  "scripts/run_daily.py --enrich-only" \
  3 0 \
  "$WORKER_ROOT/logs/enrich_stdout.log" \
  "$WORKER_ROOT/logs/enrich_stderr.log"

write_calendar_plist "com.vexecsearch.presence" \
  "scripts/check_presence.py" \
  3 30 \
  "$WORKER_ROOT/logs/presence_stdout.log" \
  "$WORKER_ROOT/logs/presence_stderr.log"

write_calendar_plist "com.vexecsearch.email" \
  "scripts/run_daily.py --email-only" \
  6 0 \
  "$WORKER_ROOT/logs/email_stdout.log" \
  "$WORKER_ROOT/logs/email_stderr.log"

write_interval_plist "com.vexecsearch.poll" \
  "$WORKER_ROOT/scripts/poll_and_run.py" \
  300 \
  "$WORKER_ROOT/logs/poll_stdout.log" \
  "$WORKER_ROOT/logs/poll_stderr.log"

launchctl bootout "gui/$(id -u)/com.vexecsearch.contactout-keepalive" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.vexecsearch.daily" 2>/dev/null || true

for label in com.vexecsearch.hygiene com.vexecsearch.scrape com.vexecsearch.rescore com.vexecsearch.enrich com.vexecsearch.presence com.vexecsearch.email com.vexecsearch.poll; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS/${label}.plist"
  launchctl enable "gui/$(id -u)/$label"
  echo "Loaded $label"
done

echo ""
echo "Done. Scheduled (America/New_York):"
echo "  • 02:00 Scrape + jobs_only ingest (free)"
echo "  • 02:15 Archive stale listings (free)"
echo "  • 02:30 ICP filter + rescore backlog (free)"
echo "  • 03:00 Enrich top-N call sheet (paid)"
echo "  • 03:30 Presence checks — iMessage + email MX (free)"
echo "  • 06:00 Call sheet email (free)"
echo "  • Every 5 min Admin 'Run now' poll (com.vexecsearch.poll)"
echo ""
echo "Verify: launchctl list | grep vexecsearch"
