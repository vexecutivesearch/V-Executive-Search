from __future__ import annotations

import logging
import os
import time
from typing import Any
from urllib.parse import urlencode

import requests

from src.contact_phones import (
    extract_apollo_phones,
    merge_sourced_phones,
    pick_primary_from_phones,
)
from src.phone_utils import apply_company_phone_dedupe
from src.location import (
    apollo_location_queries,
    collect_job_locations,
    format_person_location,
    person_matches_location,
)
from src.models import CompanyRecord, ContactRecord, EnrichedCompany

logger = logging.getLogger(__name__)

APOLLO_BASE = "https://api.apollo.io/api/v1"
EMAIL_CREDIT_COST = 1
PHONE_CREDIT_COST = 8

# Lower rank = higher priority when picking executives to enrich.
_TITLE_RANK_KEYWORDS: list[tuple[str, int]] = [
    ("chief executive", 0),
    ("ceo", 0),
    ("president", 1),
    ("founder", 2),
    ("co-founder", 2),
    ("owner", 3),
    ("chief operating", 4),
    ("coo", 4),
    ("chief financial", 5),
    ("cfo", 5),
    ("chief technology", 6),
    ("cto", 6),
    ("chief people", 7),
    ("chro", 7),
    ("chief human", 7),
    ("vp people", 8),
    ("vp human", 8),
    ("vp hr", 8),
    ("head of people", 9),
    ("head of hr", 9),
    ("head of talent", 10),
    ("hr director", 11),
    ("director of human", 12),
    ("director of hr", 12),
]

_SENIORITY_RANK = {
    "c_suite": 0,
    "owner": 1,
    "founder": 1,
    "vp": 2,
    "head": 3,
    "director": 4,
    "manager": 5,
}


def _executive_rank(person: dict[str, Any]) -> tuple[int, int, str]:
    title = (person.get("title") or "").lower()
    title_rank = 50
    for keyword, rank in _TITLE_RANK_KEYWORDS:
        if keyword in title:
            title_rank = min(title_rank, rank)
            break

    seniority = (person.get("seniority") or "").lower()
    seniority_rank = _SENIORITY_RANK.get(seniority, 20)
    return (title_rank, seniority_rank, title)


def _person_sort_key(
    person: dict[str, Any],
    job_locations: list,
) -> tuple[int, int, int, str]:
    location_rank = 0 if person_matches_location(person, job_locations) else 1
    exec_rank = _executive_rank(person)
    return (location_rank, exec_rank[0], exec_rank[1], exec_rank[2])


