from __future__ import annotations

from datetime import date, datetime
from zoneinfo import ZoneInfo

BUSINESS_TIMEZONE = ZoneInfo("America/New_York")


def business_today() -> date:
    return datetime.now(BUSINESS_TIMEZONE).date()
