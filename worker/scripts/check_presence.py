#!/usr/bin/env python3
"""Presence checks: iMessage + email MX verification via CRM API."""
from __future__ import annotations

import logging
import sys
from pathlib import Path

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))

from src.env_loader import load_worker_env  # noqa: E402

load_worker_env()

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)


def main() -> int:
    import importlib.util
    import os
    import requests

    from src.crm_client import CRMClient

    # iMessage (Mac only)
    script = WORKER_ROOT / "scripts" / "check_imessage.py"
    spec = importlib.util.spec_from_file_location("check_imessage", script)
    if spec and spec.loader:
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        n = mod.run_imessage_checks(limit=50, delay=1.5)
        logger.info("iMessage checks: %d contact(s)", n)

    crm = CRMClient()
    if crm.is_configured:
        verify = crm.verify_contact_emails(limit=50)
        logger.info(
            "Email verify: %s checked, %s deliverable",
            verify.get("verified"),
            verify.get("deliverable"),
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
