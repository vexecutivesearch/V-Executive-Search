#!/usr/bin/env python3
"""One-time ContactOut login — saves cookies for unattended background runs."""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from dotenv import load_dotenv

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))
load_dotenv(WORKER_ROOT / ".env")

from src.enrich.contactout_dashboard import (  # noqa: E402
    has_saved_session,
    login_in_progress,
)
from src.enrich.contactout_session import (  # noqa: E402
    SessionStatus,
    clear_session_degraded,
    ensure_session_healthy,
    session_file_path,
)

logging.basicConfig(level=logging.INFO, format="%(message)s")


def main() -> int:
    parser = argparse.ArgumentParser(description="ContactOut dashboard login")
    parser.add_argument(
        "--timeout",
        type=int,
        default=600,
        help="Seconds to wait for manual login (default: 600)",
    )
    args = parser.parse_args()

    if login_in_progress():
        print("ContactOut login already in progress in another window — use that window.")
        return 1

    session = session_file_path()
    print(f"Session file: {session}")
    if has_saved_session():
        print("Existing session found — will refresh cookies after you sign in.")
    print(
        "\nDedicated automation browser (NOT your daily Chrome).\n"
        "Sign in with email + password (not Google SSO) for reliable auto re-login.\n"
        "If BlockBlock prompts, click Allow for Python/Chromium.\n"
    )

    status = ensure_session_healthy(
        allow_interactive=True,
        allow_auto_login=True,
        alert_on_failure=False,
    )
    if status in (SessionStatus.OK, SessionStatus.NOT_NEEDED):
        clear_session_degraded()
        print(f"\nContactOut session ready. Background worker uses: {session}")
        return 0
    print(
        "\nLogin not completed. Store Keychain credentials for full automation:\n"
        "  python scripts/contactout_store_credentials.py"
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
