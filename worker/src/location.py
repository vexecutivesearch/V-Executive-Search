from __future__ import annotations

import re
from dataclasses import dataclass

# Common US state abbreviations and full names for matching Apollo / job board strings.
US_STATE_ABBR_TO_NAME: dict[str, str] = {
    "AL": "Alabama",
    "AK": "Alaska",
    "AZ": "Arizona",
    "AR": "Arkansas",
    "CA": "California",
    "CO": "Colorado",
    "CT": "Connecticut",
    "DE": "Delaware",
    "FL": "Florida",
    "GA": "Georgia",
    "HI": "Hawaii",
    "ID": "Idaho",
    "IL": "Illinois",
    "IN": "Indiana",
    "IA": "Iowa",
    "KS": "Kansas",
    "KY": "Kentucky",
    "LA": "Louisiana",
    "ME": "Maine",
    "MD": "Maryland",
    "MA": "Massachusetts",
    "MI": "Michigan",
    "MN": "Minnesota",
    "MS": "Mississippi",
    "MO": "Missouri",
    "MT": "Montana",
    "NE": "Nebraska",
    "NV": "Nevada",
    "NH": "New Hampshire",
    "NJ": "New Jersey",
    "NM": "New Mexico",
    "NY": "New York",
    "NC": "North Carolina",
    "ND": "North Dakota",
    "OH": "Ohio",
    "OK": "Oklahoma",
    "OR": "Oregon",
    "PA": "Pennsylvania",
    "RI": "Rhode Island",
    "SC": "South Carolina",
    "SD": "South Dakota",
    "TN": "Tennessee",
    "TX": "Texas",
    "UT": "Utah",
    "VT": "Vermont",
    "VA": "Virginia",
    "WA": "Washington",
    "WV": "West Virginia",
    "WI": "Wisconsin",
    "WY": "Wyoming",
    "DC": "District of Columbia",
}

US_STATE_NAME_TO_ABBR = {name.lower(): abbr for abbr, name in US_STATE_ABBR_TO_NAME.items()}

_REMOTE_MARKERS = re.compile(
    r"\b(remote|work from home|wfh|anywhere|nationwide|hybrid)\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ParsedLocation:
    raw: str
    city: str | None = None
    state_abbr: str | None = None
    state_name: str | None = None
    country: str | None = None
    is_remote: bool = False

    @property
    def label(self) -> str:
        if self.is_remote:
            return self.raw or "Remote"
        parts: list[str] = []
        if self.city:
            parts.append(self.city)
        if self.state_abbr:
            parts.append(self.state_abbr)
        elif self.state_name:
            parts.append(self.state_name)
        return ", ".join(parts) if parts else self.raw


def _normalize_state(token: str) -> tuple[str | None, str | None]:
    cleaned = token.strip().rstrip(".")
    if not cleaned:
        return None, None
    upper = cleaned.upper()
    if upper in US_STATE_ABBR_TO_NAME:
        return upper, US_STATE_ABBR_TO_NAME[upper]
    lower = cleaned.lower()
    if lower in US_STATE_NAME_TO_ABBR:
        abbr = US_STATE_NAME_TO_ABBR[lower]
        return abbr, US_STATE_ABBR_TO_NAME[abbr]
    return None, None


def parse_job_location(location: str) -> ParsedLocation | None:
    raw = (location or "").strip()
    if not raw:
        return None
    if _REMOTE_MARKERS.search(raw):
        return ParsedLocation(raw=raw, is_remote=True)

    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if not parts:
        return None

    country = None
    if parts[-1].upper() in {"US", "USA", "UNITED STATES"}:
        country = "US"
        parts = parts[:-1]

    state_abbr: str | None = None
    state_name: str | None = None
    city: str | None = None

    if len(parts) == 1:
        abbr, name = _normalize_state(parts[0])
        if abbr:
            state_abbr, state_name = abbr, name
        else:
            city = parts[0]
    elif len(parts) >= 2:
        city = parts[0]
        state_abbr, state_name = _normalize_state(parts[1])

    return ParsedLocation(
        raw=raw,
        city=city,
        state_abbr=state_abbr,
        state_name=state_name,
        country=country or "US",
    )


def apollo_location_queries(parsed: ParsedLocation) -> list[str]:
    """Build Apollo person_locations filter values from a parsed job location."""
    if parsed.is_remote:
        return []

    queries: list[str] = []
    city = parsed.city
    state_abbr = parsed.state_abbr
    state_name = parsed.state_name

    if city and state_abbr:
        queries.extend([
            f"{city}, {state_abbr}, US",
            f"{city}, {state_abbr}",
            f"{city}, US",
        ])
    elif city:
        queries.append(f"{city}, US")

    if state_name:
        queries.append(f"{state_name}, US")
    elif state_abbr and state_abbr in US_STATE_ABBR_TO_NAME:
        queries.append(f"{US_STATE_ABBR_TO_NAME[state_abbr]}, US")

    # Preserve order, drop duplicates.
    seen: set[str] = set()
    unique: list[str] = []
    for q in queries:
        key = q.lower()
        if key not in seen:
            seen.add(key)
            unique.append(q)
    return unique


def collect_job_locations(listings: list) -> list[ParsedLocation]:
    parsed: list[ParsedLocation] = []
    seen: set[str] = set()
    for listing in listings:
        loc = parse_job_location(getattr(listing, "location", "") or "")
        if not loc or loc.is_remote:
            continue
        key = loc.label.lower()
        if key in seen:
            continue
        seen.add(key)
        parsed.append(loc)
    return parsed


def _normalize_token(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().lower())


def person_matches_location(
    person: dict,
    targets: list[ParsedLocation],
) -> bool:
    if not targets:
        return False

    person_city = _normalize_token(person.get("city"))
    person_state = _normalize_token(person.get("state"))
    person_country = _normalize_token(person.get("country"))

    if person_state in US_STATE_NAME_TO_ABBR:
        person_state = US_STATE_NAME_TO_ABBR[person_state].lower()
    person_state_abbr = person_state.upper() if len(person_state) == 2 else None
    if person_state_abbr and person_state_abbr in US_STATE_ABBR_TO_NAME:
        person_state = person_state_abbr.lower()

    for target in targets:
        if target.is_remote:
            continue
        target_city = _normalize_token(target.city)
        target_state = _normalize_token(target.state_abbr or target.state_name)

        city_match = bool(target_city and person_city and target_city == person_city)
        state_match = False
        if target.state_abbr and person_state:
            state_match = target.state_abbr.lower() == person_state
        elif target.state_name and person_state:
            state_match = target.state_name.lower() == person_state

        if city_match and (not target.state_abbr or state_match):
            return True
        if not target_city and state_match:
            return True

        # Apollo sometimes returns metro labels; allow partial city containment.
        if target_city and person_city and (
            target_city in person_city or person_city in target_city
        ):
            if not target.state_abbr or state_match:
                return True

    return False


def format_person_location(person: dict) -> str | None:
    city = (person.get("city") or "").strip()
    state = (person.get("state") or "").strip()
    if city and state:
        return f"{city}, {state}"
    if city:
        return city
    if state:
        return state
    return None
