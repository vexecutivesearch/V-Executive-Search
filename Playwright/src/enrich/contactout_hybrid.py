from __future__ import annotations

import logging
import os
from dataclasses import replace
from src.project_root import project_root

from src.enrich.contactout_api import ContactOutApiClient
from src.enrich.contactout_base import ContactOutResult, normalize_linkedin
from src.enrich.contactout_dashboard import ContactOutDashboardClient
from src.enrich.contactout_session import is_session_degraded

logger = logging.getLogger(__name__)

API_PHONE_LOCKED_FLAG = project_root() / ".contactout-api-phone-locked"


def mark_api_phone_locked() -> None:
    API_PHONE_LOCKED_FLAG.write_text("1", encoding="utf-8")


def api_phone_credits_exhausted() -> bool:
    return API_PHONE_LOCKED_FLAG.exists()


def clear_api_phone_locked_flag() -> None:
    if API_PHONE_LOCKED_FLAG.exists():
        API_PHONE_LOCKED_FLAG.unlink()


def _merge_results(
    base: ContactOutResult | None,
    extra: ContactOutResult | None,
) -> ContactOutResult | None:
    if not base:
        return extra
    if not extra:
        return base

    merged_phones = list(base.phones or [])
    for phone in extra.phones or []:
        key = f"{phone.get('source')}:{phone.get('number')}"
        if not any(f"{p.get('source')}:{p.get('number')}" == key for p in merged_phones):
            merged_phones.append(phone)

    personal_email = base.personal_email or extra.personal_email
    work_emails = list(dict.fromkeys((base.work_emails or []) + (extra.work_emails or [])))
    personal_phone = extra.personal_phone or base.personal_phone

    return replace(
        base,
        personal_email=personal_email,
        personal_phone=personal_phone,
        work_emails=work_emails or None,
        phones=merged_phones or None,
        credits_used=base.credits_used + extra.credits_used,
        phone_api_locked=base.phone_api_locked and extra.phone_api_locked,
    )


class ContactOutHybridClient:
    """API first; dashboard fallback when no API key or API phone credits unavailable."""

    def __init__(self) -> None:
        self._api = ContactOutApiClient()
        self._dashboard: ContactOutDashboardClient | None = None
        self.credits_used = 0
        self._api_phone_locked = False

    def _dashboard_client(self) -> ContactOutDashboardClient | None:
        if self._dashboard is not None:
            return self._dashboard
        client = ContactOutDashboardClient()
        if client.is_configured:
            self._dashboard = client
            return client
        return None

    @property
    def is_configured(self) -> bool:
        return self._api.is_configured or self._dashboard_client() is not None

    def should_use_dashboard(self, api_result: ContactOutResult | None) -> bool:
        forced = os.environ.get("CONTACTOUT_MODE", "auto").strip().lower()
        if forced == "api":
            return False

        if is_session_degraded():
            logger.info("ContactOut dashboard skipped — session degraded (Apollo-only until restored)")
            return False

        if forced == "dashboard":
            return self._dashboard_client() is not None

        if not self._dashboard_client():
            return False
        if not self._api.is_configured:
            logger.debug("ContactOut: using dashboard (no API key)")
            return True
        if self._api_phone_locked or api_phone_credits_exhausted():
            logger.debug("ContactOut: using dashboard (API phone credits exhausted)")
            return True
        if api_result and api_result.phone_api_locked:
            return True
        if api_result is None and self._api.is_configured:
            # API failed entirely — try dashboard.
            return True
        if api_result and (api_result.personal_email or api_result.work_emails):
            if not api_result.phones:
                logger.debug("ContactOut: using dashboard for phones (API emails only)")
                return True
        return False

    def enrich_linkedin(self, linkedin_url: str) -> ContactOutResult | None:
        url = normalize_linkedin(linkedin_url)
        api_result: ContactOutResult | None = None

        if self._api.is_configured and os.environ.get("CONTACTOUT_MODE", "auto") != "dashboard":
            api_result = self._api.enrich_linkedin(url)
            self.credits_used += self._api.credits_used
            if api_result and api_result.phone_api_locked:
                self._api_phone_locked = True
                mark_api_phone_locked()

        if self.should_use_dashboard(api_result):
            dashboard = self._dashboard_client()
            if dashboard:
                dash_result = dashboard.enrich_linkedin(url)
                self.credits_used += dashboard.credits_used
                merged = _merge_results(api_result, dash_result)
                if merged and (
                    merged.personal_email
                    or merged.phones
                    or merged.work_emails
                ):
                    return merged
            elif not self._api.is_configured:
                logger.warning("ContactOut dashboard not configured — run contactout_login.py")
                return None

        if api_result and (
            api_result.personal_email
            or api_result.phones
            or api_result.work_emails
        ):
            return api_result
        return api_result if api_result else None

    def close(self) -> None:
        if self._dashboard:
            self._dashboard.close()

    def __del__(self) -> None:
        self.close()
