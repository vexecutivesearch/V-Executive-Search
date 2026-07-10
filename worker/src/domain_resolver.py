from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from typing import Any

import requests

from src.models import CompanyRecord, DomainConfidence

LISTING_PSEUDO_PREFIX = "(Listing)"


def is_listing_pseudo_company(name: str) -> bool:
    return name.strip().startswith(LISTING_PSEUDO_PREFIX)

logger = logging.getLogger(__name__)

APOLLO_BASE = "https://api.apollo.io/api/v1"


@dataclass
class OrgLookupResult:
    domain: str | None
    confidence: DomainConfidence
    estimated_employees: int | None = None
    industry: str | None = None


def _guess_domain(company_name: str) -> str | None:
    cleaned = re.sub(r"[^\w\s]", "", company_name.lower())
    cleaned = re.sub(
        r"\b(inc|incorporated|llc|corp|corporation|co|company|ltd|limited|plc|group|holdings)\b",
        "",
        cleaned,
    )
    slug = re.sub(r"\s+", "", cleaned.strip())
    if len(slug) < 2:
        return None
    return f"{slug}.com"


def _apollo_headers() -> dict[str, str]:
    api_key = os.environ.get("APOLLO_API_KEY", "")
    return {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": api_key,
    }


def _parse_employees(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value)
    return None


def _parse_org(org: dict[str, Any]) -> OrgLookupResult:
    domain = org.get("primary_domain") or org.get("website_url")
    if domain:
        domain = domain.replace("https://", "").replace("http://", "").split("/")[0]
        if domain.startswith("www."):
            domain = domain[4:]
    employees = _parse_employees(org.get("estimated_num_employees"))
    industry_raw = org.get("industry")
    industry = str(industry_raw).strip() if industry_raw else None
    confidence = DomainConfidence.HIGH if domain else DomainConfidence.LOW
    return OrgLookupResult(
        domain,
        confidence,
        estimated_employees=employees,
        industry=industry or None,
    )


def _search_org(company_name: str) -> OrgLookupResult:
    api_key = os.environ.get("APOLLO_API_KEY")
    if not api_key:
        guess = _guess_domain(company_name)
        return OrgLookupResult(guess, DomainConfidence.LOW)

    try:
        # organizations/search returns industry; mixed_companies/search does not.
        resp = requests.post(
            f"{APOLLO_BASE}/organizations/search",
            headers=_apollo_headers(),
            json={
                "q_organization_name": company_name,
                "page": 1,
                "per_page": 1,
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        orgs: list[dict[str, Any]] = data.get("organizations") or []
        if orgs:
            parsed = _parse_org(orgs[0])
            if parsed.domain or parsed.industry:
                return parsed
    except requests.RequestException as exc:
        logger.warning("Apollo org search failed for '%s': %s", company_name, exc)

    guess = _guess_domain(company_name)
    return OrgLookupResult(guess, DomainConfidence.LOW)


def resolve_domains(companies: list[CompanyRecord]) -> list[CompanyRecord]:
    for company in companies:
        if is_listing_pseudo_company(company.name):
            logger.info("Skipping org lookup for listing pseudo-company '%s'", company.name)
            continue
        has_domain = bool(company.domain)
        has_employees = company.estimated_employees is not None
        has_industry = bool(company.industry)
        if has_domain and has_employees and has_industry:
            continue

        lookup = _search_org(company.name)
        if not company.domain and lookup.domain:
            company.domain = lookup.domain
            company.domain_confidence = lookup.confidence
        if lookup.estimated_employees is not None:
            company.estimated_employees = lookup.estimated_employees
        if lookup.industry and not company.industry:
            company.industry = lookup.industry
        logger.info(
            "Resolved '%s' -> %s (%s, industry=%s, ~%s employees)",
            company.name,
            company.domain or "unknown",
            company.domain_confidence.value,
            company.industry or "?",
            company.estimated_employees or "?",
        )
    return companies
