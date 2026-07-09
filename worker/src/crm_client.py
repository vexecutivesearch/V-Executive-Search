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

    def get_pending_enrichment(
        self,
        *,
        limit: int = 100,
        exclude_market_scan: bool = False,
    ) -> list[dict[str, Any]]:
        if not self.is_configured:
            return []

        try:
            resp = requests.get(
                f"{self.base_url}/api/companies/pending-enrichment",
                headers=self._headers(),
                params={
                    "limit": limit,
                    **({"exclude_market_scan": "1"} if exclude_market_scan else {}),
                },
                timeout=60,
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("companies") or []
        except requests.RequestException as exc:
            logger.warning("CRM pending-enrichment lookup failed: %s", exc)
            return []

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
