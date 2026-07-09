from __future__ import annotations

import logging
import os
import time
from typing import Any

import requests

from src.models import CompanyRecord, ContactRecord, EnrichedCompany

logger = logging.getLogger(__name__)

APOLLO_BASE = "https://api.apollo.io/api/v1"
PHONE_CREDIT_COST = 8
EMAIL_CREDIT_COST = 1


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

    def _search_people(
        self,
        domain: str,
        target_titles: list[str],
        target_seniorities: list[str],
        per_page: int,
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

        try:
            resp = requests.post(
                f"{APOLLO_BASE}/mixed_people/api_search",
                headers=self._headers(),
                json=payload,
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("people") or []
        except requests.RequestException as exc:
            logger.error("Apollo people search failed for %s: %s", domain, exc)
            return []

    def _enrich_person(self, person_id: str, enrich_phone: bool) -> dict[str, Any] | None:
        payload: dict[str, Any] = {"id": person_id}
        if enrich_phone:
            payload["reveal_phone_number"] = True

        try:
            resp = requests.post(
                f"{APOLLO_BASE}/people/match",
                headers=self._headers(),
                json=payload,
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            person = data.get("person")
            if person:
                self._credits_used += EMAIL_CREDIT_COST
                if enrich_phone and person.get("phone_numbers"):
                    self._credits_used += PHONE_CREDIT_COST - EMAIL_CREDIT_COST
            return person
        except requests.RequestException as exc:
            detail = ""
            if hasattr(exc, "response") and exc.response is not None:
                try:
                    detail = exc.response.text[:200]
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

        people = self._search_people(
            domain,
            target_titles,
            target_seniorities,
            per_page=max(contacts_per_company * 3, 5),
        )

        enriched_count = 0
        for person in people:
            if enriched_count >= contacts_per_company:
                break

            if not person.get("has_email"):
                continue

            person_id = person.get("id")
            if not person_id:
                continue

            enriched = self._enrich_person(person_id, enrich_phone)
            time.sleep(0.3)  # gentle rate limiting

            if not enriched:
                continue

            email = enriched.get("email")
            first = enriched.get("first_name") or person.get("first_name") or ""
            last = enriched.get("last_name") or ""
            if not last and person.get("last_name_obfuscated"):
                last = person["last_name_obfuscated"]
            name = enriched.get("name") or f"{first} {last}".strip()

            contact = ContactRecord(
                name=name,
                first_name=first,
                last_name=last,
                title=enriched.get("title") or person.get("title") or "",
                email=email,
                phone=_extract_phone(enriched) if enrich_phone else None,
                linkedin_url=enriched.get("linkedin_url"),
                source_provider="apollo",
                apollo_id=person_id,
                enriched=bool(email),
            )
            result.contacts.append(contact)
            enriched_count += 1

        result.credits_used = self._credits_used
        return result


def _extract_phone(person: dict[str, Any]) -> str | None:
    phones = person.get("phone_numbers") or []
    if phones:
        return phones[0].get("sanitized_number") or phones[0].get("raw_number")
    return person.get("phone") or None
