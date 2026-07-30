#!/usr/bin/env python3
"""Outreach worker pump — runs each poll tick (every 5 min via launchd poll).

Three jobs, all idempotent and independently non-fatal:
  1. iMessage sends  — poll /api/outreach/imessage-queue, send via
     Messages.app AppleScript with retry, post statuses back. (macOS only)
  2. chat.db scan    — inbound texts from enrolled numbers since the last
     scanned ROWID, self-sent messages filtered (is_from_me), posted to
     /api/outreach/inbound. (macOS only)
  3. IMAP poll       — new mail in the Reply-To mailbox posted to
     /api/outreach/inbound with In-Reply-To for threading. (any OS)

State (last chat.db rowid, last IMAP UID) lives in ~/.vsearch/outreach_state.json
so release swaps never re-ingest history (the CRM also dedupes on external_id).

Env:
  OUTREACH_IMAP_HOST / OUTREACH_IMAP_USER
  OUTREACH_IMAP_FOLDER (default INBOX) / OUTREACH_IMAP_PORT (default 993)
  Auth (prefer OAuth for M365 / GoDaddy — app passwords are often unavailable):
    OUTREACH_MS_CLIENT_ID + MSAL cache from scripts/outreach_imap_login.py
    OR legacy OUTREACH_IMAP_PASSWORD (basic auth)
"""

from __future__ import annotations

import email
import email.header
import email.utils
import imaplib
import json
import logging
import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))

from src.env_loader import load_worker_env  # noqa: E402
from src.outreach_imap_oauth import (  # noqa: E402
    acquire_access_token,
    imap_authenticate_xoauth2,
    oauth_configured,
)

logger = logging.getLogger(__name__)

STATE_FILE = Path(
    os.environ.get("OUTREACH_STATE_FILE", "")
    or Path.home() / ".vsearch" / "outreach_state.json"
).expanduser()
CHAT_DB = Path.home() / "Library" / "Messages" / "chat.db"
SEND_DELAY_SECONDS = float(os.environ.get("OUTREACH_IMESSAGE_DELAY", "4"))


def _crm() -> tuple[str, str] | None:
    base = (os.environ.get("CRM_API_URL") or "").rstrip("/")
    key = os.environ.get("CRM_API_KEY", "")
    if not base or not key:
        return None
    return base, key


