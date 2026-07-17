import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { callListEntries, companyActivities } from "@/lib/db/schema";
import {
  activityTypeForStatus,
  CALL_STATUS_LABELS,
  isAttemptStatus,
  isCallStatus,
} from "@/lib/call-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type PatchBody = {
  call_status?: string;
  notes?: string | null;
  next_follow_up_date?: string | null;
  assigned_to?: string | null;
  final_result?: string | null;
  outreach_angle?: string | null;
  primary_contact_id?: string | null;
  /** Log an outreach attempt without changing status (e.g. re-dial). */
  log_attempt?: boolean;
};

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const [entry] = await db
    .select()
    .from(callListEntries)
    .where(eq(callListEntries.id, id))
    .limit(1);
  if (!entry) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const updates: Partial<typeof callListEntries.$inferInsert> = {
    updatedAt: new Date(),
  };

  let statusChanged = false;
  if (body.call_status !== undefined) {
    if (!isCallStatus(body.call_status)) {
      return NextResponse.json({ error: "Invalid call_status" }, { status: 400 });
    }
    updates.callStatus = body.call_status;
    statusChanged = body.call_status !== entry.callStatus;
    if (statusChanged) updates.callStatusUpdatedAt = new Date();
  }

  if (body.next_follow_up_date !== undefined) {
    if (body.next_follow_up_date && !DATE_RE.test(body.next_follow_up_date)) {
      return NextResponse.json(
        { error: "next_follow_up_date must be YYYY-MM-DD" },
        { status: 400 },
      );
    }
    updates.nextFollowUpDate = body.next_follow_up_date || null;
  }

  if (body.notes !== undefined) updates.notes = body.notes?.trim() || null;
  if (body.assigned_to !== undefined) {
    updates.assignedTo = body.assigned_to?.trim() || null;
  }
  if (body.final_result !== undefined) {
    updates.finalResult = body.final_result?.trim() || null;
  }
  if (body.outreach_angle !== undefined) {
    updates.outreachAngle = body.outreach_angle?.trim() || null;
  }
  if (body.primary_contact_id !== undefined) {
    updates.primaryContactId = body.primary_contact_id || null;
  }

  // Outreach-attempt statuses auto-increment attempts + stamp last contact.
  const newStatus = updates.callStatus ?? entry.callStatus;
  const logsAttempt =
    body.log_attempt === true ||
    (body.call_status !== undefined && isAttemptStatus(newStatus));
  if (logsAttempt) {
    updates.attempts = (entry.attempts ?? 0) + 1;
    updates.lastContactAt = new Date();
  }

  const [updated] = await db
    .update(callListEntries)
    .set(updates)
    .where(eq(callListEntries.id, id))
    .returning();

  // Keep history unified on the existing company activity timeline.
  if (statusChanged && updates.callStatus) {
    await db.insert(companyActivities).values({
      companyId: entry.companyId,
      contactId: updated.primaryContactId ?? entry.primaryContactId,
      type: activityTypeForStatus(updates.callStatus),
      summary: `Call list status → ${CALL_STATUS_LABELS[updates.callStatus]}`,
      source: "call_list",
    });
  } else if (body.log_attempt === true) {
    await db.insert(companyActivities).values({
      companyId: entry.companyId,
      contactId: updated.primaryContactId ?? entry.primaryContactId,
      type: "call",
      summary: `Outreach attempt logged (#${updated.attempts})`,
      source: "call_list",
    });
  }

  return NextResponse.json({ entry: updated });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const [removed] = await db
    .delete(callListEntries)
    .where(eq(callListEntries.id, id))
    .returning();
  if (!removed) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db.insert(companyActivities).values({
    companyId: removed.companyId,
    type: "note",
    summary: "Removed from call list",
    source: "call_list",
  });

  return NextResponse.json({ ok: true });
}
