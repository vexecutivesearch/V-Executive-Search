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
import { draftEnrollmentReply } from "@/lib/outreach-draft";
import { suggestAvailability } from "@/lib/outreach/calendar";
import { cancelSiblingEnrollments } from "@/lib/outreach/enroll";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { contextForEnrollment } from "@/lib/outreach/node-draft";
import { notifyReply } from "@/lib/outreach/notifications";
import {
  replyKindForIntent,
  type ReplyTemplateKind,
} from "@/lib/outreach/reply-playbook";
import {
  defaultFromAddress,
  emailFooter,
  resolveProfileApiKey,
  sendOutreachEmail,
} from "@/lib/outreach/resend-send";
import { getOrCreateOutreachSettings } from "@/lib/outreach/settings";
import { addSuppression } from "@/lib/outreach/suppression";
import { addBusinessDays } from "@/lib/outreach/timezone-infer";

/** Default Calendly booking URL when OUTREACH_SCHEDULING_LINK is unset. */
const DEFAULT_SCHEDULING_LINK =
  "https://calendly.com/odv-vexecutivesearch/30min";

function resolveSchedulingLink(): string {
  const fromEnv = process.env.OUTREACH_SCHEDULING_LINK?.trim();
  return fromEnv || DEFAULT_SCHEDULING_LINK;
}

