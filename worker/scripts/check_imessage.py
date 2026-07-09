#!/usr/bin/env python3
"""Check iMessage capability for contact emails/phones (Mac only).

Uses the Messages app via AppleScript. Run on the Mac mini after enrichment:
  python scripts/check_imessage.py
  python scripts/check_imessage.py --limit 20
"""

from __future__ import annotations

import argparse
import logging
import os
import subprocess
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))

logger = logging.getLogger(__name__)


def check_imessage(address: str) -> bool | None:
    """Return True if address resolves as iMessage, False if SMS-only, None if unknown."""
    escaped = address.replace("\\", "\\\\").replace('"', '\\"')
    script = f'''
    tell application "Messages"
        set imessageServices to (every service whose service type is iMessage)
        if (count of imessageServices) is 0 then return "unknown"
        set targetService to item 1 of imessageServices
        try
            set testBuddy to buddy "{escaped}" of targetService
            return "yes"
        on error
            return "no"
        end try
    end tell
    '''
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        out = (result.stdout or "").strip().lower()
        if out == "yes":
            return True
        if out == "no":
            return False
        return None
    except (subprocess.SubprocessError, OSError) as exc:
        logger.warning("iMessage check failed for %s: %s", address, exc)
        return None


def fetch_contacts(base_url: str, api_key: str, limit: int) -> list[dict]:
    resp = requests.get(
        f"{base_url.rstrip('/')}/api/contacts",
        headers={"Authorization": f"Bearer {api_key}"},
        params={"limit": limit},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json().get("contacts") or []


def patch_imessage(base_url: str, api_key: str, contact_id: str, capable: bool) -> None:
    resp = requests.patch(
        f"{base_url.rstrip('/')}/api/contacts/{contact_id}",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={"imessage_capable": capable},
        timeout=20,
    )
    resp.raise_for_status()


def run_imessage_checks(*, limit: int = 50, delay: float = 2.0) -> int:
    """Check pending contacts and patch CRM. Returns count checked. Mac only."""
    if sys.platform != "darwin":
        logger.info("Skipping iMessage checks (not macOS)")
        return 0

    load_dotenv(WORKER_ROOT / ".env")
    base_url = os.environ.get("CRM_API_URL", "")
    api_key = os.environ.get("CRM_API_KEY", "")
    if not base_url or not api_key:
        logger.warning("Skipping iMessage checks — CRM_API_URL/CRM_API_KEY not set")
        return 0

    try:
        pending = fetch_contacts(base_url, api_key, limit * 2)
    except requests.RequestException as exc:
        logger.warning("iMessage check skipped — could not fetch contacts: %s", exc)
        return 0

    checked = 0
    for contact in pending:
        if checked >= limit:
            break
        if contact.get("imessageCapable") is not None or contact.get("imessage_capable") is not None:
            continue

        addresses: list[str] = []
        for key in ("personalEmail", "personal_email"):
            val = contact.get(key)
            if val and isinstance(val, str) and "@" in val:
                addresses.append(val.strip())

        if not addresses:
            for key in ("email",):
                val = contact.get(key)
                if val and isinstance(val, str) and "@" in val:
                    from src.phone_utils import is_personal_email
                    if is_personal_email(val):
                        addresses.append(val.strip())

        for key in ("personalPhone", "personal_phone", "phone"):
            val = contact.get(key)
            if val and isinstance(val, str) and "@" not in val:
                digits = "".join(ch for ch in val if ch.isdigit())
                if len(digits) >= 10:
                    addresses.append(val.strip())

        for address in addresses:
            capable = check_imessage(address)
            if capable is None:
                continue
            patch_imessage(base_url, api_key, contact["id"], capable)
            label = "iMessage" if capable else "SMS only"
            logger.info(
                "iMessage: %s — %s (%s)",
                contact.get("name"),
                label,
                address,
            )
            checked += 1
            time.sleep(delay)
            break

    return checked


def main() -> int:
    parser = argparse.ArgumentParser(description="Check iMessage for CRM contacts (Mac only)")
    parser.add_argument("--limit", type=int, default=50, help="Max contacts to check")
    parser.add_argument("--delay", type=float, default=2.0, help="Seconds between checks")
    args = parser.parse_args()

    if sys.platform != "darwin":
        logger.error("iMessage checks only work on macOS with Messages signed in")
        return 1

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    n = run_imessage_checks(limit=args.limit, delay=args.delay)
    logger.info("Done — checked %d contact(s)", n)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
