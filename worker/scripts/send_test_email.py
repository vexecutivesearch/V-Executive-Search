#!/usr/bin/env python3
"""Send the daily email report using current CRM data (for testing)."""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))
load_dotenv(WORKER_ROOT / ".env")

from src.config_loader import load_config, get_notification_email  # noqa: E402
from src.crm_config import fetch_pipeline_config  # noqa: E402
from src.email_report import fetch_daily_report_from_crm, send_daily_report  # noqa: E402


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logger = logging.getLogger(__name__)

    config = fetch_pipeline_config() or load_config()
    settings = config.get("settings") or {}
    notify = settings.get("notification_email") or os.environ.get("ALERT_EMAIL")
    geo_label = settings.get("geo_label", "Unknown")

    if not notify:
        logger.error("No notification email configured")
        return 1

    crm_data = fetch_daily_report_from_crm()
    if not crm_data:
        logger.error("Could not fetch report data from CRM")
        return 1

    ok = send_daily_report(
        notify,
        crm_data.get("rows", []),
        {
            "run_date": f"{crm_data.get('run_date', 'today')} (test)",
            "listings_scraped": crm_data.get("listings_scraped", 0),
            "companies_enriched": crm_data.get("companies_enriched", 0),
            "credits_used": 0,
        },
        geo_label,
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
