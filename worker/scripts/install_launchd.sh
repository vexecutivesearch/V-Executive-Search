#!/usr/bin/env bash
# Install launchd agents for JIT pipeline stages and admin poll (every 5 min).
set -euo pipefail

WORKER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
EXPAT_LIB="${HOMEBREW_PREFIX:-/opt/homebrew}/opt/expat/lib"
DYLD_EXPAT=""
if [[ -d "$EXPAT_LIB" ]]; then
  DYLD_EXPAT="$EXPAT_LIB"
fi

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
EOF
  if [[ -n "$DYLD_EXPAT" ]]; then
    cat >> "$plist_path" <<EOF
        <key>DYLD_LIBRARY_PATH</key>
        <string>${DYLD_EXPAT}</string>
EOF
  fi
  cat >> "$plist_path" <<EOF
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
EOF
  if [[ -n "$DYLD_EXPAT" ]]; then
    cat >> "$plist_path" <<EOF
        <key>DYLD_LIBRARY_PATH</key>
        <string>${DYLD_EXPAT}</string>
EOF
  fi
  cat >> "$plist_path" <<EOF
    </dict>
</dict>
</plist>
EOF

  echo "Wrote $plist_path"
}

# Daily pipeline (America/New_York)
write_calendar_plist "com.vexecsearch.scrape" \
  "scripts/run_daily.py --scrape-only" \
  6 0 \
  "$WORKER_ROOT/logs/scrape_am_stdout.log" \
  "$WORKER_ROOT/logs/scrape_am_stderr.log"

write_calendar_plist "com.vexecsearch.hygiene" \
  "scripts/run_daily.py --hygiene-only" \
  6 15 \
  "$WORKER_ROOT/logs/hygiene_stdout.log" \
  "$WORKER_ROOT/logs/hygiene_stderr.log"

write_calendar_plist "com.vexecsearch.rescore" \
  "scripts/run_daily.py --rescore-only" \
  6 30 \
  "$WORKER_ROOT/logs/rescore_am_stdout.log" \
  "$WORKER_ROOT/logs/rescore_am_stderr.log"

# Enrich is MANUAL ONLY — do not schedule. Trigger from /admin when ready.
launchctl bootout "gui/$(id -u)/com.vexecsearch.enrich" 2>/dev/null || true
rm -f "$LAUNCH_AGENTS/com.vexecsearch.enrich.plist"

write_calendar_plist "com.vexecsearch.presence" \
  "scripts/check_presence.py" \
  7 30 \
  "$WORKER_ROOT/logs/presence_stdout.log" \
  "$WORKER_ROOT/logs/presence_stderr.log"

write_calendar_plist "com.vexecsearch.email" \
  "scripts/run_daily.py --email-only" \
  7 45 \
  "$WORKER_ROOT/logs/email_stdout.log" \
  "$WORKER_ROOT/logs/email_stderr.log"

write_calendar_plist "com.vexecsearch.scrape-pm" \
  "scripts/run_daily.py --scrape-only" \
  18 0 \
  "$WORKER_ROOT/logs/scrape_pm_stdout.log" \
  "$WORKER_ROOT/logs/scrape_pm_stderr.log"

write_calendar_plist "com.vexecsearch.rescore-pm" \
  "scripts/run_daily.py --rescore-only" \
  18 30 \
  "$WORKER_ROOT/logs/rescore_pm_stdout.log" \
  "$WORKER_ROOT/logs/rescore_pm_stderr.log"

write_interval_plist "com.vexecsearch.poll" \
  "$WORKER_ROOT/scripts/poll_and_run.py" \
  300 \
  "$WORKER_ROOT/logs/poll_stdout.log" \
  "$WORKER_ROOT/logs/poll_stderr.log"

launchctl bootout "gui/$(id -u)/com.vexecsearch.contactout-keepalive" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.vexecsearch.daily" 2>/dev/null || true
rm -f "$LAUNCH_AGENTS/com.vexecsearch.daily.plist"

for label in com.vexecsearch.hygiene com.vexecsearch.scrape com.vexecsearch.rescore com.vexecsearch.presence com.vexecsearch.email com.vexecsearch.scrape-pm com.vexecsearch.rescore-pm com.vexecsearch.poll; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS/${label}.plist"
  launchctl enable "gui/$(id -u)/$label"
  echo "Loaded $label"
done

echo ""
echo "Done. Scheduled (America/New_York):"
echo "  • 06:00 Morning scrape + jobs_only ingest + LinkedIn posters (free)"
echo "  • 06:15 Archive stale listings (free)"
echo "  • 06:30 Rescore backlog (free)"
echo "  • 07:30 Presence checks — iMessage + email MX (free)"
echo "  • 07:45 Call sheet email (free)"
echo "  • 18:00 Evening scrape + jobs_only ingest + LinkedIn posters (free)"
echo "  • 18:30 Evening rescore backlog (free)"
echo "  • Every 5 min Admin 'Run now' poll (com.vexecsearch.poll)"
echo "  • Enrich: MANUAL ONLY (Admin → Run enrich / worker --enrich-only)"
echo ""
echo "Note: Mac must be awake at scheduled times — launchd does not run missed jobs after sleep."
echo ""
echo "Verify: launchctl list | grep vexecsearch"
