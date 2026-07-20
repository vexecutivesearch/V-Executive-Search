import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  contacts,
  inboundMessages,
  outreachMessages,
  pipelineSettings,
  sequenceEnrollments,
  type InboundIntent,
  type InboundMessage,
  type SequenceEnrollment,
} from "@/lib/db/schema";
import { draftPositiveReply } from "@/lib/outreach-draft";
import { suggestAvailability } from "@/lib/outreach/calendar";
import { cancelSiblingEnrollments } from "@/lib/outreach/enroll";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { contextForEnrollment } from "@/lib/outreach/node-draft";
import { notifyReply } from "@/lib/outreach/notifications";
import {
  defaultFromAddress,
  emailFooter,
  resolveProfileApiKey,
  sendOutreachEmail,
} from "@/lib/outreach/resend-send";
import { getOrCreateOutreachSettings } from "@/lib/outreach/settings";
import { addSuppression } from "@/lib/outreach/suppression";
import { addBusinessDays } from "@/lib/outreach/timezone-infer";

/**
 * Rule engine — channel-agnostic. A text reply and an email reply hit
 * identical branching. Confirmed defaults:
 *   positive        → stop steps; DON'T suppress; threaded auto-reply with
 *                     live GCal windows; notify + follow-up task; company →
 *                     meeting track; cancel sibling sequences (one
 *                     conversation per company)
 *   positive_link_request → positive handling, but the reply carries a
 *                     scheduling link (thread established, link-safe)
 *   info_request    → stop automation, hand off with the exact quoted ask
 *   negative/opt_out→ stop + permanently suppress THAT contact only
 *   wrong_person    → stop + suppress, flag company for re-enrichment
 *   ooo             → don't stop; push next step +3 business days; 2 OOOs → pause
 *   courtesy        → stop sending, flag for manual review
 *   data_deletion   → purge drafts + inbound bodies, full suppression, audit
 *   unknown         → pause + notify
 * Every action writes to enrollment_events.
 */

async function notificationEmail(): Promise<string | null> {
  const [row] = await db
    .select({ email: pipelineSettings.notificationEmail })
    .from(pipelineSettings)
    .limit(1);
  return row?.email ?? process.env.ALERT_EMAIL ?? null;
}

async function stopPendingSteps(
  enrollmentId: string,
  actor: string,
): Promise<number> {
  const result = await db
    .update(outreachMessages)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(outreachMessages.enrollmentId, enrollmentId),
        inArray(outreachMessages.status, ["drafted", "queued"]),
      ),
    )
    .returning({ id: outreachMessages.id });
  if (result.length) {
    await logEnrollmentEvent({
      enrollmentId,
      eventType: "cancelled",
      actor,
      payload: { messages_cancelled: result.length },
    });
  }
  return result.length;
}

async function setEnrollmentStatus(
  enrollment: SequenceEnrollment,
  status: SequenceEnrollment["status"],
  actor: string,
  reason: string,
): Promise<void> {
  await db
    .update(sequenceEnrollments)
    .set({
      status,
      stopReason: reason,
      stoppedBy: actor,
      nextStepAt: null,
      updatedAt: new Date(),
    })
    .where(eq(sequenceEnrollments.id, enrollment.id));
}

/** The most recent message the contact replied to (for threading). */
async function lastSentEmail(enrollmentId: string) {
  const rows = await db
    .select()
    .from(outreachMessages)
    .where(
      and(
        eq(outreachMessages.enrollmentId, enrollmentId),
        eq(outreachMessages.status, "sent"),
        eq(outreachMessages.channel, "email"),
      ),
    );
  return rows.sort(
    (a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0),
  )[0];
}

