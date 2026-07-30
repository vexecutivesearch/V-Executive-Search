#!/usr/bin/env python3
"""Report whether this interpreter can read the two stores outreach depends on.

Both live behind a macOS Full Disk Access grant, and TCC keys that grant to the
binary that actually opens the file — the interpreter behind the venv symlink,
not caffeinate and not the venv path. When the grant lapses each read logs one
warning and keeps going, so the failure is silent.

  ~/Library/Messages/chat.db            inbound texts, and every delivery verdict
  ~/Library/IdentityServices/ids-query.db  whether a number can take an iMessage

Losing the second one is subtler than losing the first: sends still go out, but
the pump can no longer tell "this number has no Apple account" from "this
iMessage will arrive once their phone is back", which is the evidence that
authorises the SMS retry. Non-iMessage numbers then quietly stop being reached.

Read-only on purpose: no CRM calls, no state file writes, no sends. Safe to run
at any time, including while the pump is live.

Run it under launchd rather than from a shell. A terminal inherits the Full
Disk Access of its parent app, so a shell run reports success even when the
launchd job would fail:

    launchctl kickstart -k gui/$UID/com.vexecsearch.poll
"""
from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

CHAT_DB = Path.home() / "Library" / "Messages" / "chat.db"
IDS_QUERY_DB = Path.home() / "Library" / "IdentityServices" / "ids-query.db"


def _grant_hint() -> None:
    print("        Grant it: Finder Cmd+Shift+G to")
    print(f"          {Path(sys.executable).resolve().parent}")
    print("        then drag the binary onto System Settings → Privacy &")
    print("        Security → Full Disk Access. The '+' button cannot select a")
    print("        bare unix binary; drag-and-drop can.")


def _check_chat_db() -> bool:
    print(f"chat.db     : {CHAT_DB}")
    if not CHAT_DB.exists():
        print("  SKIP — does not exist (Messages never signed in?)")
        return True
    try:
        conn = sqlite3.connect(f"file:{CHAT_DB}?mode=ro", uri=True)
        (count,) = conn.execute("SELECT count(*) FROM message").fetchone()
        (max_rowid,) = conn.execute(
            "SELECT coalesce(max(ROWID), 0) FROM message"
        ).fetchone()
        conn.close()
    except sqlite3.Error as exc:
        if "unable to open database file" in str(exc).lower():
            print("  FAIL — Full Disk Access is NOT granted to this interpreter.")
            print("        stat() works but the read is denied, which is TCC, not corruption.")
            print("        Inbound texts are NOT being ingested.")
            print("")
            _grant_hint()
        else:
            print(f"  FAIL — read error: {exc}")
        return False
    print(f"  PASS — read {count} messages (max ROWID {max_rowid})")
    return True


def _check_ids_query_db() -> bool:
    print(f"ids-query.db: {IDS_QUERY_DB}")
    if not IDS_QUERY_DB.exists():
        print("  FAIL — missing. iMessage capability cannot be determined, so the")
        print("        SMS fallback will not fire for numbers with no Apple account.")
        return False
    try:
        conn = sqlite3.connect(f"file:{IDS_QUERY_DB}?mode=ro", uri=True)
        (registered,) = conn.execute(
            "SELECT count(*) FROM ZIDSQUERYSDSTATUS"
            " WHERE ZSERVICE = 'com.apple.madrid' AND ZSTATUS = 1"
        ).fetchone()
        (rejected,) = conn.execute(
            "SELECT count(*) FROM ZIDSQUERYSDSTATUS"
            " WHERE ZSERVICE = 'com.apple.madrid' AND ZSTATUS = 2"
        ).fetchone()
        conn.close()
    except sqlite3.Error as exc:
        print(f"  FAIL — read error: {exc}")
        if "unable to open database file" in str(exc).lower():
            print("        That is TCC. Sends still work, but every number looks")
            print("        iMessage-capable, so the SMS fallback cannot fire.")
            print("")
            _grant_hint()
        else:
            print("        Apple may have renamed the store's tables. Sends fall back")
            print("        to iMessage-first; the SMS retry needs this signal.")
        return False
    print(f"  PASS — {registered} handle(s) on iMessage, {rejected} with no Apple account")
    return True


def main() -> int:
    ppid = os.getppid()
    # launchd is pid 1. Anything else means we inherited someone's TCC context
    # and a PASS here does not prove the scheduled job can read these stores.
    from_launchd = ppid == 1

    print(f"interpreter : {Path(sys.executable).resolve()}")
    print(f"sys.prefix  : {sys.prefix}")
    print(f"pid/ppid    : {os.getpid()}/{ppid}")
    print(f"launched by : {'launchd' if from_launchd else f'pid {ppid} (inherited TCC context)'}")

    ok = _check_chat_db()
    ok = _check_ids_query_db() and ok

    print(f"RESULT: {'PASS' if ok else 'FAIL'}")
    if not from_launchd:
        print("NOTE:   run under launchd to prove the scheduled job can read them too.")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
