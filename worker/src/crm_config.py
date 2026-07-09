from __future__ import annotations

import logging
import os
from typing import Any

import requests

logger = logging.getLogger(__name__)


def _headers() -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {os.environ.get('CRM_API_KEY', '')}",
    }


def _base() -> str:
    return (os.environ.get("CRM_API_URL") or "").rstrip("/")


def fetch_pipeline_config() -> dict[str, Any] | None:
    base = _base()
    if not base or not os.environ.get("CRM_API_KEY"):
        return None
    try:
        resp = requests.get(
            f"{base}/api/pipeline/config",
            headers=_headers(),
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as exc:
        logger.warning("Failed to fetch pipeline config from CRM: %s", exc)
        return None


def get_pipeline_status() -> dict[str, Any]:
    base = _base()
    if not base:
        return {}
    try:
        resp = requests.get(
            f"{base}/api/pipeline/status",
            headers=_headers(),
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException:
        return {}


def post_pipeline_status(action: str) -> bool:
    base = _base()
    if not base:
        return False
    try:
        resp = requests.post(
            f"{base}/api/pipeline/status",
            headers=_headers(),
            json={"action": action},
            timeout=15,
        )
        resp.raise_for_status()
        return True
    except requests.RequestException as exc:
        logger.warning("Pipeline status update failed: %s", exc)
        return False
