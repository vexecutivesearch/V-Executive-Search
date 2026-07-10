#!/usr/bin/env python3
"""Backfill LinkedIn hiring team / job poster data for jobs missing poster_name."""
from __future__ import annotations

import logging
import sys
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))
load_dotenv(WORKER_ROOT / ".env")

from src.crm_client import CRMClient  # noqa: E402
from src.linkedin_posters import (  # noqa: E402
    fetch_hiring_team,
    linkedin_job_id_from_url,
)
from src.models import JobListing
from src.pipeline import _build_jobs_only_payload  # noqa: E402
from src.models import PipelineResult
from jobspy.util import create_session  # noqa: E402
from jobspy.linkedin.constant import headers  # noqa: E402
from src.linkedin_posters import apply_linkedin_session_cookie  # noqa: E402
import requests  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


def main() -> int:
    crm = CRMClient()
    if not crm.is_configured:
        logger.error("CRM not configured")
        return 1

    resp = requests.get(
        f"{crm.base_url}/api/jobs/pending-posters",
        headers=crm._headers(),
        params={"limit": 200},
        timeout=60,
    )
    resp.raise_for_status()
    jobs = resp.json().get("jobs") or []
    if not jobs:
        logger.info("No LinkedIn jobs pending poster backfill")
        return 0

    session = create_session(is_tls=False, has_retry=True, delay=5, clear_cookies=True)
    session.headers.update(headers)
    apply_linkedin_session_cookie(session)

    from src.dedupe import collapse_to_companies
    from src.models import CompanyRecord

    listings: list[JobListing] = []
    for row in jobs:
        url = row.get("url") or ""
        job_id = linkedin_job_id_from_url(url)
        if not job_id:
            continue
        listing = JobListing(
            company_name=row.get("companyName") or "",
            job_title=row.get("title") or "",
            location=row.get("location") or "",
            board="linkedin",
            job_url=url,
        )
        posters = fetch_hiring_team(job_id, session)
        if posters:
            listing.posters = posters
            listings.append(listing)

    if not listings:
        logger.info(
            "Fetched 0 posters for %d jobs — public pages may hide hiring team; set LINKEDIN_LI_AT",
            len(jobs),
        )
        return 0

    companies = collapse_to_companies(listings)
    result = PipelineResult(run_date=date.today(), listings_scraped=len(listings))
    payload = _build_jobs_only_payload(companies, result)
    if not crm.ingest_batch(payload):
        logger.error("CRM ingest failed")
        return 1

    rescore = crm.rescore_backlog()
    logger.info(
        "Backfill complete — %d listings, %d companies, rescored=%s",
        len(listings),
        len(companies),
        rescore.get("scored"),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
