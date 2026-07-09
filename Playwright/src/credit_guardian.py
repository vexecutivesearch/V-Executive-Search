from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

_CREDIT_PATTERNS = (
    re.compile(r"(\d+)\s*/\s*\d+\s*credits?", re.I),
    re.compile(r"(\d+)\s*credits?\s*(?:left|remaining)", re.I),
    re.compile(r"credits?\s*:\s*(\d+)", re.I),
    re.compile(r"(\d+)\s+remaining", re.I),
)


def parse_credit_balance(text: str) -> int | None:
    if not text:
        return None
    for pattern in _CREDIT_PATTERNS:
        match = pattern.search(text)
        if match:
            return int(match.group(1))
    return None


def verify_credit_balance(page: Any, *, assume_available: int = 999) -> int:
    """
    Scrape ContactOut dashboard credit widget before reveal loops.
    Returns 0 when depleted; assume_available when UI metric is missing.
    """
    selectors = (
        'nav:has-text("Credits")',
        '[data-testid="user-credits"]',
        ".credit-balance-wrapper",
        'text=/\\d+\\s*credits?/i',
    )
    for selector in selectors:
        try:
            loc = page.locator(selector).first
            if loc.count() == 0:
                continue
            raw = loc.inner_text(timeout=2000)
            remaining = parse_credit_balance(raw)
            if remaining is not None:
                logger.info("[Credit Guardian] %d credits remaining", remaining)
                return remaining
        except Exception:
            continue

    try:
        body = page.inner_text("body", timeout=5000)
        remaining = parse_credit_balance(body)
        if remaining is not None:
            logger.info("[Credit Guardian] %d credits (body scan)", remaining)
            return remaining
    except Exception as exc:
        logger.debug("Credit body scan failed: %s", exc)

    logger.warning(
        "[Credit Guardian] Could not read balance — assuming %d (set CONTACTOUT_ASSUME_CREDITS=0 to fail closed)",
        assume_available,
    )
    return assume_available


def credits_depleted(page: Any) -> bool:
    import os

    assume = int(os.environ.get("CONTACTOUT_ASSUME_CREDITS", "999"))
    return verify_credit_balance(page, assume_available=assume) <= 0
