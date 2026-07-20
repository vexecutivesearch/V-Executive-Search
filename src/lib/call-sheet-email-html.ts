import type { DailyCallSheet } from "@/lib/daily-report";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function leadCard(lead: DailyCallSheet["leads"][number], crmBase: string): string {
  const phones = (lead.phones || [])
    .map((p) => `${esc(p.number)} (${esc(p.kind_label || p.source_label || "phone")})`)
    .join(" · ");
  const emails = [lead.work_email, lead.personal_email].filter(Boolean).map(esc).join(" · ");
  const companyUrl = `${crmBase}/crm?company=${encodeURIComponent(lead.company_id)}`;
  return `
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin:10px 0">
      <div style="font-size:15px;font-weight:700">
        #${esc(lead.rank)} <a href="${esc(companyUrl)}" style="color:#111827;text-decoration:none">${esc(lead.company)}</a>
        <span style="color:#6b7280;font-weight:500">(${esc(lead.score)} pts)</span>
      </div>
      <div style="font-size:13px;margin-top:4px">${esc(lead.contact_name)}${lead.title ? ` — ${esc(lead.title)}` : ""}</div>
      ${lead.job_title ? `<div style="font-size:12px;color:#6b7280;margin-top:2px">${esc(lead.job_title)}${lead.job_location ? ` · ${esc(lead.job_location)}` : ""}</div>` : ""}
      ${emails ? `<div style="font-size:12px;margin-top:6px">${emails}</div>` : ""}
      ${phones ? `<div style="font-size:12px;margin-top:2px">${phones}</div>` : ""}
      ${lead.reason_to_call ? `<div style="font-size:12px;color:#374151;margin-top:8px">${esc(lead.reason_to_call)}</div>` : ""}
    </div>`;
}

function backlogCard(item: {
  rank?: number;
  company?: string;
  job_title?: string | null;
  job_location?: string | null;
  industry?: string | null;
  salary_text?: string | null;
  score?: number;
}): string {
  const meta = [item.industry, item.job_location, item.salary_text]
    .filter(Boolean)
    .map(esc)
    .join(" · ");
  return `
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin:8px 0">
      <strong>#${esc(item.rank ?? "?")} ${esc(item.company)}</strong>
      <span style="color:#6b7280">(${esc(item.score ?? 0)} pts)</span>
      <div style="font-size:13px;margin-top:4px">${esc(item.job_title || "—")}</div>
      ${meta ? `<div style="font-size:12px;color:#6b7280;margin-top:2px">${meta}</div>` : ""}
    </div>`;
}

/** Build the HTML body for today's call-sheet email (CRM/admin send path). */
export function buildCallSheetEmailHtml(options: {
  sheet: DailyCallSheet;
  geoLabel: string;
  crmBaseUrl: string;
}): { subject: string; html: string } {
  const { sheet, geoLabel, crmBaseUrl } = options;
  const crmBase = crmBaseUrl.replace(/\/$/, "");
  const funnel =
    `Scraped ${sheet.listings_scraped} → ICP match ${sheet.icp_match_count}` +
    ` → Enriched today ${sheet.companies_enriched} · Credits used ${sheet.credits_used}` +
    (sheet.hot_listings_included
      ? ` · Hot listings: ${sheet.hot_listings_count}`
      : "");

  const bodyLeads =
    sheet.leads.length === 0
      ? `<p style="font-size:15px;color:#4b5563;margin:24px 0">
          No enriched call sheet today — scraped ${sheet.listings_scraped} listings,
          ${sheet.icp_match_count} ICP matches. Best-fit ICP posts are below — hit
          <strong>Enrich contacts</strong> in the CRM to unlock phones and emails.
        </p>`
      : sheet.leads.map((lead) => leadCard(lead, crmBase)).join("");

  const hotSection =
    sheet.hot_listings_included === false
      ? ""
      : sheet.hot_listings.length > 0
        ? `<h3 style="margin:28px 0 12px;font-size:16px">Hot Listings</h3>
           <p style="font-size:13px;color:#6b7280;margin:0 0 8px">
             Mid-size, in-focus openings worth pitching — same set as the CRM tab.
           </p>
           ${sheet.hot_listings
             .map((h) =>
               backlogCard({
                 rank: h.rank,
                 company: h.company,
                 job_title: h.job_title,
                 job_location: h.job_location,
                 industry: h.role_family,
                 salary_text: h.salary_text,
                 score: h.score,
               }),
             )
             .join("")}`
        : `<h3 style="margin:28px 0 12px;font-size:16px">Hot Listings</h3>
           <p style="font-size:14px;color:#4b5563;margin:0 0 8px">No hot listings today.</p>`;

  const topJobs =
    sheet.top_job_posts.length > 0
      ? `<h3 style="margin:28px 0 12px;font-size:16px">Top ranked openings</h3>
         ${sheet.top_job_posts.map((j) => backlogCard(j)).join("")}`
      : "";

  const backlog =
    sheet.backlog_leads.length > 0
      ? `<h3 style="margin:28px 0 12px;font-size:16px">Ranked backlog (filtered)</h3>
         ${sheet.backlog_leads.map((j) => backlogCard(j)).join("")}`
      : "";

  const html = `
    <html><body style="font-family:sans-serif;color:#111;max-width:680px;margin:0 auto;padding:16px">
      <h2 style="margin:0 0 8px">V Executive Search — Call Sheet (${esc(geoLabel)})</h2>
      <p style="margin:0 0 4px;color:#6b7280;font-size:14px">Run date: ${esc(sheet.run_date)}</p>
      <p style="margin:0 0 20px;font-size:14px;font-weight:600;color:#111827">${esc(funnel)}</p>
      ${bodyLeads}
      ${hotSection}
      ${topJobs}
      ${backlog}
      <p style="margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:13px">
        <a href="${esc(crmBase)}/today" style="color:#2563eb;font-weight:600">
          Open full call sheet in CRM →
        </a>
      </p>
    </body></html>`;

  return {
    subject: `Call Sheet — ${geoLabel} — ${sheet.run_date}`,
    html,
  };
}
