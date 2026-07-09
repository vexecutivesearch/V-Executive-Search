#!/usr/bin/env python3
"""Layer 0 — refresh ContactOut session cookies (run every 4–6 hours via launchd)."""
from __future__ import annotations

import logging
import sys
from pathlib import Path

from dotenv import load_dotenv

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))
load_dotenv(WORKER_ROOT / ".env")

from src.enrich.contactout_session import (  # noqa: E402
    ensure_session_healthy,
    run_keepalive,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")


def main() -> int:
    if run_keepalive():
        return 0
    # Session dead — try auto-login before giving up
    status = ensure_session_healthy(
        allow_interactive=False,
        allow_auto_login=True,
        alert_on_failure=False,
    )
    if status.value == "ok":
        return run_keepalive() and 0 or 1
    logging.info("Keepalive could not refresh session (status=%s)", status.value)
    return 0  # non-fatal — poll/pipeline will retry


if __name__ == "__main__":
    raise SystemExit(main())
