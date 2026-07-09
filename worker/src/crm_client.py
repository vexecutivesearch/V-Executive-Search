from __future__ import annotations

import logging
import os
from typing import Any

import requests

logger = logging.getLogger(__name__)


class CRMClient:
    def __init__(self) -> None:
        self.base_url = (os.environ.get("CRM_API_URL") or "").rstrip("/")
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

    def ingest_batch(self, payload: dict[str, Any]) -> bool:
        if not self.is_configured:
            logger.info("CRM not configured — skipping ingest")
            return False

        try:
            resp = requests.post(
                f"{self.base_url}/api/ingest",
                headers=self._headers(),
                json=payload,
                timeout=120,
            )
            resp.raise_for_status()
            logger.info("CRM ingest succeeded: %s", resp.json())
            return True
        except requests.RequestException as exc:
            logger.error("CRM ingest failed: %s", exc)
            return False
