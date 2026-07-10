#!/usr/bin/env python3
"""Ground truth: LinkedIn guest search title vs JobSpy yield vs DB counts."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from dotenv import load_dotenv

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))
load_dotenv(WORKER_ROOT / ".env")

from jobspy import scrape_jobs  # noqa: E402
from jobspy.util import create_session  # noqa: E402
from jobspy.linkedin.constant import headers  # noqa: E402


def linkedin_guest_title(keywords: str, location: str) -> str:
    session = create_session(is_tls=False, has_retry=True, delay=5, clear_cookies=True)
    session.headers.update(headers)
    loc = location.replace(" ", "%20").replace(",", "%2C")
    url = (
        f"https://www.linkedin.com/jobs/search"
        f"?keywords={keywords.replace(' ', '%20')}&location={loc}&f_TPR=r604800"
    )
    r = session.get(url, timeout=20)
    m = re.search(r"<title>([^<]+)</title>", r.text)
    return m.group(1) if m else "unknown"


def main() -> int:
    searches = [
        ("HR Director", "West Palm Beach, Florida"),
        ("VP People", "West Palm Beach, Florida"),
        ("Head of Talent", "West Palm Beach, Florida"),
    ]
    cap = 30
    report = {"linkedin_cap_per_search": cap, "searches": []}
    raw_total = 0

    for term, loc in searches:
        guest_title = linkedin_guest_title(term, loc)
        df = scrape_jobs(
            site_name=["linkedin"],
            search_term=term,
            location=loc,
            results_wanted=cap,
            hours_old=168,
            linkedin_fetch_description=False,
        )
        jobspy_n = 0 if df is None or df.empty else len(df)
        raw_total += jobspy_n
        guest_n = re.search(r"(\d+)", guest_title)
        report["searches"].append(
            {
                "term": term,
                "location": loc,
                "linkedin_guest_title": guest_title,
                "linkedin_guest_count": int(guest_n.group(1)) if guest_n else None,
                "jobspy_returned": jobspy_n,
                "at_cap": jobspy_n >= cap,
            }
        )

    report["jobspy_raw_total"] = raw_total
    report["note"] = (
        "If jobspy_returned == cap, you are hitting the worker ceiling, not LinkedIn exhaustion. "
        "Poster count (3-5) is unrelated to job count — measure poster_public_block_in_html in funnel."
    )
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