async function sendThreadedAutoReply(options: {
  enrollment: SequenceEnrollment;
  inbound: InboundMessage;
  includeSchedulingLink: boolean;
}): Promise<{ sent: boolean; usedCalendar: boolean }> {
  const { enrollment, inbound } = options;
  const settings = await getOrCreateOutreachSettings();
  const context = await contextForEnrollment(enrollment);
  if (!context || !enrollment.emailAddress) return { sent: false, usedCalendar: false };

  const availability = await suggestAvailability();
  const schedulingLink = options.includeSchedulingLink
    ? process.env.OUTREACH_SCHEDULING_LINK ?? null
    : null;

  const body = await draftPositiveReply({
    context,
    inboundSnippet: inbound.rawBody.slice(0, 800),
    availabilityLines: availability.lines,
    includeSchedulingLink: schedulingLink,
  });
  if (!body) return { sent: false, usedCalendar: availability.fromCalendar };

  const previous = await lastSentEmail(enrollment.id);
  const apiKey = resolveProfileApiKey(null);
  const from = defaultFromAddress();
  if (!apiKey || !from) return { sent: false, usedCalendar: availability.fromCalendar };

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
    to: enrollment.emailAddress,
    replyTo: settings.replyToAddress,
    subject: previous?.subject ? `Re: ${previous.subject.replace(/^re:\s*/i, "")}` : "Re: your reply",
    textBody: `${body}\n${footer}`,
    inReplyTo: previous?.messageId ?? null,
  });

  if (result.ok) {
    await db.insert(outreachMessages).values({
      enrollmentId: enrollment.id,
      stepKind: "reply_positive",
      channel: "email",
      status: "sent",
      subject: previous?.subject ? `Re: ${previous.subject}` : "Re: your reply",
      body,
      resendId: result.resendId,
      messageId: result.messageId,
      sentAt: new Date(),
    });
    await logEnrollmentEvent({
      enrollmentId: enrollment.id,
      eventType: "sent",
      actor: "rule:positive",
      payload: {
        auto_reply: true,
        threaded_to: previous?.messageId ?? null,
        from_calendar: availability.fromCalendar,
        scheduling_link: Boolean(schedulingLink),
      },
    });
  }
  return { sent: result.ok, usedCalendar: availability.fromCalendar };
}

/** Data-deletion purge: drafts + inbound bodies, full suppression, audit. */
export async function purgeContactData(
  contactId: string,
  actor: string,
): Promise<{ enrollments: number }> {
  const enrollments = await db
    .select()
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.contactId, contactId));

  const [contact] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  for (const enrollment of enrollments) {
    await stopPendingSteps(enrollment.id, actor);
    // Purge drafted bodies (keep sent metadata for the compliance record).
    await db
      .update(outreachMessages)
      .set({ body: "[purged — data deletion request]", subject: null, updatedAt: new Date() })
      .where(
        and(
          eq(outreachMessages.enrollmentId, enrollment.id),
          inArray(outreachMessages.status, ["cancelled", "drafted", "skipped", "failed"]),
        ),
      );
    await db
      .update(inboundMessages)
      .set({ rawBody: "[purged — data deletion request]" })
      .where(eq(inboundMessages.enrollmentId, enrollment.id));
    await setEnrollmentStatus(enrollment, "suppressed", actor, "data deletion request");
    await logEnrollmentEvent({
      enrollmentId: enrollment.id,
      eventType: "purged",
      actor,
      payload: { contact_id: contactId },
    });
  }

  if (contact) {
    await addSuppression({
      email: contact.workEmail ?? contact.email,
      phone: contact.personalPhone ?? contact.phone,
      channel: "all",
      reason: "data deletion request",
      legalBasis: "GDPR/CCPA deletion",
      contactId,
    });
    const secondary = contact.personalEmail;
    if (secondary) {
      await addSuppression({
        email: secondary,
        channel: "all",
        reason: "data deletion request",
        legalBasis: "GDPR/CCPA deletion",
        contactId,
      });
    }
  }
  return { enrollments: enrollments.length };
}

export type RuleOutcome = {
  intent: InboundIntent;
  actionTaken: string;
};

