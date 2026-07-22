import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  contacts,
  outreachMessages,
  pipelineSettings,
  sequenceEnrollments,
  sendingProfiles,
  type OutreachMessage,
  type SequenceEnrollment,
} from "@/lib/db/schema";
import { sendAlertEmail } from "@/lib/alert-email";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { advanceEnrollment } from "@/lib/outreach/flow-engine";
import {
  bumpProfileCounters,
  pickSendingProfile,
  tickWarmupStateMachine,
} from "@/lib/outreach/profiles";
import {
  defaultFromAddress,
  emailFooter,
  resolveProfileApiKey,
  sendOutreachEmail,
} from "@/lib/outreach/resend-send";
import { getOrCreateOutreachSettings } from "@/lib/outreach/settings";
import { isSuppressed } from "@/lib/outreach/suppression";

/**
 * Dispatch pass (Vercel cron, every 15 min in window):
 *   1. advance active enrollments through their flow graphs
 *   2. send due queued EMAIL messages (suppression re-check → approval gate →
 *      profile pick → Resend send → activity log; company → contacted on
 *      first send)
 * iMessage sends are NOT dispatched here — the Mac worker polls its queue.
 *
 * Safety order (checked per message): global kill switch → dry-run →
 * approval gate → per-channel suppression → system daily cap → profile
 * capacity. N consecutive Resend failures halts the queue + alerts — no
 * silent pile-up, no recovery burst.
 */

const CONSECUTIVE_FAILURE_HALT = 3;
const MAX_SEND_ATTEMPTS = 3;
const DEFER_ESCALATE_WINDOWS = 96; // ~1 day of 15-min windows

export type DispatchSummary = {
  advanced: number;
  sent: number;
  deferred: number;
  suppressed: number;
  failed: number;
  halted: boolean;
  skippedReason?: string;
};

async function sentTodayTotal(): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(outreachMessages)
    .where(
      and(eq(outreachMessages.status, "sent"), gte(outreachMessages.sentAt, startOfDay)),
    );
  return Number(row?.count ?? 0);
}

async function markCompanyContacted(enrollment: SequenceEnrollment): Promise<void> {
  const [company] = await db
    .select({ status: companies.status })
    .from(companies)
    .where(eq(companies.id, enrollment.companyId))
    .limit(1);
  if (company?.status === "new") {
    await db
      .update(companies)
      .set({ status: "contacted", updatedAt: new Date() })
      .where(eq(companies.id, enrollment.companyId));
  }
}

async function logSendActivity(
  enrollment: SequenceEnrollment,
  message: OutreachMessage,
): Promise<void> {
  const { recordCallListOutreachEvent } = await import(
    "@/lib/outreach/call-list-sync"
  );
  await recordCallListOutreachEvent({
    companyId: enrollment.companyId,
    contactId: enrollment.contactId,
    activityType: "email",
    bumpAttempt: true,
    summary: `Outreach ${message.stepKind} email sent${
      message.subject ? `: ${message.subject}` : ""
    }`,
  });
}

