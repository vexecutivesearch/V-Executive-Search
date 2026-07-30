"""Microsoft 365 OAuth2 (XOAUTH2) for Outreach IMAP reply polling.

GoDaddy / Entra tenants often disable legacy app passwords. Use a one-time
device-code login (`scripts/outreach_imap_login.py`) so the poller can refresh
tokens unattended via MSAL cache at ~/.vsearch/outreach_msal_token.json.

Required Entra app (public client):
  - Allow public client flows = Yes
  - Delegated permission: IMAP.AccessAsUser.All
    (API: Office 365 Exchange Online)
  - Admin consent if the tenant requires it

Env:
  OUTREACH_MS_CLIENT_ID   — application (client) ID
  OUTREACH_MS_TENANT_ID   — directory ID, or "organizations" (default)
  OUTREACH_IMAP_USER      — mailbox UPN (e.g. odv@vexecutivesearch.com)
  OUTREACH_MSAL_CACHE     — optional token cache path
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

# MSAL adds offline_access / openid automatically — do not list them here.
IMAP_SCOPES = [
    "https://outlook.office365.com/IMAP.AccessAsUser.All",
]

DEFAULT_CACHE = Path.home() / ".vsearch" / "outreach_msal_token.json"


def oauth_configured() -> bool:
    return bool((os.environ.get("OUTREACH_MS_CLIENT_ID") or "").strip())


def cache_path() -> Path:
    raw = (os.environ.get("OUTREACH_MSAL_CACHE") or "").strip()
    return Path(raw).expanduser() if raw else DEFAULT_CACHE


def xoauth2_sasl(user: str, access_token: str) -> bytes:
    """RFC 7628 SASL XOAUTH2 initial client response."""
    return f"user={user}\x01auth=Bearer {access_token}\x01\x01".encode("utf-8")


def _authority() -> str:
    tenant = (os.environ.get("OUTREACH_MS_TENANT_ID") or "organizations").strip()
    return f"https://login.microsoftonline.com/{tenant}"


def _build_app():
    try:
        from msal import PublicClientApplication, SerializableTokenCache
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "msal is required for Outlook OAuth IMAP — pip install msal"
        ) from exc

    cache = SerializableTokenCache()
    path = cache_path()
    if path.exists():
        try:
            cache.deserialize(path.read_text(encoding="utf-8"))
        except OSError as exc:
            logger.warning("Could not read MSAL cache %s: %s", path, exc)

    client_id = (os.environ.get("OUTREACH_MS_CLIENT_ID") or "").strip()
    if not client_id:
        raise RuntimeError("OUTREACH_MS_CLIENT_ID is not set")

    app = PublicClientApplication(
        client_id,
        authority=_authority(),
        token_cache=cache,
    )
    return app, cache


def _persist_cache(cache) -> None:
    if not cache.has_state_changed:
        return
    path = cache_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(cache.serialize(), encoding="utf-8")
        path.chmod(0o600)
    except OSError as exc:
        logger.warning("Could not write MSAL cache %s: %s", path, exc)


def acquire_access_token(*, interactive_device_flow: bool = False) -> str:
    """Return a fresh access token for IMAP, refreshing from cache when possible."""
    app, cache = _build_app()
    user = (os.environ.get("OUTREACH_IMAP_USER") or "").strip().lower()
    accounts = app.get_accounts(username=user) if user else app.get_accounts()
    result = None
    if accounts:
        result = app.acquire_token_silent(IMAP_SCOPES, account=accounts[0])

    if not result and interactive_device_flow:
        flow = app.initiate_device_flow(scopes=IMAP_SCOPES)
        if "user_code" not in flow:
            raise RuntimeError(
                f"Device flow failed to start: {flow.get('error_description') or flow}"
            )
        print(flow["message"])  # noqa: T201 — intentional operator prompt
        result = app.acquire_token_by_device_flow(flow)

    if not result or "access_token" not in result:
        err = (result or {}).get("error_description") or (result or {}).get("error")
        raise RuntimeError(
            "No Outlook IMAP token — run "
            "`WORKER_ENV_FILE=~/.vsearch/worker.env "
            ".venv/bin/python scripts/outreach_imap_login.py` "
            f"once on the Mac. Detail: {err or 'missing token'}"
        )

    _persist_cache(cache)
    return str(result["access_token"])


def imap_authenticate_xoauth2(client, user: str, access_token: str) -> None:
    """Authenticate an imaplib.IMAP4_SSL client with XOAUTH2."""
    sasl = xoauth2_sasl(user, access_token)

    def _auth_object(_challenge: bytes | None) -> bytes:
        return sasl

    typ, _ = client.authenticate("XOAUTH2", _auth_object)
    if typ != "OK":
        raise RuntimeError(f"IMAP XOAUTH2 authenticate failed: {typ}")
