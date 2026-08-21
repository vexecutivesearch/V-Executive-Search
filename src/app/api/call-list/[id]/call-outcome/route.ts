import { NextRequest, NextResponse } from "next/server";
import { isCallOutcomeKind } from "@/lib/call-outcomes";
import { dialTargetsForCompany, logCall } from "@/lib/calls/log-call";
import { db } from "@/lib/db";
import { callListEntries } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The gated numbers for this entry — the call screen renders exactly these. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const [entry] = await db
    .select({ companyId: callListEntries.companyId })
    .from(callListEntries)
    .where(eq(callListEntries.id, id))
    .limit(1);
  if (!entry) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({
    targets: await dialTargetsForCompany(entry.companyId),
  });
}

/** Log what a human dial produced. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: {
    outcome?: string;
    phone?: string | null;
    contact_id?: string | null;
    notes?: string | null;
    logged_by?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!isCallOutcomeKind(body.outcome)) {
    return NextResponse.json({ error: "Invalid outcome" }, { status: 400 });
  }

  const result = await logCall({
    entryId: id,
    outcome: body.outcome,
    phone: body.phone ?? null,
    contactId: body.contact_id ?? null,
    notes: body.notes ?? null,
    loggedBy: body.logged_by ?? null,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ entry: result.entry, outcome: result.outcome });
}
