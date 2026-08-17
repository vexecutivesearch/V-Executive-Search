import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { outreachMessages, sequenceEnrollments } from "@/lib/db/schema";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { WORKER_CLAIMABLE_ENROLLMENT_STATUSES } from "@/lib/outreach/imessage-queue";
import { remainingToday, sentTodayOnChannel } from "@/lib/outreach/send-caps";
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

  // The daily send cap applies to texts too, counted separately from email.
  // Without this the text channel was entirely uncapped while still consuming
  // the email budget — the worst of both arrangements.
  const textsSentToday = await sentTodayOnChannel("imessage");
  const textsRemaining = remainingToday(settings.dailySendCap, textsSentToday);
  if (textsRemaining <= 0) {
    return NextResponse.json({
      messages: [],
      reason: "daily_cap_exhausted",
      sent_today: textsSentToday,
      cap: settings.dailySendCap,
    });
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
        // Include post-reply statuses so SMS auto-replies queued in the same
        // tick as a status flip still leave the Mac worker.
        inArray(sequenceEnrollments.status, [
          ...WORKER_CLAIMABLE_ENROLLMENT_STATUSES,
        ]),
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
    // Never hand the worker more than the day's remaining allowance; the rest
    // stay queued and go out on the next sending day.
    if (out.length >= textsRemaining) break;
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
    results?: Array<{
      id: string;
      status: "sent" | "failed";
      error?: string;
      /** Transport that actually carried it — "iMessage", "SMS", or "RCS". */
      transport?: string;
      /**
       * Set when the worker only learned the outcome on a later poll tick. An
       * iMessage has no delivery receipt for a couple of minutes, and Messages
       * can silently downgrade one to SMS, so the first status is provisional.
       */
      verification?: "late";
    }>;
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
    if (!message) continue;

    // A late verdict on a message already recorded sent is a correction, not a
    // new send: never re-queue it (that would text the contact twice) and never
    // replay the flow-advance side effects below.
    if (result.verification === "late" && message.status === "sent") {
      if (result.status === "sent") {
        await db
          .update(outreachMessages)
          .set({ error: null, updatedAt: now })
          .where(eq(outreachMessages.id, message.id));
        await logEnrollmentEvent({
          enrollmentId: message.enrollmentId,
          eventType: "delivery_verified",
          payload: {
            message_id: message.id,
            channel: "imessage",
            transport: result.transport ?? null,
          },
        });
      } else {
        await db
          .update(outreachMessages)
          .set({
            status: "failed",
            error: result.error ?? "text not delivered",
            updatedAt: now,
          })
          .where(eq(outreachMessages.id, message.id));
        await logEnrollmentEvent({
          enrollmentId: message.enrollmentId,
          eventType: "error",
          payload: {
            message_id: message.id,
            channel: "imessage",
            error: result.error,
            late_verification: true,
            manual_note:
              "recorded sent, but Messages never delivered it — send by hand if still relevant",
          },
        });
      }
      updated += 1;
      continue;
    }

    if (message.status !== "queued") continue;

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
        payload: {
          message_id: message.id,
          channel: "imessage",
          step: message.stepKind,
          transport: result.transport ?? null,
        },
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
        const { contacts } = await import("@/lib/db/schema");
        const [texted] = await db
          .select({ name: contacts.name })
          .from(contacts)
          .where(eq(contacts.id, enr.contactId))
          .limit(1);
        await recordCallListOutreachEvent({
          companyId: enr.companyId,
          contactId: enr.contactId,
          bumpAttempt: true,
          callStatus: "email_sent",
          // Several contacts enroll per company, so an unnamed line is
          // indistinguishable from a duplicate send.
          summary:
            `Outreach ${message.stepKind} ${result.transport ?? "iMessage"} sent` +
            `${texted ? ` to ${texted.name}` : ""}` +
            `${enr.phoneNumber ? ` (${enr.phoneNumber})` : ""}`,
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
