import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dailyRuns } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const runs = await db
    .select()
    .from(dailyRuns)
    .orderBy(desc(dailyRuns.runDate), desc(dailyRuns.createdAt))
    .limit(60);

  return NextResponse.json({ runs });
}
