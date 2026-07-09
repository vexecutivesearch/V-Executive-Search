#!/usr/bin/env python3
"""Scrape all job listings for a location within a lookback window."""

from __future__ import annotations

import argparse
import csv
import logging
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))

from src.scrape import DEFAULT_BOARDS, normalize_boards  # noqa: E402

logger = logging.getLogger(__name__)

BROAD_SEARCH_TERMS = [
    " ",
    "manager",
    "assistant",
    "sales",
    "customer service",
    "nurse",
    "driver",
    "technician",
    "engineer",
    "director",
    "coordinator",
    "specialist",
    "associate",
    "analyst",
    "representative",
    "supervisor",
    "administrative",
    "accountant",
    "teacher",
    "receptionist",
]


def _clean_str(value: object) -> str:
    text = str(value or "").strip()
    return "" if text.lower() == "nan" else text


def _normalize_location(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().lower())


def location_matches_west_palm_beach(location: str) -> bool:
    loc = _normalize_location(location)
    return bool(loc and "west palm beach" in loc)


def _parse_posted(value: str) -> datetime | None:
    if not value or value.lower() == "nan":
        return None
    try:
        return datetime.fromisoformat(value[:10])
    except ValueError:
        return None


def scrape_location_listings(
    *,
    location: str,
    days: int,
    results_wanted: int,
    distance: int,
    boards: list[str],
) -> list[dict]:
    boards = normalize_boards(boards)
    hours_old = days * 24
    cutoff = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(
        days=days
    )
    raw_listings: list[dict] = []

    for term in BROAD_SEARCH_TERMS:
        for board in boards:
            for offset in (0, results_wanted, results_wanted * 2):
                try:
                    kwargs: dict = {
                        "site_name": [board],
                        "search_term": term,
                        "location": location,
                        "results_wanted": results_wanted,
                        "hours_old": hours_old,
                        "country_indeed": "USA",
                        "distance": distance,
                        "offset": offset,
                        "linkedin_fetch_description": False,
                    }
                    if board == "google":
                        kwargs["google_search_term"] = (
                            f"jobs {location} posted last {days} days"
                        )

                    from jobspy import scrape_jobs

                    df = scrape_jobs(**kwargs)
                except Exception as exc:
                    logger.warning(
                        "Search failed board=%s term=%r offset=%s: %s",
                        board,
                        term,
                        offset,
                        exc,
                    )
                    continue

                if df is None or df.empty:
                    continue

                site_col = "site" if "site" in df.columns else None
                for _, row in df.iterrows():
                    listing_location = _clean_str(row.get("location"))
                    if not location_matches_west_palm_beach(listing_location):
                        continue

                    posted_raw = row.get("date_posted")
                    date_posted = ""
                    posted_dt: datetime | None = None
                    if posted_raw is not None and str(posted_raw).lower() != "nan":
                        date_posted = str(posted_raw)[:10]
                        posted_dt = _parse_posted(date_posted)

                    if posted_dt and posted_dt < cutoff:
                        continue

                    board_name = (
                        _clean_str(row[site_col]).lower()
                        if site_col and row.get(site_col) is not None
                        else board
                    )

                    raw_listings.append(
                        {
                            "title": _clean_str(row.get("title")),
                            "company": _clean_str(row.get("company")),
                            "location": listing_location,
                            "date_posted": date_posted,
                            "board": board_name or board,
                            "job_url": _clean_str(row.get("job_url") or row.get("link")),
                        }
                    )

    # Dedupe by URL across boards
    seen_urls: set[str] = set()
    rows: list[dict] = []
    for row in raw_listings:
        url = row.get("job_url") or ""
        if url:
            if url in seen_urls:
                continue
            seen_urls.add(url)
        rows.append(row)

    rows.sort(key=lambda r: (r["date_posted"], r["company"], r["title"]), reverse=True)
    return rows


def write_csv(rows: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = ["title", "company", "location", "date_posted", "board", "job_url"]
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="Scrape jobs for a location")
    parser.add_argument("--location", default="West Palm Beach, FL")
    parser.add_argument("--days", type=int, default=15)
    parser.add_argument("--results-wanted", type=int, default=200)
    parser.add_argument("--distance", type=int, default=5)
    parser.add_argument(
        "--boards",
        default=",".join(DEFAULT_BOARDS),
        help="Comma-separated boards (indeed,google,linkedin,zip_recruiter)",
    )
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()

    load_dotenv(WORKER_ROOT / ".env")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    boards = [b.strip() for b in args.boards.split(",") if b.strip()]
    slug = re.sub(r"[^a-z0-9]+", "_", args.location.lower()).strip("_")
    out = args.output or WORKER_ROOT / "output" / f"{slug}_{args.days}d_{datetime.now().date()}.csv"

    logger.info(
        "Scraping %s — last %d days, boards=%s",
        args.location,
        args.days,
        boards,
    )

    rows = scrape_location_listings(
        location=args.location,
        days=args.days,
        results_wanted=args.results_wanted,
        distance=args.distance,
        boards=boards,
    )
    write_csv(rows, out)

    logger.info("Found %d unique listings (location + date filtered)", len(rows))
    logger.info("Wrote %s", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
