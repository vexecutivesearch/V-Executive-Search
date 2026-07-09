from __future__ import annotations

import logging
import os
import smtplib
import time
from email.mime.text import MIMEText
from pathlib import Path

logger = logging.getLogger(__name__)


def _worker_root() -> Path:
    return Path(__file__).resolve().parent.parent


def alert_cooldown_path() -> Path:
    return (_worker_root() / ".contactout-alert-sent").resolve()


def _admin_url() -> str:
    base = (os.environ.get("CRM_API_URL") or "").rstrip("/")
    return f"{base}/admin" if base else "your CRM admin page"


def send_contactout_session_alert(*, reason: str) -> bool:
    """Layer 3 — email alert when auto-healing failed (rate-limited)."""
    cooldown_hours = float(os.environ.get("CONTACTOUT_ALERT_COOLDOWN_HOURS", "6"))
    path = alert_cooldown_path()
    if path.exists():
        try:
            last = float(path.read_text(encoding="utf-8").strip())
            if time.time() - last < cooldown_hours * 3600:
                logger.info("ContactOut alert suppressed (cooldown)")
                return False
        except (ValueError, OSError):
            pass

    to_email = os.environ.get("ALERT_EMAIL") or os.environ.get("CONTACTOUT_ALERT_EMAIL")
    if not to_email:
        logger.warning("No ALERT_EMAIL — cannot send ContactOut session alert")
        return False

    admin = _admin_url()
    body = (
        "ContactOut dashboard session could not be restored automatically.\n\n"
        f"Reason: {reason}\n\n"
        "The pipeline will continue with Apollo-only enrichment until the session is fixed.\n"
        "Pending ContactOut phone lookups will backfill automatically once login is restored.\n\n"
        f"Fix manually:\n"
        f"  1. Open {admin}\n"
        f"  2. Tap 'Sync ContactOut phones', OR on the Mac run:\n"
        f"     python scripts/contactout_login.py\n\n"
        "To enable fully automatic re-login, store credentials in Keychain:\n"
        "  python scripts/contactout_store_credentials.py\n"
    )

    sent = False
    resend_key = os.environ.get("RESEND_API_KEY")
    from_addr = os.environ.get("REPORT_FROM_EMAIL") or to_email

    if resend_key:
        try:
            import requests

            resp = requests.post(
                "https://api.resend.com/emails",
                headers={
                    "Authorization": f"Bearer {resend_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "from": from_addr,
                    "to": [to_email],
                    "subject": "[V Exec Search] ContactOut needs manual login",
                    "text": body,
                },
                timeout=30,
            )
            sent = resp.status_code in (200, 201)
        except Exception as exc:
            logger.warning("Resend alert failed: %s", exc)

    if not sent:
        try:
            msg = MIMEText(body)
            msg["Subject"] = "[V Exec Search] ContactOut needs manual login"
            msg["From"] = to_email
            msg["To"] = to_email
            with smtplib.SMTP("localhost", 25, timeout=10) as smtp:
                smtp.send_message(msg)
            sent = True
        except OSError as exc:
            logger.warning("SMTP alert failed: %s", exc)

    if sent:
        path.write_text(str(time.time()), encoding="utf-8")
        logger.info("ContactOut session alert sent to %s", to_email)
    return sent