def _headers(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def _load_state() -> dict[str, Any]:
    try:
        if STATE_FILE.exists():
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    return {}


def _save_state(state: dict[str, Any]) -> None:
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")
    except OSError as exc:
        logger.warning("outreach state write failed: %s", exc)


# --------------------------------------------------------------------------
# 1. iMessage sends
# --------------------------------------------------------------------------

def send_imessage(phone: str, body: str) -> tuple[bool, str | None]:
    """Send one text via Messages.app. Returns (ok, error)."""
    escaped_body = body.replace("\\", "\\\\").replace('"', '\\"')
    # Prefer E.164; also try digits-only buddy form if + fails.
    raw = "".join(ch for ch in phone if ch.isdigit() or ch == "+")
    digits = "".join(ch for ch in phone if ch.isdigit())
    candidates = []
    for candidate in (raw, digits, f"+{digits}" if digits and not digits.startswith("+") else None):
        if candidate and candidate not in candidates:
            candidates.append(candidate)

    last_error = "unknown osascript failure"
    for escaped_phone in candidates:
        escaped_phone = escaped_phone.replace("\\", "\\\\").replace('"', '\\"')
        script = f'''
        tell application "Messages"
            set imessageServices to (every service whose service type is iMessage)
            if (count of imessageServices) is 0 then return "error: no iMessage service (signed out?)"
            set targetService to item 1 of imessageServices
            try
                set targetBuddy to buddy "{escaped_phone}" of targetService
                send "{escaped_body}" to targetBuddy
                return "sent"
            on error errMsg
                return "error: " & errMsg
            end try
        end tell
        '''
        try:
            result = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            out = (result.stdout or "").strip()
            if out == "sent":
                return True, None
            last_error = out or (result.stderr or "").strip() or "unknown osascript failure"
        except (subprocess.SubprocessError, OSError) as exc:
            last_error = str(exc)
    return False, last_error


def pump_imessage_queue() -> int:
    """Fetch due texts, send, post statuses. Returns count attempted."""
    if sys.platform != "darwin":
        return 0
    crm = _crm()
    if not crm:
        return 0
    base, key = crm

    try:
        resp = requests.get(
            f"{base}/api/outreach/imessage-queue", headers=_headers(key), timeout=30
        )
        resp.raise_for_status()
        messages = resp.json().get("messages") or []
    except requests.RequestException as exc:
        logger.warning("imessage queue fetch failed: %s", exc)
        return 0

    if not messages:
        return 0

    results = []
    for message in messages:
        ok, error = send_imessage(str(message["phone"]), str(message["body"]))
        results.append(
            {
                "id": message["id"],
                "status": "sent" if ok else "failed",
                **({"error": error} if error else {}),
            }
        )
        logger.info(
            "outreach text %s → %s%s",
            message["id"],
            "sent" if ok else "FAILED",
            f" ({error})" if error else "",
        )
        time.sleep(SEND_DELAY_SECONDS)

    try:
        requests.post(
            f"{base}/api/outreach/imessage-queue",
            headers=_headers(key),
            json={"results": results},
            timeout=30,
        ).raise_for_status()
    except requests.RequestException as exc:
        logger.warning("imessage status post failed: %s", exc)
    return len(results)


# --------------------------------------------------------------------------
# 2. chat.db inbound scan
# --------------------------------------------------------------------------

APPLE_EPOCH_OFFSET = 978_307_200  # 2001-01-01 in unix seconds


def _normalize_phone(value: str) -> str:
    digits = "".join(ch for ch in value if ch.isdigit())
    return digits[-10:] if len(digits) >= 10 else ""


def _is_substantive_imessage_text(text: str | None) -> bool:
    """Reject empty / attachment-placeholder chat.db rows.

    Messages.app often stores tapbacks, stickers, and failed-delivery stubs with
    only U+FFFC (object replacement) in ``text``. Posting those as inbound
    pauses enrollments as ``unknown`` (false "SMS failed" / false delivery).
    """
    if text is None:
        return False
    cleaned = "".join(ch for ch in str(text) if ch not in "\ufffc\ufffd").strip()
    return bool(cleaned)


def scan_chat_db(watch_phones: set[str]) -> int:
    """Post inbound texts from watched numbers. Returns count posted."""
    if sys.platform != "darwin" or not CHAT_DB.exists() or not watch_phones:
        return 0
    crm = _crm()
    if not crm:
        return 0
    base, key = crm

    state = _load_state()
    last_rowid = int(state.get("chat_last_rowid") or 0)

    try:
        conn = sqlite3.connect(f"file:{CHAT_DB}?mode=ro", uri=True)
        cursor = conn.execute(
            """
            SELECT m.ROWID, m.guid, m.text, m.date, m.is_from_me, h.id
            FROM message m
            JOIN handle h ON h.ROWID = m.handle_id
            WHERE m.ROWID > ? AND m.text IS NOT NULL
            ORDER BY m.ROWID ASC
            LIMIT 500
            """,
            (last_rowid,),
        )
        rows = cursor.fetchall()
        conn.close()
    except sqlite3.Error as exc:
        # "unable to open database file" here is almost always macOS TCC, not a
        # corrupt db: stat() succeeds so CHAT_DB.exists() passed, but the read is
        # denied. It silently disables ALL inbound-text ingestion, so say so.
        if "unable to open database file" in str(exc).lower():
            logger.error(
                "chat.db unreadable — inbound texts are NOT being ingested. Grant "
                "Full Disk Access to the worker Python (%s) in System Settings → "
                "Privacy & Security → Full Disk Access, then: launchctl kickstart "
                "-k gui/$UID/com.vexecsearch.poll",
                Path(sys.executable).resolve(),
            )
        else:
            logger.warning("chat.db scan failed: %s", exc)
        return 0

    if not rows:
        return 0

    inbound = []
    max_rowid = last_rowid
    for rowid, guid, text, apple_date, is_from_me, handle in rows:
        max_rowid = max(max_rowid, int(rowid))
        # Filter self-sent messages — otherwise our own outbound texts loop
        # back as "replies".
        if is_from_me:
            continue
        if not _is_substantive_imessage_text(text):
            continue
        phone = _normalize_phone(str(handle or ""))
        if not phone or phone not in watch_phones:
            continue
        # apple date is ns since 2001 on modern macOS
        seconds = int(apple_date or 0)
        if seconds > 10**12:
            seconds = seconds // 1_000_000_000
        received = datetime.fromtimestamp(
            seconds + APPLE_EPOCH_OFFSET, tz=timezone.utc
        )
        inbound.append(
            {
                "channel": "imessage",
                "from": str(handle),
                "body": str(text),
                "external_id": f"chatdb:{guid}",
                "received_at": received.isoformat(),
            }
        )

    if inbound:
        try:
            requests.post(
                f"{base}/api/outreach/inbound",
                headers=_headers(key),
                json={"messages": inbound},
                timeout=60,
            ).raise_for_status()
            logger.info("posted %d inbound text(s) from chat.db", len(inbound))
        except requests.RequestException as exc:
            logger.warning("inbound text post failed: %s", exc)
            return 0  # don't advance rowid — retry next tick

    state["chat_last_rowid"] = max_rowid
    _save_state(state)
    return len(inbound)


# --------------------------------------------------------------------------
# 3. IMAP reply poll
# --------------------------------------------------------------------------

def _decode_header(value: str | None) -> str:
    if not value:
        return ""
    parts = email.header.decode_header(value)
    out = []
    for text, charset in parts:
        if isinstance(text, bytes):
            out.append(text.decode(charset or "utf-8", errors="replace"))
        else:
            out.append(text)
    return "".join(out)


def _plain_body(message: email.message.Message) -> str:
    if message.is_multipart():
        for part in message.walk():
            if part.get_content_type() == "text/plain":
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    return payload.decode(charset, errors="replace")
        for part in message.walk():
            if part.get_content_type() == "text/html":
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    import re

                    html = payload.decode(charset, errors="replace")
                    return re.sub(r"<[^>]+>", " ", html)
        return ""
    payload = message.get_payload(decode=True)
    if payload:
        charset = message.get_content_charset() or "utf-8"
        return payload.decode(charset, errors="replace")
    return str(message.get_payload() or "")


def _imap_connect(host: str, port: int, user: str):
    """Open IMAP SSL and authenticate via OAuth (preferred) or password."""
    client = imaplib.IMAP4_SSL(host, port)
    password = (os.environ.get("OUTREACH_IMAP_PASSWORD") or "").strip()
    auth_mode = (os.environ.get("OUTREACH_IMAP_AUTH") or "auto").strip().lower()
    use_oauth = auth_mode == "oauth" or (
        auth_mode == "auto" and oauth_configured()
    )
    if use_oauth:
        token = acquire_access_token(interactive_device_flow=False)
        imap_authenticate_xoauth2(client, user, token)
        return client
    if auth_mode == "password" or password:
        if not password:
            raise RuntimeError("OUTREACH_IMAP_PASSWORD is empty")
        client.login(user, password)
        return client
    raise RuntimeError(
        "IMAP auth not configured — set OUTREACH_MS_CLIENT_ID (OAuth) "
        "or OUTREACH_IMAP_PASSWORD"
    )


def poll_imap() -> int:
    """Poll the Reply-To mailbox for new mail; post to the CRM. Returns count.

    Posts one message at a time and advances imap_last_uid after each success.
    Bulk posts of ~100 timed out on the CRM (each inbound may LLM-classify),
    so the UID cursor never moved and real replies sat invisible in IMAP.
    """
    host = os.environ.get("OUTREACH_IMAP_HOST", "")
    user = os.environ.get("OUTREACH_IMAP_USER", "")
    password = (os.environ.get("OUTREACH_IMAP_PASSWORD") or "").strip()
    if not host or not user:
        return 0
    if not oauth_configured() and not password:
        return 0
    crm = _crm()
    if not crm:
        return 0
    base, key = crm

    folder = os.environ.get("OUTREACH_IMAP_FOLDER", "INBOX")
    port = int(os.environ.get("OUTREACH_IMAP_PORT", "993"))
    post_timeout = max(30, int(os.environ.get("OUTREACH_IMAP_POST_TIMEOUT", "120")))
    max_per_tick = max(1, int(os.environ.get("OUTREACH_IMAP_MAX_PER_TICK", "15")))
    state = _load_state()
    last_uid = int(state.get("imap_last_uid") or 0)

    try:
        client = _imap_connect(host, port, user)
        client.select(folder, readonly=True)
        status, data = client.uid("search", None, f"UID {last_uid + 1}:*")
        if status != "OK":
            client.logout()
            return 0
        uids = [int(u) for u in (data[0] or b"").split() if int(u) > last_uid]
    except (imaplib.IMAP4.error, OSError, RuntimeError) as exc:
        logger.warning("IMAP poll failed: %s", exc)
        return 0

    posted_total = 0
    for uid in uids[:max_per_tick]:
        try:
            status, msg_data = client.uid("fetch", str(uid), "(RFC822)")
            if status != "OK" or not msg_data or msg_data[0] is None:
                continue
            raw = msg_data[0][1]
            message = email.message_from_bytes(raw)
        except (imaplib.IMAP4.error, OSError, TypeError) as exc:
            logger.warning("IMAP fetch uid=%s failed: %s", uid, exc)
            continue

        from_header = _decode_header(message.get("From"))
        from_addr = email.utils.parseaddr(from_header)[1]
        # Skip our own sends landing in the mailbox — still advance cursor.
        if from_addr.lower() == user.lower():
            last_uid = max(last_uid, uid)
            state["imap_last_uid"] = last_uid
            _save_state(state)
            continue
        message_id = (message.get("Message-ID") or "").strip()
        in_reply_to = (message.get("In-Reply-To") or "").strip() or None
        body = _plain_body(message).strip()
        if not body:
            last_uid = max(last_uid, uid)
            state["imap_last_uid"] = last_uid
            _save_state(state)
            continue
        date_header = message.get("Date")
        received_at = None
        if date_header:
            try:
                received_at = email.utils.parsedate_to_datetime(date_header).isoformat()
            except (TypeError, ValueError):
                received_at = None

        item = {
            "channel": "email",
            "from": from_addr,
            "subject": _decode_header(message.get("Subject")),
            "body": body[:20000],
            "external_id": f"imap:{message_id or uid}",
            **({"in_reply_to": in_reply_to} if in_reply_to else {}),
            **({"received_at": received_at} if received_at else {}),
        }

        try:
            requests.post(
                f"{base}/api/outreach/inbound",
                headers=_headers(key),
                json={"messages": [item]},
                timeout=post_timeout,
            ).raise_for_status()
            posted_total += 1
            last_uid = max(last_uid, uid)
            state["imap_last_uid"] = last_uid
            _save_state(state)
        except requests.RequestException as exc:
            logger.warning(
                "inbound email post failed (uid=%s); will retry next tick: %s",
                uid,
                exc,
            )
            break

    try:
        client.logout()
    except (imaplib.IMAP4.error, OSError):
        pass

    if posted_total:
        logger.info(
            "posted %d inbound email(s) from IMAP (last_uid=%s)",
            posted_total,
            last_uid,
        )
    return posted_total


# --------------------------------------------------------------------------

def fetch_watchlist() -> set[str]:
    crm = _crm()
    if not crm:
        return set()
    base, key = crm
    try:
        resp = requests.get(
            f"{base}/api/outreach/watchlist", headers=_headers(key), timeout=30
        )
        resp.raise_for_status()
        return {
            _normalize_phone(str(p))
            for p in resp.json().get("phones") or []
            if _normalize_phone(str(p))
        }
    except requests.RequestException as exc:
        logger.warning("watchlist fetch failed: %s", exc)
        return set()


def run_outreach_pump() -> dict[str, int]:
    """One pump pass. Each stage isolated — a failure never blocks the rest."""
    stats = {"texts_sent": 0, "texts_in": 0, "emails_in": 0}
    try:
        stats["texts_sent"] = pump_imessage_queue()
    except Exception as exc:  # noqa: BLE001
        logger.warning("imessage pump failed (non-fatal): %s", exc)
    try:
        stats["texts_in"] = scan_chat_db(fetch_watchlist())
    except Exception as exc:  # noqa: BLE001
        logger.warning("chat.db pump failed (non-fatal): %s", exc)
    try:
        stats["emails_in"] = poll_imap()
    except Exception as exc:  # noqa: BLE001
        logger.warning("IMAP pump failed (non-fatal): %s", exc)
    return stats


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    load_worker_env()
    stats = run_outreach_pump()
    logger.info(
        "outreach pump: %d text(s) sent · %d text repl(ies) in · %d email repl(ies) in",
        stats["texts_sent"],
        stats["texts_in"],
        stats["emails_in"],
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
