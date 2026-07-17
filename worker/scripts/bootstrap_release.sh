#!/usr/bin/env bash
# Bootstrap launchd onto a clean promoted release checkout.
set -euo pipefail

SOURCE_WORKER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_REPO_ROOT="$(cd "$SOURCE_WORKER_ROOT/.." && pwd)"
RELEASE_REF="${WORKER_RELEASE_REF:-origin/worker-production}"
RELEASE_CHECKOUT="${WORKER_RELEASE_CHECKOUT:-${SOURCE_REPO_ROOT}-release}"
PREVIOUS_CHECKOUT="${WORKER_PREVIOUS_RELEASE_CHECKOUT:-${RELEASE_CHECKOUT}-previous}"
RUNTIME_ENV_FILE="${WORKER_RUNTIME_ENV_FILE:-${WORKER_ENV_FILE:-$HOME/.vsearch/worker.env}}"
BOOTSTRAP_PYTHON="${WORKER_BOOTSTRAP_PYTHON:-python3}"
EXPAT_LIB="${HOMEBREW_PREFIX:-/opt/homebrew}/opt/expat/lib"
PY_ENV=()
if [[ -d "$EXPAT_LIB" ]]; then
  PY_ENV=(env "DYLD_LIBRARY_PATH=${EXPAT_LIB}${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}")
fi
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

if [[ ! -f "$RUNTIME_ENV_FILE" ]]; then
  if [[ -f "$SOURCE_WORKER_ROOT/.env" ]]; then
    echo "→ Creating canonical worker env at $RUNTIME_ENV_FILE from current worker/.env"
    mkdir -p "$(dirname "$RUNTIME_ENV_FILE")"
    cp "$SOURCE_WORKER_ROOT/.env" "$RUNTIME_ENV_FILE"
    chmod 600 "$RUNTIME_ENV_FILE"
  else
    echo "Missing canonical worker env: $RUNTIME_ENV_FILE"
    echo "Create it from worker/.env before bootstrapping."
    exit 1
  fi
fi

if [[ "${WORKER_ALLOW_DIRTY_BOOTSTRAP:-false}" != "true" ]]; then
  dirty_tracked="$(git -C "$SOURCE_REPO_ROOT" status --porcelain --untracked-files=no)"
  if [[ -n "$dirty_tracked" ]]; then
    echo "Refusing to bootstrap from a checkout with tracked modifications:"
    echo "$dirty_tracked"
    echo ""
    echo "Commit/promote first, or set WORKER_ALLOW_DIRTY_BOOTSTRAP=true only for emergency containment."
    exit 1
  fi
fi

echo "→ Fetching promoted worker release: $RELEASE_REF"
git -C "$SOURCE_REPO_ROOT" fetch --prune origin
TARGET_SHA="$(git -C "$SOURCE_REPO_ROOT" rev-parse "$RELEASE_REF")"
TMP_CHECKOUT="${RELEASE_CHECKOUT}.tmp-${TARGET_SHA:0:12}"

echo "→ Preparing clean release checkout: $RELEASE_CHECKOUT @ $TARGET_SHA"
git -C "$SOURCE_REPO_ROOT" worktree prune
git -C "$SOURCE_REPO_ROOT" worktree remove --force "$TMP_CHECKOUT" 2>/dev/null || true
rm -rf "$TMP_CHECKOUT"
git -C "$SOURCE_REPO_ROOT" worktree add --detach "$TMP_CHECKOUT" "$TARGET_SHA"

dirty_release="$(git -C "$TMP_CHECKOUT" status --porcelain --untracked-files=no)"
if [[ -n "$dirty_release" ]]; then
  echo "Prepared release checkout is dirty:"
  echo "$dirty_release"
  exit 1
fi

echo "→ Copying worker runtime env"
ln -s "$RUNTIME_ENV_FILE" "$TMP_CHECKOUT/worker/.env"

echo "→ Creating release venv"
"${PY_ENV[@]}" "$BOOTSTRAP_PYTHON" -m venv "$TMP_CHECKOUT/worker/.venv"
"${PY_ENV[@]}" "$TMP_CHECKOUT/worker/.venv/bin/python" -m pip install -q --upgrade pip setuptools wheel
"${PY_ENV[@]}" "$TMP_CHECKOUT/worker/.venv/bin/python" -m pip install -q -e "$TMP_CHECKOUT/worker"

echo "→ Swapping release checkout"
rm -rf "$PREVIOUS_CHECKOUT"
if [[ -d "$RELEASE_CHECKOUT" ]]; then
  mv "$RELEASE_CHECKOUT" "$PREVIOUS_CHECKOUT"
fi
mv "$TMP_CHECKOUT" "$RELEASE_CHECKOUT"

echo "→ Installing launchd from release checkout"
WORKER_ENV_FILE="$RUNTIME_ENV_FILE" bash "$RELEASE_CHECKOUT/worker/scripts/install_launchd.sh"

echo "→ Verifying launchd points at release checkout only"
for label in "${LABELS[@]}"; do
  details="$(launchctl print "gui/$(id -u)/$label" 2>/dev/null || true)"
  if [[ -z "$details" ]]; then
    echo "Missing launchd job after install: $label"
    exit 1
  fi
  if ! grep -q "working directory = $RELEASE_CHECKOUT/worker" <<< "$details"; then
    echo "Launchd job does not point at release worker: $label"
    echo "$details" | grep -E 'path = |program = |working directory = |stdout path = |stderr path =' || true
    exit 1
  fi
  if grep -q "working directory = $SOURCE_WORKER_ROOT" <<< "$details"; then
    echo "Launchd job still points at edit worker: $label"
    exit 1
  fi
done

echo ""
echo "Done. launchd now points at:"
echo "  $RELEASE_CHECKOUT/worker"
if [[ -d "$PREVIOUS_CHECKOUT" ]]; then
  echo "Previous release retained for rollback:"
  echo "  $PREVIOUS_CHECKOUT"
fi
echo "Canonical worker env:"
echo "  $RUNTIME_ENV_FILE"
echo "Release SHA:"
echo "  $TARGET_SHA"
