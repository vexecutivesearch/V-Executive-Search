"""Google Jobs via SerpApi — replaces the broken JobSpy Google scraper.

Docs: https://serpapi.com/google-jobs-api
Requires SERPAPI_API_KEY on the Mac worker.
"""

from __future__ import annotations

import logging
import os
import re
import time
from datetime import datetime, timedelta
from typing import Any

import requests

from src.models import JobListing
from src.scrape import build_google_search_term

logger = logging.getLogger(__name__)

SERPAPI_ENDPOINT = "https://serpapi.com/search.json"
# ~10 results per page; cap pages to control credit burn.
DEFAULT_MAX_PAGES = max(1, int(os.getenv("SERPAPI_GOOGLE_MAX_PAGES", "3")))
REQUEST_TIMEOUT = float(os.getenv("SERPAPI_TIMEOUT_SECONDS", "45"))

_STATE_EXPAND = {
    "FL": "Florida",
    "NY": "New York",
    "CA": "California",
    "TX": "Texas",
    "GA": "Georgia",
    "NC": "North Carolina",
    "SC": "South Carolina",
    "VA": "Virginia",
    "PA": "Pennsylvania",
    "NJ": "New Jersey",
    "MA": "Massachusetts",
    "IL": "Illinois",
    "OH": "Ohio",
    "MI": "Michigan",
    "AZ": "Arizona",
    "WA": "Washington",
    "CO": "Colorado",
}


def serpapi_api_key() -> str | None:
    key = (os.getenv("SERPAPI_API_KEY") or "").strip()
    return key or None


def serpapi_google_enabled() -> bool:
    """SerpApi path is on when a key is present (unless explicitly disabled)."""
    if os.getenv("SERPAPI_GOOGLE_ENABLED", "1").strip().lower() in (
        "0",
        "false",
        "no",
        "off",
    ):
        return False
    return bool(serpapi_api_key())


def _serpapi_location(location: str) -> str:
    """SerpApi prefers 'City, State, United States'."""
    loc = (location or "").strip()
    if not loc:
        return "United States"
    if "united states" in loc.lower():
        return loc
    m = re.match(r"^(.+),\s*([A-Z]{2})$", loc)
    if m:
        city, abbr = m.group(1).strip(), m.group(2).upper()
        state = _STATE_EXPAND.get(abbr, abbr)
        return f"{city}, {state}, United States"
    if "," in loc and "florida" not in loc.lower() and loc.upper().endswith(", FL"):
        return loc
    # "West Palm Beach, Florida" → add country
    if re.search(r",\s*[A-Za-z ]+$", loc):
        return f"{loc}, United States"
    return f"{loc}, United States"


def _parse_posted_at(text: str | None) -> datetime | None:
    if not text:
        return None
    raw = text.strip().lower()
    now = datetime.now()
    if "just" in raw or "hour" in raw or "today" in raw:
        return now
    if "yesterday" in raw:
        return now - timedelta(days=1)
    m = re.search(r"(\d+)\s*day", raw)
    if m:
        return now - timedelta(days=int(m.group(1)))
    m = re.search(r"(\d+)\s*week", raw)
    if m:
        return now - timedelta(weeks=int(m.group(1)))
    m = re.search(r"(\d+)\s*month", raw)
    if m:
        return now - timedelta(days=30 * int(m.group(1)))
    return None


def _job_url(job: dict[str, Any]) -> str:
    apply = job.get("apply_options") or []
    if isinstance(apply, list):
        for opt in apply:
            if isinstance(opt, dict) and opt.get("link"):
                return str(opt["link"]).strip()
    share = job.get("share_link") or job.get("link") or ""
    return str(share).strip()


def _salary_from_job(job: dict[str, Any]) -> tuple[int | None, int | None, str | None, str | None]:
    ext = job.get("detected_extensions") or {}
    if not isinstance(ext, dict):
        return None, None, None, None
    # SerpApi sometimes exposes salary as string in extensions
    salary = ext.get("salary")
    if not salary:
        for item in job.get("extensions") or []:
            if isinstance(item, str) and ("$" in item or "year" in item.lower()):
                salary = item
                break
    if not salary:
        return None, None, None, str(salary) if salary else None
    text = str(salary)
    nums = [int(x.replace(",", "")) for x in re.findall(r"\$?\s*([\d,]+)", text)]
    if len(nums) >= 2:
        return nums[0], nums[1], "USD", text
    if len(nums) == 1:
        return nums[0], nums[0], "USD", text
    return None, None, None, text


