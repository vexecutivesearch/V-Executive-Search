import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dailyRuns } from "@/lib/db/schema";

export async function GET() {
  const runs = await db
    .select()
    .from(dailyRuns)
    .orderBy(desc(dailyRuns.runDate))
    .limit(30);

  return NextResponse.json({ runs });
}
