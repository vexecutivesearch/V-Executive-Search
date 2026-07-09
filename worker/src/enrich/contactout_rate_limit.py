from __future__ import annotations

import logging
import os
import time
from pathlib import Path

logger = logging.getLogger(__name__)


def _flag_path() -> Path:
    return Path(__file__).resolve().parents[2] / ".contactout-rate-limited"


def mark_rate_limited(*, cooldown_sec: int | None = None) -> None:
    """Pause ContactOut lookups after 429 / too-many-requests."""
    if cooldown_sec is None:
        cooldown_sec = int(os.environ.get("CONTACTOUT_RATE_LIMIT_COOLDOWN", "3600"))
    until = time.time() + max(cooldown_sec, 60)
    _flag_path().write_text(str(until), encoding="utf-8")
    logger.warning(
        "ContactOut rate-limited — pausing lookups for %ds (account may need cooldown or switch)",
        cooldown_sec,
    )


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
