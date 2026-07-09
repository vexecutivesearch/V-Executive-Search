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
from src.human_behavior import between_profile_pause, human_pause
from src.project_root import project_root
from src.rate_limit import is_rate_limited, mark_rate_limited, page_shows_rate_limit
from src.stealth_browser import get_sync_playwright, open_browser_context, persist_session

logger = logging.getLogger(__name__)

CONTACTOUT_LOGIN_URL = "https://contactout.com/login"
CONTACTOUT_SEARCH_URL = "https://contactout.com/dashboard/search"

EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)
PHONE_RE = re.compile(r"\+?\d[\d\s().-]{7,}\d")


def _worker_root() -> Path:
    return project_root()


def session_file_path() -> Path:
    """Absolute path to saved ContactOut cookies (used by all background runs)."""
    custom = os.environ.get("CONTACTOUT_SESSION_FILE", "").strip()
    if custom:
        return Path(custom).expanduser().resolve()
    return (_worker_root() / ".contactout-session.json").resolve()


def browser_profile_dir() -> Path:
    """Legacy alias — session cookies live in session_file_path()."""
    return session_file_path().parent


def has_saved_session() -> bool:
    path = session_file_path()
    try:
        return path.is_file() and path.stat().st_size > 32
    except OSError:
        return False


def login_lock_path() -> Path:
    return (_worker_root() / ".contactout-login.lock").resolve()


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def login_in_progress() -> bool:
    path = login_lock_path()
    if not path.exists():
        return False
    try:
        pid = int(path.read_text(encoding="utf-8").strip())
        if _pid_alive(pid):
            return True
    except (ValueError, OSError):
        pass
    try:
        path.unlink()
    except OSError:
        pass
    return False


def _acquire_login_lock() -> bool:
    path = login_lock_path()
    if login_in_progress():
        return False
    path.write_text(str(os.getpid()), encoding="utf-8")
    return True


def _release_login_lock() -> None:
    path = login_lock_path()
    try:
        if path.exists() and path.read_text(encoding="utf-8").strip() == str(os.getpid()):
            path.unlink()
    except OSError:
        pass


def _delay_seconds() -> float:
    low = float(os.environ.get("CONTACTOUT_DASHBOARD_DELAY_MIN", "60"))
    high = float(os.environ.get("CONTACTOUT_DASHBOARD_DELAY_MAX", "150"))
    return random.uniform(min(low, high), max(low, high))


def _linkedin_slug(url: str) -> str:
    return normalize_linkedin(url).rstrip("/").split("/")[-1]


def _needs_login_page(page: Any) -> bool:
    url = page.url.lower()
    if "/dashboard" in url and "/login" not in url:
        return False
    if "/login" in url or "/register" in url:
        return True
    return page.locator('input[type="password"]').count() > 0


def _dashboard_loaded(page: Any) -> bool:
    url = page.url.lower()
    if "/login" in url or "/register" in url:
        return False
    if "/dashboard" in url:
        for selector in (
            'input[placeholder*="Search" i]',
            'input[type="search"]',
            'input[name="search"]',
        ):
            if page.locator(selector).count() > 0:
                return True
        return True
    return False


def _persist_session(context: Any) -> None:
    persist_session(context)


def _open_browser_context(
    playwright: Any,
    *,
    headless: bool,
    load_session: bool = True,
    use_persistent_profile: bool = False,
) -> tuple[Any, Any, Any]:
    """Stealth browser via Patchright + optional system Chrome profile."""
    return open_browser_context(
        playwright,
        headless=headless,
        load_session=load_session,
        use_persistent_profile=use_persistent_profile,
    )


