#!/usr/bin/env python3
"""Test ContactOut hybrid enrichment on specific contacts (API → dashboard fallback)."""
from __future__ import annotations

import logging
import sys
from pathlib import Path

from dotenv import load_dotenv

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))
load_dotenv(WORKER_ROOT / ".env")

from src.enrich.contactout import get_contactout_client  # noqa: E402
from src.enrich.contactout_dashboard import browser_profile_dir  # noqa: E402
from src.enrich.contactout_hybrid import mark_api_phone_locked  # noqa: E402

PROFILES = [
    ("Ryan Cronin", "http://www.linkedin.com/in/ryan-cronin-3b422a32"),
    ("Lindsay Widett", "http://www.linkedin.com/in/lindsay-widett-a2a56135"),
]


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logger = logging.getLogger(__name__)

    profile = browser_profile_dir()
    logger.info("ContactOut browser profile: %s (exists=%s)", profile, profile.exists())
    if not profile.exists():
        logger.warning("Run once: python scripts/contactout_login.py")

    mark_api_phone_locked()
    client = get_contactout_client()
    if not client.is_configured:
        logger.error("ContactOut not configured (API key and/or dashboard login required)")
        return 1

    ok = 0
    try:
        for name, url in PROFILES:
            logger.info("--- %s ---", name)
            result = client.enrich_linkedin(url)
            if not result:
                logger.warning("  No data returned")
                continue
            ok += 1
            logger.info("  personal_email: %s", result.personal_email)
            logger.info("  work_emails: %s", result.work_emails)
            logger.info("  phones: %s", result.phones)
    finally:
        if hasattr(client, "close"):
            client.close()

    logger.info("Done — %d/%d profiles enriched", ok, len(PROFILES))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
