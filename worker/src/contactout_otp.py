from __future__ import annotations

import email
import imaplib
import logging
import os
import re
import time
from email.header import decode_header

logger = logging.getLogger(__name__)

OTP_RE = re.compile(r"\b(\d{6})\b")


def _decode_header(value: str | None) -> str:
    if not value:
        return ""
    parts = decode_header(value)
    out: list[str] = []
    for chunk, enc in parts:
        if isinstance(chunk, bytes):
            out.append(chunk.decode(enc or "utf-8", errors="replace"))
        else:
            out.append(chunk)
    return "".join(out)


def fetch_contactout_otp(
    *,
    wait_sec: int = 90,
    poll_interval: float = 5.0,
) -> str | None:
    """Read a 6-digit ContactOut verification code from IMAP inbox."""
    host = os.environ.get("CONTACTOUT_OTP_IMAP_HOST", "imap.gmail.com").strip()
    user = os.environ.get("CONTACTOUT_OTP_IMAP_USER", "").strip()
    password = os.environ.get("CONTACTOUT_OTP_IMAP_PASSWORD", "").strip()
    mailbox = os.environ.get("CONTACTOUT_OTP_IMAP_MAILBOX", "INBOX").strip()
    from_filter = os.environ.get("CONTACTOUT_OTP_FROM_FILTER", "contactout").strip().lower()

    if not user or not password:
        logger.debug("CONTACTOUT_OTP_IMAP_USER/PASSWORD not set — skipping OTP fetch")
        return None

    deadline = time.time() + wait_sec
    seen_uids: set[bytes] = set()

    while time.time() < deadline:
        try:
            mail = imaplib.IMAP4_SSL(host)
            mail.login(user, password)
            mail.select(mailbox)
            _, data = mail.search(None, "UNSEEN")
            uids = data[0].split() if data and data[0] else []
            for uid in reversed(uids[-10:]):
                if uid in seen_uids:
                    continue
                seen_uids.add(uid)
                _, msg_data = mail.fetch(uid, "(RFC822)")
                if not msg_data or not msg_data[0]:
                    continue
                raw = msg_data[0][1]
                if not isinstance(raw, bytes):
                    continue
                msg = email.message_from_bytes(raw)
                from_addr = _decode_header(msg.get("From")).lower()
                subject = _decode_header(msg.get("Subject")).lower()
                if from_filter and from_filter not in from_addr and from_filter not in subject:
                    continue
                body_parts: list[str] = []
                if msg.is_multipart():
                    for part in msg.walk():
                        if part.get_content_type() == "text/plain":
                            payload = part.get_payload(decode=True)
                            if isinstance(payload, bytes):
                                body_parts.append(payload.decode("utf-8", errors="replace"))
                else:
                    payload = msg.get_payload(decode=True)
                    if isinstance(payload, bytes):
                        body_parts.append(payload.decode("utf-8", errors="replace"))
                text = "\n".join(body_parts)
                match = OTP_RE.search(text) or OTP_RE.search(subject)
                if match:
                    code = match.group(1)
                    logger.info("ContactOut OTP found in email")
                    mail.logout()
                    return code
            mail.logout()
        except Exception as exc:
            logger.debug("IMAP OTP poll: %s", exc)
        time.sleep(poll_interval)

    return None