def _session_check_with_playwright(*, headless: bool) -> bool:
    if login_in_progress():
        logger.info("ContactOut login in progress — skipping session check")
        return False
    if not has_saved_session():
        return False

    try:
        sync_playwright = get_sync_playwright()
    except ImportError:
        return False

    playwright = sync_playwright().start()
    browser: Any | None = None
    context: Any | None = None
    try:
        browser, context, page = _open_browser_context(
            playwright, headless=headless, load_session=True
        )
        page.goto(CONTACTOUT_SEARCH_URL, wait_until="domcontentloaded", timeout=45000)
        human_pause(page, label="session-check")
        return _dashboard_loaded(page)
    except Exception as exc:
        logger.debug("ContactOut session check failed: %s", exc)
        return False
    finally:
        if context:
            try:
                context.close()
            except Exception:
                pass
        if browser:
            try:
                browser.close()
            except Exception:
                pass
        playwright.stop()


def ensure_contactout_session(
    *,
    timeout_sec: int = 600,
    interactive: bool = True,
) -> bool:
    """Ensure a logged-in ContactOut dashboard session exists."""
    if sys.platform != "darwin":
        return False
    if not dashboard_may_be_needed():
        return False

    if login_in_progress():
        logger.info(
            "ContactOut login already in progress in another window — not opening a second browser"
        )
        return False

    if _session_check_with_playwright(headless=True):
        logger.info("ContactOut dashboard session is ready")
        return True

    if not interactive:
        logger.info(
            "ContactOut not logged in — run once: python scripts/contactout_login.py "
            "(saves session to %s)",
            session_file_path(),
        )
        return False

    try:
        sync_playwright = get_sync_playwright()
    except ImportError:
        logger.warning(
            "Patchright/Playwright not installed — run: pip install -e . && patchright install chrome"
        )
        return False

    if not _acquire_login_lock():
        logger.info("ContactOut login already in progress — waiting for that session to finish")
        return False

    session_path = session_file_path()
    logger.info(
        "ContactOut login required — opening a dedicated automation browser (not your daily Chrome). "
        "Sign in and leave the window open until this script confirms success. "
        "Session will be saved to: %s",
        session_path,
    )

    playwright = sync_playwright().start()
    browser: Any | None = None
    context: Any | None = None
    try:
        browser, context, page = _open_browser_context(
            playwright, headless=False, load_session=has_saved_session(), use_persistent_profile=True
        )
        page.goto(CONTACTOUT_LOGIN_URL, wait_until="domcontentloaded", timeout=45000)

        deadline = time.time() + timeout_sec
        while time.time() < deadline:
            try:
                if _dashboard_loaded(page):
                    page.wait_for_timeout(2000)
                    _persist_session(context)
                    from src.enrich.contactout_session import clear_session_degraded

                    clear_session_degraded()
                    logger.info("ContactOut dashboard session saved")
                    return True
                if not _needs_login_page(page):
                    page.goto(CONTACTOUT_SEARCH_URL, wait_until="domcontentloaded", timeout=45000)
                    page.wait_for_timeout(2000)
                    if _dashboard_loaded(page):
                        page.wait_for_timeout(2000)
                        _persist_session(context)
                        from src.enrich.contactout_session import clear_session_degraded

                        clear_session_degraded()
                        logger.info("ContactOut dashboard session saved")
                        return True
            except Exception:
                pass
            page.wait_for_timeout(2000)

        logger.warning(
            "ContactOut login timed out after %ds — finish sign-in, then re-run "
            "python scripts/contactout_login.py",
            timeout_sec,
        )
        return False
    except Exception as exc:
        logger.warning("ContactOut interactive login failed: %s", exc)
        return False
    finally:
        if context:
            try:
                context.close()
            except Exception:
                pass
        if browser:
            try:
                browser.close()
            except Exception:
                pass
        playwright.stop()
        _release_login_lock()


def dashboard_may_be_needed() -> bool:
    if sys.platform != "darwin":
        return False
    mode = os.environ.get("CONTACTOUT_MODE", "auto").strip().lower()
    if mode == "api":
        return False
    if mode == "dashboard":
        return True
    from src.enrich.contactout_api import ContactOutApiClient
    from src.enrich.contactout_hybrid import api_phone_credits_exhausted

    api = ContactOutApiClient()
    if not api.is_configured:
        return True
    return api_phone_credits_exhausted()


