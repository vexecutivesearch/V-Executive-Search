from __future__ import annotations

import logging
import os
from dataclasses import replace
from typing import Any

import requests

from src.contact_phones import extract_contactout_phones
from src.enrich.contactout_base import ContactOutResult, normalize_linkedin
from src.enrich.contactout_rate_limit import is_rate_limited, mark_rate_limited
from src.enrich.contactout_samples import is_contactout_sample_response

logger = logging.getLogger(__name__)

CONTACTOUT_LINKEDIN_URL = "https://api.contactout.com/v1/people/linkedin"


def _headers(api_key: str) -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "token": api_key,
    }


def is_personal_email_str(email: str) -> bool:
    domain = email.split("@")[-1].lower() if "@" in email else ""
    personal = {
        "gmail.com",
        "yahoo.com",
        "hotmail.com",
        "outlook.com",
        "icloud.com",
        "me.com",
        "aol.com",
        "proton.me",
        "protonmail.com",
    }
    return domain in personal or any(domain.endswith(f".{d}") for d in personal)


def _pick_personal_email(emails: list[Any]) -> str | None:
    for entry in emails:
        if isinstance(entry, str):
            if is_personal_email_str(entry):
                return entry
            continue
        if not isinstance(entry, dict):
            continue
        email = entry.get("email") or entry.get("value") or entry.get("address")
        if not email:
            continue
        email_type = (entry.get("type") or entry.get("label") or "").lower()
        if "personal" in email_type or is_personal_email_str(str(email)):
            return str(email)
    for entry in emails:
        if isinstance(entry, str):
            return entry
        if isinstance(entry, dict):
            email = entry.get("email") or entry.get("value")
            if email:
                return str(email)
    return None


def _collect_profile_lists(profile: dict[str, Any], keys: tuple[str, ...]) -> list[Any]:
    out: list[Any] = []
    for key in keys:
        val = profile.get(key)
        if isinstance(val, list):
            out.extend(val)
        elif isinstance(val, str) and val:
            out.append(val)
    return out


def _parse_payload(data: dict[str, Any]) -> ContactOutResult:
    if is_contactout_sample_response(data):
        return ContactOutResult(phone_api_locked=True)

    profile = data.get("profile") or data.get("data") or data
    if not isinstance(profile, dict):
        return ContactOutResult()

    emails_raw = _collect_profile_lists(
        profile,
        ("personal_email", "personal_emails", "emails", "email"),
    )
    phones_raw = _collect_profile_lists(
        profile,
        ("phone", "phones", "mobile", "personal_phone"),
    )
    work = [
        str(v)
        for v in _collect_profile_lists(profile, ("work_email", "work_emails"))
        if v
    ]

    phones = extract_contactout_phones(phones_raw)
    personal_phone = next(
        (p["number"] for p in phones if p.get("kind") == "mobile"),
        phones[0]["number"] if phones else None,
    )

    return ContactOutResult(
        personal_email=_pick_personal_email(emails_raw),
        personal_phone=personal_phone,
        work_emails=work or None,
        phones=phones or None,
        credits_used=1,
    )


def _merge_results(base: ContactOutResult, phones: ContactOutResult) -> ContactOutResult:
    merged_phones = list(base.phones or [])
    for phone in phones.phones or []:
        key = f"{phone.get('source')}:{phone.get('number')}"
        if not any(f"{p.get('source')}:{p.get('number')}" == key for p in merged_phones):
            merged_phones.append(phone)

    personal_phone = phones.personal_phone or base.personal_phone
    return replace(
        base,
        personal_phone=personal_phone,
        phones=merged_phones or None,
        credits_used=base.credits_used + phones.credits_used,
        phone_api_locked=base.phone_api_locked or phones.phone_api_locked,
    )


class ContactOutApiClient:
    def __init__(self) -> None:
        self._api_key = os.environ.get("CONTACTOUT_API_KEY", "")
        self.credits_used = 0

    @property
    def is_configured(self) -> bool:
        return bool(self._api_key)

    def enrich_linkedin(self, linkedin_url: str, **_kwargs: Any) -> ContactOutResult | None:
        if not self._api_key:
            return None
        if is_rate_limited():
            logger.warning("ContactOut API skipped — rate limited")
            return None

        url = normalize_linkedin(linkedin_url)
        headers = _headers(self._api_key)

        try:
            email_resp = requests.get(
                CONTACTOUT_LINKEDIN_URL,
                headers=headers,
                params={"profile": url, "email_type": "personal,work"},
                timeout=30,
            )
            if email_resp.status_code == 404:
                logger.info("ContactOut API: no match for %s", url)
                return ContactOutResult()
            if email_resp.status_code == 429:
                mark_rate_limited()
                logger.warning("ContactOut API 429 for %s", url)
                return None
            email_resp.raise_for_status()
            base = _parse_payload(email_resp.json())
            if base.phone_api_locked:
                logger.warning(
                    "ContactOut API placeholder response for %s — check plan/credits",
                    url,
                )
                return ContactOutResult(phone_api_locked=True)

            phone_resp = requests.get(
                CONTACTOUT_LINKEDIN_URL,
                headers=headers,
                params={"profile": url, "include_phone": "true", "email_type": "none"},
                timeout=30,
            )
            if phone_resp.status_code == 404:
                self.credits_used += base.credits_used
                return base if (base.personal_email or base.work_emails) else None
            if phone_resp.status_code == 429:
                mark_rate_limited()
                self.credits_used += base.credits_used
                return base if (base.personal_email or base.work_emails) else None

            phone_resp.raise_for_status()
            phone_result = _parse_payload(phone_resp.json())
            if phone_result.phone_api_locked:
                logger.info("ContactOut API phone credits unavailable for %s — emails only", url)
                self.credits_used += base.credits_used
                return base if (base.personal_email or base.work_emails) else None

            merged = _merge_results(base, phone_result)
            self.credits_used += merged.credits_used
            if merged.personal_email or merged.phones or merged.work_emails:
                return merged
        except requests.RequestException as exc:
            detail = ""
            if hasattr(exc, "response") and exc.response is not None:
                detail = exc.response.text[:200]
                if exc.response.status_code == 429:
                    mark_rate_limited()
            logger.warning("ContactOut API failed for %s: %s %s", url, exc, detail)

        return None

    def close(self) -> None:
        pass
