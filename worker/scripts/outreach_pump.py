#!/usr/bin/env python3
"""Outreach worker pump — runs each poll tick (every 5 min via launchd poll).

Three jobs, all idempotent and independently non-fatal:
  1. Text sends      — poll /api/outreach/imessage-queue, send via Messages.app
     AppleScript, confirm delivery in chat.db, fall back to green-bubble SMS
     when iMessage comes back Not Delivered, post statuses back. (macOS only)
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
# How long to watch chat.db for a delivery verdict before giving up and calling
# the send unconfirmed (never "failed" — see _await_delivery).
SEND_VERIFY_SECONDS = float(os.environ.get("OUTREACH_SEND_VERIFY_SECONDS", "45"))
SEND_VERIFY_POLL_SECONDS = float(os.environ.get("OUTREACH_SEND_VERIFY_POLL", "3"))
SMS_FALLBACK_ENABLED = (os.environ.get("OUTREACH_SMS_FALLBACK", "1") or "").strip().lower() not in {
    "0",
    "false",
    "no",
}


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

# Messages.app exposes one service per transport. "iMessage" is Apple's own
# blue-bubble network; "SMS" is the green-bubble relay through the paired
# iPhone and only exists when Text Message Forwarding is enabled on that phone.
_SERVICE_APPLESCRIPT = {"imessage": "iMessage", "sms": "SMS"}
# Messages records RCS under its own service name but it is reached through the
# same SMS relay, so both map back to the "sms" plan step.
_SMS_LIKE_SERVICES = {"sms", "rcs"}

DELIVERY_CONFIRMED = "delivered"
DELIVERY_FAILED = "failed"
DELIVERY_PENDING = "pending"


def _phone_candidates(phone: str) -> list[str]:
    """E.164 first, then the digits-only buddy forms Messages also accepts."""
    raw = "".join(ch for ch in phone if ch.isdigit() or ch == "+")
    digits = "".join(ch for ch in phone if ch.isdigit())
    candidates: list[str] = []
    for candidate in (raw, digits, f"+{digits}" if digits else None):
        if candidate and candidate not in candidates:
            candidates.append(candidate)
    return candidates


def _run_osascript(script: str, timeout: int = 30) -> tuple[str, str]:
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return (result.stdout or "").strip(), (result.stderr or "").strip()
    except (subprocess.SubprocessError, OSError) as exc:
        return "", str(exc)


def messages_service_available(service: str) -> bool:
    """Is this transport usable right now?

    A missing SMS service means Text Message Forwarding is off on the paired
    iPhone; no amount of AppleScript can green-bubble a message without it.
    """
    term = _SERVICE_APPLESCRIPT[service]
    out, _ = _run_osascript(
        f'tell application "Messages" to return '
        f'(count of (every service whose service type = {term})) as text'
    )
    try:
        return int(out) > 0
    except ValueError:
        return False


def _applescript_send(phone: str, body: str, service: str) -> tuple[bool, str | None]:
    """Hand one message to Messages.app over ``service``.

    Success here only means Messages *accepted* the message. It is not delivery:
    an iMessage to a non-iMessage number is accepted and then quietly turns into
    a "Not Delivered" bubble, which is what ``_await_delivery`` exists to catch.
    """
    escaped_body = body.replace("\\", "\\\\").replace('"', '\\"')
    term = _SERVICE_APPLESCRIPT[service]
    last_error = "unknown osascript failure"
    for candidate in _phone_candidates(phone):
        escaped_phone = candidate.replace("\\", "\\\\").replace('"', '\\"')
        script = f'''
        tell application "Messages"
            set svcList to (every service whose service type = {term})
            if (count of svcList) is 0 then return "error: no {term} service"
            set targetService to item 1 of svcList
            try
                set targetBuddy to buddy "{escaped_phone}" of targetService
                send "{escaped_body}" to targetBuddy
                return "sent"
            on error errMsg
                return "error: " & errMsg
            end try
        end tell
        '''
        out, err = _run_osascript(script)
        if out == "sent":
            return True, None
        last_error = out or err or "unknown osascript failure"
    return False, last_error


# --- delivery verification ------------------------------------------------

def _chat_db_connect() -> sqlite3.Connection | None:
    if sys.platform != "darwin" or not CHAT_DB.exists():
        return None
    try:
        return sqlite3.connect(f"file:{CHAT_DB}?mode=ro", uri=True)
    except sqlite3.Error:
        return None


def _chat_db_max_rowid() -> int | None:
    """Watermark taken before a send so we only inspect rows we created."""
    conn = _chat_db_connect()
    if conn is None:
        return None
    try:
        row = conn.execute("SELECT COALESCE(MAX(ROWID), 0) FROM message").fetchone()
        return int(row[0]) if row else 0
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def _find_outbound_row(
    conn: sqlite3.Connection, phone_key: str, after_rowid: int
) -> tuple[str, int, int, int] | None:
    """Newest outbound row to ``phone_key`` past the watermark."""
    cursor = conn.execute(
        """
        SELECT m.service, m.is_sent, m.is_delivered, m.error, h.id
        FROM message m
        JOIN handle h ON h.ROWID = m.handle_id
        WHERE m.is_from_me = 1 AND m.ROWID > ?
        ORDER BY m.ROWID DESC
        LIMIT 50
        """,
        (after_rowid,),
    )
    for service, is_sent, is_delivered, error, handle in cursor:
        if _normalize_phone(str(handle or "")) == phone_key:
            return (
                str(service or ""),
                int(is_sent or 0),
                int(is_delivered or 0),
                int(error or 0),
            )
    return None


def _await_delivery(
    phone: str,
    after_rowid: int | None,
    timeout: float = SEND_VERIFY_SECONDS,
    poll: float = SEND_VERIFY_POLL_SECONDS,
) -> tuple[str, str | None, str | None]:
    """Watch chat.db for the verdict on the row we just created.

    Returns (state, detail, service). Only a non-zero ``error`` column is
    treated as failure: iMessage delivery receipts can lag, and SMS never sets
    ``is_delivered`` at all, so a quiet row at timeout is PENDING rather than
    failed. That asymmetry keeps a slow-but-fine send from being re-sent.
    """
    phone_key = _normalize_phone(phone)
    if not phone_key or after_rowid is None:
        return DELIVERY_PENDING, "delivery unverified (chat.db unavailable)", None

    deadline = time.monotonic() + timeout
    seen_service: str | None = None
    while True:
        conn = _chat_db_connect()
        if conn is None:
            return DELIVERY_PENDING, "delivery unverified (chat.db unreadable)", None
        try:
            found = _find_outbound_row(conn, phone_key, after_rowid)
        except sqlite3.Error as exc:
            return DELIVERY_PENDING, f"delivery unverified ({exc})", None
        finally:
            conn.close()

        if found:
            service, is_sent, is_delivered, error = found
            seen_service = service or seen_service
            if error:
                return DELIVERY_FAILED, f"{service or 'unknown'} error={error}", service
            if service.lower() in _SMS_LIKE_SERVICES and is_sent:
                return DELIVERY_CONFIRMED, None, service
            if is_delivered:
                return DELIVERY_CONFIRMED, None, service

        if time.monotonic() >= deadline:
            return DELIVERY_PENDING, None, seen_service
        time.sleep(poll)


def _preferred_service(phone: str) -> str | None:
    """Transport that last worked for this number, learned from chat.db.

    Lets a known SMS-only number skip the doomed iMessage attempt (and its
    ~45s verification wait) on every later step of the sequence.
    """
    phone_key = _normalize_phone(phone)
    conn = _chat_db_connect()
    if not phone_key or conn is None:
        return None
    try:
        cursor = conn.execute(
            """
            SELECT m.service, h.id
            FROM message m
            JOIN handle h ON h.ROWID = m.handle_id
            WHERE m.is_from_me = 1 AND m.is_sent = 1 AND m.error = 0
            ORDER BY m.ROWID DESC
            LIMIT 400
            """
        )
        for service, handle in cursor:
            if _normalize_phone(str(handle or "")) == phone_key:
                name = str(service or "").lower()
                if name in _SMS_LIKE_SERVICES:
                    return "sms"
                if name == "imessage":
                    return "imessage"
        return None
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def send_text(phone: str, body: str) -> tuple[bool, str | None, str | None]:
    """Send one outreach text and confirm it actually left. Returns (ok, error, service).

    Tries at most two transports — the one history says works for this number
    (default iMessage), then SMS if iMessage came back Not Delivered — so a
    single queue item can never loop.
    """
    preferred = _preferred_service(phone) or "imessage"
    plan = [preferred]
    if preferred == "imessage" and SMS_FALLBACK_ENABLED:
        plan.append("sms")

    problems: list[str] = []
    for service in plan:
        if service == "sms" and not messages_service_available("sms"):
            problems.append(
                "no SMS service — enable Text Message Forwarding for this Mac on "
                "the paired iPhone (Settings → Messages → Text Message Forwarding)"
            )
            break

        watermark = _chat_db_max_rowid()
        accepted, error = _applescript_send(phone, body, service)
        if not accepted:
            problems.append(f"{service}: {error}")
            continue

        state, detail, actual = _await_delivery(phone, watermark)
        if state == DELIVERY_FAILED:
            problems.append(f"{service}: not delivered ({detail})")
            continue
        if state == DELIVERY_PENDING and detail:
            # Verification unavailable (usually chat.db/TCC). Trust the accept
            # rather than re-sending blind and double-texting the contact.
            logger.warning("send to %s: %s", phone, detail)
        return True, None, (actual or service)

    return False, "; ".join(problems) or "unknown send failure", None


def send_imessage(phone: str, body: str) -> tuple[bool, str | None]:
    """Back-compat shim for callers that predate the SMS fallback."""
    ok, error, _service = send_text(phone, body)
    return ok, error


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
        ok, error, service = send_text(str(message["phone"]), str(message["body"]))
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
            f"sent via {service}" if ok else "FAILED",
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


# typedstream encodes an integer as one byte, or a marker byte followed by a
# little-endian width: 0x81 → 2 bytes, 0x82 → 4, 0x83 → 8.
_TYPEDSTREAM_INT_WIDTHS = {0x81: 2, 0x82: 4, 0x83: 8}


def _decode_attributed_body(blob: object) -> str:
    """Extract the plain body from a Messages ``attributedBody`` blob.

    Current macOS leaves ``message.text`` NULL and archives the body only in
    ``attributedBody`` (an NSArchiver "streamtyped" blob), so a NULL-text row is
    a real message rather than an empty one. The layout is the ``NSString``
    class name, a short type tag ending in ``+``, then a length-prefixed UTF-8
    payload; anything unparseable yields "" and is skipped as non-substantive.
    """
    if not blob:
        return ""
    try:
        data = bytes(blob)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return ""

    marker = data.find(b"NSString")
    if marker < 0:
        return ""
    # Scan a short window for the tag terminator so a tag tweak in a future
    # macOS release degrades to "skipped", never to a crash.
    tag = data.find(b"+", marker, marker + 16)
    if tag < 0:
        return ""

    cursor = tag + 1
    if cursor >= len(data):
        return ""
    length = data[cursor]
    cursor += 1
    width = _TYPEDSTREAM_INT_WIDTHS.get(length)
    if width is not None:
        length = int.from_bytes(data[cursor : cursor + width], "little")
        cursor += width
    if length <= 0 or cursor + length > len(data):
        return ""
    return data[cursor : cursor + length].decode("utf-8", errors="replace")


def _chat_db_has_attributed_body(conn: sqlite3.Connection) -> bool:
    try:
        return any(
            row[1] == "attributedBody"
            for row in conn.execute("PRAGMA table_info(message)")
        )
    except sqlite3.Error:
        return False


def scan_chat_db(watch_phones: set[str]) -> int:
    """Post inbound texts from watched numbers. Returns count posted."""
    if sys.platform != "darwin" or not CHAT_DB.exists():
        return 0
    if not watch_phones:
        # An empty watchlist disables inbound texts wholesale, and the only way
        # that happens legitimately is "nobody is enrolled with a phone".
        logger.warning("chat.db scan skipped — watchlist is empty")
        return 0
    crm = _crm()
    if not crm:
        return 0
    base, key = crm

    state = _load_state()
    last_rowid = int(state.get("chat_last_rowid") or 0)

    try:
        conn = sqlite3.connect(f"file:{CHAT_DB}?mode=ro", uri=True)
        if _chat_db_has_attributed_body(conn):
            body_column = "m.attributedBody"
            body_filter = "(m.text IS NOT NULL OR m.attributedBody IS NOT NULL)"
        else:
            body_column = "NULL"
            body_filter = "m.text IS NOT NULL"
        cursor = conn.execute(
            f"""
            SELECT m.ROWID, m.guid, m.text, m.date, m.is_from_me, h.id, {body_column}
            FROM message m
            JOIN handle h ON h.ROWID = m.handle_id
            WHERE m.ROWID > ? AND {body_filter}
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
        logger.info(
            "chat.db scan: no new rows past rowid=%d (%d number(s) watched)",
            last_rowid,
            len(watch_phones),
        )
        return 0

    inbound = []
    max_rowid = last_rowid
    for rowid, guid, text, apple_date, is_from_me, handle, attributed_body in rows:
        max_rowid = max(max_rowid, int(rowid))
        # Filter self-sent messages — otherwise our own outbound texts loop
        # back as "replies".
        if is_from_me:
            continue
        body = str(text) if text else _decode_attributed_body(attributed_body)
        if not _is_substantive_imessage_text(body):
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
                "body": body,
                "external_id": f"chatdb:{guid}",
                "received_at": received.isoformat(),
            }
        )

    logger.info(
        "chat.db scan: %d row(s) past rowid=%d, %d inbound from %d watched number(s)",
        len(rows),
        last_rowid,
        len(inbound),
        len(watch_phones),
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
        # Without this the pump looks healthy while ingesting nothing: an empty
        # watchlist makes scan_chat_db a no-op.
        logger.warning(
            "watchlist unavailable — CRM_API_URL/CRM_API_KEY unset "
            "(load_worker_env() not called?)"
        )
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