export async function runOutreachDispatch(now = new Date()): Promise<DispatchSummary> {
  const summary: DispatchSummary = {
    advanced: 0,
    sent: 0,
    deferred: 0,
    suppressed: 0,
    failed: 0,
    halted: false,
  };

  const settings = await getOrCreateOutreachSettings();

  // Warm-up state machine ticks with the cron (cheap, idempotent).
  try {
    await tickWarmupStateMachine(now);
  } catch (error) {
    console.error("[outreach] warmup tick failed", error);
  }

  // 1. Advance flows (even while disabled — advancing only schedules; the
  //    kill switch gates actual sends below).
  const due = await db
    .select()
    .from(sequenceEnrollments)
    .where(
      and(
        inArray(sequenceEnrollments.status, ["active", "waiting_on_manual"]),
        or(
          isNull(sequenceEnrollments.nextStepAt),
          lte(sequenceEnrollments.nextStepAt, now),
        ),
      ),
    )
    .limit(200);
  for (const enrollment of due) {
    try {
      const result = await advanceEnrollment(enrollment, now);
      if (result.transitions > 0) summary.advanced += 1;
    } catch (error) {
      console.error("[outreach] advance failed", enrollment.id, error);
    }
  }

  // 2. Send due queued email messages.
  if (!settings.enabled) {
    summary.skippedReason = "kill switch off";
    return summary;
  }
  if (settings.dryRun) {
    summary.skippedReason = "dry-run mode";
    return summary;
  }

  const dueMessages = await db
    .select()
    .from(outreachMessages)
    .where(
      and(
        eq(outreachMessages.status, "queued"),
        eq(outreachMessages.channel, "email"),
        lte(outreachMessages.scheduledFor, now),
      ),
    )
    .orderBy(outreachMessages.scheduledFor)
    .limit(50);

  let consecutiveFailures = 0;
  let sentTodayCount = await sentTodayTotal();

  for (const message of dueMessages) {
    if (consecutiveFailures >= CONSECUTIVE_FAILURE_HALT) {
      summary.halted = true;
      break;
    }

    const [enrollment] = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, message.enrollmentId))
      .limit(1);
    if (!enrollment || !["active"].includes(enrollment.status)) {
      await db
        .update(outreachMessages)
        .set({ status: "cancelled", updatedAt: now })
        .where(eq(outreachMessages.id, message.id));
      continue;
    }

    // Approval gate.
    if (settings.requireApproval && !message.approvedAt) {
      summary.deferred += 1;
      continue;
    }

    // Per-channel suppression re-check at dispatch time — even mid-flow.
    const suppression = await isSuppressed({
      channel: "email",
      email: enrollment.emailAddress,
    });
    if (suppression.suppressed) {
      await db
        .update(outreachMessages)
        .set({ status: "skipped", error: `suppressed: ${suppression.reason}`, updatedAt: now })
        .where(eq(outreachMessages.id, message.id));
      await logEnrollmentEvent({
        enrollmentId: enrollment.id,
        eventType: "suppressed",
        payload: { message_id: message.id, reason: suppression.reason },
      });
      summary.suppressed += 1;
      continue;
    }

    // System daily cap (0 = no extra cap).
    if (settings.dailySendCap > 0 && sentTodayCount >= settings.dailySendCap) {
      await deferMessage(message, "daily_cap_exhausted", now, summary);
      continue;
    }

    // Profile pick — pool capacity or the profile-less fallback.
    const pick = await pickSendingProfile("email_domain");
    const profile = pick?.profile ?? null;
    const configured = await db
      .select({ id: sendingProfiles.id })
      .from(sendingProfiles)
      .where(eq(sendingProfiles.kind, "email_domain"))
      .limit(1);
    if (!profile && configured.length > 0) {
      // Profiles exist but every one is capped/unhealthy → defer, never
      // silently fall back past the warm-up limits.
      await deferMessage(message, "capacity_exhausted", now, summary);
      continue;
    }

    const apiKey = resolveProfileApiKey(profile);
    const from = profile?.fromAddress ?? defaultFromAddress();
    if (!apiKey || !from) {
      await deferMessage(message, "no_sending_identity", now, summary);
      continue;
    }

    const [contact] = await db
      .select({ name: contacts.name })
      .from(contacts)
      .where(eq(contacts.id, enrollment.contactId))
      .limit(1);

    const footer = emailFooter({
      senderName: process.env.OUTREACH_SENDER_NAME ?? "Alejandro O Delgado",
      senderTitle: process.env.OUTREACH_SENDER_TITLE ?? "Head of Client Services",
      firm: process.env.OUTREACH_SENDER_FIRM ?? "Villatoro Executive Search",
      phone: process.env.OUTREACH_SENDER_PHONE ?? null,
      physicalAddress: settings.physicalAddress,
    });

    const result = await sendOutreachEmail({
      apiKey,
      from,
      to: enrollment.emailAddress!,
      replyTo: profile?.replyToAddress ?? settings.replyToAddress,
      subject: message.subject ?? "Quick question",
      textBody: `${message.body}\n${footer}`,
    });

    if (result.ok) {
      consecutiveFailures = 0;
      sentTodayCount += 1;
      summary.sent += 1;
      await db
        .update(outreachMessages)
        .set({
          status: "sent",
          sentAt: now,
          resendId: result.resendId,
          messageId: result.messageId,
          sendingProfileId: profile?.id ?? null,
          attemptCount: message.attemptCount + 1,
          deferredReason: null,
          updatedAt: now,
        })
        .where(eq(outreachMessages.id, message.id));
      if (profile) await bumpProfileCounters(profile.id, { totalSent: 1 });
      await markCompanyContacted(enrollment);
      await logSendActivity(enrollment, message);
      await logEnrollmentEvent({
        enrollmentId: enrollment.id,
        eventType: "sent",
        payload: {
          message_id: message.id,
          step: message.stepKind,
          channel: "email",
          profile: profile?.label ?? "default",
          to: enrollment.emailAddress,
          contact: contact?.name,
        },
      });
      // Nudge the flow: the send node can now advance past this step.
      await db
        .update(sequenceEnrollments)
        .set({ nextStepAt: now, updatedAt: now })
        .where(eq(sequenceEnrollments.id, enrollment.id));
    } else {
      consecutiveFailures += 1;
      summary.failed += 1;
      const attempts = message.attemptCount + 1;
      const permanent = attempts >= MAX_SEND_ATTEMPTS;
      // Exponential backoff on transient failures.
      const backoffMinutes = 15 * 2 ** (attempts - 1);
      await db
        .update(outreachMessages)
        .set({
          status: permanent ? "failed" : "queued",
          attemptCount: attempts,
          error: result.error,
          scheduledFor: permanent
            ? message.scheduledFor
            : new Date(now.getTime() + backoffMinutes * 60_000),
          updatedAt: now,
        })
        .where(eq(outreachMessages.id, message.id));
      await logEnrollmentEvent({
        enrollmentId: enrollment.id,
        eventType: permanent ? "error" : "retry",
        payload: { message_id: message.id, attempt: attempts, error: result.error },
      });
    }
  }

  if (summary.halted) {
    const [pipelineRow] = await db
      .select({ email: pipelineSettings.notificationEmail })
      .from(pipelineSettings)
      .limit(1);
    const to = pipelineRow?.email ?? process.env.ALERT_EMAIL ?? null;
    if (to) {
      await sendAlertEmail({
        toEmail: to,
        subject: "[Outreach] send queue HALTED after consecutive Resend failures",
        html: `<p style="font-family:sans-serif">The outreach dispatcher hit ${CONSECUTIVE_FAILURE_HALT} consecutive Resend failures and halted this window to avoid a pile-up. It will retry next window; check Resend status and the failed messages in Admin → Outreach.</p>`,
      });
    }
  }

  // Escalate long-deferred messages: past ~a day of windows → failed + alert.
  const stale = await db
    .select()
    .from(outreachMessages)
    .where(
      and(
        eq(outreachMessages.status, "queued"),
        sql`${outreachMessages.deferredReason} is not null`,
        lte(
          outreachMessages.updatedAt,
          new Date(now.getTime() - DEFER_ESCALATE_WINDOWS * 15 * 60_000),
        ),
      ),
    )
    .limit(20);
  for (const message of stale) {
    await db
      .update(outreachMessages)
      .set({ status: "failed", error: `escalated after prolonged ${message.deferredReason}`, updatedAt: now })
      .where(eq(outreachMessages.id, message.id));
    await logEnrollmentEvent({
      enrollmentId: message.enrollmentId,
      eventType: "error",
      payload: { message_id: message.id, escalated: true, deferred_reason: message.deferredReason },
    });
  }

  return summary;
}

async function deferMessage(
  message: OutreachMessage,
  reason: string,
  now: Date,
  summary: DispatchSummary,
): Promise<void> {
  await db
    .update(outreachMessages)
    .set({ deferredReason: reason, updatedAt: now })
    .where(eq(outreachMessages.id, message.id));
  await logEnrollmentEvent({
    enrollmentId: message.enrollmentId,
    eventType: "deferred",
    payload: { message_id: message.id, reason },
  });
  summary.deferred += 1;
}
