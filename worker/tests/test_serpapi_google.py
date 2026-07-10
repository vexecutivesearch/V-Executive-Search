"""Unit tests for SerpApi Google Jobs mapping (no live API calls)."""

from src.serpapi_google import (
    _job_url,
    _parse_posted_at,
    _row_to_listing,
    _serpapi_location,
    _serpapi_query,
)


def test_serpapi_location_expands_fl():
    assert _serpapi_location("West Palm Beach, FL") == (
        "West Palm Beach, Florida, United States"
    )


def test_serpapi_query_strips_near_clause():
    q = _serpapi_query(
        {
            "google_search_term": "jobs near West Palm Beach, FL posted in the last week",
            "location": "West Palm Beach, FL",
            "search_term": " ",
            "hours_old": 168,
        }
    )
    assert "near" not in q.lower()
    assert "posted in the last week" in q
    assert q.startswith("jobs")


def test_row_to_listing_maps_apply_link():
    job = {
        "title": "Manager",
        "company_name": "Acme Corp",
        "location": "Boca Raton, FL",
        "share_link": "https://google.example/share",
        "apply_options": [{"title": "Indeed", "link": "https://indeed.example/job/1"}],
        "detected_extensions": {"posted_at": "3 days ago"},
    }
    listing = _row_to_listing(job, "Market scan — Boca Raton, FL")
    assert listing is not None
    assert listing.board == "google"
    assert listing.job_url == "https://indeed.example/job/1"
    assert listing.company_name == "Acme Corp"
    assert listing.date_posted is not None


def test_job_url_falls_back_to_share():
    assert _job_url({"share_link": "https://google.example/x"}) == "https://google.example/x"


def test_parse_posted_at_days():
    assert _parse_posted_at("5 days ago") is not None
