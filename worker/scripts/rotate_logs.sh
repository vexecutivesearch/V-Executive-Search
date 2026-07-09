#!/bin/bash
# Rotate worker logs older than 30 days
LOG_DIR="$(dirname "$0")/../logs"
find "$LOG_DIR" -name "daily_*.log" -mtime +30 -delete 2>/dev/null
find "$LOG_DIR" -name "launchd_*.log" -size +10M -exec truncate -s 0 {} \; 2>/dev/null
