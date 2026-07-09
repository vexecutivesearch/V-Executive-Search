from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

import pandas as pd
from jobspy import scrape_jobs

from src.models import JobListing

logger = logging.getLogger(__name__)

ALLOWED_BOARDS = frozenset(
    {"indeed", "google", "linkedin", "zip_recruiter", "glassdoor"}
)
DEFAULT_BOARDS = ["indeed", "google", "linkedin", "zip_recruiter"]


def normalize_boards(boards: list[str] | None) -> list[str]:
    if not boards:
        return list(DEFAULT_BOARDS)
    out: list[str] = []
    for raw in boards:
        board = str(raw).strip().lower()
        if board in ALLOWED_BOARDS and board not in out:
            out.append(board)
    return out or list(DEFAULT_BOARDS)


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


def run_search(search: dict[str, Any], boards: list[str]) -> list[JobListing]:
    name = search.get("name", "unnamed")
    boards = normalize_boards(boards)
    logger.info("Scraping search: %s (boards=%s)", name, ",".join(boards))

    kwargs: dict[str, Any] = {
        "site_name": boards,
        "search_term": search["search_term"],
        "location": search.get("location", ""),
        "results_wanted": search.get("results_wanted", 50),
        "hours_old": search.get("hours_old", 24),
        "country_indeed": search.get("country_indeed", "USA"),
        "linkedin_fetch_description": False,
    }

    if search.get("google_search_term"):
        kwargs["google_search_term"] = search["google_search_term"]
    if search.get("is_remote") is not None:
        kwargs["is_remote"] = search["is_remote"]

    listings: list[JobListing] = []

    try:
        df = scrape_jobs(**kwargs)
    except Exception as exc:
        logger.error("Search '%s' failed: %s", name, exc)
        return listings

    if df is None or df.empty:
        logger.warning("Search '%s' returned no results", name)
        return listings

    site_col = "site" if "site" in df.columns else None
    for _, row in df.iterrows():
        board = str(row[site_col]) if site_col and not pd.isna(row.get(site_col)) else "unknown"
        listing = _normalize_listing(row, name, board)
        if listing:
            listings.append(listing)

    logger.info("Search '%s' yielded %d listings", name, len(listings))
    return listings


def scrape_all(config: dict[str, Any]) -> list[JobListing]:
    boards = normalize_boards(config.get("boards"))
    logger.info("Job boards enabled: %s", ", ".join(boards))
    all_listings: list[JobListing] = []

    for search in config.get("searches", []):
        all_listings.extend(run_search(search, boards))

    logger.info("Total listings scraped: %d", len(all_listings))
    return all_listings
