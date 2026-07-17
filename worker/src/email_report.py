from __future__ import annotations

import html
import logging
import os
from typing import Any

import requests

from src.report_format import format_call_sheet_card, has_contact_data
from src.config_loader import parse_email_recipients
from src.crm_config import crm_base_url

logger = logging.getLogger(__name__)


def _crm_base_url() -> str:
    """Resolve after env load — never hardcode the legacy Vercel host."""
    try:
        return crm_base_url(required=True)
    except RuntimeError as exc:
        logger.error("%s", exc)
        return ""


def fetch_daily_report_from_crm() -> dict[str, Any] | None:
    base = _crm_base_url()
    api_key = os.environ.get("CRM_API_KEY", "")
    if not base or not api_key:
        return None

    try:
        resp = requests.get(
            f"{base}/api/report/daily",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
            },
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as exc:
        logger.warning("Could not fetch daily report from CRM: %s", exc)
        return None


def _funnel_header(summary: dict[str, Any], leads: list[dict[str, Any]]) -> str:
    scraped = summary.get("listings_scraped", 0)
    icp = summary.get("icp_match_count", 0)
    enriched = summary.get("companies_enriched", 0)
    credits = summary.get("credits_used", 0)
    hot_listings = summary.get("hot_listings_count")
    if hot_listings is None and summary.get("hot_listings_included") is not False:
        hot_listings = len(summary.get("hot_listings") or [])
    reason_hot = sum(
        1
        for lead in leads
        if lead.get("reason_to_call") or lead.get("reasonToCall")
    )
    base = (
        f"Scraped {scraped} → ICP match {icp} → Enriched today {enriched}"
        f" · Credits used {credits}"
    )
    if hot_listings is not None:
        base = f"{base} · Hot listings: {hot_listings}"
    elif reason_hot:
        base = f"{base} · {reason_hot} hot signals"
    if leads:
        top = leads[:3]
        names = ", ".join(
            f"#{lead.get('rank', '?')} {lead.get('company', '')}"
            for lead in top
        )
        return f"{base} · Call first: {names}"
    return base


