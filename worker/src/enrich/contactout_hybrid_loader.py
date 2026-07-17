"""Load ContactOut hybrid client (API + Mac dashboard fallback) when available."""

from __future__ import annotations

import importlib
import logging
import os
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

_PLAYWRIGHT_ROOT = Path(__file__).resolve().parents[3] / "Playwright"
_WORKER_ROOT = Path(__file__).resolve().parents[2]


def try_hybrid_contactout_client():
    """Return ContactOutHybridClient on Mac when Playwright automation is installed."""
    if sys.platform != "darwin":
        return None

    if os.environ.get("ENABLE_CONTACTOUT_HYBRID") != "true":
        return None

    mode = os.environ.get("CONTACTOUT_MODE", "auto").strip().lower()
    if mode == "api":
        return None

    hybrid_path = _PLAYWRIGHT_ROOT / "src" / "enrich" / "contactout_hybrid.py"
    if not hybrid_path.exists():
        logger.debug("ContactOut hybrid unavailable — Playwright folder not found")
        return None

    worker_resolved = _WORKER_ROOT.resolve()
    playwright_root = str(_PLAYWRIGHT_ROOT.resolve())
    original_path = sys.path[:]

    try:
        # Playwright's `src.*` must resolve to Playwright/, not worker/src/
        filtered = [
            p
            for p in sys.path
            if Path(p).resolve() != worker_resolved
        ]
        sys.path = [playwright_root] + [p for p in filtered if p != playwright_root]

        for key in list(sys.modules):
            if key == "src" or key.startswith("src."):
                del sys.modules[key]

        importlib.invalidate_caches()
        hybrid_mod = importlib.import_module("src.enrich.contactout_hybrid")
        client = hybrid_mod.ContactOutHybridClient()
        if client.is_configured:
            logger.info("ContactOut hybrid enabled (API + dashboard fallback)")
            return client
    except Exception as exc:
        logger.warning("ContactOut hybrid client failed to load: %s", exc)
    finally:
        sys.path = original_path

    return None
