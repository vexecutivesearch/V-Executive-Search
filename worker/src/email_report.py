from __future__ import annotations

import logging
import os
from typing import Any

import requests

logger = logging.getLogger(__name__)


def send_daily_report(
    to_email: str,
    rows: list[dict[str, Any]],
    result_summary: dict[str, Any],
    geo_label: str,
) -> bool:
    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        logger.warning("RESEND_API_KEY not set — skipping daily email report")
        return False

    from_email = os.environ.get("REPORT_FROM_EMAIL", "reports@proventheory.co")

    contact_rows = [r for r in rows if r.get("email") or r.get("phone")]
    html_rows = ""
    for r in contact_rows:
        html_rows += f"""
        <tr>
          <td style="padding:8px;border:1px solid #ddd">{r.get('company','')}</td>
          <td style="padding:8px;border:1px solid #ddd">{r.get('contact_name','')}</td>
          <td style="padding:8px;border:1px solid #ddd">{r.get('title','')}</td>
          <td style="padding:8px;border:1px solid #ddd"><a href="mailto:{r.get('email','')}">{r.get('email','')}</a></td>
          <td style="padding:8px;border:1px solid #ddd">{r.get('phone','')}</td>
          <td style="padding:8px;border:1px solid #ddd">{r.get('job_title','')}</td>
        </tr>"""

    if not html_rows:
        html_rows = '<tr><td colspan="6" style="padding:12px">No contacts enriched today.</td></tr>'

    run_date = result_summary.get("run_date", "today")
    html = f"""
    <html><body style="font-family:sans-serif;color:#111">
      <h2>V Executive Search — Daily List ({geo_label})</h2>
      <p>Run date: {run_date}</p>
      <ul>
        <li>Listings scraped: {result_summary.get('listings_scraped', 0)}</li>
        <li>Companies enriched: {result_summary.get('companies_enriched', 0)}</li>
        <li>Contacts with data: {len(contact_rows)}</li>
        <li>Apollo credits: {result_summary.get('credits_used', 0)}</li>
      </ul>
      <table style="border-collapse:collapse;width:100%;max-width:900px">
        <thead>
          <tr style="background:#f3f4f6">
            <th style="padding:8px;border:1px solid #ddd;text-align:left">Company</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left">Contact</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left">Title</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left">Email</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left">Phone</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left">Job</th>
          </tr>
        </thead>
        <tbody>{html_rows}</tbody>
      </table>
      <p style="margin-top:24px;color:#666;font-size:12px">
        <a href="https://v-executive-search.vercel.app/today">Open CRM</a>
      </p>
    </body></html>
    """

    try:
        resp = requests.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "from": from_email,
                "to": [to_email],
                "subject": f"Daily List — {geo_label} — {run_date}",
                "html": html,
            },
            timeout=30,
        )
        resp.raise_for_status()
        logger.info("Daily report emailed to %s", to_email)
        return True
    except requests.RequestException as exc:
        logger.error("Failed to send daily report: %s", exc)
        return False
