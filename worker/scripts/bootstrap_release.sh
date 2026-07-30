#!/usr/bin/env bash
# Bootstrap launchd onto a clean promoted release checkout.
set -euo pipefail

SOURCE_WORKER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_REPO_ROOT="$(cd "$SOURCE_WORKER_ROOT/.." && pwd)"
RELEASE_REF="${WORKER_RELEASE_REF:-origin/worker-production}"
RELEASE_CHECKOUT="${WORKER_RELEASE_CHECKOUT:-${SOURCE_REPO_ROOT}-release}"
PREVIOUS_CHECKOUT="${WORKER_PREVIOUS_RELEASE_CHECKOUT:-${RELEASE_CHECKOUT}-previous}"
RUNTIME_ENV_FILE="${WORKER_RUNTIME_ENV_FILE:-${WORKER_ENV_FILE:-$HOME/.vsearch/worker.env}}"
STABLE_PYTHON_INSTALLER="$SOURCE_WORKER_ROOT/scripts/install_stable_python.sh"
EXPAT_LIB="${HOMEBREW_PREFIX:-/opt/homebrew}/opt/expat/lib"

# Build the venv against the frozen interpreter under $HOME, never the Homebrew
# Cellar. macOS TCC resolves the venv symlink and grants Full Disk Access to the
# real binary, so a Cellar-backed venv loses chat.db access (and therefore all
# inbound SMS) the next time `brew upgrade python@3.12` moves that binary.
BOOTSTRAP_PYTHON="${WORKER_BOOTSTRAP_PYTHON:-}"
if [[ -z "$BOOTSTRAP_PYTHON" && "$(uname -s)" == "Darwin" ]]; then
  # Non-fatal: a machine with no Homebrew python@3.12 still bootstraps on
  # plain python3 below, just without the durable Full Disk Access grant.
  bash "$STABLE_PYTHON_INSTALLER" --quiet || true
  BOOTSTRAP_PYTHON="$(bash "$STABLE_PYTHON_INSTALLER" --path)"
fi
if [[ -z "$BOOTSTRAP_PYTHON" || ! -x "$BOOTSTRAP_PYTHON" ]]; then
  BOOTSTRAP_PYTHON=python3
fi
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

echo "→ Creating release venv ($BOOTSTRAP_PYTHON)"
"${PY_ENV[@]}" "$BOOTSTRAP_PYTHON" -m venv "$TMP_CHECKOUT/worker/.venv"
"${PY_ENV[@]}" "$TMP_CHECKOUT/worker/.venv/bin/python" -m pip install -q --upgrade pip setuptools wheel
"${PY_ENV[@]}" "$TMP_CHECKOUT/worker/.venv/bin/python" -m pip install -q -e "$TMP_CHECKOUT/worker"

if [[ "$(uname -s)" == "Darwin" ]]; then
  TCC_PYTHON="$(readlink -f "$TMP_CHECKOUT/worker/.venv/bin/python")"
  echo "→ Full Disk Access is judged against: $TCC_PYTHON"
  if [[ "$TCC_PYTHON" == *"/Cellar/"* ]]; then
    echo "  WARNING: that path contains a Homebrew version number, so the next"
    echo "  \`brew upgrade python@3.12\` will move it and silently kill inbound SMS."
    echo "  Fix: bash $STABLE_PYTHON_INSTALLER"
  fi
fi

echo "→ Swapping release checkout"
# The rollback copy only has to be runnable, not a live worktree, so a plain mv
# is enough — git's registration for it is dropped by the prune below.
rm -rf "$PREVIOUS_CHECKOUT"
if [[ -d "$RELEASE_CHECKOUT" ]]; then
  mv "$RELEASE_CHECKOUT" "$PREVIOUS_CHECKOUT"
fi
# With the release path empty its old registration is finally prunable, which
# frees the name for the incoming worktree.
git -C "$SOURCE_REPO_ROOT" worktree prune
# `git worktree move`, not mv: git has to know the checkout by its final path.
# A plain mv leaves it registered under the temp name and therefore prunable, so
# the prune above would delete its metadata on the *next* promotion. The checkout
# keeps running either way — launchd only needs the files — while every
# `git rev-parse` inside it reports a stale SHA. That is exactly the SHA the
# worker sends to Admin, so the drift check goes blind precisely when it matters.
git -C "$SOURCE_REPO_ROOT" worktree move "$TMP_CHECKOUT" "$RELEASE_CHECKOUT"

reported="$(git -C "$RELEASE_CHECKOUT" rev-parse HEAD 2>/dev/null || true)"
if [[ "$reported" != "$TARGET_SHA" ]]; then
  echo "Release checkout reports SHA '${reported:-<none>}', expected $TARGET_SHA."
  echo "Admin drift detection reads that value, so refusing to finish silently."
  exit 1
fi

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
