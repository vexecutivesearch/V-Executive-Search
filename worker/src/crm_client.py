from __future__ import annotations

import json
import logging
import os
from typing import Any

import requests

from src.crm_config import crm_base_url

logger = logging.getLogger(__name__)


class CRMClient:
    def __init__(self) -> None:
        try:
            self.base_url = crm_base_url(required=False)
        except RuntimeError as exc:
            logger.error("%s", exc)
            self.base_url = ""
        self.api_key = os.environ.get("CRM_API_KEY", "")

    @property
    def is_configured(self) -> bool:
        return bool(self.base_url and self.api_key)

    def _headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }

    def get_existing_domains(self, domains: list[str]) -> set[str]:
        if not self.is_configured or not domains:
            return set()

        try:
            resp = requests.get(
                f"{self.base_url}/api/companies",
                headers=self._headers(),
                params={"domains": ",".join(domains)},
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            return {d.lower() for d in data.get("domains", [])}
        except requests.RequestException as exc:
            logger.warning("CRM domain lookup failed: %s", exc)
            return set()

    def check_known_listings(
        self,
        *,
        urls: list[str],
        companies: list[str],
    ) -> dict[str, Any] | None:
        """Which of these job URLs / company names already exist in the CRM.

        Powers per-page marginal-yield pagination. Returns None on any
        failure so callers fail SAFE (stop paginating) rather than spending
        SerpApi credits on an unverifiable new-ratio.
        """
        if not self.is_configured:
            return None
        if not urls and not companies:
            return {"known_urls": [], "known_companies": []}
        try:
            resp = requests.post(
                f"{self.base_url}/api/jobs/known",
                headers=self._headers(),
                json={"urls": urls, "companies": companies},
                timeout=20,
            )
            resp.raise_for_status()
            data = resp.json()
            return {
                "known_urls": data.get("known_urls") or [],
                "known_companies": data.get("known_companies") or [],
            }
        except requests.RequestException as exc:
            logger.warning("CRM known-listings lookup failed: %s", exc)
            return None

    def post_usage_events(self, events: list[dict[str, Any]]) -> bool:
        """Batch provider usage events (audit trail; local meter stays authoritative)."""
        if not self.is_configured or not events:
            return False
        try:
            resp = requests.post(
                f"{self.base_url}/api/pipeline/usage",
                headers=self._headers(),
                json={"events": events},
                timeout=20,
            )
            resp.raise_for_status()
            return True
        except requests.RequestException as exc:
            logger.warning("CRM usage-events post failed: %s", exc)
            return False

    def get_enrichment_queue(self, *, limit: int = 25) -> list[dict[str, Any]]:
        if not self.is_configured:
            return []

        try:
            resp = requests.get(
                f"{self.base_url}/api/companies/enrichment-queue",
                headers=self._headers(),
                params={"limit": limit},
                timeout=60,
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("companies") or []
        except requests.RequestException as exc:
            logger.warning("CRM enrichment-queue lookup failed: %s", exc)
            return []

    def check_pipeline_ready(self) -> bool:
        if not self.is_configured:
            return False
        try:
            resp = requests.get(
                f"{self.base_url}/api/health/pipeline",
                headers=self._headers(),
                timeout=20,
            )
            return resp.ok
        except requests.RequestException:
            return False

    def rescore_backlog(self) -> dict[str, Any]:
        if not self.is_configured:
            return {}
        try:
            resp = requests.post(
                f"{self.base_url}/api/companies/rescore",
                headers=self._headers(),
                json={},
                timeout=120,
            )
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as exc:
            logger.warning("CRM rescore failed: %s", exc)
            return {}

    def backfill_domains(self, *, limit: int = 50) -> dict[str, Any]:
        if not self.is_configured:
            return {}
        try:
            resp = requests.post(
                f"{self.base_url}/api/companies/backfill-domains",
                headers=self._headers(),
                json={"limit": limit},
                timeout=120,
            )
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as exc:
            logger.warning("CRM domain backfill failed: %s", exc)
            return {}

    def archive_stale_jobs(self) -> dict[str, Any]:
        if not self.is_configured:
            return {}
        try:
            resp = requests.post(
                f"{self.base_url}/api/jobs/archive-stale",
                headers=self._headers(),
                json={},
                timeout=60,
            )
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as exc:
            logger.warning("CRM archive-stale failed: %s", exc)
            return {}

    def verify_contact_emails(self, *, limit: int = 50) -> dict[str, Any]:
        if not self.is_configured:
            return {}
        try:
            resp = requests.post(
                f"{self.base_url}/api/contacts/verify-batch",
                headers=self._headers(),
                params={"limit": limit},
                timeout=120,
            )
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as exc:
            logger.warning("CRM email verify failed: %s", exc)
            return {}

    def generate_openers(self, company_ids: list[str], *, force: bool = False) -> dict[str, Any]:
        if not self.is_configured or not company_ids:
            return {}
        try:
            resp = requests.post(
                f"{self.base_url}/api/companies/generate-openers",
                headers=self._headers(),
                json={"company_ids": company_ids, "force": force},
                timeout=180,
            )
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as exc:
            logger.warning("CRM generate-openers failed: %s", exc)
            return {}

    def ingest_batch(
        self,
        payload: dict[str, Any],
        *,
        max_companies: int = 200,
        max_bytes: int = 3_500_000,
    ) -> bool:
        """POST companies to /api/ingest, chunking to stay under Vercel body limits."""
        if not self.is_configured:
            logger.info("CRM not configured — skipping ingest")
            return False

        companies = list(payload.get("companies") or [])
        if not companies:
            return self._post_ingest(payload)

        chunks = _chunk_companies(companies, max_companies=max_companies, max_bytes=max_bytes)
        base_meta = dict(payload.get("metadata") or {})
        total_companies = len(companies)
        ok = True
        for index, chunk in enumerate(chunks):
            meta = dict(base_meta)
            # jobs_only daily_runs counters ADD on conflict — send totals once,
            # then per-chunk company counts so sums stay correct.
            if index == 0:
                meta["companies_found"] = len(chunk)
            else:
                meta["listings_scraped"] = 0
                meta["companies_found"] = len(chunk)
                meta.pop("funnel", None)
                meta["errors"] = []
            chunk_payload = {
                **payload,
                "metadata": meta,
                "companies": chunk,
            }
            logger.info(
                "CRM ingest chunk %d/%d companies=%d (~%d bytes) total=%d",
                index + 1,
                len(chunks),
                len(chunk),
                _payload_bytes(chunk_payload),
                total_companies,
            )
            if not self._post_ingest(chunk_payload):
                ok = False
                break
        return ok

    def _post_ingest(self, payload: dict[str, Any]) -> bool:
        try:
            resp = requests.post(
                f"{self.base_url}/api/ingest",
                headers=self._headers(),
                json=payload,
                timeout=180,
            )
            resp.raise_for_status()
            logger.info("CRM ingest succeeded: %s", resp.json())
            return True
        except requests.RequestException as exc:
            logger.error("CRM ingest failed: %s", exc)
            return False


def _payload_bytes(payload: dict[str, Any]) -> int:
    return len(json.dumps(payload, separators=(",", ":")).encode("utf-8"))


def _chunk_companies(
    companies: list[dict[str, Any]],
    *,
    max_companies: int,
    max_bytes: int,
) -> list[list[dict[str, Any]]]:
    """Split companies so each POST stays under max_companies and ~max_bytes."""
    chunks: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    current_bytes = 2  # []

    for company in companies:
        company_bytes = len(json.dumps(company, separators=(",", ":")).encode("utf-8"))
        separator = 1 if current else 0
        would_exceed = (
            len(current) >= max_companies
            or (current and current_bytes + separator + company_bytes > max_bytes)
        )
        if would_exceed and current:
            chunks.append(current)
            current = []
            current_bytes = 2
            separator = 0
        # Oversized single company: still send alone (better than silent drop).
        current.append(company)
        current_bytes += separator + company_bytes

    if current:
        chunks.append(current)
    return chunks
