#!/usr/bin/env bash
# Verify all V Executive Search launchd jobs point at the clean release checkout.
set -euo pipefail

EDIT_REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EDIT_WORKER_ROOT="$EDIT_REPO_ROOT/worker"
RELEASE_CHECKOUT="${WORKER_RELEASE_CHECKOUT:-${EDIT_REPO_ROOT}-release}"
RELEASE_WORKER_ROOT="$RELEASE_CHECKOUT/worker"
LABELS=(
  com.vexecsearch.hygiene
  com.vexecsearch.scrape
  com.vexecsearch.rescore
  com.vexecsearch.presence
  com.vexecsearch.email
  com.vexecsearch.scrape-pm
  com.vexecsearch.rescore-pm
  com.vexecsearch.poll
)

if [[ ! -d "$RELEASE_WORKER_ROOT" ]]; then
  echo "Release worker directory missing: $RELEASE_WORKER_ROOT"
  exit 1
fi

for label in "${LABELS[@]}"; do
  details="$(launchctl print "gui/$(id -u)/$label" 2>/dev/null || true)"
  if [[ -z "$details" ]]; then
    echo "Missing launchd job: $label"
    exit 1
  fi
  if ! grep -q "working directory = $RELEASE_WORKER_ROOT" <<< "$details"; then
    echo "Job does not point at release worker: $label"
    echo "$details" | grep -E 'path = |program = |working directory = |stdout path = |stderr path =' || true
    exit 1
  fi
  if grep -q "working directory = $EDIT_WORKER_ROOT" <<< "$details"; then
    echo "Job still points at edit worker: $label"
    exit 1
  fi
done

loaded_count="$(launchctl list | awk '/com\.vexecsearch\./ { count++ } END { print count + 0 }')"
if [[ "$loaded_count" -ne "${#LABELS[@]}" ]]; then
  echo "Expected ${#LABELS[@]} V Exec Search agents; found $loaded_count"
  launchctl list | grep -i vexecsearch || true
  exit 1
fi

echo "OK: ${#LABELS[@]} agents loaded and all point at $RELEASE_WORKER_ROOT"
