"""Outreach pump: chat.db inbound scan filtering + IMAP/phone helpers."""

import importlib.util
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

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


APPLE_EPOCH_OFFSET = 978_307_200  # 2001-01-01 in unix seconds


def _apple_ns(when: datetime) -> int:
    """A chat.db ``message.date``: nanoseconds since 2001 on modern macOS."""
    return int(when.timestamp() - APPLE_EPOCH_OFFSET) * 1_000_000_000


def _make_chat_db(
    path: Path,
    rows,
    with_attributed_body: bool = True,
    sent_at: datetime | None = None,
):
    """Rows are (guid, text, is_from_me, handle[, attributed_body[, sent_at]]).

    Rows default to "a moment ago" because the scan ignores anything older than
    ``CHAT_DB_MAX_INBOUND_AGE``; a fixed date in the past would make every test
    here assert the stale-row path by accident.
    """
    default_at = sent_at or datetime.now(tz=timezone.utc) - timedelta(minutes=1)
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
        row_at = row[5] if len(row) > 5 else default_at
        if handle not in handles:
            handles[handle] = len(handles) + 1
            conn.execute("INSERT INTO handle VALUES (?, ?)", (handles[handle], handle))
        values = [i, guid, text, _apple_ns(row_at), is_from_me, handles[handle]]
        if with_attributed_body:
            values.append(body_blob)
        conn.execute(
            f"INSERT INTO message VALUES ({', '.join('?' * len(values))})",
            values,
        )
    conn.commit()
    conn.close()


def _seed_watermark(pump, path: Path, rowid: int = 0):
    """Give the scan a starting rowid.

    Without one it baselines at the current maximum and ingests nothing, which is
    the whole point of the guard — so any test that expects rows to come through
    has to say where it is scanning from.
    """
    path.write_text(json.dumps({"chat_last_rowid": rowid}), encoding="utf-8")
    return path


def test_normalize_phone():
    pump = _load_pump()
    assert pump._normalize_phone("+1 (561) 555-0100") == "5615550100"
    assert pump._normalize_phone("561-555-0100") == "5615550100"
    assert pump._normalize_phone("12345") == ""


def test_decode_header_unfolds_a_wrapped_subject():
    """The real Calendly booking subject arrives wrapped before "Meeting"."""
    pump = _load_pump()
    assert pump._decode_header(
        "New Event: Jeff Willson - 09:00am Mon, Aug 3, 2026 - 15 Minute\r\n Meeting"
    ) == "New Event: Jeff Willson - 09:00am Mon, Aug 3, 2026 - 15 Minute Meeting"
    assert pump._decode_header(None) == ""
    assert pump._decode_header("Re: quick question") == "Re: quick question"


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
    monkeypatch.setattr(
        pump, "STATE_FILE", _seed_watermark(pump, tmp_path / "state.json")
    )
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
    monkeypatch.setattr(
        pump, "STATE_FILE", _seed_watermark(pump, tmp_path / "state.json")
    )
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


def _fake_crm(pump, monkeypatch, posted):
    """Capture what the scan would post to /api/outreach/inbound."""

    class FakeResponse:
        def raise_for_status(self):
            return None

    def fake_post(url, headers=None, json=None, timeout=None):
        posted.setdefault("messages", []).extend(json["messages"])
        return FakeResponse()

    monkeypatch.setattr(pump.requests, "post", fake_post)
    monkeypatch.setenv("CRM_API_URL", "https://crm.example")
    monkeypatch.setenv("CRM_API_KEY", "test")


def test_first_scan_without_a_watermark_ingests_no_history(tmp_path, monkeypatch, caplog):
    """A missing watermark must baseline, not replay the whole message history.

    ``state.get("chat_last_rowid") or 0`` meant a fresh install, a wiped state
    file, or a promote that dropped the state started the scan at rowid 0 and
    swept every message ever exchanged with a watched number into the CRM as a
    brand new reply. Eleven days of personal texts arrived that way, each one
    scored as an answer to outreach that had not been sent yet.
    """
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    long_ago = datetime.now(tz=timezone.utc) - timedelta(days=11)
    _make_chat_db(
        db_path,
        [
            ("old1", "lmfao how?", 0, "+15615550100"),
            ("old2", "get this money", 0, "+15615550100"),
        ],
        sent_at=long_ago,
    )
    state_file = tmp_path / "state.json"
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    monkeypatch.setattr(pump, "STATE_FILE", state_file)
    monkeypatch.setattr(pump.sys, "platform", "darwin")
    posted = {}
    _fake_crm(pump, monkeypatch, posted)

    with caplog.at_level("WARNING"):
        assert pump.scan_chat_db({"5615550100"}) == 0
    assert "no watermark" in caplog.text
    assert posted == {}
    # Baselined at the end of the table, so the next tick starts from now.
    assert json.loads(state_file.read_text())["chat_last_rowid"] == 2


