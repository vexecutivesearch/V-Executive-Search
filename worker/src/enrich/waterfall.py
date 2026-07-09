from __future__ import annotations

import logging
import os
from typing import Any

import requests

from src.enrich.apollo import ApolloProvider
from src.enrich.contactout import get_contactout_client
from src.enrich.provider import EnrichmentProvider
from src.contact_phones import merge_sourced_phones, pick_primary_from_phones
from src.phone_utils import apply_company_phone_dedupe, is_personal_email
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
    """Apollo discovery (name, title, LinkedIn, work email) + ContactOut personal contact info."""

    def __init__(self) -> None:
        self._apollo = ApolloProvider()
        self._contactout = get_contactout_client()
        self._hunter = HunterFallback()
        self._credits_used = 0
        self._contactout_api_locked = False

    @property
    def credits_used(self) -> int:
        return self._credits_used

    def reset_credits(self) -> None:
        self._apollo.reset_credits()
        self._credits_used = 0
        self._contactout_api_locked = False

    def _apply_contactout(self, contact: ContactRecord) -> None:
        if not contact.linkedin_url or not self._contactout.is_configured:
            return

        result = self._contactout.enrich_linkedin(contact.linkedin_url)
        if not result:
            return

        has_data = bool(
            result.personal_email or result.phones or result.work_emails
        )
        if result.phone_api_locked:
            self._contactout_api_locked = True
            if not has_data:
                logger.warning(
                    "ContactOut returned no personal data for %s — Apollo only",
                    contact.name,
                )
                return

        self._credits_used += result.credits_used

        if contact.email and not is_personal_email(contact.email):
            contact.work_email = contact.email

        if result.personal_email:
            contact.personal_email = result.personal_email
            contact.email = result.personal_email
        elif result.work_emails and not contact.email:
            contact.email = result.work_emails[0]

        phones = merge_sourced_phones(contact.phones, result.phones)
        primary = pick_primary_from_phones(phones)
        contact.phones = phones
        contact.personal_phone = primary.get("personal_phone")
        contact.phone = primary.get("phone")
        contact.company_phone = primary.get("company_phone")

        if contact.personal_email or phones:
            contact.source_provider = "apollo+contactout"
            contact.enriched = True

    def enrich_company(
        self,
        company: CompanyRecord,
        target_titles: list[str],
        target_seniorities: list[str],
        contacts_per_company: int,
        enrich_phone: bool,
    ) -> EnrichedCompany:
        # ContactOut adds personal data; still request Apollo phones when enabled.
        apollo_phone = enrich_phone

        result = self._apollo.enrich_company(
            company,
            target_titles,
            target_seniorities,
            contacts_per_company,
            apollo_phone,
        )
        self._credits_used = self._apollo.credits_used

        domain = company.domain or ""
        for contact in result.contacts:
            if not contact.email:
                email = self._hunter.find_email(domain, contact.first_name, contact.last_name)
                if email:
                    contact.email = email
                    contact.work_email = email
                    contact.source_provider = "hunter"
                    contact.enriched = True

            self._apply_contactout(contact)

        apply_company_phone_dedupe(result.contacts)
        return result
