from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

import pandas as pd
from jobspy import scrape_jobs

from src.models import JobListing
from src.linkedin_posters import attach_linkedin_hiring_teams

logger = logging.getLogger(__name__)

ALLOWED_BOARDS = frozenset(
    {"indeed", "google", "linkedin", "zip_recruiter", "glassdoor"}
)
DEFAULT_BOARDS = ["linkedin", "indeed", "google", "zip_recruiter"]

# Scrape LinkedIn first — smaller result sets + hiring-team fetch is LinkedIn-only.
BOARD_PRIORITY = {
    "linkedin": 0,
    "indeed": 1,
    "google": 2,
    "zip_recruiter": 3,
    "glassdoor": 4,
}


def normalize_boards(boards: list[str] | None) -> list[str]:
    if not boards:
        raw = list(DEFAULT_BOARDS)
    else:
        raw = []
        for board in boards:
            b = str(board).strip().lower()
            if b in ALLOWED_BOARDS and b not in raw:
                raw.append(b)
        if not raw:
            raw = list(DEFAULT_BOARDS)
    return sorted(raw, key=lambda b: BOARD_PRIORITY.get(b, 99))


def _parse_date(value: Any) -> datetime | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    if isinstance(value, datetime):
        return value
    try:
        return pd.to_datetime(value).to_pydatetime()
    except (ValueError, TypeError):
        return None


def _normalize_listing(row: pd.Series, search_name: str, board: str) -> JobListing | None:
    company = row.get("company")
    title = row.get("title")
    if not company or not title or pd.isna(company) or pd.isna(title):
        return None

    job_url = row.get("job_url") or row.get("link") or ""
    location = row.get("location") or ""
    if pd.isna(location):
        location = ""

    return JobListing(
        company_name=str(company).strip(),
        job_title=str(title).strip(),
        location=str(location).strip(),
        board=board,
        job_url=str(job_url).strip() if job_url and not pd.isna(job_url) else "",
        date_posted=_parse_date(row.get("date_posted")),
        search_name=search_name,
    )


def _dedupe_listings(listings: list[JobListing]) -> list[JobListing]:
    seen_urls: set[str] = set()
    seen_keys: set[str] = set()
    out: list[JobListing] = []

    for listing in listings:
        url = listing.job_url.strip().lower()
        if url:
            if url in seen_urls:
                continue
            seen_urls.add(url)
        else:
            key = (
                f"{listing.company_name.lower()}|"
                f"{listing.job_title.lower()}|"
                f"{listing.board.lower()}"
            )
            if key in seen_keys:
                continue
            seen_keys.add(key)
        out.append(listing)

    return out


def _scrape_search_board(search: dict[str, Any], board: str) -> list[JobListing]:
    name = search.get("name", "unnamed")

    kwargs: dict[str, Any] = {
        "site_name": [board],
        "search_term": search["search_term"],
        "location": search.get("location", ""),
        "results_wanted": search.get("results_wanted", 50),
        "hours_old": search.get("hours_old", 24),
        "country_indeed": search.get("country_indeed", "USA"),
        "linkedin_fetch_description": False,
    }

    if board == "linkedin":
        # LinkedIn returns fewer rows for niche geo searches — widen the window.
        kwargs["results_wanted"] = min(
            30,
            int(search.get("linkedin_results_wanted") or search.get("results_wanted", 30)),
        )
        kwargs["hours_old"] = int(
            search.get("linkedin_hours_old")
            or max(int(search.get("hours_old", 24)), 168)
        )

    if board == "google" and search.get("google_search_term"):
        kwargs["google_search_term"] = search["google_search_term"]
    if search.get("is_remote") is not None:
        kwargs["is_remote"] = search["is_remote"]

    listings: list[JobListing] = []

    try:
        df = scrape_jobs(**kwargs)
    except Exception as exc:
        logger.error("Search '%s' board=%s failed: %s", name, board, exc)
        return listings

    if df is None or df.empty:
        logger.info("Search '%s' board=%s returned no results", name, board)
        return listings

    site_col = "site" if "site" in df.columns else None
    for _, row in df.iterrows():
        row_board = (
            str(row[site_col]).strip().lower()
            if site_col and not pd.isna(row.get(site_col))
            else board
        )
        listing = _normalize_listing(row, name, row_board or board)
        if listing:
            listings.append(listing)

    return listings


def run_search(search: dict[str, Any], boards: list[str]) -> list[JobListing]:
    name = search.get("name", "unnamed")
    boards = normalize_boards(boards)
    logger.info("Scraping search: %s (boards=%s)", name, ",".join(boards))

    merged: list[JobListing] = []
    for board in boards:
        board_listings = _scrape_search_board(search, board)
        logger.info(
            "Search '%s' board=%s yielded %d listings",
            name,
            board,
            len(board_listings),
        )
        merged.extend(board_listings)

    deduped = _dedupe_listings(merged)
    logger.info(
        "Search '%s' total %d listings after dedupe across %d board(s)",
        name,
        len(deduped),
        len(boards),
    )
    return deduped


def scrape_all(config: dict[str, Any]) -> list[JobListing]:
    boards = normalize_boards(config.get("boards"))
    logger.info("Job boards enabled: %s", ", ".join(boards))
    all_listings: list[JobListing] = []

    for search in config.get("searches", []):
        all_listings.extend(run_search(search, boards))

    logger.info("Total listings scraped: %d", len(all_listings))

    linkedin_count = sum(1 for listing in all_listings if listing.board == "linkedin")
    indeed_count = sum(1 for listing in all_listings if listing.board == "indeed")
    logger.info(
        "Board mix: linkedin=%d indeed=%d total=%d",
        linkedin_count,
        indeed_count,
        len(all_listings),
    )
    if linkedin_count:
        posters_found = attach_linkedin_hiring_teams(all_listings)
        logger.info("LinkedIn hiring-team posters captured: %d", posters_found)

    return all_listings
