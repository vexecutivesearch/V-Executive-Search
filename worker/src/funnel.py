from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any


def check_linkedin_per_search_invariants(stats: dict[str, Any]) -> list[str]:
    """union ≥ max(draws); in-focus ≤ union (when in-focus is set)."""
    violations: list[str] = []
    draws = stats.get("linkedin_draws") or []
    union = stats.get("linkedin_union")
    if not draws or union is None:
        return violations

    label = str(stats.get("search", "?")).split(" — ")[0]
    max_draw = max(draws)
    if union < max_draw:
        violations.append(f"{label}: union {union} < max(draw) {max_draw}")

    in_focus = stats.get("linkedin_in_focus")
    if in_focus is not None and in_focus > union:
        violations.append(f"{label}: in-focus {in_focus} > union {union}")

    return violations


@dataclass
class ScrapeFunnel:
    scrape_linkedin_raw: int = 0
    scrape_linkedin_deduped: int = 0
    scrape_total: int = 0
    scrape_linkedin_cap_per_search: int = 30
    scrape_by_board: dict[str, int] = field(default_factory=dict)
    board_failures: list[str] = field(default_factory=list)
    poster_pages_fetched: int = 0
    poster_public_block_in_html: int = 0
    meet_team_in_html: int = 0
    poster_parsed: int = 0
    poster_contacts_seeded: int = 0
    linkedin_per_search: list[dict[str, Any]] = field(default_factory=list)
    funnel_invariant_violations: list[str] = field(default_factory=list)

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
