import { NextRequest, NextResponse } from "next/server";
import { runOutreachDispatch } from "@/lib/outreach/dispatch";
import { flagUnderperformingTemplates } from "@/lib/outreach/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Vercel Cron — outreach dispatch, every 15 minutes inside the send window.
 * Advances flow enrollments and sends due, approved, unsuppressed emails.
 * (iMessage sends are polled by the Mac worker, not sent here.)
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runOutreachDispatch();
    // Cheap daily-ish hygiene: flag underperforming templates.
    let templatesFlagged = 0;
    if (new Date().getUTCHours() === 12) {
      templatesFlagged = await flagUnderperformingTemplates();
    }
    return NextResponse.json({ ok: true, ...summary, templatesFlagged });
  } catch (err) {
    console.error("outreach-dispatch cron failed:", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
