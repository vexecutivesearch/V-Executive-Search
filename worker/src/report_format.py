from __future__ import annotations

import html
from typing import Any

from src.contact_phones import contact_phones_for_display
from src.phone_utils import is_personal_email, parse_phone_value


def _esc(value: Any) -> str:
    if value is None:
        return ""
    return html.escape(str(value))


def _resolve_emails(row: dict[str, Any]) -> tuple[str | None, str | None]:
    personal = row.get("personal_email") or row.get("personalEmail")
    work = row.get("work_email") or row.get("workEmail")
    email = row.get("email")

    if not personal and email and is_personal_email(str(email)):
        personal = email
    if not work and email and not is_personal_email(str(email)):
        work = email

    if work and personal and work == personal:
        work = None
    return (
        str(work).strip() if work else None,
        str(personal).strip() if personal else None,
    )


def _phones_for_row(row: dict[str, Any]) -> list[dict[str, str]]:
    phones = row.get("phones")
    if isinstance(phones, list) and phones:
        normalized: list[dict[str, str]] = []
        for entry in phones:
            if isinstance(entry, dict):
                number = parse_phone_value(entry.get("number"))
                if not number:
                    continue
                normalized.append(
                    {
                        "number": number,
                        "source": entry.get("source") or "apollo",
                        "kind": entry.get("kind") or "other",
                        "source_label": entry.get("source_label")
                        or ("ContactOut" if entry.get("source") == "contactout" else "Apollo"),
                        "kind_label": entry.get("kind_label") or entry.get("kind") or "Phone",
                    }
                )
        if normalized:
            return normalized

    return contact_phones_for_display(
        {
            "phones": row.get("phones"),
            "phone": row.get("phone"),
            "personal_phone": row.get("personal_phone") or row.get("personalPhone"),
            "company_phone": row.get("company_phone") or row.get("companyPhone"),
            "source_provider": row.get("source_provider") or row.get("sourceProvider"),
        }
    )


def _source_label(source: str) -> str:
    return "ContactOut" if source == "contactout" else "Apollo"


def _kind_label(kind: str | None) -> str:
    if kind == "mobile":
        return "Mobile"
    if kind == "work":
        return "Work"
    if kind == "company":
        return "Company"
    return "Phone"


def _format_email_cell(email: str | None) -> str:
    if not email:
        return '<span style="color:#9ca3af">—</span>'
    safe = _esc(email)
    return f'<a href="mailto:{safe}" style="color:#2563eb">{safe}</a>'


def _format_phones_cell(phones: list[dict[str, str]], row: dict[str, Any]) -> str:
    parts: list[str] = []
    for phone in phones:
        number = parse_phone_value(phone.get("number"))
        if not number:
            continue
        source = _source_label(str(phone.get("source") or "apollo"))
        kind = _kind_label(phone.get("kind"))
        badge_color = "#166534" if source == "ContactOut" else "#1d4ed8"
        badge_bg = "#dcfce7" if source == "ContactOut" else "#dbeafe"
        safe_number = _esc(number)
        parts.append(
            f'<div style="margin:0 0 6px 0">'
            f'<span style="font-size:10px;font-weight:600;color:{badge_color};'
            f'background:{badge_bg};padding:2px 6px;border-radius:4px">'
            f"{source} · {kind}</span> "
            f'<a href="tel:{safe_number}" style="color:#111827">{safe_number}</a>'
            f"</div>"
        )

    personal = row.get("personal_email") or row.get("personalEmail")
    has_contactout = any(p.get("source") == "contactout" for p in phones)
    if personal and not has_contactout:
        parts.append(
            '<div style="margin:0 0 6px 0;color:#9ca3af;font-style:italic;font-size:12px">'
            "ContactOut phone not on API plan</div>"
        )

    if not parts:
        return '<span style="color:#9ca3af">—</span>'
    return "".join(parts)


def _format_imessage_cell(row: dict[str, Any], personal_email: str | None) -> str:
    capable = row.get("imessage_capable")
    if capable is None:
        capable = row.get("imessageCapable")

    if capable is True:
        return (
            '<span style="color:#166534;font-weight:600;background:#dcfce7;'
            'padding:2px 8px;border-radius:4px">iMessage ✓</span>'
        )
    if capable is False:
        return '<span style="color:#6b7280">SMS only</span>'
    if personal_email:
        return '<span style="color:#9ca3af;font-style:italic">Pending</span>'
    return '<span style="color:#9ca3af">—</span>'


def has_contact_data(row: dict[str, Any]) -> bool:
    work, personal = _resolve_emails(row)
    phones = _phones_for_row(row)
    legacy_phone = parse_phone_value(row.get("phone"))
    return bool(work or personal or phones or legacy_phone)


def format_contact_row_cells(row: dict[str, Any]) -> dict[str, str]:
    work_email, personal_email = _resolve_emails(row)
    phones = _phones_for_row(row)

    return {
        "company": _esc(row.get("company", "")),
        "contact_name": _esc(row.get("contact_name") or row.get("contactName", "")),
        "title": _esc(row.get("title", "")),
        "work_email": _format_email_cell(work_email),
        "personal_email": _format_email_cell(personal_email),
        "phones": _format_phones_cell(phones, row),
        "imessage": _format_imessage_cell(row, personal_email),
        "job_title": _esc(row.get("job_title") or row.get("jobTitle", "")),
    }