def _row_to_listing(job: dict[str, Any], search_name: str) -> JobListing | None:
    title = (job.get("title") or "").strip()
    company = (job.get("company_name") or "").strip()
    if not title or not company:
        return None
    location = (job.get("location") or "").strip()
    ext = job.get("detected_extensions") if isinstance(job.get("detected_extensions"), dict) else {}
    posted = _parse_posted_at(ext.get("posted_at") if ext else None)
    sal_min, sal_max, sal_cur, sal_text = _salary_from_job(job)
    url = _job_url(job)
    return JobListing(
        company_name=company,
        job_title=title,
        location=location,
        board="google",
        job_url=url,
        date_posted=posted,
        search_name=search_name,
        salary_min=sal_min,
        salary_max=sal_max,
        salary_currency=sal_cur,
        salary_text=sal_text,
    )


def _serpapi_query(search: dict[str, Any]) -> str:
    """NL query for SerpApi q= — location passed separately."""
    # Prefer CRM google_search_term but strip "near {place}" since location= is set.
    term = build_google_search_term(search)
    loc = (search.get("location") or "").strip()
    if loc:
        # Remove "near West Palm Beach, FL" style clause
        pattern = re.compile(
            rf"\s*near\s+{re.escape(loc)}\s*",
            re.IGNORECASE,
        )
        term = pattern.sub(" ", term).strip()
        # Also strip near City, ST if loc was expanded differently
        term = re.sub(r"\s*near\s+[^ ]+(?:\s+[^ ]+){0,4},\s*[A-Z]{2}\s*", " ", term, flags=re.I)
    return re.sub(r"\s+", " ", term).strip() or "jobs"


