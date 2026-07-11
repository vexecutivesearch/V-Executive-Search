from __future__ import annotations

import logging
import os

import requests

from src.config_loader import parse_email_recipients

logger = logging.getLogger(__name__)


def send_credit_alert(
    *,
    to_email: str,
    subject: str,
    message: str,
) -> bool:
    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        logger.warning("RESEND_API_KEY not set — skipping credit alert")
        return False

    recipients = parse_email_recipients(to_email)
    if not recipients:
        logger.warning("No valid credit alert recipients in %r", to_email)
        return False

    from_email = os.environ.get("REPORT_FROM_EMAIL", "onboarding@resend.dev")
    html = f"""
    <html><body style="font-family:sans-serif;color:#111">
      <h2>{subject}</h2>
      <p>{message}</p>
      <p style="color:#666;font-size:12px">V Executive Search worker alert</p>
    </body></html>
    """

    try:
        resp = requests.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "from": from_email,
                "to": recipients,
                "subject": f"[V Exec Search] {subject}",
                "html": html,
            },
            timeout=30,
        )
        resp.raise_for_status()
        logger.info("Credit alert emailed to %s", ", ".join(recipients))
        return True
    except requests.RequestException as exc:
        logger.warning("Credit alert email failed: %s", exc)
        return False
