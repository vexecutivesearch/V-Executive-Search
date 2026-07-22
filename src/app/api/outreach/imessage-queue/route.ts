import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { outreachMessages, sequenceEnrollments } from "@/lib/db/schema";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { getOrCreateOutreachSettings } from "@/lib/outreach/settings";
import { isSuppressed } from "@/lib/outreach/suppression";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mac worker poll: due iMessage sends. Same safety order as email dispatch —
 * kill switch → dry-run → approval gate → per-channel suppression re-check.
 * The worker sends via Messages.app AppleScript and posts status back to
 * /api/outreach/imessage-status.
 */
export async function GET(request: NextRequest) {
  if (!verifyWorkerAuth(request)) return unauthorized();

  const settings = await getOrCreateOutreachSettings();
  if (!settings.enabled || settings.dryRun) {
    return NextResponse.json({ messages: [], reason: !settings.enabled ? "kill_switch" : "dry_run" });
  }

  const now = new Date();
  const due = await db
    .select({
      message: outreachMessages,
      enrollment: sequenceEnrollments,
    })
    .from(outreachMessages)
    .innerJoin(
      sequenceEnrollments,
      eq(sequenceEnrollments.id, outreachMessages.enrollmentId),
    )
    .where(
      and(
        eq(outreachMessages.status, "queued"),
        eq(outreachMessages.channel, "imessage"),
        lte(outreachMessages.scheduledFor, now),
        eq(sequenceEnrollments.status, "active"),
        isNotNull(sequenceEnrollments.phoneNumber),
      ),
    )
    .limit(20);

  const out: Array<{
    id: string;
    phone: string;
    body: string;
    attempt: number;
  }> = [];

  for (const { message, enrollment } of due) {
    if (settings.requireApproval && !message.approvedAt) continue;
    const suppression = await isSuppressed({
      channel: "imessage",
      phone: enrollment.phoneNumber,
    });
    if (suppression.suppressed) {
      await db
        .update(outreachMessages)
        .set({ status: "skipped", error: `suppressed: ${suppression.reason}`, updatedAt: now })
        .where(eq(outreachMessages.id, message.id));
      await logEnrollmentEvent({
        enrollmentId: enrollment.id,
        eventType: "suppressed",
        payload: { message_id: message.id, channel: "imessage", reason: suppression.reason },
      });
      continue;
    }
    out.push({
      id: message.id,
      phone: enrollment.phoneNumber!,
      body: message.body,
      attempt: message.attemptCount + 1,
    });
  }

  return NextResponse.json({ messages: out });
}

/** Worker posts back per-message send results. */
export async function POST(request: NextRequest) {
  if (!verifyWorkerAuth(request)) return unauthorized();

  let payload: {
    results?: Array<{ id: string; status: "sent" | "failed"; error?: string }>;
  };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const MAX_ATTEMPTS = 3;
  const now = new Date();
  let updated = 0;

  for (const result of payload.results ?? []) {
    const [message] = await db
      .select()
      .from(outreachMessages)
      .where(eq(outreachMessages.id, result.id))
      .limit(1);
    if (!message || message.status !== "queued") continue;

    if (result.status === "sent") {
      await db
        .update(outreachMessages)
        .set({
          status: "sent",
          sentAt: now,
          attemptCount: message.attemptCount + 1,
          updatedAt: now,
        })
        .where(eq(outreachMessages.id, message.id));
      await logEnrollmentEvent({
        enrollmentId: message.enrollmentId,
        eventType: "sent",
        payload: { message_id: message.id, channel: "imessage", step: message.stepKind },
      });
      // Let the flow advance past this send node.
      await db
        .update(sequenceEnrollments)
        .set({ nextStepAt: now, updatedAt: now })
        .where(eq(sequenceEnrollments.id, message.enrollmentId));
      const [enr] = await db
        .select()
        .from(sequenceEnrollments)
        .where(eq(sequenceEnrollments.id, message.enrollmentId))
        .limit(1);
      if (enr) {
        const { recordCallListOutreachEvent } = await import(
          "@/lib/outreach/call-list-sync"
        );
        await recordCallListOutreachEvent({
          companyId: enr.companyId,
          contactId: enr.contactId,
          bumpAttempt: true,
          summary: `Outreach ${message.stepKind} iMessage sent`,
        });
        const { companies } = await import("@/lib/db/schema");
        const [company] = await db
          .select({ status: companies.status })
          .from(companies)
          .where(eq(companies.id, enr.companyId))
          .limit(1);
        if (company?.status === "new") {
          await db
            .update(companies)
            .set({ status: "contacted", updatedAt: now })
            .where(eq(companies.id, enr.companyId));
        }
      }
    } else {
      const attempts = message.attemptCount + 1;
      const permanent = attempts >= MAX_ATTEMPTS;
      await db
        .update(outreachMessages)
        .set({
          status: permanent ? "failed" : "queued",
          attemptCount: attempts,
          error: result.error ?? "imessage send failed",
          scheduledFor: permanent
            ? message.scheduledFor
            : new Date(now.getTime() + 30 * 60_000 * attempts),
          updatedAt: now,
        })
        .where(eq(outreachMessages.id, message.id));
      await logEnrollmentEvent({
        enrollmentId: message.enrollmentId,
        eventType: permanent ? "error" : "retry",
        payload: {
          message_id: message.id,
          channel: "imessage",
          attempt: attempts,
          error: result.error,
          ...(permanent ? { manual_note: "text failed after retries — send manually if still relevant" } : {}),
        },
      });
    }
    updated += 1;
  }

  return NextResponse.json({ ok: true, updated });
}