/**
 * Rule engine — channel-agnostic. A text reply and an email reply hit
 * identical branching. Intent is LLM classified against Template bank reply
 * exemplars; that intent picks which reply email goes out next:
 *   positive / positive_link_request → reply_positive (auto-send, with scheduling link)
 *   info_request    → reply_info_request (auto-send ack) then hand-off
 *   negative        → reply_decline (auto-send close) then suppress contact
 *   opt_out         → stop + suppress, no reply email
 *   wrong_person    → stop + suppress, flag company for re-enrichment
 *   ooo             → don't stop; push next step +3 business days; 2 OOOs → pause
 *   courtesy        → stop sending, flag for manual review
 *   bounce_hard     → stop + suppress email
 *   bounce_soft     → push next step +1 business day; 3 soft bounces → pause
 *   complaint       → stop + suppress email (spam complaint); no reply email
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
  replyKind: ReplyTemplateKind;
  includeSchedulingLink?: boolean;
}): Promise<{ sent: boolean; queued: boolean; usedCalendar: boolean; channel: "email" | "imessage" }> {
  const { enrollment, inbound, replyKind } = options;
  const settings = await getOrCreateOutreachSettings();
  const context = await contextForEnrollment(enrollment);
  if (!context) {
    return { sent: false, queued: false, usedCalendar: false, channel: "email" };
  }

  // Reply on the same channel they used.
  const preferSms =
    inbound.channel === "imessage" && Boolean(enrollment.phoneNumber);
  const channel: "email" | "imessage" = preferSms ? "imessage" : "email";
  if (channel === "email" && !enrollment.emailAddress) {
    return { sent: false, queued: false, usedCalendar: false, channel };
  }

  const needsAvailability =
    replyKind === "reply_positive" && !options.includeSchedulingLink;
  const availability = needsAvailability
    ? await suggestAvailability()
    : { lines: [] as string[], fromCalendar: false };
  const schedulingLink = options.includeSchedulingLink
    ? resolveSchedulingLink()
    : null;

  const body = await draftEnrollmentReply({
    replyKind,
    context,
    inboundSnippet: inbound.rawBody.slice(0, 800),
    availabilityLines: availability.lines,
    includeSchedulingLink: schedulingLink,
    channel,
  });
  if (!body) {
    return {
      sent: false,
      queued: false,
      usedCalendar: availability.fromCalendar,
      channel,
    };
  }

  if (channel === "imessage") {
    // Queue for the Mac mini Messages.app worker (cannot send from Vercel).
    const [queued] = await db
      .insert(outreachMessages)
      .values({
        enrollmentId: enrollment.id,
        stepKind: replyKind,
        channel: "imessage",
        status: "queued",
        body,
        approvedAt: new Date(),
        scheduledFor: new Date(Date.now() - 1_000),
      })
      .returning({ id: outreachMessages.id });
    await logEnrollmentEvent({
      enrollmentId: enrollment.id,
      eventType: "rule_action",
      actor: `rule:${replyKind}`,
      payload: {
        auto_reply: true,
        reply_kind: replyKind,
        channel: "imessage",
        queued_message_id: queued?.id ?? null,
        scheduling_link: Boolean(schedulingLink),
      },
    });
    return {
      sent: false,
      queued: true,
      usedCalendar: availability.fromCalendar,
      channel: "imessage",
    };
  }

  const previous = await lastSentEmail(enrollment.id);
  const { pickSendingProfile } = await import("@/lib/outreach/profiles");
  const pick = await pickSendingProfile("email_domain");
  const sendFrom = pick?.profile?.fromAddress ?? defaultFromAddress();
  const sendKey = resolveProfileApiKey(pick?.profile ?? null);
  if (!sendKey || !sendFrom) {
    return {
      sent: false,
      queued: false,
      usedCalendar: availability.fromCalendar,
      channel: "email",
    };
  }

  const footer = emailFooter({
    senderName: process.env.OUTREACH_SENDER_NAME ?? "Alejandro O Delgado",
    senderTitle: process.env.OUTREACH_SENDER_TITLE ?? "Head of Client Services",
    firm: process.env.OUTREACH_SENDER_FIRM ?? "Villatoro Executive Search",
    phone: process.env.OUTREACH_SENDER_PHONE ?? null,
    physicalAddress: settings.physicalAddress,
  });

  const result = await sendOutreachEmail({
    apiKey: sendKey,
    from: sendFrom,
    to: enrollment.emailAddress!,
    replyTo: settings.replyToAddress,
    subject: previous?.subject
      ? `Re: ${previous.subject.replace(/^re:\s*/i, "")}`
      : "Re: your reply",
    textBody: `${body}\n${footer}`,
    inReplyTo: previous?.messageId ?? null,
  });

  if (result.ok) {
    await db.insert(outreachMessages).values({
      enrollmentId: enrollment.id,
      stepKind: replyKind,
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
      actor: `rule:${replyKind}`,
      payload: {
        auto_reply: true,
        reply_kind: replyKind,
        channel: "email",
        threaded_to: previous?.messageId ?? null,
        from_calendar: availability.fromCalendar,
        scheduling_link: Boolean(schedulingLink),
      },
    });
  }
  return {
    sent: result.ok,
    queued: false,
    usedCalendar: availability.fromCalendar,
    channel: "email",
  };
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
      const replyKind = replyKindForIntent(intent) ?? "reply_positive";
      // Queue/send the channel-matched reply BEFORE flipping enrollment
      // status — iMessage worker only dequeues active-ish enrollments.
      const reply = await sendThreadedAutoReply({
        enrollment,
        inbound,
        replyKind,
        includeSchedulingLink: true,
      });
      await setEnrollmentStatus(enrollment, "replied_positive", actor, "positive reply");
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
          auto_reply_queued: reply.queued,
          reply_channel: reply.channel,
          reply_kind: replyKind,
          used_calendar: reply.usedCalendar,
          siblings_cancelled: cancelled,
          company_status: "meeting",
        },
      });
      const replyState = reply.sent
        ? "sent"
        : reply.queued
          ? "queued SMS"
          : "FAILED — manual";
      return {
        intent,
        actionTaken: `stopped; ${replyKind} via ${reply.channel} (${replyState}); ${cancelled} sibling(s) cancelled; company → meeting`,
      };
    }

    case "info_request": {
      await stopPendingSteps(enrollment.id, actor);
      const replyKind = replyKindForIntent(intent) ?? "reply_info_request";
      const reply = await sendThreadedAutoReply({
        enrollment,
        inbound,
        replyKind,
      });
      await setEnrollmentStatus(
        enrollment,
        "waiting_on_manual",
        actor,
        "info request — ack sent, hand-off for substantive answer",
      );
      await notifyReply({ ...base, intent, createFollowUpTask: true });
      await logEnrollmentEvent({
        enrollmentId: enrollment.id,
        eventType: "rule_action",
        actor,
        payload: {
          hand_off: true,
          auto_reply_sent: reply.sent,
          auto_reply_queued: reply.queued,
          reply_channel: reply.channel,
          reply_kind: replyKind,
          quoted_ask: snippet,
        },
      });
      const replyState = reply.sent
        ? "sent"
        : reply.queued
          ? "queued SMS"
          : "FAILED";
      return {
        intent,
        actionTaken: `${replyKind} via ${reply.channel} (${replyState}); stopped automation; handed off with quoted ask`,
      };
    }

    case "negative": {
      await stopPendingSteps(enrollment.id, actor);
      const replyKind = replyKindForIntent(intent) ?? "reply_decline";
      const reply = await sendThreadedAutoReply({
        enrollment,
        inbound,
        replyKind,
      });
      await setEnrollmentStatus(enrollment, "replied_negative", actor, "negative");
      await addSuppression({
        email: enrollment.emailAddress,
        phone: enrollment.phoneNumber,
        channel: "all",
        reason: "negative reply",
        legalBasis: "recipient request",
        contactId: enrollment.contactId,
      });
      await notifyReply({ ...base, intent, createFollowUpTask: false });
      await logEnrollmentEvent({
        enrollmentId: enrollment.id,
        eventType: "rule_action",
        actor,
        payload: {
          auto_reply_sent: reply.sent,
          auto_reply_queued: reply.queued,
          reply_channel: reply.channel,
          reply_kind: replyKind,
          suppressed_contact: enrollment.contactId,
          colleagues_unaffected: true,
        },
      });
      const replyState = reply.sent
        ? "sent"
        : reply.queued
          ? "queued SMS"
          : "FAILED";
      return {
        intent,
        actionTaken: `${replyKind} via ${reply.channel} (${replyState}); contact suppressed (colleagues continue)`,
      };
    }

    case "opt_out": {
      await stopPendingSteps(enrollment.id, actor);
      await setEnrollmentStatus(enrollment, "suppressed", actor, "opt_out");
      // Permanently suppress THAT contact only (email + phone); colleagues continue.
      // No auto-reply email on opt-out / STOP.
      await addSuppression({
        email: enrollment.emailAddress,
        phone: enrollment.phoneNumber,
        channel: "all",
        reason: "opt-out reply",
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
      return { intent, actionTaken: "stopped + contact suppressed (colleagues continue); no reply email" };
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
      // Flag company for re-enrichment via Call List notes + activity.
      const { recordCallListOutreachEvent } = await import(
        "@/lib/outreach/call-list-sync"
      );
      await recordCallListOutreachEvent({
        companyId: enrollment.companyId,
        contactId: enrollment.contactId,
        callStatus: "bad_contact",
        summary: `Outreach: wrong person — re-enrich for the right contact. Reply: ${snippet.slice(0, 200)}`,
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
      const state = { ...(enrollment.nodeState ?? {}) };
      const softCount = Number(state.soft_bounce_count ?? 0) + 1;
      state.soft_bounce_count = softCount;
      if (softCount >= 3) {
        await stopPendingSteps(enrollment.id, actor);
        await db
          .update(sequenceEnrollments)
          .set({
            status: "paused",
            nodeState: state,
            stopReason: "repeated soft bounces",
            nextStepAt: null,
            updatedAt: new Date(),
          })
          .where(eq(sequenceEnrollments.id, enrollment.id));
        await logEnrollmentEvent({
          enrollmentId: enrollment.id,
          eventType: "rule_action",
          actor,
          payload: { soft_bounce_count: softCount, action: "paused" },
        });
        return { intent, actionTaken: "third soft bounce — paused" };
      }
      const pushed = addBusinessDays(new Date(), 1, enrollment.timezone);
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
        payload: { rescheduled_to: pushed.toISOString(), soft_bounce_count: softCount },
      });
      return {
        intent,
        actionTaken: `soft bounce — backoff +1 business day (${softCount}/3)`,
      };
    }

    case "complaint": {
      await stopPendingSteps(enrollment.id, actor);
      await setEnrollmentStatus(enrollment, "suppressed", actor, "spam complaint");
      await addSuppression({
        email: enrollment.emailAddress,
        channel: "email",
        reason: "spam complaint",
        legalBasis: "recipient spam complaint",
        contactId: enrollment.contactId,
      });
      await notifyReply({ ...base, intent, createFollowUpTask: false });
      await logEnrollmentEvent({
        enrollmentId: enrollment.id,
        eventType: "rule_action",
        actor,
        payload: { suppressed_contact: enrollment.contactId, reason: "spam complaint" },
      });
      return {
        intent,
        actionTaken: "spam complaint — stopped + email suppressed; no reply email",
      };
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
        payload: { action: "paused_for_review", original_intent: intent },
      });
      return { intent: "unknown", actionTaken: "paused + notified" };
    }
  }
}
