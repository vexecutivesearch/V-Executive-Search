from __future__ import annotations

import logging
import re
import sys
import time
from enum import Enum
from pathlib import Path
from typing import Any

from src.contactout_alerts import send_contactout_session_alert
from src.contactout_keychain import get_contactout_credentials
from src.contactout_otp import fetch_contactout_otp
from src.enrich.contactout_dashboard import (
    CONTACTOUT_LOGIN_URL,
    CONTACTOUT_SEARCH_URL,
    _acquire_login_lock,
    _dashboard_loaded,
    _needs_login_page,
    _open_browser_context,
    _persist_session,
    _release_login_lock,
    dashboard_may_be_needed,
    has_saved_session,
    login_in_progress,
    session_file_path,
)

logger = logging.getLogger(__name__)


class SessionStatus(str, Enum):
    OK = "ok"
    NO_SESSION = "no_session"
    DEAD = "dead"
    DEGRADED = "degraded"
    LOGIN_IN_PROGRESS = "login_in_progress"
    NOT_NEEDED = "not_needed"


def _worker_root() -> Path:
    return Path(__file__).resolve().parents[2]


def degraded_flag_path() -> Path:
    return (_worker_root() / ".contactout-session-degraded").resolve()


def keepalive_stamp_path() -> Path:
    return (_worker_root() / ".contactout-last-keepalive").resolve()


def is_session_degraded() -> bool:
    return degraded_flag_path().exists()


def mark_session_degraded(reason: str = "") -> None:
    path = degraded_flag_path()
    path.write_text(reason or "session_unavailable", encoding="utf-8")
    logger.warning("ContactOut session marked degraded: %s", reason or "unknown")


def clear_session_degraded() -> None:
    path = degraded_flag_path()
    if path.exists():
        path.unlink()
    alert_path = _worker_root() / ".contactout-alert-sent"
    if alert_path.exists():
        try:
            alert_path.unlink()
        except OSError:
            pass


def _touch_keepalive_stamp() -> None:
    keepalive_stamp_path().write_text(str(time.time()), encoding="utf-8")


def canary_check(*, headless: bool = True) -> SessionStatus:
    """Layer 1 — instant session health check before scraping."""
    if not dashboard_may_be_needed():
        return SessionStatus.NOT_NEEDED
    if login_in_progress():
        return SessionStatus.LOGIN_IN_PROGRESS
    if not has_saved_session():
        return SessionStatus.NO_SESSION

    from src.enrich.contactout_dashboard import _session_check_with_playwright

    if _session_check_with_playwright(headless=headless):
        clear_session_degraded()
        return SessionStatus.OK
    return SessionStatus.DEAD


def _otp_screen_visible(page: Any) -> bool:
    patterns = (
        'input[name*="code" i]',
        'input[autocomplete="one-time-code"]',
        'input[inputmode="numeric"]',
        'input[placeholder*="code" i]',
    )
    for sel in patterns:
        if page.locator(sel).count() > 0:
            return True
    body = ""
    try:
        body = page.inner_text("body").lower()
    except Exception:
        pass
    return "verification code" in body or "one-time" in body


def _fill_otp(page: Any, code: str) -> None:
    digits = list(code.strip()[:6])
    multi = page.locator('input[inputmode="numeric"], input[maxlength="1"]')
    if multi.count() >= 4:
        for i, digit in enumerate(digits):
            if i < multi.count():
                multi.nth(i).fill(digit)
        return
    for sel in (
        'input[name*="code" i]',
        'input[autocomplete="one-time-code"]',
        'input[placeholder*="code" i]',
    ):
        loc = page.locator(sel).first
        if loc.count():
            loc.fill(code)
            loc.press("Enter")
            return


def _click_email_login_tab(page: Any) -> None:
    for pattern in (
        re.compile(r"email", re.I),
        re.compile(r"password", re.I),
        re.compile(r"sign in with email", re.I),
    ):
        try:
            tab = page.get_by_role("button", name=pattern)
            if tab.count():
                tab.first.click(timeout=2000)
                page.wait_for_timeout(500)
                return
        except Exception:
            continue
        try:
            link = page.get_by_role("link", name=pattern)
            if link.count():
                link.first.click(timeout=2000)
                page.wait_for_timeout(500)
                return
        except Exception:
            continue


def _submit_login_form(page: Any) -> None:
    for pattern in (
        re.compile(r"sign\s*in", re.I),
        re.compile(r"log\s*in", re.I),
        re.compile(r"continue", re.I),
    ):
        try:
            btn = page.get_by_role("button", name=pattern)
            if btn.count():
                btn.first.click(timeout=3000)
                return
        except Exception:
            continue
    page.locator('button[type="submit"]').first.click(timeout=3000)


