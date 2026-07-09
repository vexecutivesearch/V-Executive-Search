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
    """Skip companies whose domain already has callable contacts in CRM."""
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


def merge_company_batches(
    primary: list[CompanyRecord],
    secondary: list[CompanyRecord],
) -> list[CompanyRecord]:
    """Merge company lists; primary wins on name collisions (fresh scrape over backlog)."""
    merged: dict[str, CompanyRecord] = {}

    for company in secondary:
        key = company.normalized_name or normalize_company_name(company.name)
        if key:
            merged[key] = company

    for company in primary:
        key = company.normalized_name or normalize_company_name(company.name)
        if not key:
            continue
        existing = merged.get(key)
        if existing and existing.crm_id and not company.crm_id:
            company.crm_id = existing.crm_id
        if existing and not company.listings and existing.listings:
            company.listings = existing.listings
        merged[key] = company

    return list(merged.values())
