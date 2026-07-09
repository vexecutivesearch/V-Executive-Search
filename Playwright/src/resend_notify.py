from __future__ import annotations

import logging
import os
import time
from pathlib import Path

logger = logging.getLogger(__name__)


def _cooldown_path(name: str) -> Path:
    from src.project_root import project_root

    return project_root() / f".contactout-alert-{name}"


def _should_send(alert_key: str, cooldown_hours: float) -> bool:
    path = _cooldown_path(alert_key)
    if not path.exists():
        return True
    try:
        last = float(path.read_text(encoding="utf-8").strip())
        return time.time() - last >= cooldown_hours * 3600
    except (ValueError, OSError):
        return True


def _mark_sent(alert_key: str) -> None:
    _cooldown_path(alert_key).write_text(str(time.time()), encoding="utf-8")


def send_resend_alert(*, subject: str, body: str, alert_key: str | None = None) -> bool:
    """Send operational alert via Resend (falls back to logging only)."""
    to_email = os.environ.get("ALERT_EMAIL") or os.environ.get("CONTACTOUT_ALERT_EMAIL")
    resend_key = os.environ.get("RESEND_API_KEY")
    from_addr = os.environ.get("REPORT_FROM_EMAIL") or to_email

    if alert_key:
        cooldown = float(os.environ.get("CONTACTOUT_ALERT_COOLDOWN_HOURS", "6"))
        if not _should_send(alert_key, cooldown):
            logger.info("Alert suppressed (%s cooldown)", alert_key)
            return False

    if not to_email or not resend_key:
        logger.warning("Resend alert skipped — set ALERT_EMAIL + RESEND_API_KEY\n%s", body)
        return False

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
                "subject": subject,
                "text": body,
            },
            timeout=30,
        )
        ok = resp.status_code in (200, 201)
        if ok and alert_key:
            _mark_sent(alert_key)
        if ok:
            logger.info("Resend alert sent: %s", subject)
        else:
            logger.warning("Resend alert failed %s: %s", resp.status_code, resp.text[:200])
        return ok
    except Exception as exc:
        logger.warning("Resend alert error: %s", exc)
        return False


def notify_credits_depleted(*, balance: int = 0) -> bool:
    return send_resend_alert(
        subject="[V Exec Search] ContactOut credits depleted",
        body=(
            "ContactOut dashboard automation stopped before burning into 429 loops.\n\n"
            f"Reported balance: {balance}\n\n"
            "Action: upgrade plan, wait for daily reset, or switch to API-only mode in worker/.\n"
        ),
        alert_key="credits-depleted",
    )


def notify_rate_limit_lockout(*, attempt: int, url: str) -> bool:
    return send_resend_alert(
        subject="[V Exec Search] ContactOut rate limit (429)",
        body=(
            "ContactOut flagged the session for moving too fast.\n\n"
            f"Last URL: {url}\n"
            f"Retry attempt: {attempt}\n\n"
            "Automation is backing off with exponential delay. "
            "If this persists, rotate residential proxy and reduce lookups/hour.\n"
        ),
        alert_key="rate-limit",
    )


def notify_session_lockout(*, reason: str) -> bool:
    return send_resend_alert(
        subject="[V Exec Search] ContactOut session lockout",
        body=(
            f"ContactOut dashboard session could not be restored.\n\n"
            f"Reason: {reason}\n\n"
            "Run: python scripts/contactout_login.py\n"
        ),
        alert_key="session-lockout",
    )
