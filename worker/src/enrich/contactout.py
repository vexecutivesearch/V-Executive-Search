"""ContactOut enrichment via official API only."""

from src.enrich.contactout_api import ContactOutApiClient
from src.enrich.contactout_base import (
    ContactOutResult,
    get_contactout_client,
    normalize_linkedin,
)

ContactOutClient = ContactOutApiClient

__all__ = [
    "ContactOutApiClient",
    "ContactOutClient",
    "ContactOutResult",
    "get_contactout_client",
    "normalize_linkedin",
]
