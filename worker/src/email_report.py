from __future__ import annotations

import html
import logging
from typing import Any

import requests

from src.report_format import format_contact_row_cells, has_contact_data

logger = logging.getLogger(__name__)


def fetch_daily_report_from_crm() -> dict[str, Any] | None:
    import os

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


def send_daily_report(
    to_email: str,
    rows: list[dict[str, Any]],
    result_summary: dict[str, Any],
    geo_label: str,
) -> bool:
    api_key = __import__("os").environ.get("RESEND_API_KEY")
    if not api_key:
        logger.warning("RESEND_API_KEY not set — skipping daily email report")
        return False

    contact_rows = [r for r in rows if has_contact_data(r)]
    html_rows = ""
    for r in contact_rows:
        cells = format_contact_row_cells(r)
        html_rows += f"""
        <tr>
          <td style="padding:8px;border:1px solid #ddd;vertical-align:top">{cells["company"]}</td>
          <td style="padding:8px;border:1px solid #ddd;vertical-align:top">{cells["contact_name"]}</td>
          <td style="padding:8px;border:1px solid #ddd;vertical-align:top">{cells["title"]}</td>
          <td style="padding:8px;border:1px solid #ddd;vertical-align:top">{cells["work_email"]}</td>
          <td style="padding:8px;border:1px solid #ddd;vertical-align:top">{cells["personal_email"]}</td>
          <td style="padding:8px;border:1px solid #ddd;vertical-align:top">{cells["phones"]}</td>
          <td style="padding:8px;border:1px solid #ddd;vertical-align:top">{cells["imessage"]}</td>
          <td style="padding:8px;border:1px solid #ddd;vertical-align:top">{cells["job_title"]}</td>
        </tr>"""

    if not html_rows:
        html_rows = (
            '<tr><td colspan="8" style="padding:12px">No contacts enriched today.</td></tr>'
        )

    run_date = html.escape(str(result_summary.get("run_date", "today")))
    safe_geo = html.escape(geo_label)
    html_body = f"""
    <html><body style="font-family:sans-serif;color:#111;max-width:1100px">
      <h2>V Executive Search — Daily List ({safe_geo})</h2>
      <p>Run date: {run_date}</p>
      <ul>
        <li>Listings scraped: {result_summary.get("listings_scraped", 0)}</li>
        <li>Companies enriched: {result_summary.get("companies_enriched", 0)}</li>
        <li>Contacts with data: {len(contact_rows)}</li>
        <li>Apollo credits: {result_summary.get("credits_used", 0)}</li>
      </ul>
      <table style="border-collapse:collapse;width:100%">
        <thead>
          <tr style="background:#f3f4f6">
            <th style="padding:8px;border:1px solid #ddd;text-align:left">Company</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left">Contact</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left">Title</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left">Work email</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left">Personal email</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left">Phones</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left">iMessage</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left">Job</th>
          </tr>
        </thead>
        <tbody>{html_rows}</tbody>
      </table>
      <p style="margin-top:24px;color:#666;font-size:12px">
        Phone labels show source: <strong>Apollo</strong> or <strong>ContactOut</strong>.
        iMessage checks run on Mac after enrichment.
      </p>
      <p style="color:#666;font-size:12px">
        <a href="https://v-executive-search.vercel.app/today">Open CRM</a>
      </p>
    </body></html>
    """

    from_email = __import__("os").environ.get("REPORT_FROM_EMAIL", "onboarding@resend.dev")
    fallback_from = "V Executive Search <onboarding@resend.dev>"

    payload = {
        "from": from_email,
        "to": [to_email],
        "subject": f"Daily List — {geo_label} — {run_date}",
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
        logger.info("Daily report emailed to %s", to_email)
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
    """Prefer CRM report rows (full emails/phones/iMessage); fallback to pipeline rows."""
    crm_data = fetch_daily_report_from_crm()
    if crm_data and crm_data.get("rows"):
        summary = {
            **result_summary,
            "run_date": crm_data.get("run_date", result_summary.get("run_date")),
            "listings_scraped": crm_data.get(
                "listings_scraped", result_summary.get("listings_scraped", 0)
            ),
            "companies_enriched": crm_data.get(
                "companies_enriched", result_summary.get("companies_enriched", 0)
            ),
        }
        return send_daily_report(to_email, crm_data["rows"], summary, geo_label)

    return send_daily_report(to_email, pipeline_rows, result_summary, geo_label)
