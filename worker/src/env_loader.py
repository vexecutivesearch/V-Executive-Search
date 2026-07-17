from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

WORKER_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CANONICAL_ENV = Path.home() / ".vsearch" / "worker.env"


def worker_env_path() -> Path:
    configured = os.environ.get("WORKER_ENV_FILE")
    if configured:
        return Path(configured).expanduser().resolve()
    if DEFAULT_CANONICAL_ENV.exists():
        return DEFAULT_CANONICAL_ENV
    return WORKER_ROOT / ".env"


def load_worker_env(*, override: bool = False) -> Path:
    path = worker_env_path()
    load_dotenv(path, override=override)
    return path
