from __future__ import annotations

import logging
import time
from typing import Any

from src.human_behavior import human_pause
from src.rate_limit import (
    exponential_backoff_seconds,
    handle_http_429,
    mark_rate_limited,
    page_shows_rate_limit,
)
from src.resend_notify import notify_rate_limit_lockout

logger = logging.getLogger(__name__)


def goto_with_retry(
    page: Any,
    url: str,
    *,
    max_attempts: int = 5,
    base_delay_sec: float = 5.0,
    wait_until: str = "domcontentloaded",
    timeout_ms: int = 45000,
) -> Any:
    """
    Navigate with human pre-delay and exponential backoff on HTTP 429.
    Yields to the firewall instead of hammering the door.
    """
    attempt = 0
    backoff = base_delay_sec

    while attempt < max_attempts:
        human_pause(page, label=f"pre-goto-{attempt}")
        try:
            response = page.goto(
                url,
                wait_until=wait_until,
                timeout=timeout_ms,
            )
        except Exception as exc:
            attempt += 1
            logger.warning("Navigation error (attempt %d): %s", attempt, exc)
            time.sleep(backoff)
            backoff = min(backoff * 2, 900)
            continue

        status = getattr(response, "status", None) if response else None
        if status == 429:
            attempt += 1
            wait = int(handle_http_429(response, attempt=attempt))
            logger.warning("[429] Retracting — sleeping %ds before retry", wait)
            time.sleep(max(wait, backoff))
            backoff = min(backoff * 2, 900)
            continue

        if page_shows_rate_limit(page):
            attempt += 1
            mark_rate_limited(cooldown_sec=int(backoff))
            notify_rate_limit_lockout(attempt=attempt, url=url)
            time.sleep(backoff)
            backoff = min(backoff * 2, 900)
            continue

        return response

    raise RuntimeError(f"Navigation failed after {max_attempts} attempts: {url}")


def retry_action(
    action,
    *,
    max_attempts: int = 4,
    base_delay_sec: float = 2.0,
    label: str = "action",
):
    """Generic retry wrapper with exponential backoff."""
    last_exc: Exception | None = None
    for attempt in range(max_attempts):
        try:
            return action()
        except Exception as exc:
            last_exc = exc
            delay = exponential_backoff_seconds(attempt, cap=120.0)
            logger.warning("%s failed (attempt %d): %s — wait %.1fs", label, attempt + 1, exc, delay)
            time.sleep(delay)
    if last_exc:
        raise last_exc
    return None
