from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Mapping

from src.crm_config import post_pipeline_status
from src.worker_identity import worker_status_payload

WORKER_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = WORKER_ROOT.parent


class SelfSyncError(RuntimeError):
    pass


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _run(
    args: list[str],
    *,
    cwd: Path = REPO_ROOT,
    timeout: int = 120,
    env: Mapping[str, str] | None = None,
) -> str:
    result = subprocess.run(
        args,
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        timeout=timeout,
        env={**os.environ, **(env or {})},
    )
    return result.stdout.strip()


def _git(*args: str, cwd: Path = REPO_ROOT, timeout: int = 120) -> str:
    return _run(["git", *args], cwd=cwd, timeout=timeout)


def _current_sha() -> str:
    return _git("rev-parse", "HEAD")


def _status_porcelain() -> str:
    return _git("status", "--porcelain")


def _release_ref() -> str:
    return os.environ.get("WORKER_RELEASE_REF", "origin/worker-production").strip()


def _release_checkout_root() -> Path:
    configured = os.environ.get("WORKER_RELEASE_CHECKOUT")
    if configured:
        return Path(configured).expanduser().resolve()
    return (REPO_ROOT.parent / f"{REPO_ROOT.name}-release").resolve()


def _previous_release_checkout_root(release_root: Path) -> Path:
    configured = os.environ.get("WORKER_PREVIOUS_RELEASE_CHECKOUT")
    if configured:
        return Path(configured).expanduser().resolve()
    return release_root.with_name(f"{release_root.name}-previous")


def _runtime_env_source() -> Path:
    configured = os.environ.get("WORKER_RUNTIME_ENV_FILE")
    if configured:
        return Path(configured).expanduser().resolve()
    configured_worker_env = os.environ.get("WORKER_ENV_FILE")
    if configured_worker_env:
        return Path(configured_worker_env).expanduser().resolve()
    return Path.home() / ".vsearch" / "worker.env"


def _remove_path(path: Path) -> None:
    if not path.exists() and not path.is_symlink():
        return
    if path.is_symlink() or path.is_file():
        path.unlink()
        return
    shutil.rmtree(path)


def _post_sync_status(status: str, detail: dict[str, object] | None = None) -> None:
    try:
        identity = worker_status_payload()
        payload = {
            **identity,
            "self_sync_status": status,
            "self_sync_detail": detail or {},
        }
        post_pipeline_status(
            "worker_heartbeat",
            {
                "commit_sha": payload.get("commit_sha"),
                "branch": payload.get("branch"),
                "dirty": payload.get("dirty"),
                "agent_summary": payload.get("agent_summary"),
                "status_payload": payload,
            },
        )
    except Exception:
        logging.getLogger(__name__).exception("Failed to post self-sync status")


def self_sync_enabled() -> bool:
    return _truthy(os.environ.get("WORKER_SELF_SYNC_ENABLED"))


def prepare_release_runtime(release_root: Path) -> None:
    """Install untracked runtime assets inside a clean release checkout."""

    worker_root = release_root / "worker"
    env_source = _runtime_env_source()
    if not env_source.exists():
        raise SelfSyncError(f"worker env file missing: {env_source}")
    release_env = worker_root / ".env"
    if release_env.exists() or release_env.is_symlink():
        release_env.unlink()
    release_env.symlink_to(env_source)

    venv_python = worker_root / ".venv" / "bin" / "python"
    bootstrap_python = os.environ.get("WORKER_BOOTSTRAP_PYTHON") or sys.executable
    _run([bootstrap_python, "-m", "venv", str(worker_root / ".venv")], cwd=worker_root, timeout=180)
    _run(
        [str(venv_python), "-m", "pip", "install", "-q", "--upgrade", "pip", "setuptools", "wheel"],
        cwd=worker_root,
        timeout=300,
    )
    _run([str(venv_python), "-m", "pip", "install", "-q", "-e", "."], cwd=worker_root, timeout=300)


def ensure_worker_release(logger: logging.Logger | None = None) -> bool:
    """Prepare and hand off to a promoted worker release.

    This guard is intentionally opt-in. When enabled, it never advances from raw
    main; it fetches a deliberate release ref, prepares a clean worktree, and only
    reinstalls launchd after that checkout exists. A changed release skips the
    current run so the next launchd invocation starts from the promoted tree.
    """

    log = logger or logging.getLogger(__name__)
    if not self_sync_enabled():
        return True

    ref = _release_ref()
    if not ref:
        raise SelfSyncError("WORKER_RELEASE_REF is empty")

    try:
        _git("config", "vexecsearch.releaseRef", ref)
        _git("fetch", "--prune", "origin", timeout=180)
        target_sha = _git("rev-parse", ref)
        current_sha = _current_sha()
        dirty = bool(_status_porcelain())

        if current_sha == target_sha and not dirty:
            _post_sync_status(
                "current",
                {"release_ref": ref, "target_sha": target_sha},
            )
            return True

        checkout_root = _release_checkout_root()
        temp_root = checkout_root.with_name(f"{checkout_root.name}.tmp-{target_sha[:12]}")
        install_script = temp_root / "worker" / "scripts" / "install_launchd.sh"

        _git("worktree", "prune")
        _remove_path(temp_root)
        _git("worktree", "add", "--detach", str(temp_root), target_sha, timeout=180)

        if _git("status", "--porcelain", "--untracked-files=no", cwd=temp_root):
            raise SelfSyncError(f"prepared worktree is dirty: {temp_root}")
        if not install_script.exists():
            raise SelfSyncError(f"install script missing from {temp_root}")
        prepare_release_runtime(temp_root)

        previous_root = _previous_release_checkout_root(checkout_root)
        _remove_path(previous_root)
        if checkout_root.exists():
            checkout_root.rename(previous_root)
        temp_root.rename(checkout_root)

        _run(["bash", str(checkout_root / "worker" / "scripts" / "install_launchd.sh")], cwd=checkout_root, timeout=180)
        _post_sync_status(
            "updated",
            {
                "release_ref": ref,
                "previous_sha": current_sha,
                "target_sha": target_sha,
                "release_checkout": str(checkout_root),
                "previous_checkout": str(previous_root),
                "current_dirty": dirty,
            },
        )
        log.warning(
            "Worker self-sync installed %s at %s; skipping this run so launchd restarts cleanly",
            target_sha,
            checkout_root,
        )
        return False
    except Exception as exc:
        _post_sync_status("failed", {"release_ref": ref, "error": str(exc)})
        log.exception("Worker self-sync failed; skipping scheduled run")
        return False
