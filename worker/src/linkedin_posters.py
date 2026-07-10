from __future__ import annotations

import logging
import os
import random
import re
import time
from typing import Any
from urllib.parse import urlparse

from bs4 import BeautifulSoup
from jobspy.linkedin.constant import headers
from jobspy.util import create_session

from src.funnel import ScrapeFunnel, html_poster_signals
from src.models import JobListing, JobPoster

logger = logging.getLogger(__name__)

_LINKEDIN_IN_RE = re.compile(r"linkedin\.com/in/", re.I)
_JOB_ID_RE = re.compile(r"/jobs/view/(\d+)")
_POSTER_HEADING_RE = re.compile(
    r"(Meet the hiring team|job poster from|People you can reach out to|Direct message the job poster)",
    re.I,
)


def _normalize_linkedin_url(url: str) -> str:
    parsed = urlparse(url.strip())
    path = parsed.path.rstrip("/")
    return f"https://www.linkedin.com{path}"


def _split_name(full_name: str) -> tuple[str, str]:
    parts = full_name.strip().split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], " ".join(parts[1:])


def _extract_title_from_card(name: str, card_text: str) -> str:
    lines = [line.strip() for line in card_text.split("\n") if line.strip()]
    for line in lines:
        lower = line.lower()
        if line == name:
            continue
        if "connection" in lower or "message" in lower or "job poster" in lower:
            continue
        if "direct message" in lower:
            continue
        if len(line) >= 4:
            return line
    return ""


def _name_from_anchor(anchor) -> str:
    sr = anchor.find("span", class_=re.compile(r"sr-only"))
    if sr:
        name = sr.get_text(" ", strip=True)
        if name and len(name) >= 2:
            return name
    alt = anchor.find("img", alt=re.compile(r"view .+ profile", re.I))
    if alt and alt.get("alt"):
        match = re.search(r"view (.+?)[''']s profile", alt["alt"], re.I)
        if match:
            return match.group(1).strip()
    text = anchor.get_text(" ", strip=True)
    return text if text and len(text) >= 2 else ""


def _posters_from_card_section(section, *, is_job_poster: bool) -> list[JobPoster]:
    posters: list[JobPoster] = []
    seen: set[str] = set()
    for anchor in section.find_all("a", href=_LINKEDIN_IN_RE):
        href = _normalize_linkedin_url(anchor.get("href", ""))
        if href in seen:
            continue
        name = _name_from_anchor(anchor)
        if not name:
            continue
        seen.add(href)
        card = anchor.find_parent("div", class_=re.compile(r"base-main-card|base-card"))
        title = ""
        if card:
            title = _extract_title_from_card(name, card.get_text("\n", strip=True))
        posters.append(
            JobPoster(
                name=name,
                title=title,
                linkedin_url=href,
                is_job_poster=is_job_poster,
            )
        )
    return posters


def parse_hiring_team_from_html(html: str) -> list[JobPoster]:
    soup = BeautifulSoup(html, "html.parser")
    posters: list[JobPoster] = []
    seen: set[str] = set()

    def add(items: list[JobPoster]) -> None:
        for poster in items:
            key = poster.linkedin_url.lower()
            if key in seen:
                continue
            seen.add(key)
            posters.append(poster)

    # Public guest layout: "Direct message the job poster"
    for block in soup.select(".message-the-recruiter"):
        add(_posters_from_card_section(block, is_job_poster=True))

    # Authenticated / SSR layout: "Meet the hiring team"
    for block in soup.select(
        ".meet-the-hiring-team, .job-details-jobs-unified-top-card__hiring-team"
    ):
        add(_posters_from_card_section(block, is_job_poster=False))

    headings = soup.find_all(string=_POSTER_HEADING_RE)
    for heading in headings:
        section = heading.find_parent("section") or heading.find_parent("div", class_=True)
        if not section:
            continue
        section_text = section.get_text(" ", strip=True)
        is_job_poster = bool(re.search(r"job poster|direct message the job poster", section_text, re.I))
        is_hiring_team = bool(re.search(r"meet the hiring team", section_text, re.I))
        add(
            _posters_from_card_section(
                section,
                is_job_poster=is_job_poster and not is_hiring_team,
            )
        )

    if not posters and re.search(r"job poster", html, re.I):
        for anchor in soup.find_all("a", href=_LINKEDIN_IN_RE):
            href = _normalize_linkedin_url(anchor.get("href", ""))
            name = _name_from_anchor(anchor)
            if not name:
                continue
            add([
                JobPoster(
                    name=name,
                    title="",
                    linkedin_url=href,
                    is_job_poster=True,
                )
            ])
            break

    posters.sort(key=lambda p: (not p.is_job_poster, p.name.lower()))
    return posters


