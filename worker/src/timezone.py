from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

BUSINESS_TIMEZONE = ZoneInfo("America/New_York")


def _now() -> datetime:
    return datetime.now(BUSINESS_TIMEZONE)


def business_today() -> date:
    return _now().date()


def business_list_date() -> date:
    """Recruiting list day rolls at 5:00 AM Eastern (not midnight)."""
    now = _now()
    if now.hour < 5:
        return (now - timedelta(days=1)).date()
    return now.date()


def business_run_slot() -> str:
    """am before noon ET (5 AM scrape), pm otherwise (6 PM scrape)."""
    return "am" if _now().hour < 12 else "pm"


def is_business_weekday(day: date | None = None) -> bool:
    """Mon–Fri in the business timezone (schedule gates use business days)."""
    target = day or business_today()
    return target.weekday() < 5
