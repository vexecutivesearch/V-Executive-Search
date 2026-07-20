"""scrape_all + Google schedule gate: the 6 PM run issues ZERO SerpApi calls
but still scrapes Indeed/LinkedIn in full; the AM weekday run meters Google."""

from datetime import date

import pandas as pd
import pytest

import src.scrape as scrape_mod
import src.serpapi_google as sg


FRIDAY = date(2026, 7, 17)


@pytest.fixture
def gated_env(monkeypatch, tmp_path):
    monkeypatch.setenv("SERPAPI_API_KEY", "test-key")
    monkeypatch.setenv("SERPAPI_USAGE_FILE", str(tmp_path / "usage.json"))
    monkeypatch.setenv("GOOGLE_TITLE_STATS_FILE", str(tmp_path / "titles.json"))
    monkeypatch.delenv("CRM_API_URL", raising=False)
    monkeypatch.delenv("CRM_API_KEY", raising=False)
    # Single draws, no jitter — unit test speed.
    monkeypatch.setattr(scrape_mod, "LINKEDIN_DRAW_COUNT", 1)
    monkeypatch.setattr(scrape_mod, "INDEED_DRAW_COUNT", 1)
    # Deterministic business day (Friday) for the weekday gate.
    monkeypatch.setattr("src.google_board.business_today", lambda: FRIDAY)
    monkeypatch.setattr("src.serpapi_budget.business_today", lambda: FRIDAY)


def _df(board: str) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "company": f"{board} Co",
                "title": "Manager",
                "location": "Charlotte, NC",
                "job_url": f"https://{board}.example/job/1",
            }
        ]
    )


CONFIG = {
    "boards": ["linkedin", "indeed", "google"],
    "searches": [
        {
            "name": "Manager — Charlotte, NC",
            "search_term": "manager",
            "location": "Charlotte, NC",
            "zone_label": "Charlotte, NC",
            "results_wanted": 10,
            "hours_old": 168,
        }
    ],
    "board_zones": {"google": ["Charlotte, NC"]},
    "settings": {"market_label": "Charlotte, NC"},
}


def test_pm_run_zero_serpapi_calls_free_boards_untouched(gated_env, monkeypatch):
    boards_scraped = []
    monkeypatch.setattr(
        scrape_mod,
        "scrape_jobs",
        lambda **kw: boards_scraped.append(kw["site_name"][0]) or _df(kw["site_name"][0]),
    )

    def forbidden(**kwargs):
        raise AssertionError("SerpApi must NEVER be called in the PM run")

    monkeypatch.setattr(sg, "_fetch_serpapi_page", forbidden)

    listings, funnel = scrape_mod.scrape_all(CONFIG, run_slot="pm")

    # Free boards scraped in full — the pipeline cadence is unchanged.
    assert boards_scraped == ["linkedin", "indeed"]
    assert funnel.scrape_by_board.get("linkedin") == 1
    assert funnel.scrape_by_board.get("indeed") == 1
    # Google skipped intentionally: board_skipped, NOT a board_failure.
    assert any("schedule_gate" in s for s in funnel.board_skips)
    assert funnel.board_failures == []
    assert funnel.serpapi_searches == 0


def test_saturday_am_run_zero_serpapi_calls(gated_env, monkeypatch):
    saturday = date(2026, 7, 18)
    monkeypatch.setattr("src.google_board.business_today", lambda: saturday)
    monkeypatch.setattr("src.serpapi_budget.business_today", lambda: saturday)
    monkeypatch.setattr(scrape_mod, "scrape_jobs", lambda **kw: _df(kw["site_name"][0]))
    monkeypatch.setattr(
        sg,
        "_fetch_serpapi_page",
        lambda **kw: (_ for _ in ()).throw(AssertionError("no SerpApi on Saturday")),
    )

    _, funnel = scrape_mod.scrape_all(CONFIG, run_slot="am")
    assert funnel.serpapi_searches == 0
    assert any("schedule_gate" in s for s in funnel.board_skips)
    assert funnel.board_failures == []


def test_run_cap_stops_google_but_run_completes_normally(gated_env, monkeypatch):
    """Acceptance: cap=5 stops Google at 5 searches, logs serpapi_run_cap,
    and the rest of the run (free boards, other titles) completes normally."""
    monkeypatch.setenv("SERPAPI_RUN_CAP", "5")
    monkeypatch.setattr(scrape_mod, "scrape_jobs", lambda **kw: _df(kw["site_name"][0]))

    serp_calls = {"n": 0}

    def endless_pages(**kwargs):
        serp_calls["n"] += 1
        return {
            "jobs_results": [
                {
                    "title": "Manager",
                    "company_name": f"Co {serp_calls['n']}",
                    "location": "Charlotte, NC",
                    "share_link": f"https://google.example/job/{serp_calls['n']}",
                }
            ],
            "serpapi_pagination": {"next_page_token": f"t{serp_calls['n']}"},
        }

    monkeypatch.setattr(sg, "_fetch_serpapi_page", endless_pages)
    monkeypatch.setattr(sg, "time", __import__("types").SimpleNamespace(sleep=lambda s: None))

    config = {
        **CONFIG,
        "searches": [
            {**CONFIG["searches"][0], "name": f"{title} — Charlotte, NC"}
            for title in ("Market scan", "Manager", "Director")
        ],
    }
    listings, funnel = scrape_mod.scrape_all(config, run_slot="am")

    assert serp_calls["n"] == 5  # hard stop at the cap
    assert funnel.serpapi_searches == 5
    assert any("serpapi_run_cap" in f for f in funnel.board_failures)
    # Free boards still scraped every search — the run completed normally.
    assert funnel.scrape_by_board.get("linkedin") == 3
    assert funnel.scrape_by_board.get("indeed") == 3


def test_weekday_am_run_meters_google(gated_env, monkeypatch):
    monkeypatch.setattr(scrape_mod, "scrape_jobs", lambda **kw: _df(kw["site_name"][0]))
    monkeypatch.setattr(
        sg,
        "_fetch_serpapi_page",
        lambda **kw: {
            "jobs_results": [
                {
                    "title": "Manager",
                    "company_name": "Google Co",
                    "location": "Charlotte, NC",
                    "share_link": "https://google.example/job/1",
                }
            ],
            "serpapi_pagination": {},
        },
    )

    listings, funnel = scrape_mod.scrape_all(CONFIG, run_slot="am")

    assert funnel.scrape_by_board.get("google") == 1
    assert funnel.serpapi_searches == 1
    assert funnel.serpapi_month_to_date == 1
    assert funnel.board_skips == []
    assert funnel.board_failures == []
    assert len(funnel.google_per_query) == 1
    assert funnel.google_per_query[0]["pages"][0]["results"] == 1
