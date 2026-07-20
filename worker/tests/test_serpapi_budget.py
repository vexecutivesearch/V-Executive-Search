"""SerpApi meter, caps, budget guard, and adaptive title stats."""

from datetime import date

from src.serpapi_budget import (
    GoogleTitleStats,
    SerpApiMeter,
    SerpApiSettings,
    load_serpapi_settings,
    serpapi_period_start,
)


def test_period_start_on_and_after_renewal_day():
    assert serpapi_period_start(11, date(2026, 7, 11)) == date(2026, 7, 11)
    assert serpapi_period_start(11, date(2026, 7, 19)) == date(2026, 7, 11)


def test_period_start_before_renewal_day_uses_prior_month():
    assert serpapi_period_start(11, date(2026, 7, 10)) == date(2026, 6, 11)


def test_period_start_january_wraps_to_december():
    assert serpapi_period_start(11, date(2026, 1, 5)) == date(2025, 12, 11)


def test_settings_defaults():
    s = load_serpapi_settings({})
    assert s.monthly_plan == 15000
    assert s.budget_pct == 0.8
    assert s.budget_threshold == 12000
    assert s.renewal_day == 11
    assert s.run_cap == 200
    assert s.page_min_yield == 0.3
    assert s.max_pages == 5
    assert s.max_pages_cold == 10
    assert s.adaptive_enabled is True


def test_settings_config_block_and_env_override(monkeypatch):
    config = {"serpapi": {"run_cap": 50, "monthly_plan": 5000, "month_to_date": 123}}
    monkeypatch.setenv("SERPAPI_RUN_CAP", "5")
    s = load_serpapi_settings(config)
    assert s.run_cap == 5  # env wins over CRM config
    assert s.monthly_plan == 5000  # CRM config wins over default
    assert s.crm_month_to_date == 123


def _meter(tmp_path, *, crm_mtd=0, today=date(2026, 7, 19), **overrides):
    settings = SerpApiSettings(crm_month_to_date=crm_mtd, **overrides)
    return SerpApiMeter(settings, state_path=tmp_path / "usage.json", today=today)


def test_meter_counts_and_persists(tmp_path):
    meter = _meter(tmp_path)
    meter.record_search()
    meter.record_search(failed=True)
    assert meter.run_searches == 2
    assert meter.run_failed == 1
    assert meter.month_to_date == 2

    # Failures consume attempts too — they persist in the monthly total.
    reloaded = _meter(tmp_path)
    assert reloaded.month_to_date == 2
    assert reloaded.month_failed == 1
    assert reloaded.run_searches == 0  # per-run counter starts fresh


def test_meter_resets_on_new_billing_period(tmp_path):
    meter = _meter(tmp_path, today=date(2026, 7, 19))
    for _ in range(5):
        meter.record_search()
    # Renewal day 11: August 12 is a new period → counter resets.
    rolled = _meter(tmp_path, today=date(2026, 8, 12))
    assert rolled.month_to_date == 0


def test_meter_reconciliation_is_max_local_crm(tmp_path):
    # CRM higher (local file wiped / partial) → adopt CRM: guard over-counts.
    meter = _meter(tmp_path, crm_mtd=900)
    assert meter.month_to_date == 900

    meter.record_search()
    assert meter.month_to_date == 901

    # Local higher (usage events failed to post) → keep local, ignore CRM.
    lower_crm = _meter(tmp_path, crm_mtd=10)
    assert lower_crm.month_to_date == 901


def test_run_cap_and_budget_flags(tmp_path):
    meter = _meter(tmp_path, run_cap=2, monthly_plan=10, budget_pct=0.5)
    assert not meter.run_cap_reached
    assert not meter.budget_tripped
    meter.record_search()
    meter.record_search()
    assert meter.run_cap_reached
    # threshold = 5
    for _ in range(3):
        meter.record_search()
    assert meter.budget_tripped


def test_budget_alert_deduped_per_day(tmp_path):
    meter = _meter(tmp_path)
    assert meter.should_send_budget_alert()
    meter.mark_budget_alert_sent()
    assert not meter.should_send_budget_alert()
    # Next day (new meter instance) it may alert again.
    tomorrow = _meter(tmp_path, today=date(2026, 7, 20))
    assert tomorrow.should_send_budget_alert()


def _stats(tmp_path, *, today=date(2026, 7, 19), **overrides):
    settings = SerpApiSettings(**overrides)
    return GoogleTitleStats(settings, state_path=tmp_path / "titles.json", today=today)


def test_adaptive_demotes_after_consecutive_empty_runs(tmp_path):
    stats = _stats(tmp_path, adaptive_empty_runs=3, adaptive_interval_days=2)
    for _ in range(3):
        stats.record_run("Charlotte, NC", "Manager", new_companies=0)
    assert stats.should_skip("Charlotte, NC", "Manager")
    # Other market untouched.
    assert not stats.should_skip("Dallas-Fort Worth, TX", "Manager")


def test_adaptive_runs_again_after_interval_and_promotes_on_new(tmp_path):
    day1 = date(2026, 7, 13)
    stats = _stats(tmp_path, today=day1, adaptive_empty_runs=3, adaptive_interval_days=2)
    for _ in range(3):
        stats.record_run("Charlotte, NC", "Manager", new_companies=0)

    # Interval elapsed → due again.
    later = _stats(tmp_path, today=date(2026, 7, 15), adaptive_empty_runs=3, adaptive_interval_days=2)
    assert not later.should_skip("Charlotte, NC", "Manager")

    # Any net-new result promotes straight back to daily.
    later.record_run("Charlotte, NC", "Manager", new_companies=2)
    next_day = _stats(tmp_path, today=date(2026, 7, 16), adaptive_empty_runs=3, adaptive_interval_days=2)
    assert not next_day.should_skip("Charlotte, NC", "Manager")


def test_adaptive_failed_searches_never_demote(tmp_path):
    stats = _stats(tmp_path, adaptive_empty_runs=1)
    stats.record_run("Charlotte, NC", "Manager", new_companies=0, had_failures=True)
    assert not stats.should_skip("Charlotte, NC", "Manager")


def test_adaptive_global_flag_reverts_to_daily(tmp_path):
    stats = _stats(tmp_path, adaptive_empty_runs=1, adaptive_interval_days=30)
    stats.record_run("Charlotte, NC", "Manager", new_companies=0)
    assert stats.should_skip("Charlotte, NC", "Manager")

    disabled = GoogleTitleStats(
        SerpApiSettings(adaptive_enabled=False, adaptive_empty_runs=1),
        state_path=tmp_path / "titles.json",
        today=date(2026, 7, 19),
    )
    assert not disabled.should_skip("Charlotte, NC", "Manager")
