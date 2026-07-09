import { desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { companyActivities } from "@/lib/db/schema";
import type { ActivityType } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const activities = await db
    .select()
    .from(companyActivities)
    .where(eq(companyActivities.companyId, id))
    .orderBy(desc(companyActivities.createdAt))
    .limit(100);

  return NextResponse.json({ activities });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: companyId } = await params;
  let body: {
    type?: ActivityType;
    summary?: string;
    raw_transcript?: string;
    contact_id?: string;
    classification?: string;
    source?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.summary?.trim() || !body.type) {
    return NextResponse.json(
      { error: "type and summary are required" },
      { status: 400 },
    );
  }

  const [activity] = await db
    .insert(companyActivities)
    .values({
      companyId,
      contactId: body.contact_id ?? null,
      type: body.type,
      summary: body.summary.trim(),
      rawTranscript: body.raw_transcript?.trim() ?? null,
      classification: body.classification ?? null,
      source: body.source ?? "manual",
    })
    .returning();

  return NextResponse.json({ activity });
}
