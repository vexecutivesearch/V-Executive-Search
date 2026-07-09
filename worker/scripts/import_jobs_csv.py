#!/usr/bin/env python3
"""Import a scrape CSV into the CRM via /api/ingest.

Jobs-only import: listings appear on the Jobs page immediately. The next
scheduled pipeline run (6 AM / 6 PM) resolves domains, enriches contacts,
checks iMessage, and sends the daily email automatically.
"""

from __future__ import annotations

import argparse
import csv
import logging
import os
import re
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import requests
from dotenv import load_dotenv

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))

logger = logging.getLogger(__name__)

DEFAULT_SEARCH_NAME = "West Palm Beach — 15 day market scan"


def _company_name(row: dict[str, str]) -> str:
    name = (row.get("company") or "").strip()
    if name and name.lower() != "nan":
        return name
    title = (row.get("title") or "Untitled role").strip()
    return f"(Listing) {title[:100]}"


def group_csv_rows(rows: list[dict[str, str]], search_name: str) -> list[dict]:
    by_company: dict[str, list[dict]] = defaultdict(list)

    for row in rows:
        company = _company_name(row)
        by_company[company].append(
            {
                "title": (row.get("title") or "").strip(),
                "board": (row.get("board") or "indeed").strip(),
                "url": (row.get("job_url") or "").strip(),
                "location": (row.get("location") or "").strip(),
                "search_name": search_name,
                "posted_at": (row.get("date_posted") or "")[:10] or None,
            }
        )

    payload_companies = []
    for name, listings in sorted(by_company.items()):
        payload_companies.append(
            {
                "name": name,
                "domain_confidence": "low",
                "job_listings": listings,
            }
        )
    return payload_companies


def post_batches(
    *,
    base_url: str,
    api_key: str,
    run_date: str,
    search_name: str,
    companies: list[dict],
    batch_size: int,
) -> dict:
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    totals = {
        "companies_inserted": 0,
        "companies_updated": 0,
        "jobs_inserted": 0,
        "jobs_skipped": 0,
    }

    for i in range(0, len(companies), batch_size):
        chunk = companies[i : i + batch_size]
        job_count = sum(len(c.get("job_listings", [])) for c in chunk)
        payload = {
            "run_date": run_date,
            "import_mode": "jobs_only",
            "metadata": {
                "listings_scraped": job_count,
                "companies_found": len(chunk),
            },
            "companies": chunk,
        }
        resp = requests.post(
            f"{base_url.rstrip('/')}/api/ingest",
            headers=headers,
            json=payload,
            timeout=120,
        )
        resp.raise_for_status()
        data = resp.json()
        logger.info(
            "Batch %d-%d: inserted=%s updated=%s jobs=%s skipped=%s",
            i + 1,
            i + len(chunk),
            data.get("companies_inserted"),
            data.get("companies_updated"),
            data.get("jobs_inserted"),
            data.get("jobs_skipped"),
        )
        for key in totals:
            totals[key] += data.get(key, 0)

    return totals


def main() -> int:
    parser = argparse.ArgumentParser(description="Import job CSV into CRM")
    parser.add_argument(
        "csv",
        type=Path,
        nargs="?",
        default=WORKER_ROOT / "output" / "west_palm_beach_fl_15d_2026-07-09.csv",
    )
    parser.add_argument("--search-name", default=DEFAULT_SEARCH_NAME)
    parser.add_argument("--batch-size", type=int, default=75)
    parser.add_argument("--run-date", default=date.today().isoformat())
    args = parser.parse_args()

    load_dotenv(WORKER_ROOT / ".env")
    base_url = os.environ.get("CRM_API_URL", "")
    api_key = os.environ.get("CRM_API_KEY", "")
    if not base_url or not api_key:
        logger.error("CRM_API_URL and CRM_API_KEY required in worker/.env")
        return 1

    if not args.csv.exists():
        logger.error("CSV not found: %s", args.csv)
        return 1

    with args.csv.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    companies = group_csv_rows(rows, args.search_name)
    logger.info(
        "Importing %d jobs across %d companies from %s",
        len(rows),
        len(companies),
        args.csv,
    )

    totals = post_batches(
        base_url=base_url,
        api_key=api_key,
        run_date=args.run_date,
        search_name=args.search_name,
        companies=companies,
        batch_size=args.batch_size,
    )
    logger.info("Import complete: %s", totals)
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    raise SystemExit(main())
