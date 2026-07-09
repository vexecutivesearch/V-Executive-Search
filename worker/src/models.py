from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from enum import Enum
from typing import Any


class DomainConfidence(str, Enum):
    HIGH = "high"
    LOW = "low"


@dataclass
class JobListing:
    company_name: str
    job_title: str
    location: str
    board: str
    job_url: str
    date_posted: datetime | None = None
    search_name: str = ""


@dataclass
class CompanyRecord:
    name: str
    normalized_name: str
    domain: str | None = None
    domain_confidence: DomainConfidence = DomainConfidence.LOW
    listings: list[JobListing] = field(default_factory=list)


@dataclass
class ContactRecord:
    name: str
    first_name: str
    last_name: str
    title: str
    email: str | None = None
    work_email: str | None = None
    personal_email: str | None = None
    phone: str | None = None
    personal_phone: str | None = None
    company_phone: str | None = None
    phones: list[dict[str, str]] | None = None
    linkedin_url: str | None = None
    source_provider: str = "apollo"
    apollo_id: str | None = None
    enriched: bool = False
    location_matched: bool = False
    contact_location: str | None = None
    job_location: str | None = None


@dataclass
class EnrichedCompany:
    company: CompanyRecord
    contacts: list[ContactRecord] = field(default_factory=list)
    credits_used: int = 0


@dataclass
class PipelineResult:
    run_date: date
    listings_scraped: int
    companies_found: int
    companies_skipped_existing: int
    companies_enriched: int
    contacts_enriched: int
    credits_used: int
    errors: list[str] = field(default_factory=list)
    rows: list[dict[str, Any]] = field(default_factory=list)
