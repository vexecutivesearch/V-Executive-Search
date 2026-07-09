from __future__ import annotations

import json
import re
from typing import Any

_PERSONAL_EMAIL_DOMAINS = {
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


def phone_digits(phone: str) -> str:
    return re.sub(r"\D", "", phone)


def parse_phone_value(raw: str | None) -> str | None:
    if not raw:
        return None
    trimmed = raw.strip()
    if not trimmed:
        return None
    if trimmed.startswith("{"):
        try:
            obj = json.loads(trimmed)
            if isinstance(obj, dict):
                return (
                    obj.get("sanitized_number")
                    or obj.get("number")
                    or obj.get("raw_number")
                )
        except json.JSONDecodeError:
            return None
    return trimmed


def is_personal_email(email: str) -> bool:
    domain = email.split("@")[-1].lower() if "@" in email else ""
    return domain in _PERSONAL_EMAIL_DOMAINS or any(
        domain.endswith(f".{d}") for d in _PERSONAL_EMAIL_DOMAINS
    )


def extract_apollo_mobile(person: dict[str, Any]) -> str | None:
    """Return direct mobile only — never company HQ / switchboard fallback."""
    phones = person.get("phone_numbers") or []
    for entry in phones:
        if not isinstance(entry, dict):
            continue
        type_cd = (entry.get("type_cd") or entry.get("type") or "").lower()
        if type_cd in ("mobile", "other", "cell"):
            return (
                entry.get("sanitized_number")
                or entry.get("raw_number")
                or entry.get("number")
            )
    return None


def apply_company_phone_dedupe(contacts: list[Any]) -> None:
    """Mutates contacts: clears phone when same number appears on 2+ people."""
    counts: dict[str, int] = {}
    for contact in contacts:
        for attr in ("personal_phone", "phone", "company_phone"):
            parsed = parse_phone_value(getattr(contact, attr, None))
            if not parsed:
                continue
            key = phone_digits(parsed)
            if len(key) >= 10:
                counts[key] = counts.get(key, 0) + 1

    for contact in contacts:
        personal = parse_phone_value(getattr(contact, "personal_phone", None))
        direct = parse_phone_value(getattr(contact, "phone", None))

        best = personal or direct
        if best and not personal:
            key = phone_digits(best)
            if counts.get(key, 0) >= 2:
                contact.phone = None
                if not getattr(contact, "company_phone", None):
                    contact.company_phone = direct
            else:
                contact.phone = best
        elif personal:
            contact.phone = personal