def test_chat_scan_ignores_rows_older_than_the_age_limit(tmp_path, monkeypatch):
    """Backstop for a hand-edited or corrupted watermark.

    Even told to scan from rowid 0, history must not come through: only the
    recent row is a plausible reply to what we are sending now.
    """
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_chat_db(
        db_path,
        [
            (
                "stale",
                "so she was cheating to? lmaooo",
                0,
                "+15615550100",
                None,
                datetime.now(tz=timezone.utc) - timedelta(days=11),
            ),
            ("fresh", "Yes ! I'm interested", 0, "+15615550100"),
        ],
    )
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    monkeypatch.setattr(
        pump, "STATE_FILE", _seed_watermark(pump, tmp_path / "state.json")
    )
    monkeypatch.setattr(pump.sys, "platform", "darwin")
    posted = {}
    _fake_crm(pump, monkeypatch, posted)

    assert pump.scan_chat_db({"5615550100"}) == 1
    assert [m["external_id"] for m in posted["messages"]] == ["chatdb:fresh"]


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
    monkeypatch.setattr(
        pump, "STATE_FILE", _seed_watermark(pump, tmp_path / "state.json")
    )
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
    monkeypatch.setattr(
        pump, "STATE_FILE", _seed_watermark(pump, tmp_path / "state.json")
    )
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
#
# Column semantics here mirror the release Mac's chat.db, where the shapes are
# not the obvious ones:
#   * error has never been non-zero in 210 rows, including a genuinely failed
#     send, so it cannot be the failure signal.
#   * is_delivered is 1 on all 95 outbound iMessage rows, including two that were
#     never delivered. date_delivered is the honest receipt: set on all 93 real
#     deliveries, NULL on both failures.
#   * a failed iMessage is not a new row — Messages rewrites the original in
#     place, flipping service to SMS and setting was_downgraded.

SEND_COLUMNS = (
    "service",
    "is_sent",
    "is_delivered",
    "error",
    "was_downgraded",
    "date_delivered",
    "date_read",
)


def _make_send_db(path: Path, rows=(), columns=SEND_COLUMNS):
    """Empty chat.db carrying the outbound status columns, plus optional history."""
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT)")
    declared = ", ".join(
        f"{name} {'TEXT' if name == 'service' else 'INTEGER'}" for name in columns
    )
    conn.execute(
        "CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,"
        f" is_from_me INTEGER, handle_id INTEGER, {declared})"
    )
    conn.commit()
    conn.close()
    for row in rows:
        _append_send_row(path, **row)


def _append_send_row(path: Path, handle, service, **fields):
    """Append one outbound row, the way Messages.app would after a send."""
    conn = sqlite3.connect(path)
    found = conn.execute("SELECT ROWID FROM handle WHERE id = ?", (handle,)).fetchone()
    handle_id = (
        found[0]
        if found
        else conn.execute("INSERT INTO handle (id) VALUES (?)", (handle,)).lastrowid
    )
    present = {row[1] for row in conn.execute("PRAGMA table_info(message)")}
    # chat.db declares these NOT NULL DEFAULT 0; leaving them NULL would make
    # queries like "error = 0" quietly match nothing.
    values = {
        "service": service,
        "is_sent": 1,
        "is_delivered": 0,
        "error": 0,
        "was_downgraded": 0,
        "date_delivered": 0,
        "date_read": 0,
        **fields,
    }
    values = {k: v for k, v in values.items() if k in present}
    names = ", ".join(["is_from_me", "handle_id", *values])
    rowid = conn.execute(
        f"INSERT INTO message ({names}) VALUES (1, ?, {', '.join('?' * len(values))})",
        (handle_id, *values.values()),
    ).lastrowid
    conn.commit()
    conn.close()
    return rowid


def _rewrite_send_row(path: Path, rowid: int, **fields):
    """Update a row in place — what Messages does when it downgrades a send."""
    conn = sqlite3.connect(path)
    assignments = ", ".join(f"{name} = ?" for name in fields)
    conn.execute(
        f"UPDATE message SET {assignments} WHERE ROWID = ?",
        (*fields.values(), rowid),
    )
    conn.commit()
    conn.close()


