from __future__ import annotations

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


def get_contactout_client():
    """ContactOut API client (LinkedIn URL lookup only — no browser automation)."""
    from src.enrich.contactout_api import ContactOutApiClient

    return ContactOutApiClient()


ContactOutClient = get_contactout_client
