from __future__ import annotations

import logging
import os
import re
from typing import Any

import requests

from src.models import CompanyRecord, DomainConfidence

logger = logging.getLogger(__name__)

APOLLO_BASE = "https://api.apollo.io/api/v1"


def _guess_domain(company_name: str) -> str | None:
    """Heuristic fallback when Apollo org search misses."""
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


def _search_org_domain(company_name: str) -> tuple[str | None, DomainConfidence]:
    api_key = os.environ.get("APOLLO_API_KEY")
    if not api_key:
        guess = _guess_domain(company_name)
        return guess, DomainConfidence.LOW

    try:
        resp = requests.post(
            f"{APOLLO_BASE}/mixed_companies/search",
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
        orgs: list[dict[str, Any]] = data.get("organizations") or data.get("accounts") or []
        if orgs:
            domain = orgs[0].get("primary_domain") or orgs[0].get("website_url")
            if domain:
                domain = domain.replace("https://", "").replace("http://", "").split("/")[0]
                if domain.startswith("www."):
                    domain = domain[4:]
                return domain, DomainConfidence.HIGH
    except requests.RequestException as exc:
        logger.warning("Apollo org search failed for '%s': %s", company_name, exc)

    guess = _guess_domain(company_name)
    return guess, DomainConfidence.LOW


def resolve_domains(companies: list[CompanyRecord]) -> list[CompanyRecord]:
    for company in companies:
        if company.domain:
            continue
        domain, confidence = _search_org_domain(company.name)
        company.domain = domain
        company.domain_confidence = confidence
        logger.info(
            "Resolved '%s' -> %s (%s)",
            company.name,
            domain or "unknown",
            confidence.value,
        )
    return companies