def _make_ids_db(path: Path, capable=(), incapable=()):
    """A stand-in for ~/Library/IdentityServices/ids-query.db.

    Same two tables the real Core Data store exposes: a handle IDS resolved for
    iMessage is addressable with ZSTATUS 1, one it could not is ZSTATUS 2 only.
    """
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE ZIDSQUERYSDADDRESSABLE (Z_PK INTEGER PRIMARY KEY,"
        " ZSERVICE TEXT, ZURI TEXT)"
    )
    conn.execute(
        "CREATE TABLE ZIDSQUERYSDSTATUS (Z_PK INTEGER PRIMARY KEY, ZSERVICE TEXT,"
        " ZURI TEXT, ZSTATUS INTEGER)"
    )
    for phone in capable:
        conn.execute(
            "INSERT INTO ZIDSQUERYSDADDRESSABLE (ZSERVICE, ZURI) VALUES"
            " ('com.apple.madrid', ?)",
            (f"tel:{phone}",),
        )
        conn.execute(
            "INSERT INTO ZIDSQUERYSDSTATUS (ZSERVICE, ZURI, ZSTATUS) VALUES"
            " ('com.apple.madrid', ?, 1)",
            (f"tel:{phone}",),
        )
    for phone in incapable:
        conn.execute(
            "INSERT INTO ZIDSQUERYSDSTATUS (ZSERVICE, ZURI, ZSTATUS) VALUES"
            " ('com.apple.madrid', ?, 2)",
            (f"tel:{phone}",),
        )
        # FaceTime/Continuity rows share the table; a non-iMessage service must
        # never be mistaken for the iMessage verdict.
        conn.execute(
            "INSERT INTO ZIDSQUERYSDSTATUS (ZSERVICE, ZURI, ZSTATUS) VALUES"
            " ('com.apple.private.alloy.screensharing', ?, 1)",
            (f"tel:{phone}",),
        )
    conn.commit()
    conn.close()


def _stub_sends(pump, monkeypatch, *, sms_available=True, ids_db=None):
    """Record every AppleScript send instead of touching Messages.app."""
    calls = []
    monkeypatch.setattr(pump.sys, "platform", "darwin")
    monkeypatch.setattr(pump, "SEND_VERIFY_POLL_SECONDS", 0)
    monkeypatch.setattr(pump, "SEND_VERIFY_SECONDS", 0)
    # Absent unless a test opts in, so "no IDS answer" is the default and the
    # legacy behaviour stays under test.
    monkeypatch.setattr(pump, "IDS_QUERY_DB", ids_db or Path("/nonexistent/ids.db"))
    monkeypatch.setattr(
        pump, "messages_service_available", lambda service: sms_available
    )

    def fake_send(phone, body, service):
        calls.append((phone, body, service))
        return True, None

    monkeypatch.setattr(pump, "_applescript_send", fake_send)
    return calls


def _send_landing(pump, monkeypatch, db_path, handle, outcomes):
    """Make each stubbed send write the chat.db row Messages would have written."""
    accepted = pump._applescript_send
    queue = iter(outcomes)
    landed = []

    def send_then_land(phone, body, service):
        result = accepted(phone, body, service)
        row = next(queue, None)
        if row is not None:
            landed.append(_append_send_row(db_path, handle, **row))
        return result

    monkeypatch.setattr(pump, "_applescript_send", send_then_land)
    return landed


# --- the capability signal ------------------------------------------------


def test_ids_capability_reads_apples_own_registry(tmp_path, monkeypatch):
    pump = _load_pump()
    ids_db = tmp_path / "ids-query.db"
    _make_ids_db(ids_db, capable=["+13055550303"], incapable=["+17864083193"])
    monkeypatch.setattr(pump.sys, "platform", "darwin")
    monkeypatch.setattr(pump, "IDS_QUERY_DB", ids_db)

    assert pump.imessage_capability("+13055550303") == pump.CAPABILITY_CAPABLE
    assert pump.imessage_capability("+17864083193") == pump.CAPABILITY_INCAPABLE
    # Never looked up → no opinion, so the send path behaves as it always did.
    assert pump.imessage_capability("+15615550100") == pump.CAPABILITY_UNKNOWN
    # Formatting differences must not change the verdict.
    assert pump.imessage_capability("(786) 408-3193") == pump.CAPABILITY_INCAPABLE


def test_ids_capability_degrades_to_unknown_not_incapable(tmp_path, monkeypatch):
    """A private Apple store may vanish or be renamed — never mis-route on it."""
    pump = _load_pump()
    monkeypatch.setattr(pump.sys, "platform", "darwin")

    monkeypatch.setattr(pump, "IDS_QUERY_DB", tmp_path / "missing.db")
    assert pump.imessage_capability("+17864083193") == pump.CAPABILITY_UNKNOWN

    renamed = tmp_path / "renamed.db"
    conn = sqlite3.connect(renamed)
    conn.execute("CREATE TABLE ZIDSQUERYSDSOMETHINGELSE (ZURI TEXT)")
    conn.commit()
    conn.close()
    monkeypatch.setattr(pump, "IDS_QUERY_DB", renamed)
    assert pump.imessage_capability("+17864083193") == pump.CAPABILITY_UNKNOWN


