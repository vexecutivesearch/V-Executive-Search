"""Marginal-yield pagination: continue while pages earn it, stop when a page
is mostly resights, ceilings are circuit breakers, lookup failure fails SAFE."""

from datetime import date

import src.serpapi_google as sg
from src.serpapi_budget import SerpApiMeter, SerpApiSettings


def _page(urls, next_token=None):
    return {
        "jobs_results": [
            {
                "title": "Manager",
                "company_name": f"Co {u}",
                "location": "Charlotte, NC",
                "share_link": u,
            }
            for u in urls
        ],
        "serpapi_pagination": {"next_page_token": next_token} if next_token else {},
    }


class FakePages:
    """Sequence of SerpApi page payloads (None = request failure)."""

    def __init__(self, pages):
        self.pages = list(pages)
        self.calls = 0

    def __call__(self, **kwargs):
        self.calls += 1
        return self.pages.pop(0) if self.pages else _page([])


class RatioClassifier:
    """Fixed per-page new ratios, in order."""

    def __init__(self, ratios):
        self.ratios = list(ratios)

    def classify(self, listings):
        ratio = self.ratios.pop(0) if self.ratios else 0.0
        if ratio is None:
            return None
        new = round(ratio * len(listings))
        return {"new_urls": new, "new_companies": set(list(range(new))[:new])}


def _meter(tmp_path, **kw):
    settings = SerpApiSettings(**kw)
    return SerpApiMeter(settings, state_path=tmp_path / "u.json", today=date(2026, 7, 17))


SEARCH = {"name": "Market scan — Charlotte, NC", "location": "Charlotte, NC", "search_term": " "}


def test_stops_when_yield_drops_below_threshold(tmp_path, monkeypatch):
    fetcher = FakePages(
        [
            _page([f"https://x/{i}" for i in range(10)], "t2"),
            _page([f"https://y/{i}" for i in range(10)], "t3"),
            _page([f"https://z/{i}" for i in range(10)], "t4"),
        ]
    )
    monkeypatch.setattr(sg, "_fetch_serpapi_page", lambda **kw: fetcher(**kw))

    listings, stats = sg.scrape_google_serpapi_paged(
        SEARCH,
        api_key="test",
        meter=_meter(tmp_path),
        page_classifier=RatioClassifier([0.9, 0.5, 0.1]),
        min_yield=0.3,
        max_pages=10,
        page_delay_seconds=0,
    )
    # Page 3 is mostly resights (0.1 < 0.3) → stop AFTER it, keep its listings.
    assert fetcher.calls == 3
    assert len(listings) == 30
    assert stats["stop_reason"] == "yield_below_threshold"
    ratios = [p["new_ratio"] for p in stats["pages"]]
    assert ratios == [0.9, 0.5, 0.1]


def test_cold_ceiling_is_circuit_breaker_not_target(tmp_path, monkeypatch):
    pages = [_page([f"https://p{i}/{j}" for j in range(10)], f"t{i}") for i in range(12)]
    fetcher = FakePages(pages)
    monkeypatch.setattr(sg, "_fetch_serpapi_page", lambda **kw: fetcher(**kw))

    _, stats = sg.scrape_google_serpapi_paged(
        SEARCH,
        api_key="test",
        meter=_meter(tmp_path),
        page_classifier=RatioClassifier([1.0] * 12),  # everything new: cold market
        min_yield=0.3,
        max_pages=10,
        page_delay_seconds=0,
    )
    assert fetcher.calls == 10
    assert stats["stop_reason"] == "max_pages"
    assert len(stats["pages"]) == 10


def test_lookup_failure_stops_pagination_fail_safe(tmp_path, monkeypatch):
    fetcher = FakePages(
        [
            _page([f"https://x/{i}" for i in range(10)], "t2"),
            _page([f"https://y/{i}" for i in range(10)], "t3"),
        ]
    )
    monkeypatch.setattr(sg, "_fetch_serpapi_page", lambda **kw: fetcher(**kw))

    listings, stats = sg.scrape_google_serpapi_paged(
        SEARCH,
        api_key="test",
        meter=_meter(tmp_path),
        page_classifier=RatioClassifier([None]),  # CRM lookup down
        min_yield=0.3,
        max_pages=10,
        page_delay_seconds=0,
    )
    # Never spend blind on an unverifiable ratio: keep page 1, stop there.
    assert fetcher.calls == 1
    assert len(listings) == 10
    assert stats["stop_reason"] == "yield_lookup_unavailable"


def test_failed_request_counts_as_metered_attempt(tmp_path, monkeypatch):
    monkeypatch.setattr(sg, "_fetch_serpapi_page", lambda **kw: None)
    meter = _meter(tmp_path)

    listings, stats = sg.scrape_google_serpapi_paged(
        SEARCH,
        api_key="test",
        meter=meter,
        min_yield=0.3,
        max_pages=5,
        page_delay_seconds=0,
    )
    assert listings == []
    assert stats["stop_reason"] == "error"
    assert stats["searches_attempted"] == 1
    assert stats["searches_failed"] == 1
    # A failed search still consumed a SerpApi attempt — meter it.
    assert meter.run_searches == 1
    assert meter.run_failed == 1


def test_run_cap_halts_mid_query(tmp_path, monkeypatch):
    pages = [_page([f"https://p{i}/{j}" for j in range(10)], f"t{i}") for i in range(5)]
    fetcher = FakePages(pages)
    monkeypatch.setattr(sg, "_fetch_serpapi_page", lambda **kw: fetcher(**kw))

    meter = _meter(tmp_path, run_cap=2)
    _, stats = sg.scrape_google_serpapi_paged(
        SEARCH,
        api_key="test",
        meter=meter,
        page_classifier=RatioClassifier([1.0] * 5),
        min_yield=0.3,
        max_pages=5,
        page_delay_seconds=0,
    )
    assert stats["stop_reason"] == "run_cap"
    assert meter.run_searches == 2


def test_steady_state_stops_after_one_or_two_pages(tmp_path, monkeypatch):
    fetcher = FakePages(
        [
            _page([f"https://x/{i}" for i in range(10)], "t2"),
            _page([f"https://y/{i}" for i in range(10)], "t3"),
        ]
    )
    monkeypatch.setattr(sg, "_fetch_serpapi_page", lambda **kw: fetcher(**kw))

    _, stats = sg.scrape_google_serpapi_paged(
        SEARCH,
        api_key="test",
        meter=_meter(tmp_path),
        page_classifier=RatioClassifier([0.2]),  # daily cadence: mostly resights
        min_yield=0.3,
        max_pages=5,
        page_delay_seconds=0,
    )
    # Self-tuning: page 1 already mostly resights → stop naturally.
    assert fetcher.calls == 1
    assert stats["stop_reason"] == "yield_below_threshold"


def test_legacy_wrapper_still_returns_listings(tmp_path, monkeypatch):
    fetcher = FakePages([_page([f"https://x/{i}" for i in range(10)])])
    monkeypatch.setattr(sg, "_fetch_serpapi_page", lambda **kw: fetcher(**kw))
    listings = sg.scrape_google_serpapi(
        {**SEARCH, "results_wanted": 5}, api_key="test"
    )
    assert len(listings) == 5
