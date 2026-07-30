"""Outreach pump: chat.db inbound scan filtering + IMAP/phone helpers."""

import importlib.util
import sqlite3
import sys
from pathlib import Path

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))


def _load_pump():
    spec = importlib.util.spec_from_file_location(
        "outreach_pump", WORKER_ROOT / "scripts" / "outreach_pump.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _attributed_body(text: str) -> bytes:
    """A minimal NSArchiver "streamtyped" blob shaped like Messages' column.

    Mirrors the real layout: the ``NSString`` class name, a type tag ending in
    ``+``, then a length-prefixed UTF-8 payload (0x81 + 2 LE bytes past 127).
    """
    payload = text.encode("utf-8")
    length = (
        bytes([len(payload)])
        if len(payload) < 0x80
        else b"\x81" + len(payload).to_bytes(2, "little")
    )
    return (
        b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84"
        b"\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84"
        b"\x08NSString\x01\x94\x84\x01+" + length + payload
    )


def _make_chat_db(path: Path, rows, with_attributed_body: bool = True):
    """Rows are (guid, text, is_from_me, handle[, attributed_body])."""
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT)")
    conn.execute(
        "CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT,"
        " date INTEGER, is_from_me INTEGER, handle_id INTEGER"
        + (", attributedBody BLOB)" if with_attributed_body else ")")
    )
    handles = {}
    for i, row in enumerate(rows, start=1):
        guid, text, is_from_me, handle = row[:4]
        body_blob = row[4] if len(row) > 4 else None
        if handle not in handles:
            handles[handle] = len(handles) + 1
            conn.execute("INSERT INTO handle VALUES (?, ?)", (handles[handle], handle))
        values = [i, guid, text, 700_000_000_000_000_000, is_from_me, handles[handle]]
        if with_attributed_body:
            values.append(body_blob)
        conn.execute(
            f"INSERT INTO message VALUES ({', '.join('?' * len(values))})",
            values,
        )
    conn.commit()
    conn.close()


def test_normalize_phone():
    pump = _load_pump()
    assert pump._normalize_phone("+1 (561) 555-0100") == "5615550100"
    assert pump._normalize_phone("561-555-0100") == "5615550100"
    assert pump._normalize_phone("12345") == ""


def test_is_substantive_imessage_text():
    pump = _load_pump()
    assert pump._is_substantive_imessage_text("Yes, let's talk!")
    assert not pump._is_substantive_imessage_text(None)
    assert not pump._is_substantive_imessage_text("")
    assert not pump._is_substantive_imessage_text("   ")
    assert not pump._is_substantive_imessage_text("￼")
    assert not pump._is_substantive_imessage_text("￼￼  ")
    assert pump._is_substantive_imessage_text("ok ￼")


def test_decode_attributed_body():
    pump = _load_pump()
    assert pump._decode_attributed_body(_attributed_body("Yes, let's talk!")) == (
        "Yes, let's talk!"
    )
    # Past 127 bytes the length switches to the 0x81 + 2-byte form.
    long_reply = "Sounds great — " + "call me anytime. " * 20
    assert pump._decode_attributed_body(_attributed_body(long_reply)) == long_reply
    assert pump._decode_attributed_body(_attributed_body("Nos vemos 🙂")) == (
        "Nos vemos 🙂"
    )
    # Attachment-only rows archive a lone object-replacement char.
    assert not pump._is_substantive_imessage_text(
        pump._decode_attributed_body(_attributed_body("\ufffc"))
    )
    # Unparseable input degrades to "" rather than raising.
    assert pump._decode_attributed_body(None) == ""
    assert pump._decode_attributed_body(b"") == ""
    assert pump._decode_attributed_body(b"streamtyped no marker here") == ""
    assert pump._decode_attributed_body(b"NSString\x01\x94\x84\x01+\xff") == ""


