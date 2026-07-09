import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { sql } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET() {
  const hasUrl = Boolean(process.env.DATABASE_URL);
  if (!hasUrl) {
    return NextResponse.json({
      ok: false,
      database: "missing DATABASE_URL env var",
    });
  }

  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
    return NextResponse.json({ ok: true, database: "connected" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({
      ok: false,
      database: "connection failed",
      error: message,
    });
  }
}
