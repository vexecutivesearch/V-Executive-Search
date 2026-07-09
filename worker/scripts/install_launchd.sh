#!/usr/bin/env bash
# Install launchd agents for daily pipeline (6 AM) and admin poll (every 5 min).
set -euo pipefail

WORKER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
DAILY_LABEL="com.vexecsearch.daily"
POLL_LABEL="com.vexecsearch.poll"

PYTHON="$WORKER_ROOT/.venv/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  echo "Missing venv at $PYTHON — run: cd worker && python3 -m venv .venv && pip install -e ."
  exit 1
fi

mkdir -p "$WORKER_ROOT/logs" "$LAUNCH_AGENTS"

write_plist() {
  local label="$1"
  local script="$2"
  local interval_or_calendar="$3"
  local out_log="$4"
  local err_log="$5"

  local plist_path="$LAUNCH_AGENTS/${label}.plist"

  if [[ "$interval_or_calendar" == interval:* ]]; then
    local seconds="${interval_or_calendar#interval:}"
    cat > "$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
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
    </dict>
</dict>
</plist>
EOF
  else
    cat > "$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${PYTHON}</string>
        <string>${script}</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>6</integer>
        <key>Minute</key>
        <integer>0</integer>
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
    </dict>
</dict>
</plist>
EOF
  fi

  echo "Wrote $plist_path"
}

write_plist "$DAILY_LABEL" \
  "$WORKER_ROOT/scripts/run_daily.py" \
  "calendar" \
  "$WORKER_ROOT/logs/launchd_stdout.log" \
  "$WORKER_ROOT/logs/launchd_stderr.log"

write_plist "$POLL_LABEL" \
  "$WORKER_ROOT/scripts/poll_and_run.py" \
  "interval:300" \
  "$WORKER_ROOT/logs/poll_stdout.log" \
  "$WORKER_ROOT/logs/poll_stderr.log"

for label in "$DAILY_LABEL" "$POLL_LABEL"; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS/${label}.plist"
  launchctl enable "gui/$(id -u)/$label"
  echo "Loaded $label"
done

echo ""
echo "Done. Scheduled:"
echo "  • Daily pipeline at 6:00 AM local time ($DAILY_LABEL)"
echo "  • Admin 'Run now' poll every 5 minutes ($POLL_LABEL)"
echo ""
echo "Verify: launchctl list | grep vexecsearch"
echo "Logs:   tail -f $WORKER_ROOT/logs/launchd_stdout.log"