def test_chat_scan_ingests_attributed_body_when_text_is_null(tmp_path, monkeypatch):
    """Current macOS leaves message.text NULL — the body is only in the blob.

    Filtering on ``text IS NOT NULL`` silently dropped every real reply.
    """
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_chat_db(
        db_path,
        [
            ("g1", None, 0, "+15615550100", _attributed_body("Yes — Tuesday works")),
            ("g2", None, 1, "+15615550100", _attributed_body("our own outbound")),
            ("g3", None, 0, "+19995550000", _attributed_body("unwatched number")),
            ("g4", None, 0, "+15615550100", _attributed_body("\ufffc")),
            ("g5", None, 0, "+15615550100", None),
        ],
    )
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    monkeypatch.setattr(pump, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(pump.sys, "platform", "darwin")
    monkeypatch.setenv("CRM_API_URL", "https://crm.example")
    monkeypatch.setenv("CRM_API_KEY", "test")

    posted = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

    monkeypatch.setattr(
        pump.requests,
        "post",
        lambda url, headers=None, json=None, timeout=None: posted.update(
            messages=json["messages"]
        )
        or FakeResponse(),
    )

    assert pump.scan_chat_db({"5615550100"}) == 1
    assert posted["messages"][0]["body"] == "Yes — Tuesday works"
    assert posted["messages"][0]["external_id"] == "chatdb:g1"


def test_chat_scan_works_without_attributed_body_column(tmp_path, monkeypatch):
    """Older chat.db schemas have no attributedBody — fall back, don't error."""
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_chat_db(
        db_path,
        [("g1", "Reply from an old schema", 0, "+15615550100")],
        with_attributed_body=False,
    )
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    monkeypatch.setattr(pump, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(pump.sys, "platform", "darwin")
    monkeypatch.setenv("CRM_API_URL", "https://crm.example")
    monkeypatch.setenv("CRM_API_KEY", "test")

    posted = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

    monkeypatch.setattr(
        pump.requests,
        "post",
        lambda url, headers=None, json=None, timeout=None: posted.update(
            messages=json["messages"]
        )
        or FakeResponse(),
    )

    assert pump.scan_chat_db({"5615550100"}) == 1
    assert posted["messages"][0]["body"] == "Reply from an old schema"


def test_empty_watchlist_is_logged_not_silent(tmp_path, monkeypatch, caplog):
    """An empty watchlist no-ops the whole scan, so it must be visible."""
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_chat_db(db_path, [("g1", "Reply!", 0, "+15615550100")])
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    monkeypatch.setattr(pump.sys, "platform", "darwin")

    with caplog.at_level("WARNING"):
        assert pump.scan_chat_db(set()) == 0
    assert "watchlist is empty" in caplog.text


def test_fetch_watchlist_warns_when_crm_env_missing(monkeypatch, caplog):
    """The failure mode that made an unconfigured probe look healthy."""
    pump = _load_pump()
    monkeypatch.delenv("CRM_API_URL", raising=False)
    monkeypatch.delenv("CRM_API_KEY", raising=False)

    with caplog.at_level("WARNING"):
        assert pump.fetch_watchlist() == set()
    assert "watchlist unavailable" in caplog.text


def test_chat_scan_filters_self_and_unwatched(tmp_path, monkeypatch):
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_chat_db(
        db_path,
        [
            ("g1", "Yes, let's talk!", 0, "+15615550100"),   # watched inbound → post
            ("g2", "our own outbound text", 1, "+15615550100"),  # is_from_me → skip
            ("g3", "hello from a stranger", 0, "+19995550000"),  # unwatched → skip
            ("g4", "￼", 0, "+15615550100"),  # attachment/delivery stub → skip
        ],
    )
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    monkeypatch.setattr(pump, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(pump.sys, "platform", "darwin")
    monkeypatch.setenv("CRM_API_URL", "https://crm.example")
    monkeypatch.setenv("CRM_API_KEY", "test")

    posted = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

    def fake_post(url, headers=None, json=None, timeout=None):
        posted["url"] = url
        posted["messages"] = json["messages"]
        return FakeResponse()

    monkeypatch.setattr(pump.requests, "post", fake_post)

    count = pump.scan_chat_db({"5615550100"})
    assert count == 1
    assert posted["url"].endswith("/api/outreach/inbound")
    message = posted["messages"][0]
    assert message["channel"] == "imessage"
    assert message["body"] == "Yes, let's talk!"
    assert message["external_id"] == "chatdb:g1"

    # State advanced: re-scan finds nothing new (idempotent).
    assert pump.scan_chat_db({"5615550100"}) == 0


def test_chat_scan_does_not_advance_state_on_post_failure(tmp_path, monkeypatch):
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_chat_db(db_path, [("g1", "Reply!", 0, "+15615550100")])
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    monkeypatch.setattr(pump, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(pump.sys, "platform", "darwin")
    monkeypatch.setenv("CRM_API_URL", "https://crm.example")
    monkeypatch.setenv("CRM_API_KEY", "test")

    def failing_post(*args, **kwargs):
        raise pump.requests.RequestException("CRM down")

    monkeypatch.setattr(pump.requests, "post", failing_post)
    assert pump.scan_chat_db({"5615550100"}) == 0

    # CRM back up → same message posts (rowid was not advanced).
    posted = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

    monkeypatch.setattr(
        pump.requests,
        "post",
        lambda url, headers=None, json=None, timeout=None: posted.update(m=json["messages"]) or FakeResponse(),
    )
    assert pump.scan_chat_db({"5615550100"}) == 1
    assert posted["m"][0]["external_id"] == "chatdb:g1"


# --- send path: delivery verification + SMS fallback ----------------------


def _make_send_db(path: Path, rows=()):
    """Empty chat.db carrying the outbound status columns, plus optional history.

    Rows are (handle, service, is_sent, is_delivered, error).
    """
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT)")
    conn.execute(
        "CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,"
        " service TEXT, is_from_me INTEGER, is_sent INTEGER,"
        " is_delivered INTEGER, error INTEGER, handle_id INTEGER)"
    )
    conn.commit()
    conn.close()
    for row in rows:
        _append_send_row(path, *row)


def _append_send_row(path: Path, handle, service, is_sent, is_delivered, error):
    """Append one outbound row, the way Messages.app would after a send."""
    conn = sqlite3.connect(path)
    found = conn.execute(
        "SELECT ROWID FROM handle WHERE id = ?", (handle,)
    ).fetchone()
    if found:
        handle_id = found[0]
    else:
        handle_id = conn.execute(
            "INSERT INTO handle (id) VALUES (?)", (handle,)
        ).lastrowid
    conn.execute(
        "INSERT INTO message (service, is_from_me, is_sent, is_delivered, error,"
        " handle_id) VALUES (?, 1, ?, ?, ?, ?)",
        (service, is_sent, is_delivered, error, handle_id),
    )
    conn.commit()
    conn.close()


def _stub_sends(pump, monkeypatch, *, sms_available=True):
    """Record every AppleScript send instead of touching Messages.app."""
    calls = []
    monkeypatch.setattr(pump.sys, "platform", "darwin")
    monkeypatch.setattr(pump, "SEND_VERIFY_POLL_SECONDS", 0)
    monkeypatch.setattr(pump, "SEND_VERIFY_SECONDS", 0)
    monkeypatch.setattr(
        pump, "messages_service_available", lambda service: sms_available
    )

    def fake_send(phone, body, service):
        calls.append((phone, body, service))
        return True, None

    monkeypatch.setattr(pump, "_applescript_send", fake_send)
    return calls


def test_send_falls_back_to_sms_when_imessage_not_delivered(tmp_path, monkeypatch):
    """The Proven Theory v5 bug: a non-iMessage number silently stayed 'sent'."""
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_send_db(db_path)
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    calls = _stub_sends(pump, monkeypatch)

    # iMessage attempt lands a Not Delivered row (error != 0); the SMS retry
    # lands a clean row — the same sequence Messages.app writes.
    outcomes = iter([("iMessage", 0, 0, 1), ("SMS", 1, 0, 0)])
    real_send = pump._applescript_send

    def send_then_advance(phone, body, service):
        result = real_send(phone, body, service)
        _append_send_row(db_path, "+17864083193", *next(outcomes))
        return result

    monkeypatch.setattr(pump, "_applescript_send", send_then_advance)

    ok, error, service = pump.send_text("+17864083193", "hi")
    assert ok is True
    assert error is None
    assert service == "SMS"
    assert [c[2] for c in calls] == ["imessage", "sms"]


def test_send_reports_failure_when_no_sms_service(tmp_path, monkeypatch):
    """Without Text Message Forwarding there is no fallback — say so, don't lie."""
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_send_db(db_path)
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    _stub_sends(pump, monkeypatch, sms_available=False)
    real_send = pump._applescript_send

    def send_then_fail(phone, body, service):
        result = real_send(phone, body, service)
        _append_send_row(db_path, "+17864083193", "iMessage", 0, 0, 1)
        return result

    monkeypatch.setattr(pump, "_applescript_send", send_then_fail)

    ok, error, service = pump.send_text("+17864083193", "hi")
    assert ok is False
    assert service is None
    assert "not delivered" in error
    assert "Text Message Forwarding" in error


def test_send_confirms_delivered_imessage_without_fallback(tmp_path, monkeypatch):
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_send_db(db_path)
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    calls = _stub_sends(pump, monkeypatch)
    real_send = pump._applescript_send

    def send_then_deliver(phone, body, service):
        result = real_send(phone, body, service)
        _append_send_row(db_path, "+15615550100", "iMessage", 1, 1, 0)
        return result

    monkeypatch.setattr(pump, "_applescript_send", send_then_deliver)

    ok, error, service = pump.send_text("+15615550100", "hi")
    assert (ok, error, service) == (True, None, "iMessage")
    assert [c[2] for c in calls] == ["imessage"]


def test_send_prefers_sms_for_a_known_sms_only_number(tmp_path, monkeypatch):
    """History says SMS worked here, so skip the doomed iMessage attempt."""
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_send_db(db_path, [("+17864083193", "SMS", 1, 0, 0)])
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    calls = _stub_sends(pump, monkeypatch)

    ok, _error, _service = pump.send_text("+17864083193", "hi")
    assert ok is True
    assert [c[2] for c in calls] == ["sms"]


def test_send_treats_unverifiable_delivery_as_sent(tmp_path, monkeypatch):
    """No chat.db (TCC denied) must not turn every send into a double-text."""
    pump = _load_pump()
    monkeypatch.setattr(pump, "CHAT_DB", tmp_path / "missing.db")
    calls = _stub_sends(pump, monkeypatch)

    ok, error, service = pump.send_text("+15615550100", "hi")
    assert (ok, error) == (True, None)
    assert service == "imessage"
    assert [c[2] for c in calls] == ["imessage"]


def test_send_never_tries_more_than_two_transports(tmp_path, monkeypatch):
    """Both transports failing must terminate, not loop."""
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_send_db(db_path)
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    calls = _stub_sends(pump, monkeypatch)
    real_send = pump._applescript_send

    def always_fail(phone, body, service):
        result = real_send(phone, body, service)
        _append_send_row(db_path, "+17864083193", service, 0, 0, 22)
        return result

    monkeypatch.setattr(pump, "_applescript_send", always_fail)

    ok, error, _service = pump.send_text("+17864083193", "hi")
    assert ok is False
    assert len(calls) == 2
    assert error.count("not delivered") == 2


def test_pump_marks_failed_send_failed_not_sent(monkeypatch):
    """The CRM must hear 'failed' when Messages could not deliver."""
    pump = _load_pump()
    monkeypatch.setattr(pump.sys, "platform", "darwin")
    monkeypatch.setattr(pump, "SEND_DELAY_SECONDS", 0)
    monkeypatch.setenv("CRM_API_URL", "https://crm.example")
    monkeypatch.setenv("CRM_API_KEY", "test")
    monkeypatch.setattr(
        pump, "send_text", lambda phone, body: (False, "imessage: not delivered", None)
    )

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"messages": [{"id": "m1", "phone": "+17864083193", "body": "hi"}]}

    posted = {}
    monkeypatch.setattr(pump.requests, "get", lambda *a, **k: FakeResponse())
    monkeypatch.setattr(
        pump.requests,
        "post",
        lambda url, headers=None, json=None, timeout=None: posted.update(
            results=json["results"]
        )
        or FakeResponse(),
    )

    assert pump.pump_imessage_queue() == 1
    assert posted["results"][0]["status"] == "failed"
    assert "not delivered" in posted["results"][0]["error"]
