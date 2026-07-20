"""SerpApi metering, caps, and budget guard — ships BEFORE any optimization.

Apollo credit-drain lesson: spend must never be invisible. Every SerpApi
request (success OR failure — failures still consume attempts) is counted:
  - per run   → funnel_json → Runs page row
  - per month → local state file (source of truth) + CRM usage events (audit)

Month-to-date reconciliation is max(local, CRM): if usage events failed to
post the CRM undercounts, and if the local file was wiped local undercounts.
Taking the higher of the two means the guard can only ever OVER-count and
skip Google early — never blind-overspend.

All knobs are config-driven: CRM pipeline config `serpapi` block, overridable
by worker env vars; code values below are only the last-resort defaults.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from src.timezone import business_today

logger = logging.getLogger(__name__)

# Stable location OUTSIDE the release checkout — survives release swaps.
DEFAULT_STATE_DIR = Path.home() / ".vsearch"

_DEFAULTS: dict[str, Any] = {
    # Metering / caps
    "monthly_plan": 15000,
    "budget_pct": 0.8,
    "renewal_day": 11,
    "run_cap": 200,
    # Marginal-yield pagination
    "page_min_yield": 0.3,
    "max_pages": 5,
    "max_pages_cold": 10,
    "cold_market_days": 7,
    # Adaptive title frequency
    "adaptive_enabled": True,
    "adaptive_empty_runs": 3,
    "adaptive_interval_days": 2,
}

_ENV_KEYS: dict[str, str] = {
    "monthly_plan": "SERPAPI_MONTHLY_PLAN",
    "budget_pct": "SERPAPI_BUDGET_PCT",
    "renewal_day": "SERPAPI_RENEWAL_DAY",
    "run_cap": "SERPAPI_RUN_CAP",
    "page_min_yield": "GOOGLE_PAGE_MIN_YIELD",
    "max_pages": "GOOGLE_MAX_PAGES",
    "max_pages_cold": "GOOGLE_MAX_PAGES_COLD",
    "cold_market_days": "GOOGLE_COLD_MARKET_DAYS",
    "adaptive_enabled": "GOOGLE_ADAPTIVE_ENABLED",
    "adaptive_empty_runs": "GOOGLE_ADAPTIVE_EMPTY_RUNS",
    "adaptive_interval_days": "GOOGLE_ADAPTIVE_INTERVAL_DAYS",
}


def _coerce(value: Any, like: Any) -> Any:
    if isinstance(like, bool):
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in {"1", "true", "yes", "on"}
    if isinstance(like, int):
        return int(float(value))
    if isinstance(like, float):
        return float(value)
    return value


@dataclass
class SerpApiSettings:
    monthly_plan: int = 15000
    budget_pct: float = 0.8
    renewal_day: int = 11
    run_cap: int = 200
    page_min_yield: float = 0.3
    max_pages: int = 5
    max_pages_cold: int = 10
    cold_market_days: int = 7
    adaptive_enabled: bool = True
    adaptive_empty_runs: int = 3
    adaptive_interval_days: int = 2
    # CRM-computed month-to-date (usage events table) for max() reconciliation.
    crm_month_to_date: int = 0
    # Last date this market scraped anything (cold-start detection).
    market_last_run_date: str | None = None

    @property
    def budget_threshold(self) -> int:
        return int(self.monthly_plan * self.budget_pct)


def load_serpapi_settings(config: dict[str, Any] | None) -> SerpApiSettings:
    """defaults < CRM pipeline config `serpapi` block < worker env vars."""
    block = dict((config or {}).get("serpapi") or {})
    merged: dict[str, Any] = {}
    for key, default in _DEFAULTS.items():
        value = default
        if key in block and block[key] is not None:
            try:
                value = _coerce(block[key], default)
            except (TypeError, ValueError):
                logger.warning("serpapi config %s=%r invalid — using %r", key, block[key], default)
        raw_env = os.getenv(_ENV_KEYS[key])
        if raw_env is not None and raw_env.strip() != "":
            try:
                value = _coerce(raw_env, default)
            except (TypeError, ValueError):
                logger.warning("env %s=%r invalid — keeping %r", _ENV_KEYS[key], raw_env, value)
        merged[key] = value

    crm_mtd = 0
    try:
        crm_mtd = max(0, int(block.get("month_to_date") or 0))
    except (TypeError, ValueError):
        crm_mtd = 0

    last_run = block.get("market_last_run_date")
    return SerpApiSettings(
        crm_month_to_date=crm_mtd,
        market_last_run_date=str(last_run) if last_run else None,
        **merged,
    )


def serpapi_period_start(renewal_day: int, today: date | None = None) -> date:
    """Start of the current SerpApi billing period (plan renews on renewal_day)."""
    today = today or business_today()
    day = max(1, min(28, int(renewal_day)))
    if today.day >= day:
        return today.replace(day=day)
    first_of_month = today.replace(day=1)
    last_month_end = first_of_month - timedelta(days=1)
    return last_month_end.replace(day=day)


class SerpApiMeter:
    """Counts every SerpApi request; persists a month-to-date total.

    State lives in ~/.vsearch/serpapi_usage.json (env SERPAPI_USAGE_FILE) so
    it survives worker release swaps. Failed searches count too — SerpApi
    bills the attempt, and a retry storm must be visible.
    """

    def __init__(
        self,
        settings: SerpApiSettings,
        *,
        state_path: Path | None = None,
        today: date | None = None,
    ) -> None:
        self.settings = settings
        self._today = today or business_today()
        env_path = os.getenv("SERPAPI_USAGE_FILE")
        self.state_path = (
            state_path
            if state_path is not None
            else Path(env_path).expanduser()
            if env_path
            else DEFAULT_STATE_DIR / "serpapi_usage.json"
        )
        self.run_searches = 0
        self.run_failed = 0
        self._state = self._load_state()

    # -- state ---------------------------------------------------------------

    def _load_state(self) -> dict[str, Any]:
        period_start = serpapi_period_start(self.settings.renewal_day, self._today)
        state: dict[str, Any] = {
            "period_start": period_start.isoformat(),
            "total": 0,
            "failed": 0,
            "budget_alert_sent_on": None,
        }
        try:
            if self.state_path.exists():
                raw = json.loads(self.state_path.read_text(encoding="utf-8"))
                if raw.get("period_start") == state["period_start"]:
                    state["total"] = max(0, int(raw.get("total") or 0))
                    state["failed"] = max(0, int(raw.get("failed") or 0))
                    state["budget_alert_sent_on"] = raw.get("budget_alert_sent_on")
                else:
                    logger.info(
                        "SerpApi meter: new billing period %s (was %s) — counter reset",
                        state["period_start"],
                        raw.get("period_start"),
                    )
        except (OSError, ValueError, TypeError) as exc:
            logger.warning("SerpApi meter state unreadable (%s) — starting fresh", exc)

        # Reconcile max(local, CRM): the guard may only ever over-count.
        if self.settings.crm_month_to_date > state["total"]:
            logger.info(
                "SerpApi meter: CRM reports %d this period > local %d — adopting CRM count",
                self.settings.crm_month_to_date,
                state["total"],
            )
            state["total"] = self.settings.crm_month_to_date
        return state

    def _save_state(self) -> None:
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            payload = {**self._state, "updated_at": datetime.now().isoformat()}
            self.state_path.write_text(
                json.dumps(payload, sort_keys=True), encoding="utf-8"
            )
        except OSError as exc:
            logger.warning("SerpApi meter state write failed: %s", exc)

    # -- counters ------------------------------------------------------------

    def record_search(self, *, failed: bool = False) -> None:
        self.run_searches += 1
        self._state["total"] = int(self._state["total"]) + 1
        if failed:
            self.run_failed += 1
            self._state["failed"] = int(self._state["failed"]) + 1
        self._save_state()

    @property
    def month_to_date(self) -> int:
        return int(self._state["total"])

    @property
    def month_failed(self) -> int:
        return int(self._state["failed"])

    @property
    def period_start(self) -> str:
        return str(self._state["period_start"])

    # -- guards --------------------------------------------------------------

    @property
    def run_cap_reached(self) -> bool:
        return self.run_searches >= self.settings.run_cap

    @property
    def budget_tripped(self) -> bool:
        return self.month_to_date >= self.settings.budget_threshold

    def should_send_budget_alert(self) -> bool:
        """At most one budget alert email per day — loud but not a mail storm."""
        return self._state.get("budget_alert_sent_on") != self._today.isoformat()

    def mark_budget_alert_sent(self) -> None:
        self._state["budget_alert_sent_on"] = self._today.isoformat()
        self._save_state()


@dataclass
class TitleMarketStat:
    consecutive_empty_runs: int = 0
    last_new_company_at: str | None = None
    last_google_run_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "consecutive_empty_runs": self.consecutive_empty_runs,
            "last_new_company_at": self.last_new_company_at,
            "last_google_run_at": self.last_google_run_at,
        }


class GoogleTitleStats:
    """Per-title-per-market Google yield stats for adaptive frequency.

    Titles with zero net-new companies for N consecutive runs drop to an
    every-`interval_days` cadence in that market; any net-new result promotes
    them straight back to daily. Persisted outside the checkout so restarts
    and release swaps keep the history.
    """

    def __init__(
        self,
        settings: SerpApiSettings,
        *,
        state_path: Path | None = None,
        today: date | None = None,
    ) -> None:
        self.settings = settings
        self._today = today or business_today()
        env_path = os.getenv("GOOGLE_TITLE_STATS_FILE")
        self.state_path = (
            state_path
            if state_path is not None
            else Path(env_path).expanduser()
            if env_path
            else DEFAULT_STATE_DIR / "google_title_stats.json"
        )
        self._stats: dict[str, TitleMarketStat] = {}
        self._load()

    @staticmethod
    def _key(market: str, title: str) -> str:
        return f"{(market or 'unknown').strip().lower()}|{(title or 'unknown').strip().lower()}"

    def _load(self) -> None:
        try:
            if not self.state_path.exists():
                return
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
            for key, value in (raw or {}).items():
                if not isinstance(value, dict):
                    continue
                self._stats[key] = TitleMarketStat(
                    consecutive_empty_runs=max(0, int(value.get("consecutive_empty_runs") or 0)),
                    last_new_company_at=value.get("last_new_company_at"),
                    last_google_run_at=value.get("last_google_run_at"),
                )
        except (OSError, ValueError, TypeError) as exc:
            logger.warning("Google title stats unreadable (%s) — starting fresh", exc)

    def _save(self) -> None:
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            payload = {key: stat.to_dict() for key, stat in self._stats.items()}
            self.state_path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
        except OSError as exc:
            logger.warning("Google title stats write failed: %s", exc)

    def should_skip(self, market: str, title: str) -> bool:
        """True when this title is demoted in this market and not yet due."""
        if not self.settings.adaptive_enabled:
            return False
        stat = self._stats.get(self._key(market, title))
        if stat is None:
            return False
        if stat.consecutive_empty_runs < self.settings.adaptive_empty_runs:
            return False
        if not stat.last_google_run_at:
            return False
        try:
            last_run = date.fromisoformat(str(stat.last_google_run_at)[:10])
        except ValueError:
            return False
        return (self._today - last_run).days < self.settings.adaptive_interval_days

    def record_run(
        self,
        market: str,
        title: str,
        *,
        new_companies: int,
        had_failures: bool = False,
    ) -> None:
        """Update stats after a real Google run for this title/market."""
        key = self._key(market, title)
        stat = self._stats.get(key) or TitleMarketStat()
        stat.last_google_run_at = self._today.isoformat()
        if new_companies > 0:
            stat.consecutive_empty_runs = 0
            stat.last_new_company_at = self._today.isoformat()
        elif not had_failures:
            # A failed search proves nothing about the market — never demote on it.
            stat.consecutive_empty_runs += 1
        self._stats[key] = stat
        self._save()
