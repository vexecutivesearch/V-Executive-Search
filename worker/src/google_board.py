"""GoogleBoardController — every Google/SerpApi execution decision in one place.

Decisions, in order, each with a logged reason so an intentional skip can
never masquerade as an outage:

  1. schedule gate  → board_skipped: schedule_gate  (informational, NOT a failure)
  2. budget guard   → board_failure: serpapi_budget (loud, non-blocking) + alert email
  3. zone collapse  → per-search silent skip, aggregated count in funnel
  4. adaptive freq  → per-title skip, listed in funnel
  5. run cap        → board_failure: serpapi_run_cap once, remaining queries skipped
  6. scrape         → marginal-yield pagination with cold-start depth

Google failures are always loud and NON-BLOCKING: Indeed/LinkedIn and the
rest of the pipeline are untouched, and the backlog never shrinks because
SerpApi is capped, out of quota, or down (outage guard protects it).
"""

from __future__ import annotations

import logging
import os
from datetime import date
from typing import Any

from src.funnel import ScrapeFunnel
from src.models import JobListing
from src.serpapi_budget import (
    GoogleTitleStats,
    SerpApiMeter,
    SerpApiSettings,
    load_serpapi_settings,
)
from src.timezone import business_today, is_business_weekday

logger = logging.getLogger(__name__)

DEFAULT_BOARD_SCHEDULES: dict[str, dict[str, Any]] = {
    # Google's aggregator results move slowly intra-day; one weekday pass is
    # enough. Free boards (Indeed/LinkedIn) keep BOTH daily runs — untouched.
    "google": {"runs": ["am"], "days": "weekdays"},
}


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def board_schedule_for(config: dict[str, Any], board: str) -> dict[str, Any]:
    """Per-board schedule gate: CRM config < worker env overrides."""
    schedules = dict(config.get("board_schedules") or {})
    schedule = dict(schedules.get(board) or DEFAULT_BOARD_SCHEDULES.get(board) or {})
    if board == "google":
        env_runs = (os.getenv("GOOGLE_BOARD_RUNS") or "").strip()
        if env_runs:
            schedule["runs"] = [
                slot.strip().lower() for slot in env_runs.split(",") if slot.strip()
            ]
        env_days = (os.getenv("GOOGLE_BOARD_DAYS") or "").strip().lower()
        if env_days:
            schedule["days"] = env_days
    return schedule


def schedule_allows(
    schedule: dict[str, Any],
    *,
    run_slot: str,
    day: date | None = None,
) -> tuple[bool, str | None]:
    """(allowed, reason-when-blocked). Empty schedule = always allowed."""
    if not schedule:
        return True, None
    runs = [str(s).strip().lower() for s in (schedule.get("runs") or [])]
    if runs and (run_slot or "").strip().lower() not in runs:
        return False, f"{run_slot} run — allowed runs: {','.join(runs)}"
    days = str(schedule.get("days") or "all").strip().lower()
    if days == "weekdays" and not is_business_weekday(day):
        target = day or business_today()
        return False, f"{target.strftime('%A').lower()} — weekdays only"
    return True, None


class KnownListingChecker:
    """Per-page net-new lookup against the CRM, with a run-level cache.

    Resight tracking makes this cheap: one batched POST per page covering
    only URLs/companies not already resolved this run. If the CRM lookup
    fails, `classify` returns None and the caller must fail SAFE (stop
    paginating) — never assume unverified listings are new.
    """

    def __init__(self, crm: Any) -> None:
        self._crm = crm
        self._url_known: dict[str, bool] = {}
        self._company_known: dict[str, bool] = {}

    @staticmethod
    def _company_key(name: str) -> str:
        return (name or "").strip().lower()

    def classify(self, listings: list[JobListing]) -> dict[str, Any] | None:
        urls = []
        companies = []
        for listing in listings:
            url = (listing.job_url or "").strip()
            if url and url not in self._url_known and url not in urls:
                urls.append(url)
            key = self._company_key(listing.company_name)
            if key and key not in self._company_known and key not in companies:
                companies.append(key)

        if urls or companies:
            result = self._crm.check_known_listings(urls=urls, companies=companies)
            if result is None:
                return None
            known_urls = {str(u) for u in result.get("known_urls") or []}
            known_companies = {
                self._company_key(str(c)) for c in result.get("known_companies") or []
            }
            for url in urls:
                self._url_known[url] = url in known_urls
            for key in companies:
                self._company_known[key] = key in known_companies

        new_urls = 0
        new_companies: set[str] = set()
        for listing in listings:
            url = (listing.job_url or "").strip()
            if url and not self._url_known.get(url, True):
                new_urls += 1
                key = self._company_key(listing.company_name)
                if key and not self._company_known.get(key, True):
                    new_companies.add(key)

        # A URL/company counted new once is known for the rest of the run —
        # a repeat on a later page or query adds nothing.
        for listing in listings:
            url = (listing.job_url or "").strip()
            if url:
                self._url_known[url] = True
            key = self._company_key(listing.company_name)
            if key:
                self._company_known[key] = True

        return {"new_urls": new_urls, "new_companies": new_companies}


