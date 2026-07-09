from __future__ import annotations

import re

from src.models import CompanyRecord, DomainConfidence, JobListing

_SUFFIXES = re.compile(
    r"\b(inc|incorporated|llc|l\.l\.c|corp|corporation|co|company|ltd|limited|plc|group|holdings)\b\.?",
    re.IGNORECASE,
)
_PUNCTUATION = re.compile(r"[^\w\s]")


def normalize_company_name(name: str) -> str:
    cleaned = _PUNCTUATION.sub(" ", name.lower()).strip()
    cleaned = _SUFFIXES.sub("", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


def collapse_to_companies(listings: list[JobListing]) -> list[CompanyRecord]:
    by_normalized: dict[str, CompanyRecord] = {}

    for listing in listings:
        normalized = normalize_company_name(listing.company_name)
        if not normalized:
            continue

        if normalized not in by_normalized:
            by_normalized[normalized] = CompanyRecord(
                name=listing.company_name,
                normalized_name=normalized,
                listings=[],
            )

        company = by_normalized[normalized]
        company.listings.append(listing)
        # Prefer the longest/most complete company name spelling
        if len(listing.company_name) > len(company.name):
            company.name = listing.company_name

    return list(by_normalized.values())


def filter_existing_companies(
    companies: list[CompanyRecord],
    existing_domains: set[str],
) -> tuple[list[CompanyRecord], int]:
    if not existing_domains:
        return companies, 0

    existing_normalized = {d.lower().strip() for d in existing_domains if d}
    net_new: list[CompanyRecord] = []
    skipped = 0

    for company in companies:
        domain = (company.domain or "").lower().strip()
        if domain and domain in existing_normalized:
            skipped += 1
            continue
        net_new.append(company)

    return net_new, skipped
