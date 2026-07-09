from __future__ import annotations

import os
import random
import time
from typing import Any


def _ms_bounds() -> tuple[int, int]:
    low = int(os.environ.get("CONTACTOUT_HUMAN_DELAY_MIN_MS", "3000"))
    high = int(os.environ.get("CONTACTOUT_HUMAN_DELAY_MAX_MS", "7000"))
    return min(low, high), max(low, high)


def human_delay_ms() -> int:
    lo, hi = _ms_bounds()
    return random.randint(lo, hi)


def human_pause(page: Any | None = None, *, label: str = "") -> None:
    """Random pause after navigation, clicks, or profile renders."""
    ms = human_delay_ms()
    if label:
        import logging

        logging.getLogger(__name__).debug("Human pause %dms (%s)", ms, label)
    if page is not None:
        page.wait_for_timeout(ms)
    else:
        time.sleep(ms / 1000.0)


def human_type(locator: Any, text: str) -> None:
    """Type with per-keystroke jitter (slower than fill())."""
    locator.click(timeout=3000)
    for ch in text:
        locator.press_sequentially(ch, delay=random.randint(40, 140))


def between_profile_pause() -> None:
    """Longer idle gap between dashboard profile lookups."""
    low = float(os.environ.get("CONTACTOUT_DASHBOARD_DELAY_MIN", "60"))
    high = float(os.environ.get("CONTACTOUT_DASHBOARD_DELAY_MAX", "150"))
    time.sleep(random.uniform(min(low, high), max(low, high)))


def simulate_reading(page: Any, *, scroll_px: int | None = None) -> None:
    """Scroll and pause like a human scanning results."""
    px = scroll_px if scroll_px is not None else random.randint(200, 500)
    try:
        page.mouse.wheel(0, px)
    except Exception:
        try:
            page.evaluate(f"window.scrollBy(0, {px})")
        except Exception:
            pass
    human_pause(page, label="reading-scroll")


def pre_reveal_hesitation(page: Any) -> None:
    """Short pause before clicking Reveal (machines click instantly)."""
    ms = random.randint(1500, 3500)
    page.wait_for_timeout(ms)

