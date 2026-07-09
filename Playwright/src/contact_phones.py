from __future__ import annotations

import re
from typing import Any, Literal

PhoneSource = Literal["apollo", "contactout"]
PhoneKind = Literal["mobile", "work", "company", "other"]


def _parse_phone(raw: str | None) -> str | None:
    if not raw:
        return None
    trimmed = raw.strip()
    if not trimmed:
        return None
    if trimmed.startswith("{"):
        import json

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


def _phone_digits(number: str) -> str:
    return re.sub(r"\D", "", number)


def extract_contactout_phones(raw: list[Any]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for entry in raw:
        if isinstance(entry, str):
            number = _parse_phone(entry)
            if number:
                out.append({"number": number, "source": "contactout", "kind": "mobile"})
            continue
        if not isinstance(entry, dict):
            continue
        number = _parse_phone(
            entry.get("number")
            or entry.get("sanitized_number")
            or entry.get("value")
            or entry.get("phone")
        )
        if not number:
            continue
        phone_type = (entry.get("type") or entry.get("label") or "").lower()
        kind: PhoneKind = "other"
        if "mobile" in phone_type or "cell" in phone_type or "personal" in phone_type:
            kind = "mobile"
        elif "work" in phone_type:
            kind = "work"
        elif "company" in phone_type:
            kind = "company"
        out.append({"number": number, "source": "contactout", "kind": kind})
    return dedupe_sourced_phones(out)


def dedupe_sourced_phones(phones: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for p in phones:
        number = _parse_phone(p.get("number"))
        if not number:
            continue
        key = f"{p.get('source')}:{_phone_digits(number)}"
        if key in seen:
            continue
        seen.add(key)
        out.append({**p, "number": number})
    return out


def merge_sourced_phones(*groups: list[dict[str, str]] | None) -> list[dict[str, str]]:
    merged: list[dict[str, str]] = []
    for group in groups:
        if group:
            merged.extend(group)
    return dedupe_sourced_phones(merged)


def _direct_dial_rank(p: dict[str, str]) -> int:
    kind = p.get("kind")
    source = p.get("source")
    if kind == "company":
        return 100
    if source == "contactout" and kind == "mobile":
        return 0
    if source == "contactout":
        return 1
    if source == "apollo" and kind == "mobile":
        return 2
    if source == "apollo" and kind == "work":
        return 3
    if source == "apollo" and kind == "other":
        return 4
    return 5


def pick_primary_from_phones(phones: list[dict[str, str]]) -> dict[str, str | None]:
    sorted_phones = sorted(phones, key=_direct_dial_rank)
    direct_dial = next((p for p in sorted_phones if p.get("kind") != "company"), None)
    company_line = next((p for p in sorted_phones if p.get("kind") == "company"), None)

    personal = (
        next(
            (
                p
                for p in sorted_phones
                if p.get("source") == "contactout" and p.get("kind") == "mobile"
            ),
            None,
        )
        or next((p for p in sorted_phones if p.get("source") == "contactout"), None)
        or next(
            (
                p
                for p in sorted_phones
                if p.get("source") == "apollo" and p.get("kind") == "mobile"
            ),
            None,
        )
    )

    phone = (direct_dial or {}).get("number") or (company_line or {}).get("number")
    return {
        "phone": phone,
        "personal_phone": (personal or {}).get("number"),
        "company_phone": (company_line or {}).get("number"),
    }


def contact_phones_for_display(contact: dict[str, Any]) -> list[dict[str, str]]:
    phones = contact.get("phones") or []
    if phones:
        return dedupe_sourced_phones(phones)

    legacy: list[dict[str, str]] = []
    for field, kind in (
        ("personal_phone", "mobile"),
        ("phone", "mobile"),
        ("company_phone", "company"),
    ):
        number = _parse_phone(contact.get(field))
        if number:
            legacy.append(
                {
                    "number": number,
                    "source": "contactout" if field == "personal_phone" else "apollo",
                    "kind": kind,
                }
            )
    return dedupe_sourced_phones(legacy)
