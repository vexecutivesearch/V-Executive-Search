#!/usr/bin/env python3
"""End-to-end smoke test for worker + CRM integration."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

WORKER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER_ROOT))

load_dotenv(WORKER_ROOT / ".env")

PASS = 0
FAIL = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ✓ {name}" + (f" — {detail}" if detail else ""))
    else:
        FAIL += 1
        print(f"  ✗ {name}" + (f" — {detail}" if detail else ""))


def main() -> int:
    print("V Executive Search — health check\n")

    print("Environment")
    for key in ("APOLLO_API_KEY", "CRM_API_URL", "CRM_API_KEY", "ALERT_EMAIL"):
        check(key, bool(os.environ.get(key)), "set" if os.environ.get(key) else "MISSING")
    resend = os.environ.get("RESEND_API_KEY")
    check("RESEND_API_KEY", bool(resend), "set (daily email)" if resend else "optional — email disabled")
    co_mode = os.environ.get("CONTACTOUT_MODE", "api")
    co = os.environ.get("CONTACTOUT_API_KEY")
    if co_mode == "dashboard":
        from src.enrich.contactout_dashboard import browser_profile_dir

        profile = browser_profile_dir()
        check(
            "CONTACTOUT_MODE=dashboard",
            profile.exists(),
            f"profile at {profile}" if profile.exists() else "run contactout_login.py",
        )
    else:
        check(
            "CONTACTOUT_API_KEY",
            bool(co),
            "set (personal email/mobile)" if co else "optional — Apollo-only enrichment",
        )

    base = (os.environ.get("CRM_API_URL") or "").rstrip("/")
    key = os.environ.get("CRM_API_KEY", "")
    headers = {"Authorization": f"Bearer {key}"}

    print("\nCRM API")
    if base and key:
        try:
            health = requests.get(f"{base}/api/health", timeout=15).json()
            check("GET /api/health", health.get("ok") and health.get("database") == "connected")
        except requests.RequestException as exc:
            check("GET /api/health", False, str(exc))

        try:
            cfg = requests.get(f"{base}/api/pipeline/config", headers=headers, timeout=15).json()
            searches = len(cfg.get("searches", []))
            cpc = cfg.get("enrichment", {}).get("contacts_per_company", 0)
            check(
                "GET /api/pipeline/config",
                searches > 0 and cpc >= 3,
                f"{searches} searches, {cpc} contacts/company",
            )
        except requests.RequestException as exc:
            check("GET /api/pipeline/config", False, str(exc))

        try:
            status = requests.get(f"{base}/api/pipeline/status", headers=headers, timeout=15).json()
            check("GET /api/pipeline/status", "run_requested_at" in status)
        except requests.RequestException as exc:
            check("GET /api/pipeline/status", False, str(exc))
    else:
        check("CRM API tests", False, "CRM_API_URL or CRM_API_KEY missing")

    print("\nApollo")
    apollo_key = os.environ.get("APOLLO_API_KEY", "")
    if apollo_key:
        try:
            resp = requests.post(
                "https://api.apollo.io/api/v1/mixed_companies/search",
                headers={"X-Api-Key": apollo_key, "Content-Type": "application/json"},
                json={"q_organization_name": "Apollo.io", "page": 1, "per_page": 1},
                timeout=15,
            )
            check("Apollo API key", resp.status_code == 200, f"HTTP {resp.status_code}")
        except requests.RequestException as exc:
            check("Apollo API key", False, str(exc))
    else:
        check("Apollo API key", False, "APOLLO_API_KEY missing")

    print("\nJobSpy scrape (1 listing)")
    try:
        from jobspy import scrape_jobs

        df = scrape_jobs(
            site_name=["indeed"],
            search_term="HR Director",
            location="West Palm Beach, FL",
            results_wanted=1,
            hours_old=168,
            country_indeed="USA",
        )
        check("Indeed scrape", df is not None and len(df) > 0, f"{len(df)} listing(s)")
    except Exception as exc:
        check("Indeed scrape", False, str(exc))

    print("\nLocal paths")
    venv_python = WORKER_ROOT / ".venv" / "bin" / "python"
    check("Python venv", venv_python.exists(), str(venv_python))
    check("run_daily.py", (WORKER_ROOT / "scripts" / "run_daily.py").exists())
    check("poll_and_run.py", (WORKER_ROOT / "scripts" / "poll_and_run.py").exists())
    for d in ("logs", "output"):
        p = WORKER_ROOT / d
        p.mkdir(exist_ok=True)
        check(f"{d}/ writable", os.access(p, os.W_OK))

    print(f"\nResult: {PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
