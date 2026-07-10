from __future__ import annotations

import logging
import os
import random
import time
from datetime import datetime
from typing import Any

import pandas as pd
from jobspy import scrape_jobs

from src.funnel import ScrapeFunnel, check_linkedin_per_search_invariants
from src.models import JobListing

logger = logging.getLogger(__name__)

ALLOWED_BOARDS = frozenset(
    {"indeed", "google", "linkedin", "zip_recruiter", "glassdoor"}
)
# Google omitted by default — JobSpy Google returns empty HTML; use SerpApi if needed.
DEFAULT_BOARDS = ["linkedin", "indeed", "zip_recruiter"]

# LinkedIn guest API returns different subsets per call — union multiple draws.
LINKEDIN_DRAW_COUNT = max(1, int(os.getenv("LINKEDIN_DRAW_COUNT", "3")))
LINKEDIN_DRAW_JITTER_MIN = float(os.getenv("LINKEDIN_DRAW_JITTER_MIN", "4"))
LINKEDIN_DRAW_JITTER_MAX = float(os.getenv("LINKEDIN_DRAW_JITTER_MAX", "12"))

# Indeed can flake empty under rate pressure — multi-draw + backoff like LinkedIn.
INDEED_DRAW_COUNT = max(1, int(os.getenv("INDEED_DRAW_COUNT", "3")))
INDEED_JITTER_MIN = float(os.getenv("INDEED_JITTER_MIN", "2"))
INDEED_JITTER_MAX = float(os.getenv("INDEED_JITTER_MAX", "6"))

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


def _parse_int(value: Any) -> int | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    try:
        return int(float(value))
    except (ValueError, TypeError):
        return None


def _salary_text(min_amt: int | None, max_amt: int | None, currency: str | None) -> str | None:
    if min_amt is None and max_amt is None:
        return None
    cur = currency or "USD"
    sym = "$" if cur.upper() == "USD" else f"{cur} "
    if min_amt is not None and max_amt is not None and min_amt != max_amt:
        return f"{sym}{min_amt:,}–{sym}{max_amt:,}"
    val = max_amt if max_amt is not None else min_amt
    return f"{sym}{val:,}" if val is not None else None


