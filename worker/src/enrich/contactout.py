from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from typing import Any

import requests

from src.contact_phones import extract_contactout_phones

logger = logging.getLogger(__name__)

CONTACTOUT_PROFILE_URL = "https://api.contactout.com/v2/enrich/profile"
CONTACTOUT_LINKEDIN_URL = "https://api.contactout.com/v1/people/linkedin"


@dataclass
class ContactOutResult:
    personal_email: str | None = None
    personal_phone: str | None = None
    work_emails: list[str] | None = None
    phones: list[dict[str, str]] | None = None
    credits_used: int = 0


def _headers(api_key: str) -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "token": api_key,
    }


def _normalize_linkedin(url: str) -> str:
    url = url.strip()
    if not url.startswith("http"):
        url = f"https://www.linkedin.com/in/{url.strip('/')}"
    return url


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


def _pick_mobile_phone(phones: list[Any]) -> str | None:
    for entry in phones:
        if isinstance(entry, str):
            return entry
        if not isinstance(entry, dict):
            continue
        phone_type = (entry.get("type") or entry.get("label") or "").lower()
        number = (
            entry.get("number")
            or entry.get("sanitized_number")
            or entry.get("value")
            or entry.get("phone")
        )
        if not number:
            continue
        if "mobile" in phone_type or "cell" in phone_type or "personal" in phone_type:
            return str(number)
    for entry in phones:
        if isinstance(entry, str):
            return entry
        if isinstance(entry, dict):
            number = entry.get("number") or entry.get("sanitized_number")
            if number:
                return str(number)
    return None


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


def _parse_payload(data: dict[str, Any]) -> ContactOutResult:
    profile = data.get("profile") or data.get("data") or data
    if not isinstance(profile, dict):
        return ContactOutResult()

    emails_raw: list[Any] = []
    for key in ("personal_email", "personal_emails", "emails", "email"):
        val = profile.get(key)
        if isinstance(val, list):
            emails_raw.extend(val)
        elif isinstance(val, str) and val:
            emails_raw.append(val)

    phones_raw: list[Any] = []
    for key in ("phone", "phones", "mobile", "personal_phone"):
        val = profile.get(key)
        if isinstance(val, list):
            phones_raw.extend(val)
        elif isinstance(val, str) and val:
            phones_raw.append(val)

    work: list[str] = []
    for key in ("work_email", "work_emails"):
        val = profile.get(key)
        if isinstance(val, list):
            work.extend(str(v) for v in val if v)
        elif isinstance(val, str) and val:
            work.append(val)

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


class ContactOutClient:
    def __init__(self) -> None:
        self._api_key = os.environ.get("CONTACTOUT_API_KEY", "")
        self.credits_used = 0

    @property
    def is_configured(self) -> bool:
        return bool(self._api_key)

    def enrich_linkedin(self, linkedin_url: str) -> ContactOutResult | None:
        if not self._api_key:
            return None

        url = _normalize_linkedin(linkedin_url)
        headers = _headers(self._api_key)

        for endpoint, method, payload in (
            (CONTACTOUT_LINKEDIN_URL, "get", {"profile": url, "include": "personal_email,phone"}),
            (CONTACTOUT_PROFILE_URL, "post", {"profile": url, "include": "personal_email,phone"}),
        ):
            try:
                if method == "post":
                    resp = requests.post(
                        endpoint,
                        headers=headers,
                        json=payload,
                        timeout=30,
                    )
                else:
                    resp = requests.get(
                        endpoint,
                        headers=headers,
                        params={"profile": url},
                        timeout=30,
                    )
                if resp.status_code == 404:
                    logger.info("ContactOut: no match for %s", url)
                    return ContactOutResult()
                resp.raise_for_status()
                result = _parse_payload(resp.json())
                self.credits_used += result.credits_used
                if result.personal_email or result.phones or result.work_emails:
                    return result
            except requests.RequestException as exc:
                detail = ""
                if hasattr(exc, "response") and exc.response is not None:
                    detail = exc.response.text[:200]
                logger.warning("ContactOut %s failed for %s: %s %s", endpoint, url, exc, detail)

        return None
