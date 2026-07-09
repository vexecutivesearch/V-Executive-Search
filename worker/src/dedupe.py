from __future__ import annotations

import re

from src.models import CompanyRecord, DomainConfidence, JobListing, ContactRecord

_SUFFIXES = re.compile(
    r"\b(inc|incorporated|llc|l\.l\.c|corp|corporation|co|company|ltd|limited|plc|group|holdings)\b\.?",
    re.IGNORECASE,
)
_PUNCTUATION = re.compile(r"[^\w\s]")


def normalize_company_name(name: str) -> str:
    cleaned = _PUNCTUATION.sub(" ", name.lower()).strip()
    cleaned = _SUFFIXES.sub("", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


def _poster_to_contact(poster, job_location: str) -> ContactRecord:
    parts = poster.name.strip().split()
    first = parts[0] if parts else ""
    last = " ".join(parts[1:]) if len(parts) > 1 else ""
    return ContactRecord(
        name=poster.name,
        first_name=first,
        last_name=last,
        title=poster.title or ("Job poster" if poster.is_job_poster else "LinkedIn contact"),
        linkedin_url=poster.linkedin_url,
        source_provider="linkedin_poster",
        job_location=job_location or None,
    )


def _merge_seed_contact(company: CompanyRecord, contact: ContactRecord) -> None:
    key = (contact.linkedin_url or contact.name).lower().strip()
    if not key:
        return
    for existing in company.seed_contacts:
        existing_key = (existing.linkedin_url or existing.name).lower().strip()
        if existing_key == key:
            if contact.title and contact.title != "LinkedIn contact":
                existing.title = contact.title
            return
    company.seed_contacts.append(contact)


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
        for poster in listing.posters:
            if poster.linkedin_url:
                _merge_seed_contact(
                    company,
                    _poster_to_contact(poster, listing.location),
                )
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
