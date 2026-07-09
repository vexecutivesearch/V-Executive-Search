from __future__ import annotations

from pathlib import Path


def project_root() -> Path:
    """Playwright/ package root (parent of src/)."""
    return Path(__file__).resolve().parents[1]
