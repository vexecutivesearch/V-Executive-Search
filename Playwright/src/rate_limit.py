from __future__ import annotations

import logging
import os
import random
import time
from pathlib import Path
from typing import Any

from src.project_root import project_root

logger = logging.getLogger(__name__)


def _flag_path() -> Path:
    return project_root() / ".contactout-rate-limited"


def mark_rate_limited(*, cooldown_sec: int | None = None) -> None:
    if cooldown_sec is None:
        cooldown_sec = int(os.environ.get("CONTACTOUT_RATE_LIMIT_COOLDOWN", "3600"))
    until = time.time() + max(cooldown_sec, 60)
    _flag_path().write_text(str(until), encoding="utf-8")
    logger.warning("ContactOut rate-limited — pausing for %ds", cooldown_sec)


def clear_rate_limited() -> None:
    path = _flag_path()
    if path.exists():
        path.unlink()


def is_rate_limited() -> bool:
    path = _flag_path()
    if not path.exists():
        return False
    try:
        until = float(path.read_text(encoding="utf-8").strip())
    except ValueError:
        path.unlink(missing_ok=True)
        return False
    if time.time() < until:
        return True
    path.unlink(missing_ok=True)
    return False


def seconds_until_reset() -> int:
    path = _flag_path()
    if not path.exists():
        return 0
    try:
        until = float(path.read_text(encoding="utf-8").strip())
    except ValueError:
        return 0
    return max(0, int(until - time.time()))


def exponential_backoff_seconds(attempt: int, *, cap: float = 900.0) -> float:
    """2s, 4s, 8s, 16s … capped, with jitter (use after HTTP 429)."""
    base = min(2.0 ** max(attempt, 0), cap)
    return base * random.uniform(0.85, 1.25)


def handle_http_429(response: Any, *, attempt: int = 0) -> int:
    """Honor Retry-After when present; otherwise exponential backoff."""
    retry_after = None
    headers = getattr(response, "headers", None)
    if headers is not None:
        retry_after = headers.get("Retry-After") or headers.get("retry-after")
    if retry_after:
        try:
            wait = int(retry_after)
        except (TypeError, ValueError):
            wait = int(exponential_backoff_seconds(attempt))
    else:
        wait = int(exponential_backoff_seconds(attempt))
    mark_rate_limited(cooldown_sec=wait)
    logger.warning("HTTP 429 — backing off %ds (attempt %d)", wait, attempt)
    return wait


def page_shows_rate_limit(page: Any) -> bool:
    try:
        body = (page.inner_text("body") or "").lower()
    except Exception:
        return False
    needles = (
        "too many requests",
        "429",
        "rate limit",
        "slow down",
        "try again later",
    )
    return any(n in body for n in needles)
