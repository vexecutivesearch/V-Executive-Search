#!/usr/bin/env python3
"""Ensure ContactOut dashboard login — opens Chrome when session is missing."""
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
    browser_profile_dir,
    ensure_contactout_session,
    login_in_progress,
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

    profile = browser_profile_dir()
    print(f"Browser profile: {profile}")
    print(
        "Chrome will open. Sign in to ContactOut and leave the window open.\n"
        "The script closes it automatically once login is confirmed.\n"
        "If BlockBlock prompts, click Allow for Python/Chrome."
    )
    ok = ensure_contactout_session(timeout_sec=args.timeout, interactive=True)
    if ok:
        print("ContactOut session ready.")
        return 0
    print(
        "ContactOut login not completed. Re-run this script after signing in, "
        "or use Admin → Sync ContactOut phones."
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
