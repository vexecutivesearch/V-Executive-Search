from __future__ import annotations

import logging
import os
from typing import Any

import requests

from src.enrich.apollo import ApolloProvider
from src.enrich.provider import EnrichmentProvider
from src.models import CompanyRecord, ContactRecord, EnrichedCompany

logger = logging.getLogger(__name__)


class HunterFallback:
    """Cheap email finder fallback when Apollo finds a person but no email."""

    def __init__(self) -> None:
        self._api_key = os.environ.get("HUNTER_API_KEY", "")

    def find_email(self, domain: str, first_name: str, last_name: str) -> str | None:
        if not self._api_key or not domain or not first_name:
            return None

        try:
            resp = requests.get(
                "https://api.hunter.io/v2/email-finder",
                params={
                    "domain": domain,
                    "first_name": first_name,
                    "last_name": last_name,
                    "api_key": self._api_key,
                },
                timeout=20,
            )
            resp.raise_for_status()
            data = resp.json().get("data") or {}
            return data.get("email")
        except requests.RequestException as exc:
            logger.warning("Hunter fallback failed for %s@%s: %s", first_name, domain, exc)
            return None


class WaterfallProvider:
    """Apollo search + enrich, with optional Hunter email fallback."""

    def __init__(self) -> None:
        self._apollo = ApolloProvider()
        self._hunter = HunterFallback()
        self._credits_used = 0

    @property
    def credits_used(self) -> int:
        return self._credits_used

    def reset_credits(self) -> None:
        self._apollo.reset_credits()
        self._credits_used = 0

    def enrich_company(
        self,
        company: CompanyRecord,
        target_titles: list[str],
        target_seniorities: list[str],
        contacts_per_company: int,
        enrich_phone: bool,
    ) -> EnrichedCompany:
        result = self._apollo.enrich_company(
            company,
            target_titles,
            target_seniorities,
            contacts_per_company,
            enrich_phone,
        )
        self._credits_used = self._apollo.credits_used

        domain = company.domain or ""
        for contact in result.contacts:
            if contact.email:
                continue
            email = self._hunter.find_email(domain, contact.first_name, contact.last_name)
            if email:
                contact.email = email
                contact.source_provider = "hunter"
                contact.enriched = True

        return result
