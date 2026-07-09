from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "searches.yaml"


def load_config(config_path: Path | None = None) -> dict[str, Any]:
    path = config_path or DEFAULT_CONFIG_PATH
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f)
