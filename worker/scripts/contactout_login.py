#!/usr/bin/env python3
"""One-time ContactOut login — saves a persistent Chrome session for dashboard mode."""
from __future__ import annotations

import sys
from pathlib import Path

from dotenv import load_dotenv

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))
load_dotenv(WORKER_ROOT / ".env")

from src.enrich.contactout_dashboard import (  # noqa: E402
    CONTACTOUT_LOGIN_URL,
    browser_profile_dir,
)


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Install Playwright first:")
        print("  pip install playwright")
        print("  playwright install chrome")
        return 1

    profile = browser_profile_dir()
    profile.mkdir(parents=True, exist_ok=True)
    print(f"Browser profile: {profile}")
    print("A Chrome window will open. Log into ContactOut, then return here.")

    with sync_playwright() as playwright:
        try:
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=str(profile),
                channel="chrome",
                headless=False,
                viewport={"width": 1440, "height": 900},
            )
        except Exception:
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=str(profile),
                headless=False,
                viewport={"width": 1440, "height": 900},
            )
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(CONTACTOUT_LOGIN_URL, wait_until="domcontentloaded")
        input("Press Enter after you are logged in and can see the dashboard... ")
        context.close()

    print("Saved session. Set CONTACTOUT_MODE=dashboard in worker/.env")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
