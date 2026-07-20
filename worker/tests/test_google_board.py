"""GoogleBoardController: schedule gate, budget guard, zone collapse,
run cap, adaptive skips — every skip logged with a reason, failures loud
and non-blocking."""

from datetime import date

import src.serpapi_google as serpapi_google
from src.funnel import ScrapeFunnel
from src.google_board import (
    GoogleBoardController,
    KnownListingChecker,
    board_schedule_for,
    schedule_allows,
)
from src.models import JobListing
from src.serpapi_budget import GoogleTitleStats, SerpApiMeter, SerpApiSettings

FRIDAY = date(2026, 7, 17)
SATURDAY = date(2026, 7, 18)


def _listing(url: str, company: str = "Acme") -> JobListing:
    return JobListing(
        company_name=company,
        job_title="Manager",
        location="Charlotte, NC",
        board="google",
        job_url=url,
    )


class FakeCRM:
    """check_known_listings stub; None simulates a CRM outage."""

    def __init__(self, known_urls=(), known_companies=(), fail=False):
        self.known_urls = set(known_urls)
        self.known_companies = set(known_companies)
        self.fail = fail
        self.calls = 0
        self.usage_batches = []

    def check_known_listings(self, *, urls, companies):
        self.calls += 1
        if self.fail:
            return None
        return {
            "known_urls": [u for u in urls if u in self.known_urls],
            "known_companies": [c for c in companies if c in self.known_companies],
        }

    def post_usage_events(self, events):
        self.usage_batches.append(events)
        return True


def _controller(tmp_path, *, config=None, run_slot="am", today=FRIDAY, crm=None, **settings_kw):
    settings = SerpApiSettings(**settings_kw)
    funnel = ScrapeFunnel()
    controller = GoogleBoardController(
        config or {},
        run_slot=run_slot,
        funnel=funnel,
        crm=crm,
        settings=settings,
        meter=SerpApiMeter(settings, state_path=tmp_path / "usage.json", today=today),
        title_stats=GoogleTitleStats(settings, state_path=tmp_path / "titles.json", today=today),
        today=today,
    )
    return controller, funnel


# -- schedule gate -----------------------------------------------------------


def test_schedule_allows_am_weekday():
    schedule = {"runs": ["am"], "days": "weekdays"}
    ok, reason = schedule_allows(schedule, run_slot="am", day=FRIDAY)
    assert ok and reason is None


def test_schedule_blocks_pm_run_and_weekend():
    schedule = {"runs": ["am"], "days": "weekdays"}
    ok, reason = schedule_allows(schedule, run_slot="pm", day=FRIDAY)
    assert not ok and "pm" in reason
    ok, reason = schedule_allows(schedule, run_slot="am", day=SATURDAY)
    assert not ok and "saturday" in reason


def test_board_schedule_default_and_env_override(monkeypatch):
    assert board_schedule_for({}, "google") == {"runs": ["am"], "days": "weekdays"}
    config = {"board_schedules": {"google": {"runs": ["am", "pm"], "days": "all"}}}
    assert board_schedule_for(config, "google")["days"] == "all"
    monkeypatch.setenv("GOOGLE_BOARD_RUNS", "pm")
    monkeypatch.setenv("GOOGLE_BOARD_DAYS", "weekdays")
    schedule = board_schedule_for(config, "google")
    assert schedule == {"runs": ["pm"], "days": "weekdays"}


def test_pm_run_skips_google_as_schedule_gate_not_failure(tmp_path):
    controller, funnel = _controller(tmp_path, run_slot="pm")
    assert controller.schedule_blocked
    assert controller.google_intentionally_skipped
    assert controller.scrape({"name": "Manager — Charlotte, NC"}) == []
    assert any("schedule_gate" in s for s in funnel.board_skips)
    assert funnel.board_failures == []
    controller.finalize()
    assert funnel.serpapi_searches == 0


def test_saturday_skips_google(tmp_path):
    controller, funnel = _controller(tmp_path, run_slot="am", today=SATURDAY)
    assert controller.schedule_blocked
    assert any("schedule_gate" in s for s in funnel.board_skips)