export async function applyReplyRules(
  enrollment: SequenceEnrollment,
  inbound: InboundMessage,
  intent: InboundIntent,
): Promise<RuleOutcome> {
  const actor = `rule:${intent}`;
  const notifyTo = await notificationEmail();

  const [contact] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, enrollment.contactId))
    .limit(1);
  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, enrollment.companyId))
    .limit(1);
  const snippet = inbound.rawBody.slice(0, 400);

  const base = {
    contactId: enrollment.contactId,
    companyId: enrollment.companyId,
    inboundMessageId: inbound.id,
    contactName: contact?.name ?? null,
    companyName: company?.name ?? null,
    snippet,
    notifyEmail: notifyTo,
  };

  switch (intent) {
    case "positive":
    case "positive_link_request": {
      await stopPendingSteps(enrollment.id, actor);
      await setEnrollmentStatus(enrollment, "replied_positive", actor, "positive reply");
      const reply = await sendThreadedAutoReply({
        enrollment,
        inbound,
        includeSchedulingLink: intent === "positive_link_request",
      });
      // Company → meeting track.
      await db
        .update(companies)
        .set({ status: "meeting", updatedAt: new Date() })
        .where(eq(companies.id, enrollment.companyId));
      const cancelled = await cancelSiblingEnrollments(
        enrollment.companyId,
        enrollment.id,
        "sibling replied positive — one conversation per company",
      );
      await notifyReply({ ...base, intent, createFollowUpTask: true });
      await logEnrollmentEvent({
        enrollmentId: enrollment.id,
        eventType: "rule_action",
        actor,
        payload: {
          auto_reply_sent: reply.sent,
          used_calendar: reply.usedCalendar,
          siblings_cancelled: cancelled,
          company_status: "meeting",
        },
      });
      return {
        intent,
        actionTaken: `stopped; auto-replied (${reply.sent ? "sent" : "FAILED — manual"}); ${cancelled} sibling(s) cancelled; company → meeting`,
      };
    }

    case "info_request": {
      await stopPendingSteps(enrollment.id, actor);
      await setEnrollmentStatus(enrollment, "waiting_on_manual", actor, "info request — hand-off");
      await notifyReply({ ...base, intent, createFollowUpTask: true });
      await logEnrollmentEvent({
        enrollmentId: enrollment.id,
        eventType: "rule_action",
        actor,
        payload: { hand_off: true, quoted_ask: snippet },
      });
      return { intent, actionTaken: "stopped automation; handed off with quoted ask" };
    }

    case "negative":
    case "opt_out": {
      await stopPendingSteps(enrollment.id, actor);
      await setEnrollmentStatus(
        enrollment,
        intent === "opt_out" ? "suppressed" : "replied_negative",
        actor,
        intent,
      );
      // Permanently suppress THAT contact only (email + phone); colleagues continue.
      await addSuppression({
        email: enrollment.emailAddress,
        phone: enrollment.phoneNumber,
        channel: "all",
        reason: intent === "opt_out" ? "opt-out reply" : "negative reply",
        legalBasis: "recipient request",
        contactId: enrollment.contactId,
      });
      await notifyReply({ ...base, intent, createFollowUpTask: false });
      await logEnrollmentEvent({
        enrollmentId: enrollment.id,
        eventType: "rule_action",
        actor,
        payload: { suppressed_contact: enrollment.contactId, colleagues_unaffected: true },
      });
      return { intent, actionTaken: "stopped + contact suppressed (colleagues continue)" };
    }

    case "wrong_person": {
      await stopPendingSteps(enrollment.id, actor);
      await setEnrollmentStatus(enrollment, "stopped", actor, "wrong person");
      await addSuppression({
        email: enrollment.emailAddress,
        phone: enrollment.phoneNumber,
        channel: "all",
        reason: "wrong person",
        contactId: enrollment.contactId,
      });
      // Flag company for re-enrichment via a visible activity.
      await db.insert((await import("@/lib/db/schema")).companyActivities).values({
        companyId: enrollment.companyId,
        contactId: enrollment.contactId,
        type: "note",
        summary: `Outreach: wrong person — re-enrich this company for the right contact. Reply: ${snippet.slice(0, 200)}`,
        source: "outreach",
      });
      await notifyReply({ ...base, intent, createFollowUpTask: false });
      return { intent, actionTaken: "stopped + suppressed; company flagged for re-enrichment" };
    }

    case "ooo": {
      const state = { ...(enrollment.nodeState ?? {}) };
      const oooCount = Number(state.ooo_count ?? 0) + 1;
      state.ooo_count = oooCount;
      if (oooCount >= 2) {
        await db
          .update(sequenceEnrollments)
          .set({ status: "paused", nodeState: state, stopReason: "two OOO replies", updatedAt: new Date() })
          .where(eq(sequenceEnrollments.id, enrollment.id));
        await logEnrollmentEvent({
          enrollmentId: enrollment.id,
          eventType: "rule_action",
          actor,
          payload: { ooo_count: oooCount, action: "paused" },
        });
        return { intent, actionTaken: "second OOO — paused" };
      }
      // Push next step +3 business days; don't stop.
      const currentNext = enrollment.nextStepAt ?? new Date();
      const pushed = addBusinessDays(currentNext, 3, enrollment.timezone);
      const waitUntil = state.wait_until
        ? addBusinessDays(new Date(String(state.wait_until)), 3, enrollment.timezone)
        : undefined;
      if (waitUntil) state.wait_until = waitUntil.toISOString();
      await db
        .update(sequenceEnrollments)
        .set({ nextStepAt: pushed, nodeState: state, updatedAt: new Date() })
        .where(eq(sequenceEnrollments.id, enrollment.id));
      await db
        .update(outreachMessages)
        .set({ scheduledFor: pushed, updatedAt: new Date() })
        .where(
          and(
            eq(outreachMessages.enrollmentId, enrollment.id),
            eq(outreachMessages.status, "queued"),
          ),
        );
      await logEnrollmentEvent({
        enrollmentId: enrollment.id,
        eventType: "rule_action",
        actor,
        payload: { rescheduled_to: pushed.toISOString(), ooo_count: oooCount },
      });
      return { intent, actionTaken: `rescheduled +3 business days (OOO ${oooCount}/2)` };
    }

    case "courtesy": {
      await stopPendingSteps(enrollment.id, actor);
      await setEnrollmentStatus(enrollment, "waiting_on_manual", actor, "courtesy reply — manual review");
      await notifyReply({ ...base, intent, createFollowUpTask: false });
      return { intent, actionTaken: "stopped sending; flagged for manual review" };
    }

    case "data_deletion": {
      const purged = await purgeContactData(enrollment.contactId, actor);
      await notifyReply({ ...base, intent, createFollowUpTask: false });
      return {
        intent,
        actionTaken: `automated purge (${purged.enrollments} enrollment(s)) + full suppression`,
      };
    }

    case "bounce_hard": {
      await stopPendingSteps(enrollment.id, actor);
      await setEnrollmentStatus(enrollment, "bounced", actor, "hard bounce");
      await addSuppression({
        email: enrollment.emailAddress,
        channel: "email",
        reason: "hard bounce",
        contactId: enrollment.contactId,
      });
      return { intent, actionTaken: "hard bounce — suppressed email" };
    }

    case "bounce_soft": {
      const pushed = addBusinessDays(new Date(), 1, enrollment.timezone);
      await db
        .update(sequenceEnrollments)
        .set({ nextStepAt: pushed, updatedAt: new Date() })
        .where(eq(sequenceEnrollments.id, enrollment.id));
      return { intent, actionTaken: "soft bounce — backoff retry" };
    }

    default: {
      // unknown — pause + notify; never auto-suppress on a guess.
      await db
        .update(sequenceEnrollments)
        .set({ status: "paused", stopReason: "unclassified reply", updatedAt: new Date() })
        .where(eq(sequenceEnrollments.id, enrollment.id));
      await notifyReply({ ...base, intent: "unknown", createFollowUpTask: true });
      await logEnrollmentEvent({
        enrollmentId: enrollment.id,
        eventType: "rule_action",
        actor: "rule:unknown",
        payload: { action: "paused_for_review" },
      });
      return { intent: "unknown", actionTaken: "paused + notified" };
    }
  }
}