def prepare_contactout_dashboard(*, interactive: bool = False) -> bool:
    """Called at pipeline start — headless check only unless *interactive* is True."""
    if not dashboard_may_be_needed():
        return True
    return ensure_contactout_session(interactive=interactive, timeout_sec=600)


class ContactOutDashboardClient:
    """ContactOut via logged-in Chrome dashboard (Mac mini). No LinkedIn browsing."""

    def __init__(self) -> None:
        self.credits_used = 0
        self._playwright: Any | None = None
        self._browser: Any | None = None
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
        return True

    def close(self) -> None:
        if self._context:
            try:
                self._context.close()
            except Exception:
                pass
        if self._browser:
            try:
                self._browser.close()
            except Exception:
                pass
        if self._playwright:
            try:
                self._playwright.stop()
            except Exception:
                pass
        self._context = None
        self._browser = None
        self._playwright = None
        self._page = None

    def __del__(self) -> None:
        self.close()

    def _reset_browser(self) -> None:
        if self._context:
            try:
                self._context.close()
            except Exception:
                pass
        if self._browser:
            try:
                self._browser.close()
            except Exception:
                pass
        self._context = None
        self._browser = None
        self._page = None

    def _ensure_browser(self) -> Any:
        if self._page is not None:
            return self._page

        if login_in_progress():
            raise RuntimeError(
                "ContactOut login in progress — finish signing in, then retry"
            )

        if not has_saved_session():
            raise RuntimeError(
                f"ContactOut not logged in — run once: python scripts/contactout_login.py "
                f"(saves session to {session_file_path()})"
            )

        sync_playwright = get_sync_playwright()
        headless = os.environ.get("CONTACTOUT_HEADLESS", "false").lower() == "true"

        self._playwright = sync_playwright().start()
        self._browser, self._context, self._page = _open_browser_context(
            self._playwright,
            headless=headless,
            load_session=True,
        )
        return self._page

    def _needs_login(self, page: Any) -> bool:
        return _needs_login_page(page)

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
                    human_pause(page, label="reveal-click")
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
        human_pause(page, label="search-load")

        if self._needs_login(page):
            from src.enrich.contactout_session import ensure_session_healthy

            status = ensure_session_healthy(allow_interactive=True, allow_auto_login=True)
            if status.value not in ("ok", "not_needed"):
                raise RuntimeError(
                    "ContactOut session expired — run: python scripts/contactout_login.py"
                )
            self._reset_browser()
            page = self._ensure_browser()
            page.goto(CONTACTOUT_SEARCH_URL, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(1200)
            if self._needs_login(page):
                raise RuntimeError("ContactOut login still required after ensure_contactout_session")

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
                    human_pause(page, label="search-submit")
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
            human_pause(page, label="search-fallback")

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
                    human_pause(page, label="open-profile")
                    break
            except Exception:
                continue

    def enrich_linkedin(self, linkedin_url: str) -> ContactOutResult | None:
        if not self.is_configured:
            logger.warning(
                "ContactOut dashboard not configured — set CONTACTOUT_MODE=dashboard and run contactout_login.py"
            )
            return None

        if is_rate_limited():
            logger.warning("ContactOut dashboard skipped — rate limited (see .contactout-rate-limited)")
            return None

        if self._lookups > 0:
            between_profile_pause()

        page = self._ensure_browser()
        url = normalize_linkedin(linkedin_url)

        try:
            self._search_profile(page, url)
            if page_shows_rate_limit(page):
                mark_rate_limited()
                logger.warning("ContactOut dashboard rate limit detected in UI")
                return None
            self._click_reveal_buttons(page)
            human_pause(page, label="post-extract")
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
