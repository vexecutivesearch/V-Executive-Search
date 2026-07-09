#!/usr/bin/env python3
"""Test Apollo cross-match flow: name search → LinkedIn verify → scoped reveal."""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from src.enrich.contactout_dashboard import ContactOutDashboardClient  # noqa: E402
from src.enrich.contactout_session import ensure_session_healthy  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(message)s")


def main() -> int:
    parser = argparse.ArgumentParser(description="ContactOut cross-match reveal test")
    parser.add_argument("--name", required=True, help="Person name from Apollo")
    parser.add_argument("--linkedin", required=True, help="Expected Apollo LinkedIn URL")
    parser.add_argument("--title", default=None)
    parser.add_argument("--company", default=None)
    args = parser.parse_args()

    status = ensure_session_healthy(allow_interactive=True, allow_auto_login=True)
    if status.value not in ("ok", "not_needed"):
        logging.error("Session not ready: %s", status.value)
        return 1

    client = ContactOutDashboardClient()
    try:
        result = client.enrich_contact(
            contact_name=args.name,
            expected_linkedin_url=args.linkedin,
            expected_title=args.title,
            expected_company=args.company,
        )
    finally:
        client.close()

    if not result:
        logging.error("No result")
        return 1
    logging.info(
        "personal_email=%s personal_phone=%s phones=%s",
        result.personal_email,
        result.personal_phone,
        result.phones,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
