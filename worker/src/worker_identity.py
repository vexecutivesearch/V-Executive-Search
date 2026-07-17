from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]


def _run_git(*args: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.stdout.strip() or None
    except (subprocess.SubprocessError, OSError):
        return None


def _launchd_agents() -> str | None:
    try:
        result = subprocess.run(
            ["launchctl", "list"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    lines = [
        line.strip()
        for line in result.stdout.splitlines()
        if "vexecsearch" in line.lower()
    ]
    return "; ".join(lines) if lines else "none"


def worker_status_payload() -> dict[str, Any]:
    status = _run_git("status", "--porcelain")
    release_ref = _run_git("config", "--get", "vexecsearch.releaseRef") or "origin/worker-production"
    return {
        "commit_sha": _run_git("rev-parse", "HEAD"),
        "branch": _run_git("rev-parse", "--abbrev-ref", "HEAD"),
        "dirty": bool(status),
        "origin_main_sha": _run_git("rev-parse", "origin/main"),
        "worker_release_ref": release_ref,
        "worker_release_sha": _run_git("rev-parse", release_ref),
        "agent_summary": _launchd_agents(),
    }
