#!/usr/bin/env python3
"""Mac-only: enrich CRM contacts via ContactOut dashboard (unlimited plan workaround)."""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))
load_dotenv(WORKER_ROOT / ".env")

from src.contact_phones import (  # noqa: E402
    contact_phones_for_display,
    merge_sourced_phones,
    pick_primary_from_phones,
)
from src.enrich.contactout import get_contactout_client  # noqa: E402

logger = logging.getLogger(__name__)


def _crm_headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {os.environ.get('CRM_API_KEY', '')}",
        "Content-Type": "application/json",
    }


def _crm_base() -> str:
    return (os.environ.get("CRM_API_URL") or "").rstrip("/")


def fetch_pending_contacts(limit: int) -> list[dict]:
    resp = requests.get(
        f"{_crm_base()}/api/contacts",
        headers=_crm_headers(),
        params={"pending_contactout": "1", "limit": limit},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json().get("contacts") or []


def patch_contact(contact_id: str, payload: dict) -> None:
    resp = requests.patch(
        f"{_crm_base()}/api/contacts/{contact_id}",
        headers=_crm_headers(),
        json=payload,
        timeout=30,
    )
    resp.raise_for_status()


def run_dashboard_sync(*, limit: int = 10) -> int:
    if os.environ.get("CONTACTOUT_MODE", "").lower() != "dashboard":
        logger.info("Skipping ContactOut dashboard sync (CONTACTOUT_MODE != dashboard)")
        return 0

    client = get_contactout_client()
    if not client.is_configured:
        logger.warning(
            "ContactOut dashboard not ready — run: python scripts/contactout_login.py"
        )
        return 0

    pending = fetch_pending_contacts(limit)
    if not pending:
        logger.info("No contacts pending ContactOut dashboard lookup")
        return 0

    updated = 0
    try:
        for contact in pending:
            linkedin = contact.get("linkedinUrl") or contact.get("linkedin_url")
            if not linkedin:
                continue

            logger.info("Dashboard lookup: %s", contact.get("name"))
            result = client.enrich_linkedin(linkedin)
            if not result:
                continue

            phones = merge_sourced_phones(
                contact_phones_for_display(
                    {
                        "phones": contact.get("phones"),
                        "phone": contact.get("phone"),
                        "personal_phone": contact.get("personalPhone"),
                        "company_phone": contact.get("companyPhone"),
                        "source_provider": contact.get("sourceProvider"),
                    }
                ),
                result.phones or [],
            )
            primary = pick_primary_from_phones(phones)
            personal_email = result.personal_email or contact.get("personalEmail")

            patch_contact(
                contact["id"],
                {
                    "personal_email": personal_email,
                    "work_email": contact.get("workEmail")
                    or (result.work_emails[0] if result.work_emails else None),
                    "email": personal_email or contact.get("email"),
                    "phones": phones,
                    "phone": primary.get("phone"),
                    "personal_phone": primary.get("personal_phone"),
                    "company_phone": primary.get("company_phone"),
                    "source_provider": "apollo+contactout",
                },
            )
            updated += 1
    finally:
        if hasattr(client, "close"):
            client.close()

    logger.info("ContactOut dashboard sync updated %d contact(s)", updated)
    return updated


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="ContactOut dashboard sync (Mac only)")
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if not _crm_base() or not os.environ.get("CRM_API_KEY"):
        logger.error("Set CRM_API_URL and CRM_API_KEY in worker/.env")
        return 1

    run_dashboard_sync(limit=args.limit)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