def test_ids_capability_lets_positive_evidence_win(tmp_path, monkeypatch):
    """A stale "not registered" row must never divert a real iMessage number."""
    pump = _load_pump()
    ids_db = tmp_path / "ids-query.db"
    _make_ids_db(ids_db, capable=["+13055550303"], incapable=["+13055550303"])
    monkeypatch.setattr(pump.sys, "platform", "darwin")
    monkeypatch.setattr(pump, "IDS_QUERY_DB", ids_db)

    assert pump.imessage_capability("+13055550303") == pump.CAPABILITY_CAPABLE


# --- proactive routing ----------------------------------------------------


def test_send_skips_imessage_for_a_number_with_no_apple_account(tmp_path, monkeypatch):
    """Best outcome: never create the undeliverable blue bubble in the first place."""
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_send_db(db_path)
    ids_db = tmp_path / "ids-query.db"
    _make_ids_db(ids_db, incapable=["+17864083193"])
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    calls = _stub_sends(pump, monkeypatch, ids_db=ids_db)
    _send_landing(pump, monkeypatch, db_path, "+17864083193", [{"service": "SMS"}])

    result = pump.send_text("+17864083193", "hi")
    assert result.ok is True
    assert result.service == "SMS"
    assert result.pending is None
    assert [c[2] for c in calls] == ["sms"]


def test_send_still_uses_imessage_for_a_capable_number(tmp_path, monkeypatch):
    """The IDS check must not cost genuine iMessage numbers their blue bubble."""
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_send_db(db_path)
    ids_db = tmp_path / "ids-query.db"
    _make_ids_db(ids_db, capable=["+15615550100"])
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    calls = _stub_sends(pump, monkeypatch, ids_db=ids_db)
    _send_landing(
        pump,
        monkeypatch,
        db_path,
        "+15615550100",
        [{"service": "iMessage", "is_delivered": 1, "date_delivered": 700_000_000}],
    )

    result = pump.send_text("+15615550100", "hi")
    assert (result.ok, result.service, result.pending) == (True, "iMessage", None)
    assert [c[2] for c in calls] == ["imessage"]


# --- reactive fallback ----------------------------------------------------


def test_send_falls_back_to_sms_when_ids_says_no_imessage_account(
    tmp_path, monkeypatch
):
    """The real v7 shape: error stays 0 and the receipt never comes.

    The send itself makes Messages perform the IDS lookup, so the "no Apple
    account" answer is available within the confirm window and the SMS retry
    happens on the same tick — no waiting, no human tap.
    """
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_send_db(db_path)
    ids_db = tmp_path / "ids-query.db"
    _make_ids_db(ids_db, incapable=["+17864083193"])
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    # Reset forces the ladder even though IDS could have skipped iMessage.
    monkeypatch.setenv("OUTREACH_TRANSPORT_RESET", "+17864083193")
    calls = _stub_sends(pump, monkeypatch, ids_db=ids_db)
    _send_landing(
        pump,
        monkeypatch,
        db_path,
        "+17864083193",
        [
            # Not Delivered, exactly as Messages records it: sent, error 0,
            # is_delivered set anyway, and no receipt timestamp.
            {"service": "iMessage", "is_delivered": 1, "date_delivered": 0},
            {"service": "SMS"},
        ],
    )

    result = pump.send_text("+17864083193", "hi")
    assert result.ok is True
    assert result.error is None
    assert result.service == "SMS"
    assert result.pending is None
    assert [c[2] for c in calls] == ["imessage", "sms"]


def test_is_delivered_alone_never_confirms_an_imessage(tmp_path, monkeypatch):
    """The bug in one assertion: is_delivered=1 with no receipt is not delivery."""
    pump = _load_pump()
    stuck = {
        "service": "iMessage",
        "is_sent": 1,
        "is_delivered": 1,
        "error": 0,
        "was_downgraded": 0,
        "date_delivered": 0,
        "date_read": 0,
        "receipts_tracked": True,
    }
    assert pump._classify_outbound(stuck, "imessage")[0] == pump.DELIVERY_PENDING
    assert (
        pump._classify_outbound({**stuck, "date_delivered": 700_000_000}, "imessage")[0]
        == pump.DELIVERY_CONFIRMED
    )
    # A read receipt is delivery too, even if the delivered one went missing.
    assert (
        pump._classify_outbound({**stuck, "date_read": 700_000_000}, "imessage")[0]
        == pump.DELIVERY_CONFIRMED
    )


def test_downgraded_row_counts_as_sent_over_sms_and_is_not_resent(
    tmp_path, monkeypatch
):
    """was_downgraded=1 means Messages already delivered it as SMS itself."""
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_send_db(db_path)
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    calls = _stub_sends(pump, monkeypatch)
    _send_landing(
        pump,
        monkeypatch,
        db_path,
        "+17864083193",
        [{"service": "SMS", "was_downgraded": 1}],
    )

    result = pump.send_text("+17864083193", "hi")
    assert (result.ok, result.service, result.pending) == (True, "SMS", None)
    # One send only — the contact already has the text.
    assert [c[2] for c in calls] == ["imessage"]


