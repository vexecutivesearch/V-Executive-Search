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
    ensure_contactout_session,
    has_saved_session,
    login_in_progress,
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
        "\nA dedicated automation browser will open (NOT your daily Chrome profile).\n"
        "Sign in to ContactOut and leave the window open.\n"
        "Cookies are saved to the session file above for headless background runs.\n"
        "If BlockBlock prompts, click Allow for Python/Chromium.\n"
    )

    ok = ensure_contactout_session(timeout_sec=args.timeout, interactive=True)
    if ok:
        print(f"\nContactOut session ready. Background worker will use: {session}")
        return 0
    print(
        "\nLogin not completed. Re-run this script after signing in, "
        "or use Admin → Sync ContactOut phones."
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
