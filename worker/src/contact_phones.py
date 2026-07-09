from __future__ import annotations

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
    import re

    return re.sub(r"\D", "", number)


def extract_apollo_phones(person: dict[str, Any]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for entry in person.get("phone_numbers") or []:
        if not isinstance(entry, dict):
            continue
        number = _parse_phone(
            entry.get("sanitized_number")
            or entry.get("raw_number")
            or entry.get("number")
        )
        if not number:
            continue
        type_cd = (entry.get("type_cd") or entry.get("type") or "other").lower()
        kind: PhoneKind = "other"
        if type_cd in ("mobile", "cell"):
            kind = "mobile"
        elif type_cd in ("work", "direct"):
            kind = "work"
        elif type_cd in ("company", "hq"):
            kind = "company"
        out.append({"number": number, "source": "apollo", "kind": kind})
    return dedupe_sourced_phones(out)


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


def pick_primary_from_phones(phones: list[dict[str, str]]) -> dict[str, str | None]:
    contactout_mobile = next(
        (p for p in phones if p.get("source") == "contactout" and p.get("kind") == "mobile"),
        None,
    )
    contactout_any = next((p for p in phones if p.get("source") == "contactout"), None)
    apollo_mobile = next(
        (p for p in phones if p.get("source") == "apollo" and p.get("kind") == "mobile"),
        None,
    )
    apollo_other = next(
        (p for p in phones if p.get("source") == "apollo" and p.get("kind") != "company"),
        None,
    )
    company_line = next((p for p in phones if p.get("kind") == "company"), None)

    personal = (contactout_mobile or contactout_any or {}).get("number")
    phone = personal or (apollo_mobile or apollo_other or {}).get("number")
    return {
        "phone": phone,
        "personal_phone": personal,
        "company_phone": (company_line or {}).get("number"),
    }
