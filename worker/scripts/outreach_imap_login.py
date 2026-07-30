#!/usr/bin/env python3
"""One-time Microsoft 365 device-code login for Outreach IMAP (XOAUTH2).

Prereqs (Entra admin / you):
  1. App registration → Authentication → Allow public client flows = Yes
  2. API permissions → Office 365 Exchange Online → Delegated
     IMAP.AccessAsUser.All → Grant admin consent if required
  3. In ~/.vsearch/worker.env:
       OUTREACH_MS_CLIENT_ID=<app client id>
       OUTREACH_MS_TENANT_ID=<directory id>   # or organizations
       OUTREACH_IMAP_HOST=outlook.office365.com
       OUTREACH_IMAP_USER=odv@vexecutivesearch.com

Usage (from release or editable worker venv):
  WORKER_ENV_FILE=~/.vsearch/worker.env \\
    .venv/bin/python scripts/outreach_imap_login.py

Follow the printed device code in a browser, then leave the MSAL cache in place.
The 5-min poll agent will refresh tokens automatically.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))

from src.env_loader import load_worker_env  # noqa: E402
from src.outreach_imap_oauth import (  # noqa: E402
    acquire_access_token,
    cache_path,
    oauth_configured,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)


def main() -> int:
    load_worker_env(override=True)
    if not oauth_configured():
        print("Set OUTREACH_MS_CLIENT_ID in ~/.vsearch/worker.env first.", file=sys.stderr)
        return 1
    token = acquire_access_token(interactive_device_flow=True)
    print(f"OK — token acquired ({len(token)} chars). Cache: {cache_path()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
