from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import yaml

from src.crm_config import fetch_pipeline_config

logger = logging.getLogger(__name__)

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "searches.yaml"


def load_config(config_path: Path | None = None) -> dict[str, Any]:
    remote = fetch_pipeline_config()
    if remote and remote.get("searches"):
        logger.info(
            "Using CRM pipeline config — geo: %s",
            remote.get("settings", {}).get("geo_label", "unknown"),
        )
        return remote

    path = config_path or DEFAULT_CONFIG_PATH
    logger.info("Using local searches.yaml (CRM config unavailable)")
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def get_notification_email(config: dict[str, Any]) -> str | None:
    settings = config.get("settings") or {}
    email = settings.get("notification_email")
    if email:
        return email
    return None
