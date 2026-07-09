"""Prevent macOS idle sleep while the pipeline or worker scripts run."""

from __future__ import annotations

import contextlib
import logging
import subprocess
import sys

logger = logging.getLogger(__name__)


@contextlib.contextmanager
def prevent_sleep():
    """Hold `caffeinate -s` for the duration of the wrapped block (macOS only)."""
    if sys.platform != "darwin":
        yield
        return

    proc: subprocess.Popen[bytes] | None = None
    try:
        proc = subprocess.Popen(["/usr/bin/caffeinate", "-s"])
        logger.info("caffeinate -s active — system will not idle-sleep during this run")
        yield
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            logger.info("caffeinate released")
