"""ContactOut enrichment — API or dashboard scraper (see CONTACTOUT_MODE)."""

from src.enrich.contactout_api import ContactOutApiClient
from src.enrich.contactout_base import (
    ContactOutResult,
    get_contactout_client,
    get_contactout_mode,
    normalize_linkedin,
)
from src.enrich.contactout_dashboard import ContactOutDashboardClient


def ContactOutClient() -> ContactOutApiClient | ContactOutDashboardClient:
    return get_contactout_client()


__all__ = [
    "ContactOutApiClient",
    "ContactOutClient",
    "ContactOutDashboardClient",
    "ContactOutResult",
    "get_contactout_client",
    "get_contactout_mode",
    "normalize_linkedin",
]
