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


def _make_chat_db(path: Path, rows):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT)")
    conn.execute(
        "CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT,"
        " date INTEGER, is_from_me INTEGER, handle_id INTEGER)"
    )
    handles = {}
    for i, (guid, text, is_from_me, handle) in enumerate(rows, start=1):
        if handle not in handles:
            handles[handle] = len(handles) + 1
            conn.execute("INSERT INTO handle VALUES (?, ?)", (handles[handle], handle))
        conn.execute(
            "INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)",
            (i, guid, text, 700_000_000_000_000_000, is_from_me, handles[handle]),
        )
    conn.commit()
    conn.close()


def test_normalize_phone():
    pump = _load_pump()
    assert pump._normalize_phone("+1 (561) 555-0100") == "5615550100"
    assert pump._normalize_phone("561-555-0100") == "5615550100"
    assert pump._normalize_phone("12345") == ""


def test_chat_scan_filters_self_and_unwatched(tmp_path, monkeypatch):
    pump = _load_pump()
    db_path = tmp_path / "chat.db"
    _make_chat_db(
        db_path,
        [
            ("g1", "Yes, let's talk!", 0, "+15615550100"),   # watched inbound → post
            ("g2", "our own outbound text", 1, "+15615550100"),  # is_from_me → skip
            ("g3", "hello from a stranger", 0, "+19995550000"),  # unwatched → skip
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
