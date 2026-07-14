from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests


class PaidEgressBlocked(RuntimeError):
    pass


Provider = str
Context = str

WORKER_ROOT = Path(__file__).resolve().parent.parent
USAGE_LOG = WORKER_ROOT / "logs" / "provider_usage_events.jsonl"


def default_context() -> Context:
    return os.environ.get("PAID_EGRESS_CONTEXT", "scheduled_pipeline")


def manual_enrich_context(company_id: str) -> Context:
    return f"manual_enrich:{company_id}"


def _env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _provider_prefix(provider: Provider) -> str:
    return "APOLLO" if provider == "apollo" else "CONTACTOUT"


def _provider_enabled(provider: Provider) -> bool:
    if not _env_flag("PAID_EGRESS_ENABLED", True):
        return False
    if not _env_flag(f"{_provider_prefix(provider)}_EGRESS_ENABLED", True):
        return False
    return _env_flag(f"{_provider_prefix(provider)}_PAID_EGRESS_ENABLED", True)


def _daily_cap(provider: Provider) -> int:
    raw = os.environ.get(f"{_provider_prefix(provider)}_DAILY_CREDIT_CAP")
    if raw and raw.strip().isdigit():
        return int(raw)
    return 200 if provider == "apollo" else 50


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def record_provider_usage(
    provider: Provider,
    endpoint: str,
    context: Context,
    *,
    records_returned: int = 0,
    estimated_cost: int = 0,
    blocked: bool = False,
    metadata: dict[str, Any] | None = None,
) -> None:
    USAGE_LOG.parent.mkdir(parents=True, exist_ok=True)
    event = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "date": _today(),
        "provider": provider,
        "endpoint": endpoint,
        "egress_context": context,
        "trigger_source": context.split(":", 1)[0],
        "records_returned": records_returned,
        "estimated_cost": estimated_cost,
        "blocked": blocked,
        "metadata": metadata or {},
    }
    with USAGE_LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, sort_keys=True) + "\n")
    _post_provider_usage(event)


def _post_provider_usage(event: dict[str, Any]) -> None:
    base = (os.environ.get("CRM_API_URL") or "").rstrip("/")
    key = os.environ.get("CRM_API_KEY", "")
    if not base or not key:
        return
    try:
        requests.post(
            f"{base}/api/pipeline/usage",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {key}",
            },
            json=event,
            timeout=5,
        )
    except requests.RequestException:
        return


def _daily_usage(provider: Provider) -> int:
    if not USAGE_LOG.exists():
        return 0
    total = 0
    today = _today()
    try:
        with USAGE_LOG.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if (
                    event.get("date") == today
                    and event.get("provider") == provider
                    and not event.get("blocked")
                ):
                    total += int(event.get("estimated_cost") or 0)
    except OSError:
        return 0
    return total


def assert_paid_egress_allowed(
    provider: Provider,
    endpoint: str,
    *,
    context: Context | None = None,
    estimated_cost: int = 1,
    metadata: dict[str, Any] | None = None,
) -> Context:
    ctx = context or default_context()
    if not _provider_enabled(provider):
        record_provider_usage(
            provider,
            endpoint,
            ctx,
            blocked=True,
            metadata={**(metadata or {}), "reason": "provider_disabled"},
        )
        raise PaidEgressBlocked(f"{provider} paid egress disabled for {endpoint}")

    if not ctx.startswith("manual_enrich:"):
        record_provider_usage(
            provider,
            endpoint,
            ctx,
            blocked=True,
            metadata={**(metadata or {}), "reason": "non_manual_context"},
        )
        raise PaidEgressBlocked(f"{provider} paid egress blocked for {ctx} ({endpoint})")

    cap = _daily_cap(provider)
    if _daily_usage(provider) + estimated_cost > cap:
        record_provider_usage(
            provider,
            endpoint,
            ctx,
            blocked=True,
            metadata={**(metadata or {}), "reason": "daily_cap_reached", "cap": cap},
        )
        raise PaidEgressBlocked(f"{provider} daily cap reached for {endpoint}")

    return ctx
