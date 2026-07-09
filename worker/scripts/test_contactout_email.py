#!/usr/bin/env python3
"""Re-enrich specific contacts via ContactOut and send a 2-row test email."""
from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
from pathlib import Path

from dotenv import load_dotenv

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))
load_dotenv(WORKER_ROOT / ".env")

from src.config_loader import load_config, get_notification_email  # noqa: E402
from src.contact_phones import contact_phones_for_display, merge_sourced_phones, pick_primary_from_phones  # noqa: E402
from src.crm_config import fetch_pipeline_config  # noqa: E402
from src.email_report import send_daily_report  # noqa: E402
from src.enrich.contactout import ContactOutClient  # noqa: E402

logger = logging.getLogger(__name__)


def fetch_contacts(names: list[str]) -> list[dict]:
    repo_root = WORKER_ROOT.parent
    env = os.environ.copy()
    env["DOTENV_CONFIG_QUIET"] = "true"
    out = subprocess.check_output(
        ["node", str(WORKER_ROOT / "scripts" / "fetch_contacts.js"), *names],
        cwd=repo_root,
        text=True,
        env=env,
    )
    line = out.strip().splitlines()[-1]
    return json.loads(line)


def save_contact(contact_id: str, payload: dict) -> None:
    repo_root = WORKER_ROOT.parent
    subprocess.check_call(
        [
            "node",
            str(WORKER_ROOT / "scripts" / "save_contact.js"),
            contact_id,
            json.dumps(payload),
        ],
        cwd=repo_root,
    )


def build_report_row(contact: dict) -> dict:
    phones = contact.get("phones") or []
    return {
        "company": contact["company"],
        "contact_name": contact["name"],
        "title": contact.get("title"),
        "work_email": contact.get("work_email"),
        "personal_email": contact.get("personal_email"),
        "phones": phones,
        "imessage_capable": contact.get("imessage_capable"),
        "job_title": contact.get("job_title"),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--names",
        nargs="+",
        default=["Ryan Cronin", "Lindsay Widett"],
        help="Contact names to re-enrich and include in test email",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    client = ContactOutClient()
    if not client.is_configured:
        logger.error("CONTACTOUT_API_KEY not set")
        return 1

    contacts = fetch_contacts(args.names)
    if not contacts:
        logger.error("No contacts found for names: %s", args.names)
        return 1

    report_rows = []
    for contact in contacts:
        linkedin = contact.get("linkedin_url")
        if not linkedin:
            logger.warning("Skipping %s — no LinkedIn URL", contact["name"])
            continue

        logger.info("ContactOut enrich: %s", contact["name"])
        result = client.enrich_linkedin(linkedin)
        if not result:
            logger.warning("ContactOut returned nothing for %s", contact["name"])
            report_rows.append(build_report_row(contact))
            continue

        if result.phone_api_locked:
            logger.warning(
                "%s: ContactOut phone API locked (upgrade plan for phone credits)",
                contact["name"],
            )

        existing_phones = contact_phones_for_display(
            {
                "phones": contact.get("phones"),
                "phone": contact.get("phone"),
                "personal_phone": contact.get("personal_phone"),
                "company_phone": contact.get("company_phone"),
                "source_provider": contact.get("source_provider"),
            }
        )
        phones = merge_sourced_phones(existing_phones, result.phones or [])
        primary = pick_primary_from_phones(phones)

        personal_email = result.personal_email or contact.get("personal_email")
        work_email = contact.get("work_email")
        if not work_email and contact.get("email") and contact.get("email") != personal_email:
            work_email = contact.get("email")

        payload = {
            "personal_email": personal_email,
            "work_email": work_email,
            "email": personal_email or work_email or contact.get("email"),
            "phones": phones,
            "phone": primary.get("phone"),
            "personal_phone": primary.get("personal_phone"),
            "company_phone": primary.get("company_phone"),
            "source_provider": "apollo+contactout"
            if phones and any(p.get("source") == "contactout" for p in phones)
            else contact.get("source_provider") or "apollo+contactout",
        }
        save_contact(contact["id"], payload)

        updated = {**contact, **payload}
        co_phones = [p for p in phones if p.get("source") == "contactout"]
        apollo_phones = [p for p in phones if p.get("source") == "apollo"]
        logger.info(
            "  %s — ContactOut phones: %s | Apollo phones: %s",
            contact["name"],
            len(co_phones),
            len(apollo_phones),
        )
        for p in phones:
            logger.info("    %s · %s %s", p.get("source"), p.get("kind"), p.get("number"))
        report_rows.append(build_report_row(updated))

    config = fetch_pipeline_config() or load_config()
    settings = config.get("settings") or {}
    notify = settings.get("notification_email") or os.environ.get("ALERT_EMAIL")
    geo_label = settings.get("geo_label", "Unknown")
    if not notify:
        logger.error("No notification email configured")
        return 1

    ok = send_daily_report(
        notify,
        report_rows,
        {
            "run_date": "2026-07-09 (ContactOut phone test)",
            "listings_scraped": 0,
            "companies_enriched": len(report_rows),
            "credits_used": client.credits_used,
        },
        geo_label,
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
