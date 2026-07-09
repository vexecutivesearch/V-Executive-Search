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
    return os.environ.get("CONTACTOUT_MODE", "auto").strip().lower()


def get_contactout_client():
    """Hybrid client: API when available, dashboard fallback on Mac when not."""
    from src.enrich.contactout_hybrid import ContactOutHybridClient

    return ContactOutHybridClient()


# Backward-compatible alias used across the worker.
ContactOutClient = get_contactout_client
