#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -e .
patchright install chrome || playwright install chrome

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env — edit before running."
fi

echo "Setup complete. See README.md (this folder is NOT wired to production worker)."
