import { describe, expect, it } from "vitest";
import { buildCallSheetEmailHtml } from "@/lib/call-sheet-email-html";
import type { DailyCallSheet } from "@/lib/daily-report";

const sheet: DailyCallSheet = {
  run_date: "2026-07-20",
  listings_scraped: 12434,
  icp_match_count: 5940,
  companies_enriched: 0,
  credits_used: 0,
  leads: [
    {
      rank: 1,
      score: 88,
      company: "Acme Co",
      company_id: "c1",
      contact_name: "Jane Doe",
      title: "Owner",
      reason_to_call: "Hiring coordinator",
      work_email: "jane@acme.com",
      personal_email: null,
      phones: [],
      imessage_capable: null,
      call_opener: null,
      job_title: "Coordinator",
      job_location: "Nashville, TN",
    },
  ],
  top_job_posts: [],
  backlog_leads: [],
  hot_listings: [],
  hot_listings_count: 0,
  hot_listings_included: true,
};

describe("buildCallSheetEmailHtml", () => {
  it("includes market, funnel, and lead company", () => {
    const { subject, html } = buildCallSheetEmailHtml({
      sheet,
      geoLabel: "Nashville, Tennessee",
      crmBaseUrl: "https://example.com",
    });
    expect(subject).toContain("Nashville");
    expect(subject).toContain("2026-07-20");
    expect(html).toContain("Acme Co");
    expect(html).toContain("12434");
    expect(html).toContain("Jane Doe");
  });
});
