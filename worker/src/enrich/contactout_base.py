from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class ContactOutResult:
    personal_email: str | None = None
    personal_phone: str | None = None
    work_emails: list[str] | None = None
    phones: list[dict[str, str]] | None = None
    credits_used: int = 0
    phone_api_locked: bool = False


def normalize_linkedin(url: str) -> str:
    url = url.strip()
    if not url.startswith("http"):
        url = f"https://www.linkedin.com/in/{url.strip('/')}"
    return url


def get_contactout_mode() -> str:
    return os.environ.get("CONTACTOUT_MODE", "api").strip().lower()


def get_contactout_client():
    """API client on Vercel; dashboard scraper on Mac mini when CONTACTOUT_MODE=dashboard."""
    if get_contactout_mode() == "dashboard":
        from src.enrich.contactout_dashboard import ContactOutDashboardClient

        return ContactOutDashboardClient()

    from src.enrich.contactout_api import ContactOutApiClient

    return ContactOutApiClient()


# Backward-compatible alias used across the worker.
ContactOutClient = get_contactout_client
