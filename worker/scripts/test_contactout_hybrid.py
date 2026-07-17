#!/usr/bin/env python3
"""Test ContactOut API enrichment on specific LinkedIn profiles."""
from __future__ import annotations

import logging
import sys
from pathlib import Path

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))

from src.env_loader import load_worker_env  # noqa: E402
from src.enrich.contactout import get_contactout_client  # noqa: E402

load_worker_env()

PROFILES = [
    ("Ryan Cronin", "http://www.linkedin.com/in/ryan-cronin-3b422a32"),
    ("Lindsay Widett", "http://www.linkedin.com/in/lindsay-widett-a2a56135"),
]


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logger = logging.getLogger(__name__)

    client = get_contactout_client()
    if not client.is_configured:
        logger.error("Set CONTACTOUT_API_KEY in the canonical worker env")
        return 1

    ok = 0
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

    logger.info("Done — %d/%d profiles enriched via API", ok, len(PROFILES))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
