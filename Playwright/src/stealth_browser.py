from __future__ import annotations

import logging
import os
import random
from pathlib import Path
from typing import Any

from src.project_root import project_root

logger = logging.getLogger(__name__)


def session_file_path() -> Path:
    custom = os.environ.get("CONTACTOUT_SESSION_FILE", "").strip()
    if custom:
        return Path(custom).expanduser().resolve()
    return (project_root() / ".contactout-session.json").resolve()


def chrome_profile_dir() -> Path:
    custom = os.environ.get("CONTACTOUT_CHROME_PROFILE", "").strip()
    if custom:
        return Path(custom).expanduser().resolve()
    return (project_root() / ".contactout-chrome-profile").resolve()


def get_sync_playwright() -> Any:
    """
    Patchright is a drop-in replacement that patches automation flags.
    Set CONTACTOUT_BROWSER_ENGINE=playwright to use stock Playwright.
    """
    engine = os.environ.get("CONTACTOUT_BROWSER_ENGINE", "patchright").strip().lower()
    if engine == "patchright":
        try:
            from patchright.sync_api import sync_playwright

            logger.debug("Browser engine: patchright")
            return sync_playwright
        except ImportError:
            logger.warning("patchright missing — pip install patchright; using playwright")
    from playwright.sync_api import sync_playwright

    logger.debug("Browser engine: playwright")
    return sync_playwright


def _proxy_config() -> dict[str, str] | None:
    pool = os.environ.get("CONTACTOUT_PROXY_LIST", "").strip()
    single = os.environ.get("CONTACTOUT_PROXY_URL", "").strip()
    url = single
    if pool:
        urls = [u.strip() for u in pool.split(",") if u.strip()]
        if urls:
            url = random.choice(urls)
    return {"server": url} if url else None


def _launch_args() -> list[str]:
    return [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-dev-shm-usage",
    ]


def _default_user_agent() -> str:
    return (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    )


def _apply_cdp_fingerprint(context: Any, page: Any) -> None:
    tz = os.environ.get("CONTACTOUT_CDP_TIMEZONE", "America/New_York").strip()
    locale = os.environ.get("CONTACTOUT_CDP_LOCALE", "en-US").strip()
    try:
        cdp = context.new_cdp_session(page)
        cdp.send("Emulation.setTimezoneOverride", {"timezoneId": tz})
        cdp.send("Emulation.setLocaleOverride", {"locale": locale})
        cdp.send(
            "Network.setUserAgentOverride",
            {
                "userAgent": _default_user_agent(),
                "userAgentMetadata": {
                    "brands": [
                        {"brand": "Chromium", "version": "131"},
                        {"brand": "Google Chrome", "version": "131"},
                        {"brand": "Not_A Brand", "version": "24"},
                    ],
                    "fullVersion": "131.0.0.0",
                    "platform": "macOS",
                    "platformVersion": "14.0.0",
                    "architecture": "arm",
                    "model": "",
                    "mobile": False,
                },
            },
        )
    except Exception as exc:
        logger.debug("CDP fingerprint alignment skipped: %s", exc)


def open_browser_context(
    playwright: Any,
    *,
    headless: bool,
    load_session: bool = True,
    use_persistent_profile: bool = False,
) -> tuple[Any, Any, Any]:
    """
    Launch browser + context with stealth defaults.

    - Login / Turnstile: use_persistent_profile=True, headless=False, system Chrome
    - Background jobs: load cookies from session file, Patchright Chromium
    """
    proxy = _proxy_config()
    use_chrome = os.environ.get("CONTACTOUT_USE_SYSTEM_CHROME", "true").lower() == "true"

    if use_persistent_profile:
        profile = chrome_profile_dir()
        profile.mkdir(parents=True, exist_ok=True)
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(profile),
            headless=headless,
            channel="chrome" if use_chrome else None,
            args=_launch_args(),
            proxy=proxy,
            viewport={"width": 1440, "height": 900},
            user_agent=_default_user_agent(),
            locale=os.environ.get("CONTACTOUT_CDP_LOCALE", "en-US"),
            timezone_id=os.environ.get("CONTACTOUT_CDP_TIMEZONE", "America/New_York"),
        )
        page = context.pages[0] if context.pages else context.new_page()
        _apply_cdp_fingerprint(context, page)
        return context, context, page

    launch_kwargs: dict[str, Any] = {
        "headless": headless,
        "args": _launch_args(),
        "proxy": proxy,
    }
    if use_chrome and not headless:
        launch_kwargs["channel"] = "chrome"

    browser = playwright.chromium.launch(**launch_kwargs)
    context_kwargs: dict[str, Any] = {
        "viewport": {"width": 1440, "height": 900},
        "user_agent": _default_user_agent(),
        "locale": os.environ.get("CONTACTOUT_CDP_LOCALE", "en-US"),
        "timezone_id": os.environ.get("CONTACTOUT_CDP_TIMEZONE", "America/New_York"),
        "proxy": proxy,
    }
    session = session_file_path()
    if load_session and session.is_file():
        context_kwargs["storage_state"] = str(session)

    context = browser.new_context(**context_kwargs)
    page = context.new_page()
    _apply_cdp_fingerprint(context, page)
    return browser, context, page


def pick_proxy_for_lookup() -> dict[str, str] | None:
    """Rotate residential exit node per profile lookup when pool is configured."""
    return _proxy_config()


def open_fresh_context(
    playwright: Any,
    *,
    headless: bool,
    load_session: bool = True,
) -> tuple[Any, Any, Any]:
    """New isolated context — rotate proxy + cookies per lookup."""
    return open_browser_context(
        playwright,
        headless=headless,
        load_session=load_session,
        use_persistent_profile=False,
    )


def persist_session(context: Any) -> None:
    path = session_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    context.storage_state(path=str(path))
    logger.info("Saved ContactOut session to %s", path)
