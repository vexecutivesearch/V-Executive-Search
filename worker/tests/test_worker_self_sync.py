from __future__ import annotations

import logging
import os
import unittest
from unittest.mock import patch


class WorkerSelfSyncTest(unittest.TestCase):
    def test_failed_fetch_returns_false_and_posts_failed_status(self) -> None:
        from src import worker_self_sync

        calls: list[tuple[str, dict[str, object] | None]] = []

        def fail_fetch(*args: str, **_: object) -> str:
            if args[:2] == ("config", "vexecsearch.releaseRef"):
                return ""
            if args and args[0] == "fetch":
                raise RuntimeError("simulated fetch failure")
            raise AssertionError(f"unexpected git call after failed fetch: {args}")

        def record_status(status: str, detail: dict[str, object] | None = None) -> None:
            calls.append((status, detail))

        with patch.dict(
            os.environ,
            {
                "WORKER_SELF_SYNC_ENABLED": "true",
                "WORKER_RELEASE_REF": "origin/worker-production",
            },
            clear=False,
        ), patch.object(worker_self_sync, "_git", side_effect=fail_fetch), patch.object(
            worker_self_sync,
            "_post_sync_status",
            side_effect=record_status,
        ):
            ok = worker_self_sync.ensure_worker_release(logging.getLogger(__name__))

        self.assertFalse(ok)
        self.assertEqual(calls[0][0], "failed")
        self.assertEqual(calls[0][1]["release_ref"], "origin/worker-production")
        self.assertIn("simulated fetch failure", calls[0][1]["error"])


if __name__ == "__main__":
    unittest.main()
