#!/usr/bin/env python3
"""Report whether this interpreter can read ~/Library/Messages/chat.db.

Inbound SMS ingestion depends on a macOS Full Disk Access grant, and TCC keys
that grant to the binary that actually opens the file — the interpreter behind
the venv symlink, not caffeinate and not the venv path. When the grant lapses
the pump logs one warning and keeps going, so the failure is silent.

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


def main() -> int:
    ppid = os.getppid()
    # launchd is pid 1. Anything else means we inherited someone's TCC context
    # and a PASS here does not prove the scheduled job can read chat.db.
    from_launchd = ppid == 1

    print(f"interpreter : {Path(sys.executable).resolve()}")
    print(f"sys.prefix  : {sys.prefix}")
    print(f"pid/ppid    : {os.getpid()}/{ppid}")
    print(f"launched by : {'launchd' if from_launchd else f'pid {ppid} (inherited TCC context)'}")
    print(f"chat.db     : {CHAT_DB}")

    if not CHAT_DB.exists():
        print("RESULT: SKIP — chat.db does not exist (Messages never signed in?)")
        return 0

    try:
        conn = sqlite3.connect(f"file:{CHAT_DB}?mode=ro", uri=True)
        (count,) = conn.execute("SELECT count(*) FROM message").fetchone()
        (max_rowid,) = conn.execute("SELECT coalesce(max(ROWID), 0) FROM message").fetchone()
        conn.close()
    except sqlite3.Error as exc:
        if "unable to open database file" in str(exc).lower():
            print("RESULT: FAIL — Full Disk Access is NOT granted to this interpreter.")
            print("        stat() works but the read is denied, which is TCC, not corruption.")
            print("        Inbound texts are NOT being ingested.")
            print("")
            print("        Grant it: Finder Cmd+Shift+G to")
            print(f"          {Path(sys.executable).resolve().parent}")
            print("        then drag the binary onto System Settings → Privacy &")
            print("        Security → Full Disk Access. The '+' button cannot select a")
            print("        bare unix binary; drag-and-drop can.")
        else:
            print(f"RESULT: FAIL — chat.db read error: {exc}")
        return 1

    print(f"RESULT: PASS — read {count} messages (max ROWID {max_rowid})")
    if not from_launchd:
        print("NOTE:   run under launchd to prove the scheduled job can read it too.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
