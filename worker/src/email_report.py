from __future__ import annotations

import html
import logging
import os
from typing import Any

import requests

from src.report_format import format_call_sheet_card, has_contact_data

logger = logging.getLogger(__name__)

CRM_BASE_URL = (os.environ.get("CRM_API_URL") or "https://v-executive-search.vercel.app").rstrip("/")


def fetch_daily_report_from_crm() -> dict[str, Any] | None:
    base = (os.environ.get("CRM_API_URL") or "").rstrip("/")
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


def _funnel_header(summary: dict[str, Any]) -> str:
    scraped = summary.get("listings_scraped", 0)
    icp = summary.get("icp_match_count", 0)
    enriched = summary.get("companies_enriched", 0)
    credits = summary.get("credits_used", 0)
    return (
        f"Scraped {scraped} → ICP match {icp} → Enriched today {enriched}"
        f" · Credits used {credits}"
    )


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
        }
    else:
        summary = result_summary

    leads = _leads_from_crm_or_rows(crm_data, rows)
    run_date = html.escape(str(summary.get("run_date", "today")))
    safe_geo = html.escape(geo_label)
    funnel = html.escape(_funnel_header(summary))

    if not leads:
        body_leads = (
            '<p style="font-size:15px;color:#4b5563;margin:24px 0">'
            "No hot leads today — nothing above your enrichment threshold. "
            "Check the backlog in the CRM.</p>"
        )
    else:
        body_leads = "".join(
            format_call_sheet_card(lead, CRM_BASE_URL) for lead in leads
        )

    html_body = f"""
    <html><body style="font-family:sans-serif;color:#111;max-width:680px;margin:0 auto;padding:16px">
      <h2 style="margin:0 0 8px">V Executive Search — Call Sheet ({safe_geo})</h2>
      <p style="margin:0 0 4px;color:#6b7280;font-size:14px">Run date: {run_date}</p>
      <p style="margin:0 0 20px;font-size:14px;font-weight:600;color:#111827">{funnel}</p>
      {body_leads}
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
        "to": [to_email],
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
        logger.info("Daily call sheet emailed to %s (%d leads)", to_email, len(leads))
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
