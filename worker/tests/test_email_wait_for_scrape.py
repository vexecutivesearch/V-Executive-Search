"""email-only job waits for morning scrape ingest before sending."""

from __future__ import annotations

from src.email_report import wait_for_scrape_ingest


def test_wait_returns_immediately_when_listings_ready():
    sleeps: list[float] = []
    calls = {"n": 0}

    def fetch():
        calls["n"] += 1
        return {"listings_scraped": 1200, "leads": []}

    result = wait_for_scrape_ingest(
        timeout_seconds=120,
        poll_seconds=30,
        sleep_fn=sleeps.append,
        fetch_fn=fetch,
    )
    assert result is not None
    assert result["listings_scraped"] == 1200
    assert calls["n"] == 1
    assert sleeps == []


def test_wait_polls_until_ingest_appears():
    sleeps: list[float] = []
    payloads = [
        {"listings_scraped": 0},
        {"listings_scraped": 0},
        {"listings_scraped": 450},
    ]

    def fetch():
        return payloads.pop(0)

    result = wait_for_scrape_ingest(
        timeout_seconds=300,
        poll_seconds=10,
        sleep_fn=sleeps.append,
        fetch_fn=fetch,
    )
    assert result is not None
    assert result["listings_scraped"] == 450
    assert sleeps == [10, 10]


def test_wait_times_out_and_returns_last_payload():
    sleeps: list[float] = []

    def fetch():
        return {"listings_scraped": 0, "leads": []}

    # Fake clock via shrinking timeout: first loop remaining>0, then timeout.
    # sleep_fn records; we use timeout=5, poll=3 → one sleep then exit.
    result = wait_for_scrape_ingest(
        timeout_seconds=5,
        poll_seconds=3,
        sleep_fn=sleeps.append,
        fetch_fn=fetch,
    )
    assert result is not None
    assert result["listings_scraped"] == 0
    assert len(sleeps) >= 1