def test_send_reports_failure_when_no_sms_service(tmp_path, monkeypatch):
    """Without Text Message Forwarding there is no fallback — say so, don't lie."""
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_send_db(db_path)
    ids_db = tmp_path / "ids-query.db"
    _make_ids_db(ids_db, incapable=["+17864083193"])
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    monkeypatch.setenv("OUTREACH_TRANSPORT_RESET", "+17864083193")
    calls = _stub_sends(pump, monkeypatch, sms_available=False, ids_db=ids_db)
    _send_landing(
        pump,
        monkeypatch,
        db_path,
        "+17864083193",
        [{"service": "iMessage", "is_delivered": 1}],
    )

    result = pump.send_text("+17864083193", "hi")
    assert result.ok is False
    assert result.service is None
    assert result.pending is None
    assert "not delivered" in result.error
    assert "Text Message Forwarding" in result.error
    assert [c[2] for c in calls] == ["imessage"]


def test_send_records_pending_when_capability_is_unknown(tmp_path, monkeypatch):
    """No receipt and no IDS verdict: hand it to the re-check, do not re-send.

    A receipt-less iMessage to a real Apple account (phone off, no signal) still
    arrives later, so texting again here would duplicate it.
    """
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_send_db(db_path)
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    calls = _stub_sends(pump, monkeypatch)
    landed = _send_landing(
        pump,
        monkeypatch,
        db_path,
        "+15615550100",
        [{"service": "iMessage", "is_delivered": 1}],
    )

    result = pump.send_text("+15615550100", "hi")
    assert result.ok is True
    assert [c[2] for c in calls] == ["imessage"]
    assert result.pending["rowid"] == landed[0]
    assert result.pending["sms_retried"] is False
    assert result.pending["phone"] == "+15615550100"


def test_send_prefers_sms_for_a_known_sms_only_number(tmp_path, monkeypatch):
    """History says SMS worked here, so skip the doomed iMessage attempt."""
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_send_db(db_path, [{"handle": "+17864083193", "service": "SMS"}])
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    calls = _stub_sends(pump, monkeypatch)

    assert pump.send_text("+17864083193", "hi").ok is True
    assert [c[2] for c in calls] == ["sms"]


def test_transport_reset_replays_the_imessage_attempt(tmp_path, monkeypatch):
    """Re-test the full ladder on a known-SMS number without wiping chat.db."""
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_send_db(db_path, [{"handle": "+17864083193", "service": "SMS"}])
    ids_db = tmp_path / "ids-query.db"
    # Reset outranks the IDS shortcut too, or the ladder could never be replayed.
    _make_ids_db(ids_db, incapable=["+17864083193"])
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    calls = _stub_sends(pump, monkeypatch, ids_db=ids_db)
    monkeypatch.setenv("OUTREACH_TRANSPORT_RESET", "(786) 408-3193")
    _send_landing(
        pump,
        monkeypatch,
        db_path,
        "+17864083193",
        [{"service": "iMessage", "is_delivered": 1}, {"service": "SMS"}],
    )

    result = pump.send_text("+17864083193", "hi")
    assert result.ok is True
    assert [c[2] for c in calls] == ["imessage", "sms"]

    # Scoped: another number keeps its learned transport.
    _append_send_row(db_path, "+15615550100", "SMS")
    calls.clear()
    pump.send_text("+15615550100", "hi")
    assert [c[2] for c in calls] == ["sms"]


def test_transport_reset_accepts_all(tmp_path, monkeypatch):
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_send_db(db_path, [{"handle": "+17864083193", "service": "SMS"}])
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    calls = _stub_sends(pump, monkeypatch)
    monkeypatch.setenv("OUTREACH_TRANSPORT_RESET", "all")
    _send_landing(
        pump,
        monkeypatch,
        db_path,
        "+17864083193",
        [{"service": "iMessage", "is_delivered": 1}],
    )

    pump.send_text("+17864083193", "hi")
    assert [c[2] for c in calls] == ["imessage"]


def test_transport_reset_unset_keeps_learned_transport(tmp_path, monkeypatch):
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_send_db(db_path, [{"handle": "+17864083193", "service": "SMS"}])
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    calls = _stub_sends(pump, monkeypatch)
    monkeypatch.delenv("OUTREACH_TRANSPORT_RESET", raising=False)

    pump.send_text("+17864083193", "hi")
    assert [c[2] for c in calls] == ["sms"]


def test_send_treats_unverifiable_delivery_as_sent(tmp_path, monkeypatch):
    """No chat.db (TCC denied) must not turn every send into a double-text."""
    pump = _load_pump()
    monkeypatch.setattr(pump, "CHAT_DB", tmp_path / "missing.db")
    calls = _stub_sends(pump, monkeypatch)

    result = pump.send_text("+15615550100", "hi")
    assert (result.ok, result.error, result.service) == (True, None, "imessage")
    # Nothing to re-check against, so no pending record to act on later either.
    assert result.pending is None
    assert [c[2] for c in calls] == ["imessage"]


