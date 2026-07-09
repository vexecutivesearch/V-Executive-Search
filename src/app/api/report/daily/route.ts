import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { getDailyReportData } from "@/lib/daily-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Worker-only: today's leads formatted for the daily email report. */
export async function GET(request: NextRequest) {
  if (!verifyWorkerAuth(request)) {
    return unauthorized();
  }

  const data = await getDailyReportData();
  return NextResponse.json(data);
}
