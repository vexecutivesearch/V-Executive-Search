from __future__ import annotations

import re
from urllib.parse import urlparse

from src.enrich.contactout_base import normalize_linkedin

_SLUG_RE = re.compile(r"linkedin\.com/in/([^/?#]+)", re.I)


def linkedin_slug(url: str | None) -> str:
    if not url:
        return ""
    normalized = normalize_linkedin(url).lower().rstrip("/")
    match = _SLUG_RE.search(normalized)
    if match:
        return match.group(1).strip("/")
    return normalized.split("/")[-1]


def clean_linkedin_url(url: str | None) -> str:
    """Strip query strings and normalize host for comparison."""
    if not url:
        return ""
    normalized = normalize_linkedin(url).lower().strip()
    parsed = urlparse(normalized)
    path = parsed.path.rstrip("/")
    host = (parsed.netloc or "").replace("www.", "")
    return f"{host}{path}"


def linkedin_urls_match(found: str | None, expected: str | None) -> bool:
    """True when both URLs point to the same /in/slug."""
    if not found or not expected:
        return False
    a = clean_linkedin_url(found)
    b = clean_linkedin_url(expected)
    if a == b:
        return True
    return linkedin_slug(found) == linkedin_slug(expected) and bool(linkedin_slug(found))


def score_profile_card(
    card_text: str,
    *,
    expected_title: str | None = None,
    expected_company: str | None = None,
) -> int:
    """Lightweight text match when multiple cards share a common name."""
    text = (card_text or "").lower()
    score = 0
    if expected_title:
        for token in expected_title.lower().split():
            if len(token) > 2 and token in text:
                score += 1
    if expected_company:
        for token in expected_company.lower().split():
            if len(token) > 2 and token in text:
                score += 1
    return score
