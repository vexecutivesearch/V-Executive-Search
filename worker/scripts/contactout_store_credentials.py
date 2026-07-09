#!/usr/bin/env python3
"""Store ContactOut credentials in macOS Keychain for automatic re-login."""
from __future__ import annotations

import getpass
import sys
from pathlib import Path

from dotenv import load_dotenv

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))
load_dotenv(WORKER_ROOT / ".env")

from src.contactout_keychain import store_contactout_credentials  # noqa: E402


def main() -> int:
    if sys.platform != "darwin":
        print("Keychain storage is macOS only.")
        return 1

    email = input("ContactOut email: ").strip()
    if not email:
        print("Email required.")
        return 1
    password = getpass.getpass("ContactOut password: ")
    if not password:
        print("Password required.")
        return 1

    if store_contactout_credentials(email, password):
        print("Saved to Keychain. Auto-login will use email/password (not Google SSO).")
        print("Optional: set CONTACTOUT_OTP_IMAP_* in worker/.env for email verification codes.")
        return 0
    print("Failed to save — run manually:")
    print(
        f'  security add-generic-password -a "{email}" '
        '-s "v-execsearch-contactout" -w "YOUR_PASSWORD" -U'
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
