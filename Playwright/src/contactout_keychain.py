from __future__ import annotations

import logging
import os
import subprocess
import sys

logger = logging.getLogger(__name__)

DEFAULT_SERVICE = "v-execsearch-contactout"


def _keychain_service() -> str:
    return os.environ.get("CONTACTOUT_KEYCHAIN_SERVICE", DEFAULT_SERVICE).strip() or DEFAULT_SERVICE


def _keychain_account() -> str:
    return (
        os.environ.get("CONTACTOUT_KEYCHAIN_ACCOUNT", "").strip()
        or os.environ.get("CONTACTOUT_EMAIL", "").strip()
    )


def get_contactout_credentials() -> tuple[str, str] | None:
    """Read ContactOut email + password from macOS Keychain (never plaintext on disk)."""
    if sys.platform != "darwin":
        return None

    account = _keychain_account()
    if not account:
        logger.debug("CONTACTOUT_KEYCHAIN_ACCOUNT or CONTACTOUT_EMAIL not set")
        return None

    service = _keychain_service()
    try:
        result = subprocess.run(
            [
                "security",
                "find-generic-password",
                "-s",
                service,
                "-a",
                account,
                "-w",
            ],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        if result.returncode != 0:
            logger.debug("Keychain lookup failed for %s@%s", account, service)
            return None
        password = (result.stdout or "").strip()
        if not password:
            return None
        return account, password
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.warning("Keychain read error: %s", exc)
        return None


def store_contactout_credentials(email: str, password: str) -> bool:
    """Store credentials in macOS Keychain (interactive — run store script once)."""
    if sys.platform != "darwin":
        return False
    service = _keychain_service()
    try:
        subprocess.run(
            [
                "security",
                "add-generic-password",
                "-a",
                email,
                "-s",
                service,
                "-w",
                password,
                "-U",
            ],
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        )
        return True
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        logger.error("Keychain store failed: %s", exc)
        return False