def linkedin_job_id_from_url(job_url: str) -> str | None:
    match = _JOB_ID_RE.search(job_url or "")
    return match.group(1) if match else None


def apply_linkedin_session_cookie(session: Any) -> None:
    """Opt-in only — authenticated fetches risk account bans at 2× daily volume."""
    if os.environ.get("LINKEDIN_LI_AT_ENABLED", "").lower() not in {
        "1",
        "true",
        "yes",
    }:
        return
    li_at = os.environ.get("LINKEDIN_LI_AT", "").strip()
    if not li_at:
        return
    session.cookies.set("li_at", li_at, domain=".linkedin.com")
    logger.warning(
        "LINKEDIN_LI_AT_ENABLED — using authenticated session; burner account only, throttle heavily"
    )


def fetch_hiring_team(job_id: str, session: Any) -> tuple[list[JobPoster], str]:
    try:
        response = session.get(
            f"https://www.linkedin.com/jobs/view/{job_id}",
            timeout=15,
        )
        if response.status_code != 200:
            return [], ""
        if "linkedin.com/signup" in response.url:
            return [], ""
        html = response.text
        posters = parse_hiring_team_from_html(html)
        if posters:
            return posters, html
        if not os.environ.get("LINKEDIN_LI_AT", "").strip():
            logger.debug(
                "No hiring team on public page for %s — set LINKEDIN_LI_AT for Meet the hiring team",
                job_id,
            )
        return [], html
    except Exception as exc:
        logger.debug("LinkedIn hiring team fetch failed for %s: %s", job_id, exc)
        return [], ""


def attach_linkedin_hiring_teams(
    listings: list[JobListing],
    funnel: ScrapeFunnel | None = None,
) -> int:
    """Fetch public job posters for LinkedIn listings. Returns count found."""
    if os.environ.get("LINKEDIN_FETCH_HIRING_TEAM", "true").lower() in {
        "0",
        "false",
        "no",
    }:
        return 0

    linkedin_listings = [
        listing
        for listing in listings
        if listing.board == "linkedin" and listing.job_url
    ]
    if not linkedin_listings:
        return 0

    session = create_session(
        is_tls=False,
        has_retry=True,
        delay=5,
        clear_cookies=True,
    )
    session.headers.update(headers)
    apply_linkedin_session_cookie(session)

    delay_min = float(os.environ.get("LINKEDIN_POSTER_DELAY_MIN", "2"))
    delay_max = float(os.environ.get("LINKEDIN_POSTER_DELAY_MAX", "4"))
    found = 0

    for index, listing in enumerate(linkedin_listings):
        job_id = linkedin_job_id_from_url(listing.job_url)
        if not job_id:
            continue
        if index > 0:
            time.sleep(random.uniform(delay_min, delay_max))

        posters, html = fetch_hiring_team(job_id, session)
        if funnel is not None:
            funnel.poster_pages_fetched += 1
            if html:
                pub, meet = html_poster_signals(html)
                if pub:
                    funnel.poster_public_block_in_html += 1
                if meet:
                    funnel.meet_team_in_html += 1
        if posters:
            listing.posters = posters
            found += len(posters)
            if funnel is not None:
                funnel.poster_parsed += 1
                funnel.poster_contacts_seeded += len(posters)
            logger.info(
                "LinkedIn poster for %s / %s: %s",
                listing.company_name,
                listing.job_title,
                ", ".join(p.name for p in posters[:3]),
            )

    logger.info(
        "LinkedIn hiring team: %d poster(s) on %d/%d listings",
        found,
        sum(1 for listing in linkedin_listings if listing.posters),
        len(linkedin_listings),
    )
    return found


def posters_to_contact_dicts(
    posters: list[JobPoster],
    job_location: str = "",
) -> list[dict[str, Any]]:
    contacts: list[dict[str, Any]] = []
    for poster in posters:
        first, last = _split_name(poster.name)
        contacts.append(
            {
                "name": poster.name,
                "title": poster.title or None,
                "linkedin_url": poster.linkedin_url,
                "source_provider": "linkedin_poster",
                "location_matched": False,
                "job_location": job_location or None,
                "first_name": first,
                "last_name": last,
            }
        )
    return contacts
