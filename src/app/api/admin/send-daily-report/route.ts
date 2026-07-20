import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { sendAlertEmailDetailed } from "@/lib/alert-email";
import { buildCallSheetEmailHtml } from "@/lib/call-sheet-email-html";
import { getDailyCallSheet } from "@/lib/daily-report";
import { getOrCreateSettings } from "@/lib/pipeline-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function crmPublicBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (explicit) return explicit;
  const vercel = process.env.VERCEL_URL?.replace(/\/$/, "");
  if (vercel) return `https://${vercel}`;
  return "https://v-executive-search-delta.vercel.app";
}

/**
 * Admin-only: send today's call sheet immediately via Resend (Vercel).
 * Use when the Mac mini 07:45 job failed or raced a slow scrape.
 */
export async function POST() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await getOrCreateSettings();
  const toEmail = settings.notificationEmail?.trim();
  if (!toEmail) {
    return NextResponse.json(
      { error: "No notification_email configured in Admin settings" },
      { status: 400 },
    );
  }

  const sheet = await getDailyCallSheet();
  if ((sheet.listings_scraped ?? 0) <= 0) {
    return NextResponse.json(
      {
        error:
          "No scrape ingest for today's business date yet (listings_scraped=0). Wait for the Mac scrape to finish, then retry.",
        listings_scraped: sheet.listings_scraped,
        run_date: sheet.run_date,
      },
      { status: 409 },
    );
  }

  const geoLabel =
    [settings.focusCity, settings.focusState].filter(Boolean).join(", ") ||
    "Focus market";

  const { subject, html } = buildCallSheetEmailHtml({
    sheet,
    geoLabel,
    crmBaseUrl: crmPublicBaseUrl(),
  });

  const result = await sendAlertEmailDetailed({
    toEmail,
    subject,
    html,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        hint: "Check Vercel RESEND_API_KEY and REPORT_FROM_EMAIL (must be a verified Resend domain, or leave unset to use onboarding@resend.dev).",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    run_date: sheet.run_date,
    listings_scraped: sheet.listings_scraped,
    leads: sheet.leads.length,
    to: toEmail,
  });
}
