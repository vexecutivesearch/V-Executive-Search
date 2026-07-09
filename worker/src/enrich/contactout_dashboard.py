from __future__ import annotations

import logging
import os
import random
import re
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

from src.contact_phones import extract_contactout_phones
from src.enrich.contactout_api import is_personal_email_str
from src.enrich.contactout_base import ContactOutResult, normalize_linkedin

logger = logging.getLogger(__name__)

CONTACTOUT_LOGIN_URL = "https://contactout.com/login"
CONTACTOUT_SEARCH_URL = "https://contactout.com/dashboard/search"

EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)
PHONE_RE = re.compile(r"\+?\d[\d\s().-]{7,}\d")


def _worker_root() -> Path:
    return Path(__file__).resolve().parents[2]


def browser_profile_dir() -> Path:
    custom = os.environ.get("CONTACTOUT_BROWSER_PROFILE", "").strip()
    if custom:
        return Path(custom).expanduser()
    return _worker_root() / ".contactout-browser"


def _delay_seconds() -> float:
    low = float(os.environ.get("CONTACTOUT_DASHBOARD_DELAY_MIN", "60"))
    high = float(os.environ.get("CONTACTOUT_DASHBOARD_DELAY_MAX", "150"))
    return random.uniform(min(low, high), max(low, high))


def _linkedin_slug(url: str) -> str:
    return normalize_linkedin(url).rstrip("/").split("/")[-1]


