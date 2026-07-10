from __future__ import annotations

import logging
import os
import random
import time
from datetime import datetime
from typing import Any

import pandas as pd
from jobspy import scrape_jobs

from src.funnel import ScrapeFunnel
from src.models import JobListing

logger = logging.getLogger(__name__)

ALLOWED_BOARDS = frozenset(
    {"indeed", "google", "linkedin", "zip_recruiter", "glassdoor"}
)
DEFAULT_BOARDS = ["linkedin", "indeed", "google", "zip_recruiter"]

# LinkedIn guest API returns different subsets per call — union multiple draws.
LINKEDIN_DRAW_COUNT = max(1, int(os.getenv("LINKEDIN_DRAW_COUNT", "3")))
# Pause between draws (seconds) — avoid back-to-back hits on residential IP.
LINKEDIN_DRAW_JITTER_MIN = float(os.getenv("LINKEDIN_DRAW_JITTER_MIN", "4"))
LINKEDIN_DRAW_JITTER_MAX = float(os.getenv("LINKEDIN_DRAW_JITTER_MAX", "12"))

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


def _board_kwargs(search: dict[str, Any], board: str) -> dict[str, Any]:
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
        kwargs["results_wanted"] = min(
            30,
            int(search.get("linkedin_results_wanted") or search.get("results_wanted", 30)),
        )
        kwargs["hours_old"] = int(
            search.get("linkedin_hours_old")
            or max(int(search.get("hours_old", 24)), 168)
        )
        distance = search.get("linkedin_distance")
        if distance is not None and str(distance).strip() != "":
            kwargs["distance"] = int(distance)

    if board == "google" and search.get("google_search_term"):
        kwargs["google_search_term"] = search["google_search_term"]
    if search.get("is_remote") is not None:
        kwargs["is_remote"] = search["is_remote"]

    return kwargs


def _dataframe_to_listings(
    df: pd.DataFrame | None,
    search_name: str,
    board: str,
) -> list[JobListing]:
    listings: list[JobListing] = []
    if df is None or df.empty:
        return listings

    site_col = "site" if "site" in df.columns else None
    for _, row in df.iterrows():
        row_board = (
            str(row[site_col]).strip().lower()
            if site_col and not pd.isna(row.get(site_col))
            else board
        )
        listing = _normalize_listing(row, search_name, row_board or board)
        if listing:
            listings.append(listing)
    return listings


def _scrape_search_board(search: dict[str, Any], board: str) -> list[JobListing]:
    name = search.get("name", "unnamed")
    kwargs = _board_kwargs(search, board)

    try:
        df = scrape_jobs(**kwargs)
    except Exception as exc:
        logger.error("Search '%s' board=%s failed: %s", name, board, exc)
        return []

    if df is None or df.empty:
        logger.info("Search '%s' board=%s returned no results", name, board)
        return []

    listings = _dataframe_to_listings(df, name, board)
    return listings


def _scrape_linkedin_union(
    search: dict[str, Any],
) -> tuple[list[JobListing], dict[str, Any]]:
    """Fetch LinkedIn multiple times and union — mitigates JobSpy paginator variance."""
    name = search.get("name", "unnamed")
    kwargs = _board_kwargs(search, "linkedin")
    draw_counts: list[int] = []
    merged: list[JobListing] = []

    for draw in range(1, LINKEDIN_DRAW_COUNT + 1):
        try:
            df = scrape_jobs(**kwargs)
        except Exception as exc:
            logger.error(
                "Search '%s' LinkedIn draw %d/%d failed: %s",
                name,
                draw,
                LINKEDIN_DRAW_COUNT,
                exc,
            )
            draw_counts.append(0)
            continue

        batch = _dataframe_to_listings(df, name, "linkedin")
        draw_counts.append(len(batch))
        merged.extend(batch)
        logger.info(
            "Search '%s' LinkedIn draw %d/%d yielded %d listings",
            name,
            draw,
            LINKEDIN_DRAW_COUNT,
            len(batch),
        )

        if draw < LINKEDIN_DRAW_COUNT:
            delay = random.uniform(LINKEDIN_DRAW_JITTER_MIN, LINKEDIN_DRAW_JITTER_MAX)
            logger.info(
                "Search '%s' LinkedIn draw pause %.1fs before draw %d",
                name,
                delay,
                draw + 1,
            )
            time.sleep(delay)

    unioned = _dedupe_listings(merged)
    stats = {
        "search": name,
        "linkedin_draws": draw_counts,
        "linkedin_raw_sum": sum(draw_counts),
        "linkedin_union": len(unioned),
        "linkedin_distance": search.get("linkedin_distance"),
    }
    logger.info(
        "Search '%s' LinkedIn union: draws=%s raw_sum=%d union=%d",
        name,
        draw_counts,
        stats["linkedin_raw_sum"],
        stats["linkedin_union"],
    )
    return unioned, stats