def _normalize_listing(row: pd.Series, search_name: str, board: str) -> JobListing | None:
    company = row.get("company")
    title = row.get("title")
    if not company or not title or pd.isna(company) or pd.isna(title):
        return None

    job_url = row.get("job_url") or row.get("link") or ""
    location = row.get("location") or ""
    if pd.isna(location):
        location = ""

    salary_min = _parse_int(row.get("min_amount"))
    salary_max = _parse_int(row.get("max_amount"))
    currency = row.get("currency")
    if currency is not None and not pd.isna(currency):
        currency = str(currency).strip() or None
    else:
        currency = None

    return JobListing(
        company_name=str(company).strip(),
        job_title=str(title).strip(),
        location=str(location).strip(),
        board=board,
        job_url=str(job_url).strip() if job_url and not pd.isna(job_url) else "",
        date_posted=_parse_date(row.get("date_posted")),
        search_name=search_name,
        salary_min=salary_min,
        salary_max=salary_max,
        salary_currency=currency,
        salary_text=_salary_text(salary_min, salary_max, currency),
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


def _google_recency_phrase(hours_old: int) -> str:
    if hours_old <= 24:
        return "posted since yesterday"
    if hours_old <= 72:
        return "posted in the last 3 days"
    if hours_old <= 168:
        return "posted in the last week"
    return "posted in the last month"


def build_google_search_term(search: dict[str, Any]) -> str:
    """Natural-language Google query for broad geo scrape (not contact titles).

    Examples:
      jobs near West Palm Beach, FL posted in the last week
      manager jobs near Boca Raton, FL posted in the last week
    """
    existing = (search.get("google_search_term") or "").strip()
    if existing and (" near " in existing.lower() or existing.lower().startswith("jobs near")):
        return existing
    if existing and "posted" in existing.lower() and " near " in existing.lower():
        return existing

    role = (search.get("search_term") or "").strip()
    location = (search.get("location") or "").strip()
    hours_old = int(search.get("hours_old") or 168)
    window = _google_recency_phrase(hours_old)
    head = f"{role} jobs" if role else "jobs"
    if location:
        return f"{head} near {location} {window}"
    return f"{head} {window}"


def _board_kwargs(search: dict[str, Any], board: str) -> dict[str, Any]:
    default_hours = 168 if board != "linkedin" else 24
    hours_old = int(search.get("hours_old") or default_hours)
    kwargs: dict[str, Any] = {
        "site_name": [board],
        "search_term": search["search_term"],
        "location": search.get("location", ""),
        "results_wanted": search.get("results_wanted", 50),
        "hours_old": hours_old,
        "country_indeed": search.get("country_indeed", "USA"),
        "linkedin_fetch_description": False,
    }

    distance = search.get("distance")
    if distance is None:
        distance = search.get("linkedin_distance")
    if distance is not None and str(distance).strip() != "":
        kwargs["distance"] = int(distance)
    elif board in ("indeed", "zip_recruiter"):
        # Cover WPB + nearby metro when scraping a hub city.
        kwargs["distance"] = 50

    if board == "linkedin":
        kwargs["results_wanted"] = min(
            30,
            int(search.get("linkedin_results_wanted") or search.get("results_wanted", 30)),
        )
        kwargs["hours_old"] = int(
            search.get("linkedin_hours_old")
            or max(int(search.get("hours_old") or 24), 168)
        )

    if board == "google":
        google_term = build_google_search_term({**search, "hours_old": hours_old})
        kwargs["google_search_term"] = google_term
        logger.info(
            "Google board params search=%r google_search_term=%r location=%r "
            "hours_old=%s results_wanted=%s",
            search.get("name"),
            google_term,
            kwargs.get("location"),
            kwargs.get("hours_old"),
            kwargs.get("results_wanted"),
        )

    if board == "indeed":
        logger.info(
            "Indeed board params search=%r search_term=%r location=%r "
            "results_wanted=%s hours_old=%s country_indeed=%r distance=%s",
            search.get("name"),
            kwargs.get("search_term"),
            kwargs.get("location"),
            kwargs.get("results_wanted"),
            kwargs.get("hours_old"),
            kwargs.get("country_indeed"),
            kwargs.get("distance"),
        )

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

    for attempt in range(1, 3):
        try:
            df = scrape_jobs(**kwargs)
        except Exception as exc:
            logger.error(
                "Search '%s' board=%s attempt %d failed: %s",
                name,
                board,
                attempt,
                exc,
            )
            if attempt == 1:
                time.sleep(3 + random.uniform(0, 2))
                continue
            return []

        if df is None or df.empty:
            logger.warning(
                "Search '%s' board=%s attempt %d returned no results",
                name,
                board,
                attempt,
            )
            if attempt == 1:
                time.sleep(2 + random.uniform(0, 2))
                continue
            return []

        return _dataframe_to_listings(df, name, board)

    return []


def _scrape_indeed_union(
    search: dict[str, Any],
) -> tuple[list[JobListing], dict[str, Any]]:
    """Multi-draw Indeed with backoff — distinguishes thin market from flake."""
    name = search.get("name", "unnamed")
    kwargs = _board_kwargs(search, "indeed")
    draw_counts: list[int] = []
    merged: list[JobListing] = []

    for draw in range(1, INDEED_DRAW_COUNT + 1):
        try:
            df = scrape_jobs(**kwargs)
        except Exception as exc:
            logger.error(
                "Search '%s' Indeed draw %d/%d failed: %s",
                name,
                draw,
                INDEED_DRAW_COUNT,
                exc,
            )
            draw_counts.append(0)
            if draw < INDEED_DRAW_COUNT:
                time.sleep(random.uniform(INDEED_JITTER_MIN, INDEED_JITTER_MAX))
            continue

        batch = _dataframe_to_listings(df, name, "indeed")
        draw_counts.append(len(batch))
        merged.extend(batch)
        logger.info(
            "Search '%s' Indeed draw %d/%d yielded %d listings",
            name,
            draw,
            INDEED_DRAW_COUNT,
            len(batch),
        )

        if len(batch) > 0 and draw >= 2:
            break

        if draw < INDEED_DRAW_COUNT:
            lo, hi = INDEED_JITTER_MIN, INDEED_JITTER_MAX
            if len(batch) == 0:
                lo, hi = hi, hi * 2
            delay = random.uniform(lo, hi)
            logger.info(
                "Search '%s' Indeed draw pause %.1fs before draw %d",
                name,
                delay,
                draw + 1,
            )
            time.sleep(delay)

    unioned = _dedupe_listings(merged)
    stats = {
        "search": name,
        "indeed_draws": draw_counts,
        "indeed_raw_sum": sum(draw_counts),
        "indeed_union": len(unioned),
    }
    logger.info(
        "Search '%s' Indeed union: draws=%s raw_sum=%d union=%d",
        name,
        draw_counts,
        stats["indeed_raw_sum"],
        stats["indeed_union"],
    )
    if stats["indeed_union"] == 0:
        logger.warning(
            "Search '%s' Indeed confirmed empty across %d draws "
            "(thin market or sustained block — not a single silent failure)",
            name,
            INDEED_DRAW_COUNT,
        )
    return unioned, stats


def _scrape_linkedin_union(
    search: dict[str, Any],
) -> tuple[list[JobListing], dict[str, Any]]:
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
    violations = check_linkedin_per_search_invariants(stats)
    if violations:
        for msg in violations:
            logger.error("Funnel invariant: %s", msg)
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
        elif board == "indeed":
            board_listings, _stats = _scrape_indeed_union(search)
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
        "Job boards enabled: %s (LinkedIn draws/search=%d Indeed draws/search=%d)",
        ", ".join(boards),
        LINKEDIN_DRAW_COUNT,
        INDEED_DRAW_COUNT,
    )
    if "google" in boards:
        logger.warning(
            "Google board enabled — JobSpy Google often returns 0 (empty HTML). "
            "If still empty after NL google_search_term, disable and use SerpApi."
        )
    all_listings: list[JobListing] = []
    linkedin_raw_sum = 0

    for search in config.get("searches", []):
        name = search.get("name", "unnamed")
        merged: list[JobListing] = []
        for board in boards:
            if board == "linkedin":
                li_union, stats = _scrape_linkedin_union(search)
                linkedin_raw_sum += stats["linkedin_raw_sum"]
                funnel.linkedin_per_search.append(stats)
                funnel.funnel_invariant_violations.extend(
                    check_linkedin_per_search_invariants(stats),
                )
                merged.extend(li_union)
            elif board == "indeed":
                indeed_union, _stats = _scrape_indeed_union(search)
                merged.extend(indeed_union)
            else:
                merged.extend(_scrape_search_board(search, board))
        search_listings = _dedupe_listings(merged)

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

    by_board: dict[str, int] = {}
    for listing in all_listings:
        key = (listing.board or "unknown").lower()
        by_board[key] = by_board.get(key, 0) + 1
    funnel.scrape_by_board = by_board

    for board in boards:
        count = by_board.get(board, 0)
        if count == 0:
            if board == "zip_recruiter":
                msg = (
                    f"{board}: 0 listings this run "
                    "(known-degraded Cloudflare/403 — non-blocking)"
                )
            elif board == "google":
                msg = (
                    f"{board}: 0 listings this run "
                    "(JobSpy Google empty HTML — flag SerpApi; non-blocking)"
                )
            else:
                msg = f"{board}: 0 listings this run (configured board returned nothing)"
            funnel.board_failures.append(msg)
            logger.error("BOARD FAILURE — %s", msg)

    logger.info("Total listings scraped: %d", len(all_listings))

    linkedin_count = funnel.scrape_linkedin_deduped
    indeed_count = by_board.get("indeed", 0)
    google_count = by_board.get("google", 0)
    zip_count = by_board.get("zip_recruiter", 0)
    logger.info(
        "Board mix: linkedin=%d indeed=%d google=%d zip_recruiter=%d total=%d "
        "(linkedin raw_sum=%d cap/search=%d)",
        linkedin_count,
        indeed_count,
        google_count,
        zip_count,
        len(all_listings),
        linkedin_raw_sum,
        funnel.scrape_linkedin_cap_per_search,
    )
    if funnel.board_failures:
        logger.error(
            "Scrape board failures (%d): %s",
            len(funnel.board_failures),
            "; ".join(funnel.board_failures),
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
