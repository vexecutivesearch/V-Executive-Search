import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import {
  companies,
  contacts,
  outreachMessages,
  sequenceEnrollments,
} from "@/lib/db/schema";
import { draftStep } from "@/lib/outreach-draft";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { contextForEnrollment } from "@/lib/outreach/node-draft";
import { sanitizeOutreachBody, sanitizeSubject } from "@/lib/outreach/sanitizer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Approval queue: preview drafted/queued messages before anything sends. */
export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pendingOnly = request.nextUrl.searchParams.get("pending") === "1";

  const rows = await db
    .select({
      message: outreachMessages,
      contactName: contacts.name,
      companyName: companies.name,
      enrollmentStatus: sequenceEnrollments.status,
      emailAddress: sequenceEnrollments.emailAddress,
      phoneNumber: sequenceEnrollments.phoneNumber,
    })
    .from(outreachMessages)
    .innerJoin(sequenceEnrollments, eq(sequenceEnrollments.id, outreachMessages.enrollmentId))
    .innerJoin(contacts, eq(contacts.id, sequenceEnrollments.contactId))
    .innerJoin(companies, eq(companies.id, sequenceEnrollments.companyId))
    .where(
      pendingOnly
        ? and(
            inArray(outreachMessages.status, ["drafted", "queued"]),
            isNull(outreachMessages.approvedAt),
          )
        : undefined,
    )
    .orderBy(desc(outreachMessages.createdAt))
    .limit(200);

  return NextResponse.json({ messages: rows });
}

export async function PATCH(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: {
    id?: string;
    ids?: string[];
    action?: "approve" | "unapprove" | "cancel" | "redraft" | "edit";
    subject?: string;
    body?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ids = body.ids ?? (body.id ? [body.id] : []);
  if (!ids.length || !body.action) {
    return NextResponse.json({ error: "id(s) + action required" }, { status: 400 });
  }

  if (body.action === "approve" || body.action === "unapprove") {
    await db
      .update(outreachMessages)
      .set({
        approvedAt: body.action === "approve" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(inArray(outreachMessages.id, ids));
    for (const id of ids) {
      const [m] = await db
        .select({ enrollmentId: outreachMessages.enrollmentId })
        .from(outreachMessages)
        .where(eq(outreachMessages.id, id))
        .limit(1);
      if (m) {
        await logEnrollmentEvent({
          enrollmentId: m.enrollmentId,
          eventType: "manual_intervention",
          actor: "user",
          payload: { action: body.action, message_id: id },
        });
      }
    }
    return NextResponse.json({ ok: true, updated: ids.length });
  }

  if (body.action === "cancel") {
    await db
      .update(outreachMessages)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          inArray(outreachMessages.id, ids),
          inArray(outreachMessages.status, ["drafted", "queued"]),
        ),
      );
    return NextResponse.json({ ok: true });
  }

  // Single-message actions.
  const [message] = await db
    .select()
    .from(outreachMessages)
    .where(eq(outreachMessages.id, ids[0]))
    .limit(1);
  if (!message) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!["drafted", "queued"].includes(message.status)) {
    return NextResponse.json({ error: `cannot modify a ${message.status} message` }, { status: 422 });
  }

  if (body.action === "edit") {
    const bodyCheck = sanitizeOutreachBody(body.body ?? "", {
      channel: message.channel,
    });
    if (!bodyCheck.ok) {
      return NextResponse.json({ error: `body rejected: ${bodyCheck.violations.join("; ")}` }, { status: 422 });
    }
    let subject = message.subject;
    if (message.channel === "email" && body.subject !== undefined) {
      const subjectCheck = sanitizeSubject(body.subject);
      if (!subjectCheck.ok) {
        return NextResponse.json({ error: `subject rejected: ${subjectCheck.violations.join("; ")}` }, { status: 422 });
      }
      subject = subjectCheck.cleaned;
    }
    const [updated] = await db
      .update(outreachMessages)
      .set({ body: bodyCheck.cleaned, subject, approvedAt: null, updatedAt: new Date() })
      .where(eq(outreachMessages.id, message.id))
      .returning();
    return NextResponse.json({ message: updated });
  }

  if (body.action === "redraft") {
    const [enrollment] = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, message.enrollmentId))
      .limit(1);
    if (!enrollment) return NextResponse.json({ error: "enrollment missing" }, { status: 404 });
    const context = await contextForEnrollment(enrollment);
    if (!context) return NextResponse.json({ error: "context unavailable" }, { status: 422 });
    const drafted = await draftStep({
      spec: { stepKind: message.stepKind, channel: message.channel },
      context,
      priorSteps: [],
    });
    if (!drafted) {
      return NextResponse.json({ error: "redraft failed sanitization" }, { status: 422 });
    }
    const [updated] = await db
      .update(outreachMessages)
      .set({
        body: drafted.body,
        subject: drafted.subject,
        approvedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(outreachMessages.id, message.id))
      .returning();
    await logEnrollmentEvent({
      enrollmentId: message.enrollmentId,
      eventType: "drafted",
      actor: "user",
      payload: { redraft: true, message_id: message.id },
    });
    return NextResponse.json({ message: updated });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