def test_send_works_on_a_schema_without_receipt_columns(tmp_path, monkeypatch):
    """Older chat.db has no date_delivered — fall back to is_delivered, don't hang."""
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_send_db(db_path, columns=("service", "is_sent", "is_delivered", "error"))
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    calls = _stub_sends(pump, monkeypatch)
    _send_landing(
        pump,
        monkeypatch,
        db_path,
        "+15615550100",
        [{"service": "iMessage", "is_delivered": 1}],
    )

    result = pump.send_text("+15615550100", "hi")
    assert (result.ok, result.service, result.pending) == (True, "iMessage", None)
    assert [c[2] for c in calls] == ["imessage"]


def test_send_never_tries_more_than_two_transports(tmp_path, monkeypatch):
    """Both transports failing must terminate, not loop."""
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_send_db(db_path)
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    calls = _stub_sends(pump, monkeypatch)
    _send_landing(
        pump,
        monkeypatch,
        db_path,
        "+17864083193",
        [
            {"service": "iMessage", "is_sent": 0, "error": 22},
            {"service": "SMS", "is_sent": 0, "error": 22},
        ],
    )

    result = pump.send_text("+17864083193", "hi")
    assert result.ok is False
    assert len(calls) == 2
    assert result.error.count("not delivered") == 2


# --- the asynchronous re-check -------------------------------------------


def _crm_stub(pump, monkeypatch, queue=()):
    """Capture every status post; serve ``queue`` from the queue endpoint."""
    posted = []

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"messages": list(queue)}

    monkeypatch.setenv("CRM_API_URL", "https://crm.example")
    monkeypatch.setenv("CRM_API_KEY", "test")
    monkeypatch.setattr(pump.requests, "get", lambda *a, **k: FakeResponse())
    monkeypatch.setattr(
        pump.requests,
        "post",
        lambda url, headers=None, json=None, timeout=None: posted.extend(
            json["results"]
        )
        or FakeResponse(),
    )
    return posted


def _pending_setup(pump, monkeypatch, tmp_path, *, ids_db=None, sms_available=True):
    """chat.db + state file + stubs for the re-check, with one iMessage sent."""
    db_path = tmp_path / "chat.db"
    _make_send_db(db_path)
    monkeypatch.setattr(pump, "CHAT_DB", db_path)
    monkeypatch.setattr(pump, "STATE_FILE", tmp_path / "state.json")
    calls = _stub_sends(
        pump, monkeypatch, ids_db=ids_db, sms_available=sms_available
    )
    rowid = _append_send_row(
        db_path, "+17864083193", "iMessage", is_delivered=1, date_delivered=0
    )
    pump._remember_pending_send(
        "m1",
        {
            "phone": "+17864083193",
            "body": "hi",
            "rowid": rowid,
            # Well past the grace period.
            "sent_at": pump.time.time() - 600,
            "sms_retried": False,
        },
    )
    return db_path, rowid, calls


def test_pending_recheck_retries_over_sms_and_reports_the_transport(
    tmp_path, monkeypatch
):
    pump = _load_pump()
    ids_db = tmp_path / "ids-query.db"
    _make_ids_db(ids_db, incapable=["+17864083193"])
    _db, _rowid, calls = _pending_setup(pump, monkeypatch, tmp_path, ids_db=ids_db)
    posted = _crm_stub(pump, monkeypatch)

    assert pump.resolve_pending_text_sends() == 1
    assert [c[2] for c in calls] == ["sms"]
    assert posted == [
        {"id": "m1", "status": "sent", "transport": "sms", "verification": "late"}
    ]
    # Record consumed, so the next tick has nothing left to do.
    assert pump._load_state().get(pump.PENDING_STATE_KEY) == {}


def test_pending_recheck_never_sends_twice(tmp_path, monkeypatch):
    """The whole point: repeated polls must not re-text anyone."""
    pump = _load_pump()
    ids_db = tmp_path / "ids-query.db"
    _make_ids_db(ids_db, incapable=["+17864083193"])
    _db, _rowid, calls = _pending_setup(pump, monkeypatch, tmp_path, ids_db=ids_db)
    _crm_stub(pump, monkeypatch)

    assert pump.resolve_pending_text_sends() == 1
    assert pump.resolve_pending_text_sends() == 0
    assert pump.resolve_pending_text_sends() == 0
    assert [c[2] for c in calls] == ["sms"]