def run_search(search: dict[str, Any], boards: list[str]) -> list[JobListing]:
    name = search.get("name", "unnamed")
    boards = normalize_boards(boards)
    logger.info("Scraping search: %s (boards=%s)", name, ",".join(boards))

    merged: list[JobListing] = []
    for board in boards:
        if board == "linkedin":
            board_listings, _stats = _scrape_linkedin_union(search)
        else:
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


def scrape_all(config: dict[str, Any]) -> tuple[list[JobListing], ScrapeFunnel]:
    boards = normalize_boards(config.get("boards"))
    funnel = ScrapeFunnel()
    logger.info(
        "Job boards enabled: %s (LinkedIn draws/search=%d)",
        ", ".join(boards),
        LINKEDIN_DRAW_COUNT,
    )
    all_listings: list[JobListing] = []
    linkedin_raw_sum = 0

    for search in config.get("searches", []):
        name = search.get("name", "unnamed")
        if "linkedin" in boards:
            li_union, stats = _scrape_linkedin_union(search)
            linkedin_raw_sum += stats["linkedin_raw_sum"]
            funnel.linkedin_per_search.append(stats)
            # Non-LinkedIn boards via run_search would re-scrape LinkedIn — build manually.
            merged = list(li_union)
            for board in boards:
                if board == "linkedin":
                    continue
                merged.extend(_scrape_search_board(search, board))
            search_listings = _dedupe_listings(merged)
        else:
            search_listings = run_search(search, boards)

        logger.info(
            "Search '%s' ingested %d listings",
            name,
            len(search_listings),
        )
        all_listings.extend(search_listings)

    funnel.scrape_linkedin_raw = linkedin_raw_sum
    funnel.scrape_total = len(all_listings)
    funnel.scrape_linkedin_deduped = sum(
        1 for listing in all_listings if listing.board == "linkedin"
    )
    logger.info("Total listings scraped: %d", len(all_listings))

    linkedin_count = funnel.scrape_linkedin_deduped
    indeed_count = sum(1 for listing in all_listings if listing.board == "indeed")
    logger.info(
        "Board mix: linkedin=%d indeed=%d total=%d (linkedin raw_sum=%d cap/search=%d)",
        linkedin_count,
        indeed_count,
        len(all_listings),
        linkedin_raw_sum,
        funnel.scrape_linkedin_cap_per_search,
    )
    if linkedin_count:
        from src.linkedin_posters import attach_linkedin_hiring_teams

        posters_found = attach_linkedin_hiring_teams(all_listings, funnel=funnel)
        logger.info("LinkedIn hiring-team posters captured: %d", posters_found)
        logger.info(
            "Poster funnel: fetched=%d public_block=%d meet_team_html=%d parsed_listings=%d",
            funnel.poster_pages_fetched,
            funnel.poster_public_block_in_html,
            funnel.meet_team_in_html,
            funnel.poster_parsed,
        )

    return all_listings, funnel
