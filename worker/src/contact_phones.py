from __future__ import annotations

from typing import Any, Literal

PhoneSource = Literal["apollo", "contactout"]
PhoneKind = Literal["mobile", "work", "company", "other"]

MAX_PERSONAL_PHONES_PER_CONTACT = 3


def _parse_phone(raw: str | dict[str, Any] | None) -> str | None:
    if not raw:
        return None
    if isinstance(raw, dict):
        return (
            _parse_phone(raw.get("sanitized_number"))
            or _parse_phone(raw.get("number"))
            or _parse_phone(raw.get("raw_number"))
            or _parse_phone(raw.get("value"))
            or _parse_phone(raw.get("phone"))
        )
    if not isinstance(raw, str):
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
        elif type_cd in ("company", "hq", "corporate"):
            kind = "company"
        out.append({"number": number, "source": "apollo", "kind": kind})

    for field, kind in (
        ("mobile_phone", "mobile"),
        ("phone", "mobile"),
        ("direct_phone", "work"),
        ("corporate_phone", "company"),
    ):
        number = _parse_phone(person.get(field))
        if number:
            out.append({"number": number, "source": "apollo", "kind": kind})

    org = person.get("organization")
    if isinstance(org, dict):
        for field in (
            "primary_phone",
            "phone",
            "sanitized_phone",
            "primary_phone_number",
        ):
            number = _parse_phone(org.get(field))
            if number:
                out.append({"number": number, "source": "apollo", "kind": "company"})
                break

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


def trim_phones_for_contact(
    phones: list[dict[str, str]],
    max_personal: int = MAX_PERSONAL_PHONES_PER_CONTACT,
) -> list[dict[str, str]]:
    sorted_phones = sorted(phones, key=_direct_dial_rank)
    direct = [p for p in sorted_phones if p.get("kind") != "company"]
    company = next((p for p in sorted_phones if p.get("kind") == "company"), None)
    trimmed = direct[:max_personal]
    if company and not trimmed:
        trimmed.append(company)
    return trimmed


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
    return trim_phones_for_contact(dedupe_sourced_phones(merged))


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
    """Build display list from phones json or legacy single fields."""
    from src.phone_utils import parse_phone_value

    phones = contact.get("phones") or []
    if phones:
        return trim_phones_for_contact(dedupe_sourced_phones(phones))

    legacy: list[dict[str, str]] = []
    personal_phone = parse_phone_value(contact.get("personal_phone"))
    phone = parse_phone_value(contact.get("phone"))
    company_phone = parse_phone_value(contact.get("company_phone"))

    if personal_phone:
        legacy.append(
            {"number": personal_phone, "source": "contactout", "kind": "mobile"}
        )
    if phone and phone != personal_phone:
        legacy.append({"number": phone, "source": "apollo", "kind": "mobile"})
    if company_phone:
        legacy.append(
            {"number": company_phone, "source": "apollo", "kind": "company"}
        )
    return dedupe_sourced_phones(legacy)
