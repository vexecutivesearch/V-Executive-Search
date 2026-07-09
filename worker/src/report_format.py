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


def score_badge_style(score: int) -> tuple[str, str]:
    if score >= 80:
        return "#166534", "#dcfce7"
    if score >= 60:
        return "#92400e", "#fef3c7"
    return "#6b7280", "#f3f4f6"


def _format_email_chip(email: str | None, label: str) -> str:
    if not email:
        return ""
    safe = _esc(email)
    return (
        f'<span style="display:inline-block;margin:0 6px 6px 0;font-size:11px;'
        f'padding:3px 8px;border-radius:999px;background:#eff6ff;color:#1d4ed8">'
        f"{label}: <a href=\"mailto:{safe}\" style=\"color:#1d4ed8\">{safe}</a></span>"
    )


def _format_phone_chips(phones: list[dict[str, str]]) -> str:
    parts: list[str] = []
    for phone in phones[:2]:
        number = parse_phone_value(phone.get("number"))
        if not number:
            continue
        kind = _kind_label(phone.get("kind"))
        safe_number = _esc(number)
        parts.append(
            f'<span style="display:inline-block;margin:0 6px 6px 0;font-size:11px;'
            f'padding:3px 8px;border-radius:999px;background:#f3f4f6;color:#111827">'
            f'{kind}: <a href="tel:{safe_number}" style="color:#111827">{safe_number}</a></span>'
        )
    return "".join(parts)


def _format_imessage_chip(row: dict[str, Any], personal_email: str | None) -> str:
    capable = row.get("imessage_capable")
    if capable is None:
        capable = row.get("imessageCapable")

    if capable is True:
        return (
            '<span style="display:inline-block;margin:0 6px 6px 0;font-size:11px;'
            'padding:3px 8px;border-radius:999px;background:#dcfce7;color:#166534;'
            'font-weight:600">iMessage ✓</span>'
        )
    if capable is False:
        return (
            '<span style="display:inline-block;margin:0 6px 6px 0;font-size:11px;'
            'padding:3px 8px;border-radius:999px;background:#f3f4f6;color:#6b7280">'
            "SMS only</span>"
        )
    if personal_email:
        return (
            '<span style="display:inline-block;margin:0 6px 6px 0;font-size:11px;'
            'padding:3px 8px;border-radius:999px;background:#f9fafb;color:#9ca3af;'
            'font-style:italic">iMessage pending</span>'
        )
    return ""


def _format_job_location(row: dict[str, Any]) -> str:
    raw = row.get("job_location") or row.get("jobLocation") or ""
    if not raw:
        return ""
    parts = [p.strip() for p in str(raw).split(",") if p.strip()]
    if parts and parts[-1].upper() in ("US", "USA", "UNITED STATES"):
        parts.pop()
    if len(parts) >= 2:
        return f"{parts[0]}, {parts[1]}"
    return parts[0] if parts else str(raw)


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
        "work_email": _format_email_chip(work_email, "Work"),
        "personal_email": _format_email_chip(personal_email, "Personal"),
        "phones": _format_phone_chips(phones),
        "imessage": _format_imessage_chip(row, personal_email),
        "job_title": _esc(row.get("job_title") or row.get("jobTitle", "")),
        "job_location": _esc(_format_job_location(row)),
    }


def format_call_sheet_card(lead: dict[str, Any], crm_base_url: str) -> str:
    rank = int(lead.get("rank") or 0)
    score = int(lead.get("score") or 0)
    color, bg = score_badge_style(score)
    work_email, personal_email = _resolve_emails(lead)
    phones = _phones_for_row(lead)

    company = _esc(lead.get("company", ""))
    contact_name = _esc(lead.get("contact_name") or lead.get("contactName", ""))
    title = _esc(lead.get("title", ""))
    reason = lead.get("reason_to_call") or lead.get("reasonToCall")
    job_title = _esc(lead.get("job_title") or lead.get("jobTitle", ""))
    job_location = _esc(_format_job_location(lead))
    company_id = lead.get("company_id") or lead.get("companyId") or ""
    crm_link = f"{crm_base_url.rstrip('/')}/companies/{company_id}" if company_id else f"{crm_base_url.rstrip('/')}/today"

    channels = (
        _format_email_chip(personal_email, "Personal")
        + _format_email_chip(work_email, "Work")
        + _format_phone_chips(phones)
        + _format_imessage_chip(lead, personal_email)
    )

    reason_html = ""
    if reason:
        reason_html = (
            f'<p style="margin:6px 0 0;font-size:13px;color:#4b5563;font-style:italic">'
            f"{_esc(reason)}</p>"
        )

    job_html = ""
    if job_title:
        loc = f" · {job_location}" if job_location else ""
        job_html = (
            f'<p style="margin:8px 0 0;font-size:12px;color:#6b7280">'
            f"{job_title}{loc}</p>"
        )

    opener = lead.get("call_opener") or lead.get("callOpener")
    opener_html = ""
    if opener:
        opener_html = (
            f'<p style="margin:10px 0 0;font-size:13px;color:#1e3a8a;background:#eff6ff;'
            f'padding:10px;border-radius:8px;line-height:1.45">'
            f"<strong>Opener:</strong> {_esc(opener)}</p>"
        )

    return f"""
    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:0 0 12px;background:#fff">
      <div style="display:flex;align-items:flex-start;gap:12px">
        <div style="min-width:36px;text-align:center">
          <div style="font-size:11px;color:#9ca3af;font-weight:600">#{rank}</div>
          <div style="margin-top:4px;font-size:14px;font-weight:700;color:{color};background:{bg};
            padding:4px 8px;border-radius:8px;display:inline-block">{score}</div>
        </div>
        <div style="flex:1;min-width:0">
          <p style="margin:0;font-size:16px;font-weight:600;color:#111827">
            {contact_name}{f' · <span style="font-weight:400;color:#4b5563">{title}</span>' if title else ''}
          </p>
          <p style="margin:4px 0 0;font-size:14px;color:#374151">{company}</p>
          {reason_html}
          {opener_html}
          <div style="margin-top:10px">{channels or '<span style="color:#9ca3af;font-size:12px">No channels yet</span>'}</div>
          {job_html}
          <p style="margin:10px 0 0;font-size:12px">
            <a href="{crm_link}" style="color:#2563eb">Open in CRM →</a>
          </p>
        </div>
      </div>
    </div>"""
