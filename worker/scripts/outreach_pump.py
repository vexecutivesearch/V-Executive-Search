#!/usr/bin/env python3
"""Outreach worker pump — runs each poll tick (every 5 min via launchd poll).

Four jobs, all idempotent and independently non-fatal:
  1. Pending re-check — finish verifying iMessage sends from earlier ticks that
     had no delivery receipt yet, retrying once over SMS when Apple's own IDS
     registry says the handle cannot take an iMessage. (macOS only)
  2. Text sends      — poll /api/outreach/imessage-queue, send via Messages.app
     AppleScript, confirm delivery in chat.db, fall back to green-bubble SMS
     when iMessage cannot deliver, post statuses back. (macOS only)
  3. chat.db scan    — inbound texts from enrolled numbers since the last
     scanned ROWID, self-sent messages filtered (is_from_me), posted to
     /api/outreach/inbound. (macOS only)
  4. IMAP poll       — new mail in the Reply-To mailbox posted to
     /api/outreach/inbound with In-Reply-To for threading. (any OS)

State (last chat.db rowid, last IMAP UID, sends awaiting a delivery verdict)
lives in ~/.vsearch/outreach_state.json so release swaps never re-ingest history
(the CRM also dedupes on external_id).

Env:
  OUTREACH_TRANSPORT_RESET — comma-separated numbers (or "all") to forget the
    learned transport AND the IDS capability shortcut for, so the next send
    replays the whole iMessage → SMS ladder
  OUTREACH_SEND_VERIFY_SECONDS — inline confirm window per send (default 20)
  OUTREACH_PENDING_GRACE_SECONDS / OUTREACH_PENDING_MAX_AGE_SECONDS — bounds on
    the asynchronous re-check
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
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, NamedTuple

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
# identityservicesd's cache of every "can this address take an iMessage" lookup
# Messages has performed. The only trustworthy capability signal on the box.
IDS_QUERY_DB = Path.home() / "Library" / "IdentityServices" / "ids-query.db"
SEND_DELAY_SECONDS = float(os.environ.get("OUTREACH_IMESSAGE_DELAY", "4"))
# Inline confirm window: how long a send waits for its delivery receipt before
# handing the verdict to the asynchronous re-check. Delivery receipts on this Mac
# land in under a second (93 receipts: p50 0.39s, p90 0.98s, max 5.08s), so 20s
# is ~4x the worst case observed and still keeps a poll tick short.
SEND_VERIFY_SECONDS = float(os.environ.get("OUTREACH_SEND_VERIFY_SECONDS", "20"))
SEND_VERIFY_POLL_SECONDS = float(os.environ.get("OUTREACH_SEND_VERIFY_POLL", "3"))
# A row younger than this is never called failed by the async re-check, so a
# receipt still in flight can't trigger a retry. Far above the 5.08s worst case.
PENDING_GRACE_SECONDS = float(os.environ.get("OUTREACH_PENDING_GRACE_SECONDS", "120"))
# Hard stop on re-checking. Past this a send is reported for what it is instead
# of being watched forever.
PENDING_MAX_AGE_SECONDS = float(
    os.environ.get("OUTREACH_PENDING_MAX_AGE_SECONDS", "3600")
)
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
# Messages itself gave up on iMessage and re-sent the row over SMS. The contact
# already has the text, so this is a success — and must never look like a fresh
# failure, or the re-check would text them a second time.
DELIVERY_DOWNGRADED = "downgraded"

CAPABILITY_CAPABLE = "capable"
CAPABILITY_INCAPABLE = "incapable"
CAPABILITY_UNKNOWN = "unknown"

# The IDS service name for iMessage. identityservicesd keys its lookup cache by
# service, and every other name in there is FaceTime/Continuity plumbing.
_IMESSAGE_IDS_SERVICE = "com.apple.madrid"
# ZIDSQUERYSDSTATUS.ZSTATUS observed on this Mac: 1 for a handle IDS resolved to
# an Apple account, 2 for one it could not. Anything else is treated as unknown.
_IDS_STATUS_REGISTERED = 1
_IDS_STATUS_NOT_REGISTERED = 2


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


# --- iMessage capability (Apple's own IDS registry) -----------------------

_capability_warned = False


def _capability_unavailable(reason: str) -> str:
    """UNKNOWN, said out loud once.

    Losing this store is not fatal — sends fall back to iMessage-first — but it
    silently removes the only signal that can tell "no Apple account" from
    "iMessage that will arrive later", which is what authorises the SMS retry.
    """
    global _capability_warned
    if not _capability_warned:
        _capability_warned = True
        logger.warning(
            "IDS capability lookup unavailable (%s) — sends will try iMessage "
            "first and the SMS retry can no longer be triggered automatically",
            reason,
        )
    return CAPABILITY_UNKNOWN


def imessage_capability(phone: str) -> str:
    """Can this number take an iMessage at all? Reads Apple's IDS lookup cache.

    Messages resolves capability asynchronously through IDS and exposes no
    synchronous AppleScript equivalent, but identityservicesd persists every
    answer in ~/Library/IdentityServices/ids-query.db. For the iMessage service
    (``com.apple.madrid``) a resolvable handle gets a ZIDSQUERYSDADDRESSABLE row
    and ZIDSQUERYSDSTATUS.ZSTATUS = 1; an unresolvable one gets ZSTATUS = 2 and
    never becomes addressable.

    On the release Mac that split is exact: the four numbers with delivered blue
    bubbles all read addressable/1, and the three with no Apple account all read
    2 — including +1786…3193, whose iMessage had to be downgraded by hand.

    Positive evidence wins over negative so a stale "not registered" row can
    never divert a number that genuinely is on iMessage, and every failure
    (missing file, renamed Core Data table, unreadable) returns UNKNOWN, which
    sends exactly as it did before this lookup existed.
    """
    phone_key = _normalize_phone(phone)
    if sys.platform != "darwin" or not phone_key:
        return CAPABILITY_UNKNOWN
    if not IDS_QUERY_DB.exists():
        return _capability_unavailable(f"{IDS_QUERY_DB} is missing")
    try:
        conn = sqlite3.connect(f"file:{IDS_QUERY_DB}?mode=ro", uri=True)
    except sqlite3.Error as exc:
        return _capability_unavailable(str(exc))
    try:
        for uri, in conn.execute(
            "SELECT ZURI FROM ZIDSQUERYSDADDRESSABLE WHERE ZSERVICE = ?",
            (_IMESSAGE_IDS_SERVICE,),
        ):
            if _normalize_phone(str(uri or "")) == phone_key:
                return CAPABILITY_CAPABLE
        verdict = CAPABILITY_UNKNOWN
        for uri, status in conn.execute(
            "SELECT ZURI, ZSTATUS FROM ZIDSQUERYSDSTATUS WHERE ZSERVICE = ?",
            (_IMESSAGE_IDS_SERVICE,),
        ):
            if _normalize_phone(str(uri or "")) != phone_key:
                continue
            if status == _IDS_STATUS_REGISTERED:
                return CAPABILITY_CAPABLE
            if status == _IDS_STATUS_NOT_REGISTERED:
                verdict = CAPABILITY_INCAPABLE
        return verdict
    except sqlite3.Error as exc:
        return _capability_unavailable(str(exc))
    finally:
        conn.close()


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


# Columns the verdict is read from. Selected defensively because chat.db grows
# columns between macOS releases and the test fixtures build a minimal table.
_OUTBOUND_COLUMNS = (
    "service",
    "is_sent",
    "is_delivered",
    "error",
    "was_downgraded",
    "date_delivered",
    "date_read",
)


def _outbound_projection(conn: sqlite3.Connection) -> tuple[str, bool]:
    """SELECT list for _OUTBOUND_COLUMNS, plus "are receipt timestamps here".

    Absent columns come back as NULL so one query shape works on every schema.
    """
    try:
        present = {row[1] for row in conn.execute("PRAGMA table_info(message)")}
    except sqlite3.Error:
        present = set()
    projection = ", ".join(
        f"m.{name}" if name in present else f"NULL AS {name}"
        for name in _OUTBOUND_COLUMNS
    )
    return projection, "date_delivered" in present


def _row_status(row: tuple, receipts_tracked: bool) -> dict[str, Any]:
    rowid, service, is_sent, is_delivered, error, downgraded, delivered_at, read_at = (
        row[:8]
    )
    return {
        "rowid": int(rowid),
        "service": str(service or ""),
        "is_sent": int(is_sent or 0),
        "is_delivered": int(is_delivered or 0),
        "error": int(error or 0),
        "was_downgraded": int(downgraded or 0),
        "date_delivered": int(delivered_at or 0),
        "date_read": int(read_at or 0),
        "receipts_tracked": receipts_tracked,
    }


def _find_outbound_row(
    conn: sqlite3.Connection, phone_key: str, after_rowid: int
) -> dict[str, Any] | None:
    """Newest outbound row to ``phone_key`` past the watermark."""
    projection, receipts_tracked = _outbound_projection(conn)
    cursor = conn.execute(
        f"""
        SELECT m.ROWID, {projection}, h.id
        FROM message m
        JOIN handle h ON h.ROWID = m.handle_id
        WHERE m.is_from_me = 1 AND m.ROWID > ?
        ORDER BY m.ROWID DESC
        LIMIT 50
        """,
        (after_rowid,),
    )
    for row in cursor:
        if _normalize_phone(str(row[-1] or "")) == phone_key:
            return _row_status(row, receipts_tracked)
    return None


def _read_outbound_row(
    conn: sqlite3.Connection, rowid: int
) -> dict[str, Any] | None:
    """Re-read one pinned row. Messages rewrites rows in place, so the ROWID
    recorded at send time still identifies the same message after a downgrade."""
    projection, receipts_tracked = _outbound_projection(conn)
    row = conn.execute(
        f"""
        SELECT m.ROWID, {projection}, m.handle_id
        FROM message m
        WHERE m.ROWID = ? AND m.is_from_me = 1
        """,
        (rowid,),
    ).fetchone()
    return _row_status(row, receipts_tracked) if row else None


def _classify_outbound(status: dict[str, Any], sent_via: str) -> tuple[str, str | None]:
    """Turn one chat.db row into a delivery verdict. Returns (state, detail).

    ``is_delivered`` is deliberately not trusted for iMessage: all 95 outbound
    iMessage rows on this Mac carry ``is_delivered = 1``, including two that were
    never delivered, so the flag cannot distinguish them. ``date_delivered`` can
    — it is set on all 93 real receipts and NULL on both failures. Likewise
    ``error`` has never been non-zero in 210 rows, so it is kept only as a
    belt-and-braces check rather than the primary signal.
    """
    service = status["service"].lower()
    if status["error"]:
        return DELIVERY_FAILED, f"{service or 'unknown'} error={status['error']}"
    # An iMessage row whose service has flipped to SMS is the in-place rewrite
    # Messages performs when it gives up on the blue bubble.
    if status["was_downgraded"] or (
        sent_via == "imessage" and service in _SMS_LIKE_SERVICES
    ):
        return DELIVERY_DOWNGRADED, "Messages re-sent it over SMS itself"
    if service in _SMS_LIKE_SERVICES:
        # SMS gets no delivery receipt at all — handing it to the relay is as
        # much confirmation as exists.
        return (DELIVERY_CONFIRMED, None) if status["is_sent"] else (DELIVERY_PENDING, None)
    if status["date_delivered"] or status["date_read"]:
        return DELIVERY_CONFIRMED, None
    if not status["receipts_tracked"] and status["is_delivered"]:
        # Schema too old to carry receipt timestamps; the flag is all there is.
        return DELIVERY_CONFIRMED, None
    return DELIVERY_PENDING, None


class Verdict(NamedTuple):
    state: str
    detail: str | None
    service: str | None
    rowid: int | None


def _await_delivery(
    phone: str,
    after_rowid: int | None,
    sent_via: str = "imessage",
    timeout: float | None = None,
    poll: float | None = None,
) -> Verdict:
    """Watch chat.db for the verdict on the row we just created.

    Returns as soon as there is one. A quiet iMessage row is only called failed
    when IDS says the handle has no Apple account — the send itself triggers that
    lookup, so the answer is usually cached within a second or two. Without that
    corroboration a quiet row stays PENDING and is handed to the asynchronous
    re-check, because a receipt-less iMessage to a real Apple account (phone off,
    no signal) will still arrive and re-sending it would double-text the contact.
    """
    phone_key = _normalize_phone(phone)
    if not phone_key or after_rowid is None:
        return Verdict(
            DELIVERY_PENDING, "delivery unverified (chat.db unavailable)", None, None
        )

    # Read the window off the module at call time, not as a default argument, so
    # it stays overridable.
    timeout = SEND_VERIFY_SECONDS if timeout is None else timeout
    poll = SEND_VERIFY_POLL_SECONDS if poll is None else poll
    deadline = time.monotonic() + timeout
    seen_service: str | None = None
    seen_rowid: int | None = None
    while True:
        conn = _chat_db_connect()
        if conn is None:
            return Verdict(
                DELIVERY_PENDING, "delivery unverified (chat.db unreadable)", None, None
            )
        try:
            status = _find_outbound_row(conn, phone_key, after_rowid)
        except sqlite3.Error as exc:
            return Verdict(DELIVERY_PENDING, f"delivery unverified ({exc})", None, None)
        finally:
            conn.close()

        if status:
            seen_service = status["service"] or seen_service
            seen_rowid = status["rowid"]
            state, detail = _classify_outbound(status, sent_via)
            if state != DELIVERY_PENDING:
                return Verdict(state, detail, status["service"], seen_rowid)
            if sent_via == "imessage" and (
                imessage_capability(phone) == CAPABILITY_INCAPABLE
            ):
                return Verdict(
                    DELIVERY_FAILED,
                    "no iMessage account for this number (IDS)",
                    status["service"],
                    seen_rowid,
                )

        if time.monotonic() >= deadline:
            return Verdict(DELIVERY_PENDING, None, seen_service, seen_rowid)
        time.sleep(poll)


def _transport_reset_numbers() -> set[str]:
    """Numbers whose learned transport is ignored, from OUTREACH_TRANSPORT_RESET.

    Comma-separated numbers, or "all"/"*" for every number. The learned
    transport lives nowhere but chat.db, so without this the only way to make a
    number behave as if it had never been texted is to delete its Messages
    conversation — which throws away the delivery history the send path reads.
    """
    raw = (os.environ.get("OUTREACH_TRANSPORT_RESET") or "").strip()
    if not raw:
        return set()
    if raw.lower() in {"all", "*"}:
        return {"*"}
    return {key for key in (_normalize_phone(part) for part in raw.split(",")) if key}


def _transport_reset(phone: str) -> bool:
    reset = _transport_reset_numbers()
    return bool(reset) and ("*" in reset or _normalize_phone(phone) in reset)


def _preferred_service(phone: str) -> str | None:
    """Transport that last worked for this number, learned from chat.db.

    Lets a known SMS-only number skip the doomed iMessage attempt (and its
    verification wait) on every later step of the sequence.
    """
    phone_key = _normalize_phone(phone)
    if _transport_reset(phone):
        logger.info("transport reset for %s — starting from iMessage", phone)
        return None
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


NO_SMS_SERVICE = (
    "no SMS service — enable Text Message Forwarding for this Mac on the paired "
    "iPhone (Settings → Messages → Text Message Forwarding)"
)


class SendResult(NamedTuple):
    ok: bool
    error: str | None
    service: str | None
    #: Set when the send was accepted but has no delivery verdict yet. The caller
    #: persists it so a later tick can finish the job — see
    #: resolve_pending_text_sends().
    pending: dict[str, Any] | None = None


def _send_plan(phone: str) -> list[str]:
    """Transports to try, best-first.

    Order of authority: an explicit transport reset (replay the whole ladder),
    then Apple's IDS registry (a number with no Apple account skips the blue
    bubble entirely — nothing to fall back from), then the transport chat.db says
    last worked, then plain iMessage-first with SMS behind it.
    """
    if _transport_reset(phone):
        return ["imessage", "sms"] if SMS_FALLBACK_ENABLED else ["imessage"]

    if imessage_capability(phone) == CAPABILITY_INCAPABLE:
        logger.info("%s has no iMessage account (IDS) — sending as SMS", phone)
        return ["sms"] if SMS_FALLBACK_ENABLED else ["imessage"]

    preferred = _preferred_service(phone) or "imessage"
    if preferred == "imessage" and SMS_FALLBACK_ENABLED:
        return ["imessage", "sms"]
    return [preferred]


def send_text(phone: str, body: str) -> SendResult:
    """Send one outreach text and confirm it actually left.

    Tries at most two transports — the one history and IDS say should work
    (default iMessage), then SMS if iMessage provably cannot deliver — so a
    single queue item can never loop. A send that is accepted but still has no
    receipt when the confirm window closes comes back ok with ``pending`` set,
    never re-sent inline: blocking a poll tick for minutes is not an option and
    re-sending on a hunch double-texts people.
    """
    problems: list[str] = []
    for service in _send_plan(phone):
        if service == "sms" and not messages_service_available("sms"):
            problems.append(NO_SMS_SERVICE)
            break

        watermark = _chat_db_max_rowid()
        accepted, error = _applescript_send(phone, body, service)
        if not accepted:
            problems.append(f"{service}: {error}")
            continue

        verdict = _await_delivery(phone, watermark, sent_via=service)
        if verdict.state == DELIVERY_FAILED:
            problems.append(f"{service}: not delivered ({verdict.detail})")
            continue
        if verdict.state == DELIVERY_DOWNGRADED:
            # Messages beat us to it; the contact has the text as SMS already.
            logger.info("send to %s: %s", phone, verdict.detail)
            return SendResult(True, None, "SMS")
        if verdict.state == DELIVERY_PENDING and verdict.detail:
            # Verification unavailable (usually chat.db/TCC). Trust the accept
            # rather than re-sending blind and double-texting the contact.
            logger.warning("send to %s: %s", phone, verdict.detail)
            return SendResult(True, None, verdict.service or service)

        pending = None
        if verdict.state == DELIVERY_PENDING and service == "imessage":
            if verdict.rowid is None:
                # No row to pin means no way to re-examine this exact send, and a
                # re-check that guesses which row is ours could retry the wrong
                # message. Trust the accept instead.
                logger.warning(
                    "send to %s accepted but no chat.db row to verify", phone
                )
            else:
                pending = {
                    "phone": phone,
                    "body": body,
                    "rowid": verdict.rowid,
                    "sent_at": time.time(),
                    "sms_retried": False,
                }
                logger.info(
                    "send to %s has no delivery receipt yet — re-checking rowid %d "
                    "on a later tick",
                    phone,
                    verdict.rowid,
                )
        return SendResult(True, None, verdict.service or service, pending)

    return SendResult(False, "; ".join(problems) or "unknown send failure", None)


def send_imessage(phone: str, body: str) -> tuple[bool, str | None]:
    """Back-compat shim for callers that predate the SMS fallback."""
    result = send_text(phone, body)
    return result.ok, result.error


def _post_send_results(
    base: str, key: str, results: list[dict[str, Any]]
) -> bool:
    if not results:
        return True
    try:
        requests.post(
            f"{base}/api/outreach/imessage-queue",
            headers=_headers(key),
            json={"results": results},
            timeout=30,
        ).raise_for_status()
        return True
    except requests.RequestException as exc:
        logger.warning("imessage status post failed: %s", exc)
        return False


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
        message_id = str(message["id"])
        result = send_text(str(message["phone"]), str(message["body"]))
        if result.pending:
            # Recorded before the status post so a crash in between leaves the
            # send re-checkable rather than silently accepted.
            _remember_pending_send(message_id, result.pending)
        results.append(
            {
                "id": message_id,
                # Reported sent so the queue does not serve it again — a second
                # GET would re-send it, and the transport is corrected later by
                # resolve_pending_text_sends() if the receipt never lands.
                "status": "sent" if result.ok else "failed",
                **({"transport": result.service} if result.ok and result.service else {}),
                **({"error": result.error} if result.error else {}),
            }
        )
        logger.info(
            "outreach text %s → %s%s",
            message_id,
            f"sent via {result.service}" if result.ok else "FAILED",
            f" ({result.error})" if result.error else "",
        )
        time.sleep(SEND_DELAY_SECONDS)

    _post_send_results(base, key, results)
    return len(results)


# --- asynchronous delivery re-check ---------------------------------------

PENDING_STATE_KEY = "pending_text_verifications"


def _read_pending() -> dict[str, Any]:
    """Pending records from the state file, ignoring anything malformed.

    The state file outlives releases, so a shape written by another version must
    degrade to "nothing pending" rather than break the whole pump stage.
    """
    raw = _load_state().get(PENDING_STATE_KEY)
    if not isinstance(raw, dict):
        return {}
    return {
        str(key): value
        for key, value in raw.items()
        if isinstance(value, dict) and value.get("rowid") is not None
    }


def _remember_pending_send(message_id: str, record: dict[str, Any]) -> None:
    pending = _read_pending()
    # Keyed by CRM message id, so re-recording the same send overwrites rather
    # than queueing a second re-check for it.
    pending[message_id] = record
    _write_pending(pending)


def _write_pending(pending: dict[str, Any]) -> None:
    state = _load_state()
    state[PENDING_STATE_KEY] = pending
    _save_state(state)


def _pending_verdict(record: dict[str, Any], now: float) -> tuple[str, str | None]:
    """Re-examine one pinned row. Returns (state, detail).

    Never returns FAILED for a row that Messages has already downgraded, and
    never before the grace period, so an in-flight receipt cannot be mistaken for
    a failure. FAILED additionally requires IDS to say the number has no Apple
    account: without that corroboration a receipt-less iMessage may simply be
    waiting for a phone to come back online, and texting again would duplicate it.
    """
    conn = _chat_db_connect()
    if conn is None:
        return DELIVERY_PENDING, "chat.db unreadable"
    try:
        status = _read_outbound_row(conn, int(record["rowid"]))
    except (sqlite3.Error, KeyError, TypeError, ValueError) as exc:
        return DELIVERY_PENDING, f"row unreadable ({exc})"
    finally:
        conn.close()

    if status is None:
        # Conversation deleted, or history trimmed. No evidence either way, so
        # do not send anything.
        return DELIVERY_CONFIRMED, "row no longer in chat.db — leaving as sent"

    state, detail = _classify_outbound(status, "imessage")
    if state != DELIVERY_PENDING:
        return state, detail
    if now - float(record.get("sent_at") or 0) < PENDING_GRACE_SECONDS:
        return DELIVERY_PENDING, "within grace period"
    if imessage_capability(str(record.get("phone") or "")) == CAPABILITY_INCAPABLE:
        return DELIVERY_FAILED, "no iMessage account for this number (IDS)"
    return DELIVERY_PENDING, "no delivery receipt yet"


def resolve_pending_text_sends() -> int:
    """Finish verifying earlier sends; retry once over SMS. Returns count resolved.

    Runs before new sends each tick so a rescued message goes out promptly. Every
    record leaves this function either resolved (dropped) or older, and a record
    can authorise at most one SMS retry in its whole life, so no contact can be
    texted twice by this path.
    """
    if sys.platform != "darwin":
        return 0
    pending = _read_pending()
    if not pending:
        return 0
    crm = _crm()
    if not crm:
        return 0
    base, key = crm

    now = time.time()
    results: list[dict[str, Any]] = []
    resolved: list[str] = []
    for message_id, record in sorted(pending.items()):
        verdict, detail = _pending_verdict(record, now)
        phone = str(record.get("phone") or "")
        age = now - float(record.get("sent_at") or 0)

        if verdict == DELIVERY_CONFIRMED:
            logger.info("late verify %s: delivered via iMessage", message_id)
            results.append({"id": message_id, "status": "sent", "transport": "imessage",
                            "verification": "late"})
            resolved.append(message_id)
            continue

        if verdict == DELIVERY_DOWNGRADED:
            # Messages already re-sent it as SMS. Sending our own would be the
            # duplicate this whole mechanism exists to avoid.
            logger.info("late verify %s: %s", message_id, detail)
            results.append({"id": message_id, "status": "sent", "transport": "sms",
                            "verification": "late"})
            resolved.append(message_id)
            continue

        if verdict == DELIVERY_FAILED and not record.get("sms_retried"):
            if not messages_service_available("sms") or not SMS_FALLBACK_ENABLED:
                logger.warning("late verify %s: %s", message_id, NO_SMS_SERVICE)
                results.append({"id": message_id, "status": "failed",
                                "error": f"iMessage not delivered; {NO_SMS_SERVICE}",
                                "verification": "late"})
                resolved.append(message_id)
                continue
            # Persist the one-shot flag BEFORE sending: if this process dies mid
            # send the message is left unretried, never retried twice.
            record["sms_retried"] = True
            pending[message_id] = record
            _write_pending(pending)

            accepted, error = _applescript_send(phone, str(record.get("body") or ""), "sms")
            if accepted:
                logger.info("late verify %s: iMessage failed (%s) — re-sent as SMS",
                            message_id, detail)
                results.append({"id": message_id, "status": "sent", "transport": "sms",
                                "verification": "late"})
            else:
                logger.warning("late verify %s: SMS retry rejected: %s", message_id, error)
                results.append({"id": message_id, "status": "failed",
                                "error": f"iMessage not delivered; SMS retry failed: {error}",
                                "verification": "late"})
            resolved.append(message_id)
            continue

        if age >= PENDING_MAX_AGE_SECONDS:
            logger.warning(
                "late verify %s: giving up after %.0f min with no delivery receipt "
                "(%s) — send it by hand if it still matters",
                message_id,
                age / 60,
                detail,
            )
            results.append({"id": message_id, "status": "failed",
                            "error": f"no delivery confirmation after "
                                     f"{age / 60:.0f} min ({detail})",
                            "verification": "late"})
            resolved.append(message_id)
            continue

        logger.info("late verify %s: still pending (%s)", message_id, detail)

    for message_id in resolved:
        pending.pop(message_id, None)
    _write_pending(pending)
    _post_send_results(base, key, results)
    return len(resolved)


# --------------------------------------------------------------------------
# 2. chat.db inbound scan
# --------------------------------------------------------------------------

APPLE_EPOCH_OFFSET = 978_307_200  # 2001-01-01 in unix seconds

# Independent of the rowid watermark: however we got here, a text this old is not
# a reply to anything we are currently sending. Belt and braces, so a corrupted
# or hand-edited watermark can never replay message history into the CRM again.
CHAT_DB_MAX_INBOUND_AGE = timedelta(hours=24)


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
    stored_watermark = state.get("chat_last_rowid")
    if stored_watermark is None:
        # No watermark means a fresh install, a wiped state file, or a promote
        # that did not carry the state across. Scanning from rowid 0 in that
        # situation ingests the entire local Messages history for every watched
        # number as brand new replies: that is how eleven days of personal texts
        # with a test number arrived as answers to outreach that had not been
        # sent yet. Adopt the current maximum instead, so watching starts now and
        # history is left alone.
        baseline = _chat_db_max_rowid() or 0
        state["chat_last_rowid"] = baseline
        _save_state(state)
        logger.warning(
            "chat.db scan: no watermark — baselining at rowid=%d, "
            "existing history will not be ingested",
            baseline,
        )
        return 0
    last_rowid = int(stored_watermark or 0)

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
    stale = 0
    cutoff = datetime.now(tz=timezone.utc) - CHAT_DB_MAX_INBOUND_AGE
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
        if received < cutoff:
            stale += 1
            continue
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
        "chat.db scan: %d row(s) past rowid=%d, %d inbound from %d watched "
        "number(s), %d skipped as older than %s",
        len(rows),
        last_rowid,
        len(inbound),
        len(watch_phones),
        stale,
        CHAT_DB_MAX_INBOUND_AGE,
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
    """Decode a header and undo RFC 5322 folding.

    Long subjects arrive wrapped ("… - 15 Minute\\r\\n Meeting"); leaving the
    newline in breaks every downstream single-line subject match.
    """
    if not value:
        return ""
    parts = email.header.decode_header(value)
    out = []
    for text, charset in parts:
        if isinstance(text, bytes):
            out.append(text.decode(charset or "utf-8", errors="replace"))
        else:
            out.append(text)
    return re.sub(r"\s+", " ", "".join(out)).strip()


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
    """One pump pass. Each stage isolated — a failure never blocks the rest.

    Stage order matters: they share one state file and each reloads it before
    writing, so a stage that writes state must not be followed by one already
    holding a stale snapshot.
    """
    stats = {"texts_resolved": 0, "texts_sent": 0, "texts_in": 0, "emails_in": 0}
    try:
        # First, so a message rescued by the SMS retry leaves on this tick.
        stats["texts_resolved"] = resolve_pending_text_sends()
    except Exception as exc:  # noqa: BLE001
        logger.warning("pending text re-check failed (non-fatal): %s", exc)
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

    # An inbound posted above is classified inline by the CRM, so its
    # auto-reply text is usually queued within seconds. Without a second send
    # pass that reply would sit until the NEXT tick, making the floor for a
    # texted reply one full poll interval (~5 min) and the ceiling two
    # (~10 min — exactly what v12 measured). Re-pump once so a reply earned
    # this tick leaves this tick.
    if stats["texts_in"] or stats["emails_in"]:
        time.sleep(5)  # give the CRM a beat to finish classify + queue
        try:
            followup = pump_imessage_queue()
            if followup:
                logger.info(
                    "same-tick reply pass sent %d text(s) for inbound(s) "
                    "ingested this tick",
                    followup,
                )
            stats["texts_sent"] += followup
        except Exception as exc:  # noqa: BLE001
            logger.warning("same-tick reply pump failed (non-fatal): %s", exc)
    return stats


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    load_worker_env()
    stats = run_outreach_pump()
    logger.info(
        "outreach pump: %d text(s) sent · %d late verif(ies) resolved · "
        "%d text repl(ies) in · %d email repl(ies) in",
        stats["texts_sent"],
        stats["texts_resolved"],
        stats["texts_in"],
        stats["emails_in"],
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