def _fill_login_form(page: Any, email: str, password: str) -> None:
    _click_email_login_tab(page)
    for sel in (
        'input[type="email"]',
        'input[name="email"]',
        'input[name="username"]',
        'input[autocomplete="username"]',
    ):
        loc = page.locator(sel).first
        if loc.count():
            loc.click(timeout=2000)
            loc.fill(email)
            break
    pw = page.locator('input[type="password"]').first
    if pw.count():
        pw.click(timeout=2000)
        pw.fill(password)
    _submit_login_form(page)


def try_auto_login(*, headless: bool = True) -> bool:
    """Layer 2 — Keychain credentials + email/password form (+ optional IMAP OTP)."""
    if sys.platform != "darwin":
        return False
    creds = get_contactout_credentials()
    if not creds:
        logger.info("ContactOut auto-login skipped — no Keychain credentials")
        return False
    email, password = creds

    if login_in_progress():
        return False
    if not _acquire_login_lock():
        return False

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        _release_login_lock()
        return False

    playwright = sync_playwright().start()
    browser: Any | None = None
    context: Any | None = None
    try:
        browser, context, page = _open_browser_context(
            playwright, headless=headless, load_session=False
        )
        page.goto(CONTACTOUT_LOGIN_URL, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(1200)
        _fill_login_form(page, email, password)
        page.wait_for_timeout(4000)

        if _otp_screen_visible(page):
            logger.info("ContactOut OTP screen detected — checking IMAP")
            code = fetch_contactout_otp()
            if code:
                _fill_otp(page, code)
                page.wait_for_timeout(4000)
            else:
                logger.warning("ContactOut OTP required but IMAP code not found")
                return False

        if not _dashboard_loaded(page):
            if not _needs_login_page(page):
                page.goto(CONTACTOUT_SEARCH_URL, wait_until="domcontentloaded", timeout=45000)
                page.wait_for_timeout(2000)

        if _dashboard_loaded(page):
            _persist_session(context)
            clear_session_degraded()
            logger.info("ContactOut auto-login succeeded")
            return True

        logger.warning("ContactOut auto-login failed — still on login page")
        return False
    except Exception as exc:
        logger.warning("ContactOut auto-login error: %s", exc)
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


def run_keepalive() -> bool:
    """Layer 0 — headless dashboard visit to roll session cookies forward."""
    if not dashboard_may_be_needed():
        return True

    status = canary_check(headless=True)
    if status == SessionStatus.NOT_NEEDED:
        return True
    if status == SessionStatus.LOGIN_IN_PROGRESS:
        return False
    if status in (SessionStatus.NO_SESSION, SessionStatus.DEAD):
        logger.info("ContactOut keepalive: session not healthy (%s) — skipping refresh", status.value)
        return False

    if login_in_progress():
        return False

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return False

    playwright = sync_playwright().start()
    browser: Any | None = None
    context: Any | None = None
    try:
        browser, context, page = _open_browser_context(
            playwright, headless=True, load_session=True
        )
        page.goto(CONTACTOUT_SEARCH_URL, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(2000)
        if _dashboard_loaded(page):
            _persist_session(context)
            _touch_keepalive_stamp()
            clear_session_degraded()
            logger.info("ContactOut keepalive OK — session refreshed")
            return True
        logger.warning("ContactOut keepalive: dashboard not loaded")
        return False
    except Exception as exc:
        logger.warning("ContactOut keepalive failed: %s", exc)
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


def ensure_session_healthy(
    *,
    allow_interactive: bool = False,
    allow_auto_login: bool = True,
    alert_on_failure: bool = True,
) -> SessionStatus:
    """Run the self-healing ladder: canary → auto-login → interactive → alert."""
    if not dashboard_may_be_needed():
        return SessionStatus.NOT_NEEDED

    status = canary_check(headless=True)
    if status == SessionStatus.OK:
        return SessionStatus.OK
    if status == SessionStatus.LOGIN_IN_PROGRESS:
        return status

    logger.info("ContactOut canary: %s — attempting heal", status.value)

    if allow_auto_login and try_auto_login(headless=True):
        if canary_check(headless=True) == SessionStatus.OK:
            return SessionStatus.OK

    if allow_auto_login and try_auto_login(headless=False):
        if canary_check(headless=True) == SessionStatus.OK:
            return SessionStatus.OK

    if allow_interactive:
        from src.enrich.contactout_dashboard import ensure_contactout_session

        if ensure_contactout_session(interactive=True, timeout_sec=600):
            clear_session_degraded()
            if canary_check(headless=True) == SessionStatus.OK:
                return SessionStatus.OK

    mark_session_degraded(status.value)
    if alert_on_failure:
        send_contactout_session_alert(
            reason=f"Session {status.value}; auto-login and interactive recovery failed"
        )
    return SessionStatus.DEGRADED


def prepare_for_pipeline() -> SessionStatus:
    """Layer 1 at pipeline start — heal before enrichment, never block Apollo."""
    return ensure_session_healthy(
        allow_interactive=False,
        allow_auto_login=True,
        alert_on_failure=True,
    )
