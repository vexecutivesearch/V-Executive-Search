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
)

logging.basicConfig(level=logging.INFO, format="%(message)s")


def main() -> int:
    parser = argparse.ArgumentParser(description="ContactOut dashboard login")
    parser.add_argument(
        "--timeout",
        type=int,
        default=300,
        help="Seconds to wait for manual login (default: 300)",
    )
    args = parser.parse_args()

    profile = browser_profile_dir()
    print(f"Browser profile: {profile}")
    ok = ensure_contactout_session(timeout_sec=args.timeout)
    if ok:
        print("ContactOut session ready.")
        return 0
    print("ContactOut login not completed — try again and allow Python/Chrome in BlockBlock if prompted.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