def test_schedule_gate_bypass_env(tmp_path, monkeypatch):
    monkeypatch.setenv("SERPAPI_SCHEDULE_GATE_BYPASS", "1")
    controller, funnel = _controller(tmp_path, run_slot="pm")
    assert not controller.schedule_blocked
    assert funnel.board_skips == []


# -- budget guard --------------------------------------------------------------


def test_budget_guard_skips_google_and_alerts(tmp_path, monkeypatch):
    sent = []
    import src.credit_alert as credit_alert

    monkeypatch.setattr(
        credit_alert, "send_credit_alert", lambda **kw: sent.append(kw) or True
    )
    monkeypatch.setenv("ALERT_EMAIL", "ops@example.com")

    controller, funnel = _controller(
        tmp_path, crm_month_to_date=12500, monthly_plan=15000, budget_pct=0.8
    )
    assert controller.budget_blocked
    assert controller.scrape({"name": "Manager — Charlotte, NC"}) == []
    assert any("serpapi_budget" in f for f in funnel.board_failures)
    assert len(sent) == 1
    assert "budget" in sent[0]["subject"].lower()

    # Second search same run: no duplicate failure, no second email.
    controller.scrape({"name": "Director — Charlotte, NC"})
    assert sum("serpapi_budget" in f for f in funnel.board_failures) == 1
    assert len(sent) == 1


# -- zone collapse -------------------------------------------------------------


def test_zone_collapse_runs_only_google_zones(tmp_path, monkeypatch):
    calls = []

    def fake_paged(search, **kwargs):
        calls.append(search["name"])
        kwargs["meter"].record_search()
        return [_listing("https://x/1")], {
            "search": search["name"],
            "pages": [{"page": 1, "results": 1}],
            "searches_attempted": 1,
            "searches_failed": 0,
            "listings": 1,
            "new_listings": 1,
            "new_companies": 1,
            "stop_reason": "no_next_page",
        }

    monkeypatch.setattr(serpapi_google, "scrape_google_serpapi_paged", fake_paged)

    config = {"board_zones": {"google": ["Charlotte, NC"]}}
    controller, funnel = _controller(tmp_path, config=config)

    controller.scrape({"name": "Manager — Charlotte, NC", "zone_label": "Charlotte, NC"})
    controller.scrape({"name": "Manager — Concord, NC", "zone_label": "Concord, NC"})
    controller.scrape({"name": "Manager — Gastonia, NC", "zone_label": "Gastonia, NC"})

    assert calls == ["Manager — Charlotte, NC"]
    assert funnel.google_zone_queries_skipped == 2
    assert funnel.google_zones_used == ["Charlotte, NC"]
    assert funnel.board_failures == []


def test_yaml_fallback_searches_without_zone_metadata_still_run(tmp_path, monkeypatch):
    monkeypatch.setattr(
        serpapi_google,
        "scrape_google_serpapi_paged",
        lambda search, **kw: ([], {"search": search["name"], "pages": [], "searches_attempted": 0, "searches_failed": 0, "listings": 0, "new_listings": 0, "new_companies": 0, "stop_reason": "no_api_key"}),
    )
    controller, funnel = _controller(tmp_path, config={})
    controller.scrape({"name": "Market scan — West Palm Beach, FL"})
    assert funnel.google_zone_queries_skipped == 0


# -- run cap -----------------------------------------------------------------


