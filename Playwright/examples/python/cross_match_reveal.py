#!/usr/bin/env python3
"""
Reference: async ContactOut cross-match + 429 backoff (Python / Playwright).
NOT wired to production — prefer scripts/test_cross_match.py for this package.

Usage:
  pip install playwright && playwright install chrome
  python examples/python/cross_match_reveal.py "Ryan Cronin" "https://linkedin.com/in/..."
"""
from __future__ import annotations

import asyncio
import random
import re
import sys
from pathlib import Path

from playwright.async_api import async_playwright


async def human_wait(min_ms: int = 3000, max_ms: int = 7000) -> None:
    await asyncio.sleep(random.uniform(min_ms / 1000, max_ms / 1000))


def clean_linkedin(url: str | None) -> str:
    return (url or "").split("?")[0].lower().rstrip("/")


async def goto_with_retry(page, url: str, max_attempts: int = 5):
    backoff = 5.0
    for attempt in range(max_attempts):
        await human_wait()
        response = await page.goto(url, wait_until="domcontentloaded")
        if response and response.status == 429:
            print(f"[429] Vanishing for {backoff}s (attempt {attempt + 1})")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 900)
            continue
        return response
    raise RuntimeError(f"429 loop on {url}")


async def verify_credits(page) -> int:
    body = await page.inner_text("body")
    match = re.search(r"(\d+)\s*credits?\s*(left|remaining)", body, re.I)
    return int(match.group(1)) if match else 999


async def cross_match_and_reveal(name: str, expected_linkedin: str) -> None:
    session = Path(__file__).resolve().parents[2] / ".contactout-session.json"
    storage = str(session) if session.is_file() else None

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = await browser.new_context(
            storage_state=storage,
            viewport={"width": 1440, "height": 900},
        )
        page = await context.new_page()
        try:
            await goto_with_retry(page, "https://contactout.com/dashboard/search")
            if await verify_credits(page) <= 0:
                print("Credits depleted")
                return

            name_input = page.get_by_label("Name").first()
            await name_input.click()
            await name_input.fill(name)
            await name_input.press("Enter")
            await human_wait(3000, 6000)
            await page.evaluate("window.scrollBy(0, 350)")

            expected = clean_linkedin(expected_linkedin)
            cards = await page.locator("table tbody tr, .profile-card").all()
            for card in cards:
                anchor = card.locator('a[href*="linkedin.com"]').first()
                if await anchor.count() == 0:
                    continue
                found = clean_linkedin(await anchor.get_attribute("href"))
                if found != expected:
                    continue
                print("Match verified — reveal on card")
                reveal = card.get_by_role("button", name=re.compile(r"reveal|show email", re.I))
                await human_wait(1500, 3500)
                await reveal.first.click()
                await human_wait()
                break
        finally:
            await context.close()
            await browser.close()


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python cross_match_reveal.py <name> <linkedin_url>")
        raise SystemExit(1)
    asyncio.run(cross_match_and_reveal(sys.argv[1], sys.argv[2]))