class ContactOutDashboardClient:
    """ContactOut via logged-in Chrome dashboard (Mac mini). No LinkedIn browsing."""

    def __init__(self) -> None:
        self.credits_used = 0
        self._playwright: Any | None = None
        self._context: Any | None = None
        self._page: Any | None = None
        self._lookups = 0

    @property
    def is_configured(self) -> bool:
        if sys.platform != "darwin":
            return False
        mode = os.environ.get("CONTACTOUT_MODE", "auto").strip().lower()
        if mode == "api":
            return False
        # Profile is created on first launch; login is saved after contactout_login.py
        return True

    def close(self) -> None:
        if self._context:
            try:
                self._context.close()
            except Exception:
                pass
        if self._playwright:
            try:
                self._playwright.stop()
            except Exception:
                pass
        self._context = None
        self._playwright = None
        self._page = None

    def __del__(self) -> None:
        self.close()

    def _ensure_browser(self) -> Any:
        if self._page is not None:
            return self._page

        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:
            raise RuntimeError(
                "Playwright not installed. Run: pip install playwright && playwright install chrome"
            ) from exc

        profile = browser_profile_dir()
        profile.mkdir(parents=True, exist_ok=True)
        headless = os.environ.get("CONTACTOUT_HEADLESS", "true").lower() == "true"

        self._playwright = sync_playwright().start()
        launch_kwargs: dict[str, Any] = {
            "user_data_dir": str(profile),
            "headless": headless,
            "viewport": {"width": 1440, "height": 900},
            "args": ["--disable-blink-features=AutomationControlled"],
        }
        try:
            self._context = self._playwright.chromium.launch_persistent_context(
                channel="chrome",
                **launch_kwargs,
            )
        except Exception:
            self._context = self._playwright.chromium.launch_persistent_context(
                **launch_kwargs,
            )

        self._page = self._context.pages[0] if self._context.pages else self._context.new_page()
        return self._page

    def _needs_login(self, page: Any) -> bool:
        url = page.url.lower()
        if "/login" in url or "/register" in url:
            return True
        if page.locator('input[type="password"]').count() > 0:
            return True
        return False

    def _click_reveal_buttons(self, page: Any) -> None:
        patterns = [
            re.compile(r"show", re.I),
            re.compile(r"reveal", re.I),
            re.compile(r"view (email|phone)", re.I),
            re.compile(r"get (email|phone|contact)", re.I),
        ]
        for pattern in patterns:
            buttons = page.get_by_role("button", name=pattern)
            count = min(buttons.count(), 6)
            for i in range(count):
                try:
                    buttons.nth(i).click(timeout=1500)
                    page.wait_for_timeout(400)
                except Exception:
                    continue

    def _extract_contacts(self, page: Any) -> ContactOutResult:
        emails: list[str] = []
        phones_raw: list[str] = []

        for locator in (
            page.locator('a[href^="mailto:"]'),
            page.locator('[data-email]'),
        ):
            count = min(locator.count(), 20)
            for i in range(count):
                try:
                    el = locator.nth(i)
                    href = el.get_attribute("href") or ""
                    data_email = el.get_attribute("data-email") or ""
                    text = (el.inner_text() or "").strip()
                    for candidate in (href.replace("mailto:", "").split("?")[0], data_email, text):
                        if candidate and "@" in candidate and "example.com" not in candidate.lower():
                            emails.append(candidate.strip())
                except Exception:
                    continue

        for locator in (
            page.locator('a[href^="tel:"]'),
            page.locator('[data-phone]'),
        ):
            count = min(locator.count(), 20)
            for i in range(count):
                try:
                    el = locator.nth(i)
                    href = el.get_attribute("href") or ""
                    data_phone = el.get_attribute("data-phone") or ""
                    text = (el.inner_text() or "").strip()
                    for candidate in (href.replace("tel:", ""), data_phone, text):
                        if candidate and PHONE_RE.search(candidate):
                            phones_raw.append(candidate.strip())
                except Exception:
                    continue

        body_text = page.inner_text("body")
        for match in EMAIL_RE.findall(body_text):
            if "example.com" not in match.lower():
                emails.append(match)
        for match in PHONE_RE.findall(body_text):
            if "phone number 1" not in match.lower():
                phones_raw.append(match.strip())

        deduped_emails: list[str] = []
        seen_email: set[str] = set()
        for email in emails:
            key = email.lower()
            if key in seen_email:
                continue
            seen_email.add(key)
            deduped_emails.append(email)

        work_emails = [e for e in deduped_emails if not is_personal_email_str(e)]
        personal_email = next((e for e in deduped_emails if is_personal_email_str(e)), None)
        if not personal_email and deduped_emails:
            personal_email = deduped_emails[0]

        phones = extract_contactout_phones(phones_raw)
        personal_phone = next(
            (p["number"] for p in phones if p.get("kind") == "mobile"),
            phones[0]["number"] if phones else None,
        )

        return ContactOutResult(
            personal_email=personal_email,
            personal_phone=personal_phone,
            work_emails=work_emails or None,
            phones=phones or None,
            credits_used=1,
        )

    def _search_profile(self, page: Any, linkedin_url: str) -> None:
        slug = _linkedin_slug(linkedin_url)
        queries = [
            linkedin_url,
            normalize_linkedin(linkedin_url),
            slug,
        ]

        page.goto(CONTACTOUT_SEARCH_URL, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(1200)

        if self._needs_login(page):
            raise RuntimeError(
                "ContactOut session expired. Run: python scripts/contactout_login.py"
            )

        search_selectors = [
            'input[placeholder*="Search" i]',
            'input[type="search"]',
            'input[name="search"]',
            'input[aria-label*="search" i]',
            "textarea",
            'input[type="text"]',
        ]

        filled = False
        for query in queries:
            for selector in search_selectors:
                locator = page.locator(selector).first
                try:
                    if locator.count() == 0:
                        continue
                    locator.click(timeout=2000)
                    locator.fill("")
                    locator.fill(query, timeout=3000)
                    locator.press("Enter")
                    page.wait_for_timeout(2500)
                    filled = True
                    break
                except Exception:
                    continue
            if filled:
                break

        if not filled:
            page.goto(
                f"{CONTACTOUT_SEARCH_URL}?q={quote(linkedin_url)}",
                wait_until="domcontentloaded",
                timeout=45000,
            )
            page.wait_for_timeout(2500)

        # Open the best-matching result card if present.
        for selector in (
            f'a[href*="{slug}"]',
            f'text="{slug}"',
            '[data-testid*="profile"]',
            ".profile-card",
            "table tbody tr",
        ):
            locator = page.locator(selector).first
            try:
                if locator.count() > 0:
                    locator.click(timeout=2500)
                    page.wait_for_timeout(1500)
                    break
            except Exception:
                continue

    def enrich_linkedin(self, linkedin_url: str) -> ContactOutResult | None:
        if not self.is_configured:
            logger.warning(
                "ContactOut dashboard not configured — set CONTACTOUT_MODE=dashboard and run contactout_login.py"
            )
            return None

        if self._lookups > 0:
            delay = _delay_seconds()
            logger.info("ContactOut dashboard throttle: sleeping %.0fs", delay)
            time.sleep(delay)

        page = self._ensure_browser()
        url = normalize_linkedin(linkedin_url)

        try:
            self._search_profile(page, url)
            self._click_reveal_buttons(page)
            result = self._extract_contacts(page)
            self._lookups += 1
            self.credits_used += result.credits_used

            if result.personal_email or result.phones or result.work_emails:
                logger.info(
                    "ContactOut dashboard: %s — personal=%s phones=%d",
                    _linkedin_slug(url),
                    result.personal_email,
                    len(result.phones or []),
                )
                return result

            logger.info("ContactOut dashboard: no data for %s", _linkedin_slug(url))
            return ContactOutResult()
        except Exception as exc:
            logger.warning("ContactOut dashboard failed for %s: %s", url, exc)
            return None