def test_run_cap_stops_google_loudly_and_run_continues(tmp_path, monkeypatch):
    def fake_paged(search, **kwargs):
        meter = kwargs["meter"]
        for _ in range(3):
            if meter.run_cap_reached:
                return [], {
                    "search": search["name"], "pages": [], "searches_attempted": 0,
                    "searches_failed": 0, "listings": 0, "new_listings": 0,
                    "new_companies": 0, "stop_reason": "run_cap",
                }
            meter.record_search()
        return [_listing(f"https://x/{search['name']}")], {
            "search": search["name"], "pages": [{"page": 1, "results": 1}],
            "searches_attempted": 3, "searches_failed": 0, "listings": 1,
            "new_listings": 1, "new_companies": 1, "stop_reason": "no_next_page",
        }

    monkeypatch.setattr(serpapi_google, "scrape_google_serpapi_paged", fake_paged)

    controller, funnel = _controller(tmp_path, run_cap=5)
    controller.scrape({"name": "A — Charlotte, NC"})  # 3 searches
    controller.scrape({"name": "B — Charlotte, NC"})  # hits cap at 5
    controller.scrape({"name": "C — Charlotte, NC"})  # skipped entirely

    assert any("serpapi_run_cap" in f for f in funnel.board_failures)
    assert sum("serpapi_run_cap" in f for f in funnel.board_failures) == 1
    controller.finalize()
    assert funnel.serpapi_searches == 5  # never exceeds the cap


# -- adaptive ------------------------------------------------------------------


def test_adaptive_skip_listed_in_funnel(tmp_path, monkeypatch):
    monkeypatch.setattr(
        serpapi_google,
        "scrape_google_serpapi_paged",
        lambda search, **kw: ([], {"search": search["name"], "pages": [], "searches_attempted": 1, "searches_failed": 0, "listings": 0, "new_listings": 0, "new_companies": 0, "stop_reason": "empty_page"}),
    )
    config = {"settings": {"market_label": "Charlotte, NC"}}
    controller, funnel = _controller(
        tmp_path, config=config, adaptive_empty_runs=1, adaptive_interval_days=5
    )
    # One empty run demotes (threshold=1); title stats persist via tmp files.
    controller.title_stats.record_run("Charlotte, NC", "Manager", new_companies=0)
    controller.scrape({"name": "Manager — Charlotte, NC", "zone_label": None})
    assert any("adaptive" in s for s in funnel.google_adaptive_skips)


# -- meter totals + usage events ----------------------------------------------


def test_finalize_writes_meter_to_funnel_and_posts_usage(tmp_path, monkeypatch):
    def fake_paged(search, **kwargs):
        kwargs["meter"].record_search()
        kwargs["meter"].record_search(failed=True)
        return [_listing("https://x/1")], {
            "search": search["name"], "pages": [{"page": 1, "results": 1}],
            "searches_attempted": 2, "searches_failed": 1, "listings": 1,
            "new_listings": 1, "new_companies": 1, "stop_reason": "error",
        }

    monkeypatch.setattr(serpapi_google, "scrape_google_serpapi_paged", fake_paged)
    crm = FakeCRM()
    controller, funnel = _controller(tmp_path, crm=crm, crm_month_to_date=100)
    controller.scrape({"name": "Manager — Charlotte, NC"})
    controller.finalize()

    assert funnel.serpapi_searches == 2
    assert funnel.serpapi_searches_failed == 1
    assert funnel.serpapi_month_to_date == 102  # max(local, CRM) + this run
    assert len(crm.usage_batches) == 1
    event = crm.usage_batches[0][0]
    assert event["provider"] == "serpapi"
    assert event["estimated_cost"] == 2


# -- known-listing checker -----------------------------------------------------


def test_known_checker_computes_new_ratio_inputs():
    crm = FakeCRM(known_urls={"https://x/old"}, known_companies={"oldco"})
    checker = KnownListingChecker(crm)
    result = checker.classify(
        [
            _listing("https://x/old", "OldCo"),
            _listing("https://x/new1", "NewCo"),
            _listing("https://x/new2", "NewCo"),
        ]
    )
    assert result["new_urls"] == 2
    assert result["new_companies"] == {"newco"}

    # Same URLs on a later page are resights within the run — nothing new.
    repeat = checker.classify([_listing("https://x/new1", "NewCo")])
    assert repeat["new_urls"] == 0
    assert crm.calls == 1  # second page fully cache-served


def test_known_checker_returns_none_on_crm_outage():
    checker = KnownListingChecker(FakeCRM(fail=True))
    assert checker.classify([_listing("https://x/1")]) is None
