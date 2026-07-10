from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class ScrapeFunnel:
    scrape_linkedin_raw: int = 0
    scrape_linkedin_deduped: int = 0
    scrape_total: int = 0
    scrape_linkedin_cap_per_search: int = 30
    poster_pages_fetched: int = 0
    poster_public_block_in_html: int = 0
    meet_team_in_html: int = 0
    poster_parsed: int = 0
    poster_contacts_seeded: int = 0
    linkedin_per_search: list[dict[str, Any]] = field(default_factory=list)

    def to_metadata(self) -> dict[str, Any]:
        return asdict(self)


def html_poster_signals(html: str) -> tuple[bool, bool]:
    lower = html.lower()
    public_block = (
        "job poster" in lower
        or "message-the-recruiter" in lower
        or "direct message the job poster" in lower
    )
    meet_team = "meet the hiring team" in lower
    return public_block, meet_team
