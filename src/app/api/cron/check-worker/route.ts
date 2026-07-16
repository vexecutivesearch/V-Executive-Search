import { NextRequest, NextResponse } from "next/server";
import { checkMissedPipelineRun } from "@/lib/missed-run-alert";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Vercel Cron — alert if 5 AM / 6 PM pipeline did not run or worker is offline. */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await checkMissedPipelineRun();
    return NextResponse.json(result);
  } catch (err) {
    console.error("check-worker cron failed:", err);
    return NextResponse.json(
      { ok: false, error: String(err) },
      { status: 500 },
    );
  }
}