def test_pending_recheck_keeps_the_one_shot_flag_across_a_crash(tmp_path, monkeypatch):
    """The retry flag is persisted before sending, so a crash cannot duplicate."""
    pump = _load_pump()
    ids_db = tmp_path / "ids-query.db"
    _make_ids_db(ids_db, incapable=["+17864083193"])
    _db, _rowid, calls = _pending_setup(pump, monkeypatch, tmp_path, ids_db=ids_db)
    _crm_stub(pump, monkeypatch)

    def die(phone, body, service):
        calls.append((phone, body, service))
        raise RuntimeError("worker killed mid-send")

    monkeypatch.setattr(pump, "_applescript_send", die)
    with pytest.raises(RuntimeError):
        pump.resolve_pending_text_sends()
    assert pump._load_state()[pump.PENDING_STATE_KEY]["m1"]["sms_retried"] is True

    # Recovered process: the record is still there but its retry is spent.
    def record(phone, body, service):
        calls.append((phone, body, service))
        return True, None

    monkeypatch.setattr(pump, "_applescript_send", record)
    pump.resolve_pending_text_sends()
    assert [c[2] for c in calls] == ["sms"]


def test_pending_recheck_does_not_resend_a_downgraded_row(tmp_path, monkeypatch):
    """Messages rewrote the row and delivered it — a second text is the bug."""
    pump = _load_pump()
    ids_db = tmp_path / "ids-query.db"
    _make_ids_db(ids_db, incapable=["+17864083193"])
    db_path, rowid, calls = _pending_setup(
        pump, monkeypatch, tmp_path, ids_db=ids_db
    )
    posted = _crm_stub(pump, monkeypatch)
    # The in-place rewrite: same ROWID, service flipped, was_downgraded set.
    _rewrite_send_row(db_path, rowid, service="SMS", was_downgraded=1)

    assert pump.resolve_pending_text_sends() == 1
    assert calls == []
    assert posted[0]["transport"] == "sms"
    assert posted[0]["status"] == "sent"


def test_pending_recheck_confirms_a_late_delivery_receipt(tmp_path, monkeypatch):
    pump = _load_pump()
    db_path, rowid, calls = _pending_setup(pump, monkeypatch, tmp_path)
    posted = _crm_stub(pump, monkeypatch)
    _rewrite_send_row(db_path, rowid, date_delivered=700_000_000)

    assert pump.resolve_pending_text_sends() == 1
    assert calls == []
    assert posted == [
        {"id": "m1", "status": "sent", "transport": "imessage", "verification": "late"}
    ]


def test_pending_recheck_holds_off_inside_the_grace_period(tmp_path, monkeypatch):
    """A receipt still in flight must not look like a failure."""
    pump = _load_pump()
    ids_db = tmp_path / "ids-query.db"
    _make_ids_db(ids_db, incapable=["+17864083193"])
    _db, _rowid, calls = _pending_setup(pump, monkeypatch, tmp_path, ids_db=ids_db)
    _crm_stub(pump, monkeypatch)
    state = pump._load_state()
    state[pump.PENDING_STATE_KEY]["m1"]["sent_at"] = pump.time.time()
    pump._save_state(state)

    assert pump.resolve_pending_text_sends() == 0
    assert calls == []
    assert "m1" in pump._load_state()[pump.PENDING_STATE_KEY]


def test_pending_recheck_will_not_retry_without_an_ids_verdict(tmp_path, monkeypatch):
    """No positive evidence iMessage failed → wait it out, never duplicate.

    At the deadline the message is reported failed, which is honest: it was
    recorded sent and never delivered.
    """
    pump = _load_pump()
    _db, _rowid, calls = _pending_setup(pump, monkeypatch, tmp_path)
    posted = _crm_stub(pump, monkeypatch)

    assert pump.resolve_pending_text_sends() == 0
    assert calls == []

    state = pump._load_state()
    state[pump.PENDING_STATE_KEY]["m1"]["sent_at"] = (
        pump.time.time() - pump.PENDING_MAX_AGE_SECONDS - 1
    )
    pump._save_state(state)

    assert pump.resolve_pending_text_sends() == 1
    assert calls == []
    assert posted[0]["status"] == "failed"
    assert posted[0]["verification"] == "late"
    assert pump._load_state()[pump.PENDING_STATE_KEY] == {}


def test_pending_recheck_reports_failed_when_no_sms_service(tmp_path, monkeypatch):
    pump = _load_pump()
    ids_db = tmp_path / "ids-query.db"
    _make_ids_db(ids_db, incapable=["+17864083193"])
    _db, _rowid, calls = _pending_setup(
        pump, monkeypatch, tmp_path, ids_db=ids_db, sms_available=False
    )
    posted = _crm_stub(pump, monkeypatch)

    assert pump.resolve_pending_text_sends() == 1
    assert calls == []
    assert posted[0]["status"] == "failed"
    assert "Text Message Forwarding" in posted[0]["error"]


