#!/usr/bin/env python3
"""Send a test daily email using CRM JSON from stdin or --crm-json (local Hot Listings)."""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))
load_dotenv(WORKER_ROOT / ".env")
load_dotenv(WORKER_ROOT.parent / ".env.local", override=False)

from src.config_loader import load_config  # noqa: E402
from src.crm_config import fetch_pipeline_config  # noqa: E402
from src.email_report import fetch_daily_report_from_crm, send_daily_report  # noqa: E402


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logger = logging.getLogger(__name__)

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--crm-json",
        help="Path to CRM daily report JSON (from local branch). Default: fetch live CRM.",
    )
    parser.add_argument(
        "--to",
        help="Override recipient(s). Default: CRM notification_email / ALERT_EMAIL.",
    )
    args = parser.parse_args()

    config = fetch_pipeline_config() or load_config()
    settings = config.get("settings") or {}
    notify = (
        args.to
        or settings.get("notification_email")
        or os.environ.get("ALERT_EMAIL")
    )
    geo_label = settings.get("geo_label", "Unknown")

    if not notify:
        logger.error("No notification email configured")
        return 1

    if args.crm_json:
        crm_data = json.loads(Path(args.crm_json).read_text())
        logger.info(
            "Loaded CRM JSON: %d leads, %d hot listings (of %s total)",
            len(crm_data.get("leads") or []),
            len(crm_data.get("hot_listings") or []),
            crm_data.get("hot_listings_count", "?"),
        )
    else:
        crm_data = fetch_daily_report_from_crm()
        if not crm_data:
            logger.error("Could not fetch report data from CRM")
            return 1

    ok = send_daily_report(
        notify,
        crm_data.get("rows") or crm_data.get("leads") or [],
        {
            "run_date": f"{crm_data.get('run_date', 'today')} (test)",
            "listings_scraped": crm_data.get("listings_scraped", 0),
            "icp_match_count": crm_data.get("icp_match_count", 0),
            "companies_enriched": crm_data.get("companies_enriched", 0),
            "credits_used": crm_data.get("credits_used", 0),
        },
        geo_label,
        crm_data=crm_data,
    )
    if ok:
        logger.info("Test email sent to %s", notify)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
