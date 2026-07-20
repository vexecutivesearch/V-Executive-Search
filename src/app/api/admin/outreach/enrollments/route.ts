import { and, desc, eq, inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import {
  companies,
  contacts,
  enrollmentEvents,
  outreachMessages,
  sequenceEnrollments,
} from "@/lib/db/schema";
import { enrollContact } from "@/lib/outreach/enroll";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { resolveManualWait } from "@/lib/outreach/flow-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const status = request.nextUrl.searchParams.get("status");
  const enrollmentId = request.nextUrl.searchParams.get("id");

  if (enrollmentId) {
    const [enrollment] = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, enrollmentId))
      .limit(1);
    if (!enrollment) return NextResponse.json({ error: "not found" }, { status: 404 });
    const messages = await db
      .select()
      .from(outreachMessages)
      .where(eq(outreachMessages.enrollmentId, enrollmentId))
      .orderBy(outreachMessages.createdAt);
    const events = await db
      .select()
      .from(enrollmentEvents)
      .where(eq(enrollmentEvents.enrollmentId, enrollmentId))
      .orderBy(desc(enrollmentEvents.createdAt))
      .limit(100);
    return NextResponse.json({ enrollment, messages, events });
  }

  const rows = await db
    .select({
      enrollment: sequenceEnrollments,
      contactName: contacts.name,
      contactTitle: contacts.title,
      companyName: companies.name,
    })
    .from(sequenceEnrollments)
    .innerJoin(contacts, eq(contacts.id, sequenceEnrollments.contactId))
    .innerJoin(companies, eq(companies.id, sequenceEnrollments.companyId))
    .where(
      status
        ? eq(
            sequenceEnrollments.status,
            status as (typeof sequenceEnrollments.$inferSelect)["status"],
          )
        : undefined,
    )
    .orderBy(desc(sequenceEnrollments.enrolledAt))
    .limit(200);

  return NextResponse.json({ enrollments: rows });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: {
    action?: "pause" | "resume" | "stop" | "enroll" | "resolve_manual" | "set_timezone";
    enrollmentId?: string;
    contactId?: string;
    edge?: "done" | "timeout";
    reason?: string;
    timezone?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.action === "enroll") {
    if (!body.contactId) {
      return NextResponse.json({ error: "contactId required" }, { status: 400 });
    }
    const result = await enrollContact(body.contactId, { actor: "user" });
    return NextResponse.json(result, { status: result.enrolled ? 200 : 422 });
  }

  if (!body.enrollmentId) {
    return NextResponse.json({ error: "enrollmentId required" }, { status: 400 });
  }
  const [enrollment] = await db
    .select()
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.id, body.enrollmentId))
    .limit(1);
  if (!enrollment) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (body.action === "resolve_manual") {
    const ok = await resolveManualWait(enrollment.id, body.edge ?? "done", "user");
    return NextResponse.json({ ok });
  }

  if (body.action === "set_timezone") {
    // timezone_override on the contact wins over inference — for remote
    // workers whose inferred location is wrong.
    const tz = body.timezone?.trim() || null;
    if (tz) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
      } catch {
        return NextResponse.json({ error: `invalid timezone ${tz}` }, { status: 400 });
      }
    }
    await db
      .update(contacts)
      .set({ timezoneOverride: tz })
      .where(eq(contacts.id, enrollment.contactId));
    await db
      .update(sequenceEnrollments)
      .set({ timezone: tz ?? enrollment.timezone, updatedAt: new Date() })
      .where(eq(sequenceEnrollments.id, enrollment.id));
    await logEnrollmentEvent({
      enrollmentId: enrollment.id,
      eventType: "manual_intervention",
      actor: "user",
      payload: { action: "set_timezone", timezone: tz },
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "pause") {
    await db
      .update(sequenceEnrollments)
      .set({ status: "paused", stopReason: body.reason ?? "paused by admin", stoppedBy: "user", updatedAt: new Date() })
      .where(eq(sequenceEnrollments.id, enrollment.id));
  } else if (body.action === "resume") {
    if (!["paused", "waiting_on_manual"].includes(enrollment.status)) {
      return NextResponse.json({ error: `cannot resume from ${enrollment.status}` }, { status: 422 });
    }
    await db
      .update(sequenceEnrollments)
      .set({ status: "active", stopReason: null, stoppedBy: null, nextStepAt: new Date(), updatedAt: new Date() })
      .where(eq(sequenceEnrollments.id, enrollment.id));
  } else if (body.action === "stop") {
    await db
      .update(sequenceEnrollments)
      .set({ status: "stopped", stopReason: body.reason ?? "stopped by admin", stoppedBy: "user", updatedAt: new Date() })
      .where(eq(sequenceEnrollments.id, enrollment.id));
    await db
      .update(outreachMessages)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(outreachMessages.enrollmentId, enrollment.id),
          inArray(outreachMessages.status, ["drafted", "queued"]),
        ),
      );
  } else {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }

  await logEnrollmentEvent({
    enrollmentId: enrollment.id,
    eventType: "manual_intervention",
    actor: "user",
    payload: { action: body.action, reason: body.reason },
  });
  return NextResponse.json({ ok: true });
}