def test_pending_recheck_leaves_a_vanished_row_alone(tmp_path, monkeypatch):
    """Conversation deleted: no evidence either way, so send nothing."""
    pump = _load_pump()
    ids_db = tmp_path / "ids-query.db"
    _make_ids_db(ids_db, incapable=["+17864083193"])
    db_path, rowid, calls = _pending_setup(
        pump, monkeypatch, tmp_path, ids_db=ids_db
    )
    posted = _crm_stub(pump, monkeypatch)
    conn = sqlite3.connect(db_path)
    conn.execute("DELETE FROM message WHERE ROWID = ?", (rowid,))
    conn.commit()
    conn.close()

    assert pump.resolve_pending_text_sends() == 1
    assert calls == []
    assert posted[0]["status"] == "sent"


def test_pending_recheck_is_a_noop_with_nothing_pending(tmp_path, monkeypatch):
    pump = _load_pump()
    monkeypatch.setattr(pump.sys, "platform", "darwin")
    monkeypatch.setattr(pump, "STATE_FILE", tmp_path / "state.json")
    assert pump.resolve_pending_text_sends() == 0


def test_pending_recheck_ignores_state_it_cannot_understand(tmp_path, monkeypatch):
    """The state file outlives releases — a foreign shape must not break the stage."""
    pump = _load_pump()
    monkeypatch.setattr(pump.sys, "platform", "darwin")
    monkeypatch.setattr(pump, "STATE_FILE", tmp_path / "state.json")

    for junk in ([], "nope", {"m1": "not a dict"}, {"m1": {"phone": "+1786"}}):
        pump._save_state({"chat_last_rowid": 7, pump.PENDING_STATE_KEY: junk})
        assert pump._read_pending() == {}
        assert pump.resolve_pending_text_sends() == 0
        # Unrelated state survives the sanitising.
        assert pump._load_state()["chat_last_rowid"] == 7


# --- CRM status reporting -------------------------------------------------


def test_pump_marks_failed_send_failed_not_sent(monkeypatch):
    """The CRM must hear 'failed' when Messages could not deliver."""
    pump = _load_pump()
    monkeypatch.setattr(pump.sys, "platform", "darwin")
    monkeypatch.setattr(pump, "SEND_DELAY_SECONDS", 0)
    monkeypatch.setattr(
        pump,
        "send_text",
        lambda phone, body: pump.SendResult(False, "imessage: not delivered", None),
    )
    posted = _crm_stub(
        pump, monkeypatch, [{"id": "m1", "phone": "+17864083193", "body": "hi"}]
    )

    assert pump.pump_imessage_queue() == 1
    assert posted[0]["status"] == "failed"
    assert "not delivered" in posted[0]["error"]


def test_pump_reports_the_transport_that_carried_the_text(monkeypatch):
    pump = _load_pump()
    monkeypatch.setattr(pump.sys, "platform", "darwin")
    monkeypatch.setattr(pump, "SEND_DELAY_SECONDS", 0)
    monkeypatch.setattr(
        pump, "send_text", lambda phone, body: pump.SendResult(True, None, "SMS")
    )
    posted = _crm_stub(
        pump, monkeypatch, [{"id": "m1", "phone": "+17864083193", "body": "hi"}]
    )

    assert pump.pump_imessage_queue() == 1
    assert posted[0] == {"id": "m1", "status": "sent", "transport": "SMS"}


def test_pump_persists_a_pending_send_for_the_next_tick(tmp_path, monkeypatch):
    """Reported sent so the queue won't re-serve it, but still tracked locally."""
    pump = _load_pump()
    monkeypatch.setattr(pump.sys, "platform", "darwin")
    monkeypatch.setattr(pump, "SEND_DELAY_SECONDS", 0)
    monkeypatch.setattr(pump, "STATE_FILE", tmp_path / "state.json")
    pending = {
        "phone": "+17864083193",
        "body": "hi",
        "rowid": 41,
        "sent_at": 1.0,
        "sms_retried": False,
    }
    monkeypatch.setattr(
        pump,
        "send_text",
        lambda phone, body: pump.SendResult(True, None, "iMessage", pending),
    )
    posted = _crm_stub(
        pump, monkeypatch, [{"id": "m1", "phone": "+17864083193", "body": "hi"}]
    )

    assert pump.pump_imessage_queue() == 1
    assert posted[0]["status"] == "sent"
    assert pump._load_state()[pump.PENDING_STATE_KEY]["m1"]["rowid"] == 41


def test_pending_record_for_one_message_is_never_duplicated(tmp_path, monkeypatch):
    pump = _load_pump()
    monkeypatch.setattr(pump, "STATE_FILE", tmp_path / "state.json")
    base = {"phone": "+17864083193", "body": "hi", "sent_at": 1.0, "sms_retried": False}
    pump._remember_pending_send("m1", {**base, "rowid": 41})
    pump._remember_pending_send("m1", {**base, "rowid": 42})

    pending = pump._load_state()[pump.PENDING_STATE_KEY]
    assert list(pending) == ["m1"]
    assert pending["m1"]["rowid"] == 42