class GoogleBoardController:
    def __init__(
        self,
        config: dict[str, Any],
        *,
        run_slot: str,
        funnel: ScrapeFunnel,
        crm: Any = None,
        settings: SerpApiSettings | None = None,
        meter: SerpApiMeter | None = None,
        title_stats: GoogleTitleStats | None = None,
        today: date | None = None,
    ) -> None:
        self.config = config
        self.run_slot = (run_slot or "am").strip().lower()
        self.funnel = funnel
        self.crm = crm
        self._today = today or business_today()
        self.settings = settings or load_serpapi_settings(config)
        self.meter = meter or SerpApiMeter(self.settings, today=self._today)
        self.title_stats = title_stats or GoogleTitleStats(self.settings, today=self._today)
        self.checker = KnownListingChecker(crm) if crm is not None else None

        settings_block = config.get("settings") or {}
        self.market_label = (
            settings_block.get("market_label") or settings_block.get("geo_label") or "unknown"
        )
        zones = (config.get("board_zones") or {}).get("google")
        self.google_zones: list[str] | None = (
            [str(z) for z in zones] if isinstance(zones, list) and zones else None
        )

        self._gate_reason = self._compute_gate_reason()
        self._budget_failure_logged = False
        self._run_cap_failure_logged = False
        self._ran_any_search = False
        self._usage_events: list[dict[str, Any]] = []

        self.funnel.serpapi_monthly_plan = self.settings.monthly_plan
        self.funnel.serpapi_budget_threshold = self.settings.budget_threshold
        self.funnel.serpapi_run_cap = self.settings.run_cap
        if self.google_zones is not None:
            self.funnel.google_zones_used = list(self.google_zones)

        if self._gate_reason:
            msg = f"google: schedule_gate ({self._gate_reason})"
            self.funnel.board_skips.append(msg)
            logger.info(
                "BOARD SKIPPED — %s (intentional; set GOOGLE_BOARD_RUNS/"
                "GOOGLE_BOARD_DAYS or SERPAPI_SCHEDULE_GATE_BYPASS=1 to force)",
                msg,
            )
        elif self.budget_blocked:
            self._log_budget_failure()

    # -- run-level gates -------------------------------------------------

    def _compute_gate_reason(self) -> str | None:
        if _env_flag("SERPAPI_SCHEDULE_GATE_BYPASS"):
            logger.info("Google schedule gate bypassed (SERPAPI_SCHEDULE_GATE_BYPASS)")
            return None
        schedule = board_schedule_for(self.config, "google")
        allowed, reason = schedule_allows(
            schedule, run_slot=self.run_slot, day=self._today
        )
        return None if allowed else reason

    @property
    def schedule_blocked(self) -> bool:
        return self._gate_reason is not None

    @property
    def budget_blocked(self) -> bool:
        return self.meter.budget_tripped

    @property
    def google_intentionally_skipped(self) -> bool:
        """True when zero Google listings must NOT be reported as a board failure."""
        if self.schedule_blocked:
            return True
        # Every query skipped by zone collapse / adaptive frequency and none
        # attempted: intentional, not an outage.
        if (
            not self._ran_any_search
            and self.meter.run_searches == 0
            and (
                self.funnel.google_zone_queries_skipped > 0
                or self.funnel.google_adaptive_skips
            )
        ):
            return True
        return False

    def _log_budget_failure(self) -> None:
        if self._budget_failure_logged:
            return
        self._budget_failure_logged = True
        msg = (
            f"google: serpapi_budget — month-to-date {self.meter.month_to_date} ≥ "
            f"threshold {self.settings.budget_threshold} "
            f"(plan {self.settings.monthly_plan}); Google skipped, other boards unaffected"
        )
        self.funnel.board_failures.append(msg)
        logger.error("BOARD FAILURE — %s", msg)
        self._send_budget_alert()

    def _send_budget_alert(self) -> None:
        if not self.meter.should_send_budget_alert():
            return
        notify = (
            (self.config.get("settings") or {}).get("notification_email")
            or os.environ.get("ALERT_EMAIL")
        )
        if not notify:
            logger.warning("SerpApi budget tripped but no alert email configured")
            return
        try:
            from src.credit_alert import send_credit_alert

            sent = send_credit_alert(
                to_email=notify,
                subject="SerpApi monthly budget guard tripped",
                message=(
                    f"SerpApi Google searches this billing period: "
                    f"{self.meter.month_to_date} — past the budget threshold of "
                    f"{self.settings.budget_threshold} "
                    f"({int(self.settings.budget_pct * 100)}% of the "
                    f"{self.settings.monthly_plan}/mo plan). The Google board now "
                    f"skips until the period resets (renewal day "
                    f"{self.settings.renewal_day}). Indeed/LinkedIn keep running; "
                    f"the backlog is protected by the outage guard."
                ),
            )
            if sent:
                self.meter.mark_budget_alert_sent()
        except Exception as exc:  # alert must never break the scrape
            logger.warning("SerpApi budget alert email failed: %s", exc)

    def _log_run_cap_failure(self) -> None:
        if self._run_cap_failure_logged:
            return
        self._run_cap_failure_logged = True
        msg = (
            f"google: serpapi_run_cap — stopped at {self.meter.run_searches} searches "
            f"(cap={self.settings.run_cap}); remaining Google queries skipped, "
            f"other boards unaffected"
        )
        self.funnel.board_failures.append(msg)
        logger.error("BOARD FAILURE — %s", msg)

    # -- per-search decisions ----------------------------------------------

    @staticmethod
    def _title_of(search: dict[str, Any]) -> str:
        name = str(search.get("name") or "unnamed")
        return name.split(" — ")[0].strip()

    def _zone_allowed(self, search: dict[str, Any]) -> bool:
        if self.google_zones is None:
            return True
        zone = str(search.get("zone_label") or "").strip()
        if not zone:
            return True  # yaml fallback searches carry no zone metadata
        return zone in self.google_zones

    @property
    def is_cold_start(self) -> bool:
        last = self.settings.market_last_run_date
        if not last:
            return True
        try:
            last_date = date.fromisoformat(str(last)[:10])
        except ValueError:
            return True
        return (self._today - last_date).days > self.settings.cold_market_days

    def scrape(self, search: dict[str, Any]) -> list[JobListing]:
        if self.schedule_blocked:
            return []

        if self.budget_blocked:
            self._log_budget_failure()
            return []

        if not self._zone_allowed(search):
            self.funnel.google_zone_queries_skipped += 1
            return []

        title = self._title_of(search)
        if self.title_stats.should_skip(self.market_label, title):
            entry = f"{title} (adaptive — no net-new companies recently)"
            if entry not in self.funnel.google_adaptive_skips:
                self.funnel.google_adaptive_skips.append(entry)
            logger.info(
                "Google adaptive skip — title=%r market=%r", title, self.market_label
            )
            return []

        if self.meter.run_cap_reached:
            self._log_run_cap_failure()
            return []

        from src.serpapi_google import scrape_google_serpapi_paged

        cold = self.is_cold_start
        ceiling = self.settings.max_pages_cold if cold else self.settings.max_pages
        listings, stats = scrape_google_serpapi_paged(
            search,
            meter=self.meter,
            page_classifier=self.checker,
            min_yield=self.settings.page_min_yield,
            max_pages=ceiling,
        )
        stats["cold_start"] = cold
        stats["new_companies"] = int(stats.get("new_companies") or 0)
        self.funnel.google_per_query.append(stats)
        self._ran_any_search = True

        self._usage_events.append(
            {
                "provider": "serpapi",
                "endpoint": "google_jobs",
                "egress_context": "scheduled_pipeline",
                "records_returned": len(listings),
                "estimated_cost": int(stats.get("searches_attempted") or 0),
                "metadata": {
                    "search": stats.get("search"),
                    "pages": len(stats.get("pages") or []),
                    "failed": int(stats.get("searches_failed") or 0),
                    "run_slot": self.run_slot,
                    "stop_reason": stats.get("stop_reason"),
                },
            }
        )

        if stats.get("searches_attempted"):
            # "Zero net-new" is only meaningful when the yield lookup actually
            # ran — missing data must never demote a title (coverage first).
            pages = stats.get("pages") or []
            have_yield_data = any(p.get("new_ratio") is not None for p in pages)
            self.title_stats.record_run(
                self.market_label,
                title,
                new_companies=int(stats.get("new_companies") or 0),
                had_failures=bool(stats.get("searches_failed")) or not have_yield_data,
            )

        if stats.get("stop_reason") == "run_cap":
            self._log_run_cap_failure()
        if self.meter.budget_tripped:
            # Crossed the monthly threshold mid-run — stop the rest loudly.
            self._log_budget_failure()

        return listings

    # -- wrap-up -------------------------------------------------------------

    def finalize(self) -> None:
        """Write run totals to the funnel and post usage events to the CRM."""
        self.funnel.serpapi_searches = self.meter.run_searches
        self.funnel.serpapi_searches_failed = self.meter.run_failed
        self.funnel.serpapi_month_to_date = self.meter.month_to_date

        if self.meter.run_searches or self._ran_any_search:
            logger.info(
                "SerpApi meter: %d searches this run (%d failed) · %d this period "
                "(started %s) · plan %d · budget threshold %d",
                self.meter.run_searches,
                self.meter.run_failed,
                self.meter.month_to_date,
                self.meter.period_start,
                self.settings.monthly_plan,
                self.settings.budget_threshold,
            )

        if self._usage_events and self.crm is not None:
            try:
                self.crm.post_usage_events(self._usage_events)
            except Exception as exc:  # audit trail only — local file is authoritative
                logger.warning("SerpApi usage event post failed (non-fatal): %s", exc)