class ApolloProvider:
    def __init__(self) -> None:
        self._credits_used = 0
        self._api_key = os.environ.get("APOLLO_API_KEY", "")

    @property
    def credits_used(self) -> int:
        return self._credits_used

    def reset_credits(self) -> None:
        self._credits_used = 0

    def _headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            "X-Api-Key": self._api_key,
        }

    def _webhook_url(self) -> str | None:
        base = (os.environ.get("CRM_API_URL") or "").rstrip("/")
        if not base or not base.startswith("https://"):
            return None
        return f"{base}/api/apollo/webhook"

    def _search_people(
        self,
        domain: str,
        target_titles: list[str],
        target_seniorities: list[str],
        per_page: int,
        person_locations: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        if not self._api_key:
            logger.warning("APOLLO_API_KEY not set — skipping people search")
            return []

        payload: dict[str, Any] = {
            "q_organization_domains_list": [domain],
            "person_titles": target_titles,
            "include_similar_titles": True,
            "page": 1,
            "per_page": per_page,
        }
        if target_seniorities:
            payload["person_seniorities"] = target_seniorities
        if person_locations:
            payload["person_locations"] = person_locations

        try:
            resp = requests.post(
                f"{APOLLO_BASE}/mixed_people/api_search",
                headers=self._headers(),
                json=payload,
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            people = data.get("people") or []
            if person_locations:
                logger.info(
                    "Apollo location search (%s): %d candidates for %s",
                    ", ".join(person_locations[:3]),
                    len(people),
                    domain,
                )
            return people
        except requests.RequestException as exc:
            logger.error("Apollo people search failed for %s: %s", domain, exc)
            return []

    def _merge_people(
        self,
        local_people: list[dict[str, Any]],
        broad_people: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        merged: list[dict[str, Any]] = []
        seen: set[str] = set()
        for person in local_people + broad_people:
            person_id = person.get("id")
            if not person_id or person_id in seen:
                continue
            seen.add(person_id)
            merged.append(person)
        return merged

    def _enrich_person(self, person_id: str, enrich_phone: bool) -> dict[str, Any] | None:
        params: dict[str, str] = {"id": person_id}
        if enrich_phone:
            webhook = self._webhook_url()
            if not webhook:
                logger.warning(
                    "enrich_phone enabled but CRM_API_URL not set — phones will not be revealed"
                )
            else:
                params["reveal_phone_number"] = "true"
                params["webhook_url"] = webhook

        try:
            resp = requests.post(
                f"{APOLLO_BASE}/people/match?{urlencode(params)}",
                headers=self._headers(),
                json={},
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            person = data.get("person")
            if person:
                self._credits_used += EMAIL_CREDIT_COST
                if enrich_phone and params.get("reveal_phone_number"):
                    self._credits_used += PHONE_CREDIT_COST - EMAIL_CREDIT_COST
                    logger.info(
                        "Phone reveal requested for %s — mobile numbers will arrive via webhook",
                        person_id,
                    )
            return person
        except requests.RequestException as exc:
            detail = ""
            if hasattr(exc, "response") and exc.response is not None:
                try:
                    detail = exc.response.text[:300]
                except Exception:
                    pass
            if "insufficient credits" in detail.lower():
                logger.error("Apollo out of credits — upgrade plan or add credits")
            else:
                logger.error("Apollo enrich failed for %s: %s %s", person_id, exc, detail)
            return None

    def enrich_company(
        self,
        company: CompanyRecord,
        target_titles: list[str],
        target_seniorities: list[str],
        contacts_per_company: int,
        enrich_phone: bool,
    ) -> EnrichedCompany:
        result = EnrichedCompany(company=company)
        domain = company.domain
        if not domain:
            logger.warning("No domain for '%s' — skipping enrichment", company.name)
            return result

        job_locations = collect_job_locations(company.listings)
        job_location_label = job_locations[0].label if job_locations else None
        apollo_locations: list[str] = []
        for parsed in job_locations:
            apollo_locations.extend(apollo_location_queries(parsed))
        apollo_locations = list(dict.fromkeys(apollo_locations))

        per_page = max(contacts_per_company * 5, 10)
        local_people: list[dict[str, Any]] = []
        if apollo_locations:
            local_people = self._search_people(
                domain,
                target_titles,
                target_seniorities,
                per_page=per_page,
                person_locations=apollo_locations,
            )

        broad_people = self._search_people(
            domain,
            target_titles,
            target_seniorities,
            per_page=per_page,
        )
        people = self._merge_people(local_people, broad_people)
        people.sort(key=lambda p: _person_sort_key(p, job_locations))

        enriched_count = 0
        seen_ids: set[str] = set()
        for person in people:
            if enriched_count >= contacts_per_company:
                break

            if not person.get("has_email"):
                continue

            person_id = person.get("id")
            if not person_id or person_id in seen_ids:
                continue
            seen_ids.add(person_id)

            enriched = self._enrich_person(person_id, enrich_phone)
            time.sleep(0.3)

            if not enriched:
                continue

            email = enriched.get("email")
            first = enriched.get("first_name") or person.get("first_name") or ""
            last = enriched.get("last_name") or ""
            if not last and person.get("last_name_obfuscated"):
                last = person["last_name_obfuscated"]
            name = enriched.get("name") or f"{first} {last}".strip()

            location_matched = person_matches_location(enriched, job_locations) or (
                person_matches_location(person, job_locations)
            )

            phones = extract_apollo_phones(enriched)
            primary = pick_primary_from_phones(phones)

            contact = ContactRecord(
                name=name,
                first_name=first,
                last_name=last,
                title=enriched.get("title") or person.get("title") or "",
                email=email,
                phone=primary.get("phone"),
                personal_phone=primary.get("personal_phone"),
                company_phone=primary.get("company_phone"),
                phones=phones,
                linkedin_url=enriched.get("linkedin_url"),
                source_provider="apollo",
                apollo_id=person_id,
                enriched=bool(email),
                location_matched=location_matched,
                contact_location=format_person_location(enriched)
                or format_person_location(person),
                job_location=job_location_label,
            )
            result.contacts.append(contact)
            enriched_count += 1

        apply_company_phone_dedupe(result.contacts)

        if job_location_label and result.contacts:
            matched = sum(1 for c in result.contacts if c.location_matched)
            logger.info(
                "Location match for %s (%s): %d/%d contacts",
                company.name,
                job_location_label,
                matched,
                len(result.contacts),
            )

        result.credits_used = self._credits_used
        return result


def _extract_phone(person: dict[str, Any]) -> str | None:
    """Deprecated — use extract_apollo_mobile. Kept for tests."""
    return extract_apollo_mobile(person)
