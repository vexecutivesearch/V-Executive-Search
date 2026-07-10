"""Tests for LinkedIn multi-draw union dedupe."""

from src.models import JobListing
from src.scrape import _dedupe_listings


def _listing(url: str, company: str = "Acme", title: str = "HR Director") -> JobListing:
    return JobListing(
        company_name=company,
        job_title=title,
        location="West Palm Beach, FL",
        board="linkedin",
        job_url=url,
        date_posted=None,
        search_name="test",
    )


def test_dedupe_by_url_keeps_first():
    a = _listing("https://linkedin.com/jobs/view/111")
    b = _listing("https://linkedin.com/jobs/view/111", title="Other title")
    out = _dedupe_listings([a, b])
    assert len(out) == 1
    assert out[0].job_title == "HR Director"


def test_union_simulation_merges_draws():
    draw1 = [
        _listing("https://linkedin.com/jobs/view/1"),
        _listing("https://linkedin.com/jobs/view/2"),
    ]
    draw2 = [
        _listing("https://linkedin.com/jobs/view/2"),
        _listing("https://linkedin.com/jobs/view/3"),
    ]
    unioned = _dedupe_listings(draw1 + draw2)
    urls = {x.job_url for x in unioned}
    assert urls == {
        "https://linkedin.com/jobs/view/1",
        "https://linkedin.com/jobs/view/2",
        "https://linkedin.com/jobs/view/3",
    }