def _leads_from_crm_or_rows(
    crm_data: dict[str, Any] | None,
    rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if crm_data and crm_data.get("leads"):
        return crm_data["leads"]

    leads: list[dict[str, Any]] = []
    rank = 0
    for row in rows:
        if not has_contact_data(row):
            continue
        rank += 1
        leads.append({
            "rank": rank,
            "score": row.get("score") or row.get("lead_score") or 0,
            "company": row.get("company", ""),
            "company_id": row.get("company_id") or row.get("companyId"),
            "contact_name": row.get("contact_name") or row.get("contactName", ""),
            "title": row.get("title"),
            "reason_to_call": row.get("reason_to_call") or row.get("reasonToCall"),
            "call_opener": row.get("call_opener") or row.get("callOpener"),
            "work_email": row.get("work_email") or row.get("workEmail"),
            "personal_email": row.get("personal_email") or row.get("personalEmail"),
            "email": row.get("email"),
            "phones": row.get("phones"),
            "phone": row.get("phone"),
            "personal_phone": row.get("personal_phone"),
            "company_phone": row.get("company_phone"),
            "source_provider": row.get("source_provider"),
            "imessage_capable": row.get("imessage_capable"),
            "job_title": row.get("job_title") or row.get("jobTitle"),
            "job_location": row.get("job_location") or row.get("jobLocation"),
        })
    return leads


def send_daily_report(
    to_email: str,
    rows: list[dict[str, Any]],
    result_summary: dict[str, Any],
    geo_label: str,
    *,
    crm_data: dict[str, Any] | None = None,
) -> bool:
    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        logger.warning("RESEND_API_KEY not set — skipping daily email report")
        return False

    recipients = parse_email_recipients(to_email)
    if not recipients:
        logger.warning("No valid report recipients in %r", to_email)
        return False

    if crm_data:
        summary = {
            **result_summary,
            "run_date": crm_data.get("run_date", result_summary.get("run_date")),
            "listings_scraped": crm_data.get(
                "listings_scraped", result_summary.get("listings_scraped", 0)
            ),
            "icp_match_count": crm_data.get(
                "icp_match_count", result_summary.get("icp_match_count", 0)
            ),
            "companies_enriched": crm_data.get(
                "companies_enriched", result_summary.get("companies_enriched", 0)
            ),
            "credits_used": crm_data.get(
                "credits_used", result_summary.get("credits_used", 0)
            ),
            "hot_listings": crm_data.get("hot_listings") or [],
            "hot_listings_count": crm_data.get("hot_listings_count", 0),
            "hot_listings_included": crm_data.get("hot_listings_included", True),
        }
    else:
        summary = result_summary

    CRM_BASE_URL = _crm_base_url()
    if not CRM_BASE_URL:
        logger.error("Refusing to send call sheet email without a valid CRM_API_URL")
        return False

    leads = _leads_from_crm_or_rows(crm_data, rows)
    run_date = html.escape(str(summary.get("run_date", "today")))
    safe_geo = html.escape(geo_label)
    funnel = html.escape(_funnel_header(summary, leads))

    if not leads:
        scraped = summary.get("listings_scraped", 0)
        icp = summary.get("icp_match_count", 0)
        body_leads = (
            '<p style="font-size:15px;color:#4b5563;margin:24px 0">'
            f"No enriched call sheet today — scraped {scraped} listings, "
            f"{icp} ICP matches. Best-fit ICP posts are below — hit "
            "<strong>Enrich contacts</strong> in the CRM to unlock phones and emails."
            "</p>"
        )
    else:
        body_leads = "".join(
            format_call_sheet_card(lead, CRM_BASE_URL) for lead in leads
        )

    top_job_posts = (crm_data or {}).get("top_job_posts") or []
    if top_job_posts:
        top_cards = []
        for job in top_job_posts:
            company = html.escape(str(job.get("company", "")))
            title = html.escape(str(job.get("job_title") or "—"))
            loc = html.escape(str(job.get("job_location") or ""))
            ind = html.escape(str(job.get("industry") or ""))
            sal = html.escape(str(job.get("salary_text") or ""))
            rank = job.get("rank", "?")
            score = job.get("score", 0)
            meta = " · ".join(p for p in [ind, loc, sal] if p)
            top_cards.append(
                f'<div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin:8px 0">'
                f'<strong>#{rank} {company}</strong> <span style="color:#6b7280">({score} pts)</span>'
                f'<div style="font-size:13px;margin-top:4px">{title}</div>'
                f'<div style="font-size:12px;color:#6b7280;margin-top:2px">{meta}</div>'
                f"</div>"
            )
        body_top_jobs = (
            '<h3 style="margin:28px 0 12px;font-size:16px">Best-fit ICP posts</h3>'
            + "".join(top_cards)
        )
    else:
        body_top_jobs = ""

    # Hot Listings — default ON from CRM; never silently blank the section.
    hot_included = (crm_data or {}).get("hot_listings_included", True)
    if hot_included is False:
        body_hot = ""
    else:
        hot_listings = (crm_data or {}).get("hot_listings") or []
        hot_total = (crm_data or {}).get("hot_listings_count", len(hot_listings))
        if hot_listings:
            hot_cards = []
            for item in hot_listings:
                headline = html.escape(
                    str(item.get("headline") or item.get("job_title") or "")
                )
                family = html.escape(str(item.get("role_family") or ""))
                rank = item.get("rank", "?")
                score = item.get("score", 0)
                board = html.escape(str(item.get("board") or ""))
                meta = " · ".join(p for p in [family, board, f"{score} pts"] if p)
                hot_cards.append(
                    f'<div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin:8px 0">'
                    f'<div style="font-size:12px;color:#6b7280;margin-bottom:4px">'
                    f"#{rank} · {meta}</div>"
                    f'<div style="font-size:14px;line-height:1.4">{headline}</div>'
                    f"</div>"
                )
            more = ""
            if isinstance(hot_total, int) and hot_total > len(hot_listings):
                more = (
                    f'<p style="font-size:13px;margin:8px 0 0">'
                    f'<a href="{CRM_BASE_URL}/today?tab=hot-listings" '
                    f'style="color:#2563eb;font-weight:600">'
                    f"See all {hot_total} hot listings in CRM →</a></p>"
                )
            else:
                more = (
                    f'<p style="font-size:13px;margin:8px 0 0">'
                    f'<a href="{CRM_BASE_URL}/today?tab=hot-listings" '
                    f'style="color:#2563eb;font-weight:600">'
                    f"Open Hot Listings in CRM →</a></p>"
                )
            body_hot = (
                '<h3 style="margin:28px 0 12px;font-size:16px">Hot Listings</h3>'
                '<p style="font-size:13px;color:#6b7280;margin:0 0 8px">'
                "Mid-size, in-focus openings worth pitching — same set as the CRM tab."
                "</p>"
                + "".join(hot_cards)
                + more
            )
        else:
            body_hot = (
                '<h3 style="margin:28px 0 12px;font-size:16px">Hot Listings</h3>'
                '<p style="font-size:14px;color:#4b5563;margin:0 0 8px">'
                "No hot listings today."
                "</p>"
                f'<p style="font-size:13px;margin:0">'
                f'<a href="{CRM_BASE_URL}/today?tab=hot-listings" '
                f'style="color:#2563eb;font-weight:600">'
                f"Open Hot Listings in CRM →</a></p>"
            )

    backlog_leads = (crm_data or {}).get("backlog_leads") or []
    if backlog_leads:
        backlog_cards = []
        for bl in backlog_leads:
            company = html.escape(str(bl.get("company", "")))
            job = html.escape(str(bl.get("job_title") or "—"))
            loc = html.escape(str(bl.get("job_location") or ""))
            ind = html.escape(str(bl.get("industry") or ""))
            sal = html.escape(str(bl.get("salary_text") or ""))
            rank = bl.get("rank", "?")
            score = bl.get("score", 0)
            meta = " · ".join(
                p for p in [ind, loc, sal] if p
            )
            backlog_cards.append(
                f'<div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin:8px 0">'
                f'<strong>#{rank} {company}</strong> <span style="color:#6b7280">({score} pts)</span>'
                f'<div style="font-size:13px;margin-top:4px">{job}</div>'
                f'<div style="font-size:12px;color:#6b7280;margin-top:2px">{meta}</div>'
                f"</div>"
            )
        body_backlog = (
            '<h3 style="margin:28px 0 12px;font-size:16px">Ranked backlog (filtered)</h3>'
            + "".join(backlog_cards)
        )
    else:
        body_backlog = ""

    html_body = f"""
    <html><body style="font-family:sans-serif;color:#111;max-width:680px;margin:0 auto;padding:16px">
      <h2 style="margin:0 0 8px">V Executive Search — Call Sheet ({safe_geo})</h2>
      <p style="margin:0 0 4px;color:#6b7280;font-size:14px">Run date: {run_date}</p>
      <p style="margin:0 0 20px;font-size:14px;font-weight:600;color:#111827">{funnel}</p>
      {body_leads}
      {body_hot}
      {body_top_jobs}
      {body_backlog}
      <p style="margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:13px">
        <a href="{CRM_BASE_URL}/today" style="color:#2563eb;font-weight:600">
          Open full call sheet in CRM →
        </a>
      </p>
      <p style="color:#9ca3af;font-size:11px;margin-top:16px">
        Ranked by lead score. iMessage checks run on your Mac after enrichment.
      </p>
    </body></html>
    """

    from_email = os.environ.get("REPORT_FROM_EMAIL", "onboarding@resend.dev")
    fallback_from = "V Executive Search <onboarding@resend.dev>"

    payload = {
        "from": from_email,
        "to": recipients,
        "subject": f"Call Sheet — {geo_label} — {run_date}",
        "html": html_body,
    }

    try:
        resp = requests.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=30,
        )
        if resp.status_code == 403 and "domain is not verified" in resp.text.lower():
            logger.warning(
                "From address %s not verified on Resend — retrying with %s",
                from_email,
                fallback_from,
            )
            payload["from"] = fallback_from
            resp = requests.post(
                "https://api.resend.com/emails",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=30,
            )
        resp.raise_for_status()
        logger.info(
            "Daily call sheet emailed to %s (%d leads)",
            ", ".join(recipients),
            len(leads),
        )
        return True
    except requests.RequestException as exc:
        logger.error("Failed to send daily report: %s", exc)
        return False


def send_daily_report_for_pipeline(
    *,
    to_email: str,
    pipeline_rows: list[dict[str, Any]],
    result_summary: dict[str, Any],
    geo_label: str,
) -> bool:
    """Prefer CRM call sheet (ranked leads); fallback to pipeline rows."""
    crm_data = fetch_daily_report_from_crm()
    return send_daily_report(
        to_email,
        pipeline_rows,
        result_summary,
        geo_label,
        crm_data=crm_data,
    )