def _fetch_serpapi_page(
    *,
    key: str,
    q: str,
    location: str,
    next_token: str | None,
    name: str,
    page: int,
) -> dict[str, Any] | None:
    """One SerpApi request. Returns parsed payload, or None on any failure.

    Every call — including failures — consumes a SerpApi attempt, so callers
    must meter BEFORE interpreting the result.
    """
    params: dict[str, Any] = {
        "engine": "google_jobs",
        "q": q,
        "location": location,
        "hl": "en",
        "gl": "us",
        "api_key": key,
    }
    if next_token:
        params["next_page_token"] = next_token

    try:
        resp = requests.get(SERPAPI_ENDPOINT, params=params, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as exc:
        logger.error("SerpApi Google request failed search=%r page=%d: %s", name, page, exc)
        return None

    if resp.status_code != 200:
        logger.error(
            "SerpApi Google HTTP %s search=%r page=%d body=%s",
            resp.status_code,
            name,
            page,
            resp.text[:300],
        )
        return None

    try:
        data = resp.json()
    except ValueError:
        logger.error("SerpApi Google invalid JSON search=%r page=%d", name, page)
        return None

    if data.get("error"):
        logger.error("SerpApi Google error search=%r: %s", name, data.get("error"))
        return None

    return data


def scrape_google_serpapi_paged(
    search: dict[str, Any],
    *,
    api_key: str | None = None,
    meter: Any = None,
    page_classifier: Any = None,
    min_yield: float = 0.3,
    max_pages: int | None = None,
    page_delay_seconds: float = 0.4,
) -> tuple[list[JobListing], dict[str, Any]]:
    """Marginal-yield pagination: keep fetching pages while they earn it.

    NOT a fixed page cap — a flat cap silently loses jobs (the LinkedIn
    5-of-29 under-fetch failure mode), and the consolidated metro query after
    zone collapse carries ALL the volume so it needs depth. Instead:

      - after each page, compute net-new ratio vs the DB (`page_classifier`,
        backed by resight tracking) and continue while ratio >= min_yield;
      - `max_pages` is a runaway circuit breaker, not the normal stop
        (callers pass the deeper cold-start ceiling for fresh markets);
      - if the yield lookup is unavailable, STOP after the current page —
        never spend blind on an unverifiable ratio;
      - `meter` counts every attempt (failures included) and can halt the
        query mid-flight on run cap / budget.

    Returns (listings, per-query stats for the funnel). Resighted listings
    are still returned — ingest/resight tracking is unchanged; newness only
    drives the pagination decision.
    """
    stats: dict[str, Any] = {
        "search": search.get("name", "unnamed"),
        "zone": search.get("zone_label"),
        "pages": [],
        "searches_attempted": 0,
        "searches_failed": 0,
        "listings": 0,
        "new_listings": 0,
        "new_companies": 0,
        "stop_reason": None,
        "max_pages": None,
    }

    key = api_key or serpapi_api_key()
    if not key:
        logger.error("SerpApi Google requested but SERPAPI_API_KEY is not set")
        stats["stop_reason"] = "no_api_key"
        return [], stats

    name = search.get("name", "unnamed")
    q = _serpapi_query(search)
    location = _serpapi_location(search.get("location") or "")
    ceiling = max(1, int(max_pages if max_pages is not None else DEFAULT_MAX_PAGES))
    stats["max_pages"] = ceiling

    logger.info(
        "SerpApi Google search=%r q=%r location=%r yield>=%.2f pages<=%d",
        name,
        q,
        location,
        min_yield,
        ceiling,
    )

    listings: list[JobListing] = []
    next_token: str | None = None
    stop_reason = "max_pages"

    for page in range(1, ceiling + 1):
        if meter is not None and meter.run_cap_reached:
            stop_reason = "run_cap"
            break
        if meter is not None and meter.budget_tripped:
            stop_reason = "budget"
            break

        data = _fetch_serpapi_page(
            key=key, q=q, location=location, next_token=next_token, name=name, page=page
        )
        stats["searches_attempted"] += 1
        if meter is not None:
            meter.record_search(failed=data is None)
        if data is None:
            stats["searches_failed"] += 1
            stop_reason = "error"
            break

        jobs = data.get("jobs_results") or []
        if not isinstance(jobs, list) or not jobs:
            logger.info("SerpApi Google search=%r page=%d empty", name, page)
            stop_reason = "empty_page"
            break

        page_listings: list[JobListing] = []
        for job in jobs:
            if not isinstance(job, dict):
                continue
            listing = _row_to_listing(job, name)
            if listing:
                page_listings.append(listing)
        listings.extend(page_listings)

        page_stat: dict[str, Any] = {"page": page, "results": len(page_listings)}
        new_ratio: float | None = None
        if page_classifier is not None and page_listings:
            yield_info = page_classifier.classify(page_listings)
            if yield_info is None:
                # CRM lookup down: an unverifiable ratio never justifies
                # another paid page. Keep what we fetched, stop here, be loud.
                page_stat["new"] = None
                page_stat["new_ratio"] = None
                stats["pages"].append(page_stat)
                logger.warning(
                    "SerpApi Google search=%r page=%d yield lookup unavailable — "
                    "stopping pagination (fail-safe, no blind spend)",
                    name,
                    page,
                )
                stop_reason = "yield_lookup_unavailable"
                break
            new_count = yield_info["new_urls"]
            new_ratio = new_count / len(page_listings)
            page_stat["new"] = new_count
            page_stat["new_ratio"] = round(new_ratio, 3)
            stats["new_listings"] += new_count
            stats["new_companies"] += len(yield_info["new_companies"])
        stats["pages"].append(page_stat)

        logger.info(
            "SerpApi Google search=%r page=%d got %d jobs new_ratio=%s (total %d)",
            name,
            page,
            len(page_listings),
            f"{new_ratio:.2f}" if new_ratio is not None else "n/a",
            len(listings),
        )

        if new_ratio is not None and new_ratio < min_yield:
            stop_reason = "yield_below_threshold"
            break

        pagination = data.get("serpapi_pagination") or {}
        next_token = pagination.get("next_page_token")
        if not next_token:
            stop_reason = "no_next_page"
            break
        if page_delay_seconds > 0:
            time.sleep(page_delay_seconds)

    stats["stop_reason"] = stop_reason
    stats["listings"] = len(listings)
    return listings, stats


def scrape_google_serpapi(
    search: dict[str, Any],
    *,
    api_key: str | None = None,
    max_pages: int | None = None,
) -> list[JobListing]:
    """Legacy entry point (fixed page ceiling, no meter). Prefer the
    GoogleBoardController path in scrape_all which meters and yield-paginates."""
    pages = max_pages if max_pages is not None else DEFAULT_MAX_PAGES
    results_wanted = int(search.get("results_wanted") or 50)
    pages = max(1, min(pages, max(1, (results_wanted + 9) // 10)))
    listings, _stats = scrape_google_serpapi_paged(
        search,
        api_key=api_key,
        min_yield=0.0,  # no yield data on the legacy path — page cap only
        max_pages=pages,
    )
    return listings[:results_wanted]
