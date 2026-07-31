import { and, desc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  contacts,
  inboundMessages,
  outreachMessages,
  sequenceEnrollments,
  type OutreachChannel,
} from "@/lib/db/schema";
import {
  applyCalendlyBooking,
  type ParsedCalendlyBooking,
} from "@/lib/outreach/calendly-booking";
import {
  isCalendlyNotificationAddress,
  parseCalendlyNotificationEmail,
} from "@/lib/outreach/calendly-email";
import { classifyInbound } from "@/lib/outreach/classify";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { applyReplyRules } from "@/lib/outreach/rules";
import { bumpProfileCounters } from "@/lib/outreach/profiles";
import { recomputeTemplateCounters } from "@/lib/outreach/template-counters";
import { normalizeEmail, normalizePhone } from "@/lib/outreach/suppression";

/**
 * Channel-agnostic inbound ingest: IMAP poll (worker), chat.db scan (worker),
 * and Resend webhooks all converge here — one table, one classifier, one
 * rule engine. Dedupe on external_id so re-polls are idempotent.
 */

export type InboundIngestResult = {
  id: string | null;
  duplicate: boolean;
  matched: boolean;
  intent?: string;
  actionTaken?: string;
};

/**
 * Enrollments that have been deliberately retired and must not absorb a reply.
 *
 * Retired test enrollments used to keep answering for a number long after it was
 * released: a note the operator texted themselves landed on a stopped v4
 * enrollment, was classified, and flipped it back to paused. `replied_positive`
 * and `completed` stay eligible on purpose, because a follow-up on a thread we
 * already answered is exactly the reply we most want to catch.
 */
const RETIRED_ENROLLMENT_STATUSES = ["stopped", "suppressed"] as const;

/**
 * Slack for clock skew between the Mac's chat.db timestamps and our sent_at.
 * A genuine reply cannot predate the message it answers, but the two clocks are
 * not the same clock.
 */
const REPLY_CLOCK_SKEW_GRACE_MS = 5 * 60_000;

/**
 * Did we actually send this enrollment something before the reply arrived?
 *
 * Nothing else establishes that an inbound is a *reply*. Without this, a first
 * chat.db scan that starts from rowid 0 hands over the whole local message
 * history for a watched number and every line of it scores as an answer to
 * outreach that had not been sent yet.
 */
async function hasOutboundBefore(
  enrollmentId: string,
  receivedAt: Date,
): Promise<boolean> {
  const [row] = await db
    .select({ id: outreachMessages.id })
    .from(outreachMessages)
    .where(
      and(
        eq(outreachMessages.enrollmentId, enrollmentId),
        eq(outreachMessages.status, "sent"),
        isNotNull(outreachMessages.sentAt),
        lte(
          outreachMessages.sentAt,
          new Date(receivedAt.getTime() + REPLY_CLOCK_SKEW_GRACE_MS),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

type EnrollmentMatch = {
  enrollmentId: string | null;
  contactId: string | null;
  /** Set when a candidate was found but refused, for the audit trail. */
  refusedReason: string | null;
};

/**
 * Is this candidate allowed to own the reply? Keeps the contact attribution
 * either way so the row still shows under the right person in the CRM.
 */
async function admitEnrollment(
  candidate: { id: string; status: string; contactId: string },
  receivedAt: Date,
): Promise<EnrollmentMatch> {
  if (
    (RETIRED_ENROLLMENT_STATUSES as readonly string[]).includes(
      candidate.status,
    )
  ) {
    return {
      enrollmentId: null,
      contactId: candidate.contactId,
      refusedReason: `newest matching enrollment is ${candidate.status}`,
    };
  }
  if (!(await hasOutboundBefore(candidate.id, receivedAt))) {
    return {
      enrollmentId: null,
      contactId: candidate.contactId,
      refusedReason: "predates anything we sent on that enrollment",
    };
  }
  return {
    enrollmentId: candidate.id,
    contactId: candidate.contactId,
    refusedReason: null,
  };
}

/** Find the live enrollment for a reply, by threading id or address. */
async function matchEnrollment(options: {
  channel: OutreachChannel;
  fromAddress?: string | null;
  inReplyTo?: string | null;
  receivedAt: Date;
}): Promise<EnrollmentMatch> {
  const unmatched: EnrollmentMatch = {
    enrollmentId: null,
    contactId: null,
    refusedReason: null,
  };

  // 1. Threading header wins — exact message match.
  if (options.inReplyTo) {
    const [message] = await db
      .select({
        enrollmentId: outreachMessages.enrollmentId,
      })
      .from(outreachMessages)
      .where(eq(outreachMessages.messageId, options.inReplyTo))
      .limit(1);
    if (message) {
      const [enrollment] = await db
        .select({
          id: sequenceEnrollments.id,
          contactId: sequenceEnrollments.contactId,
          status: sequenceEnrollments.status,
        })
        .from(sequenceEnrollments)
        .where(eq(sequenceEnrollments.id, message.enrollmentId))
        .limit(1);
      if (enrollment) return admitEnrollment(enrollment, options.receivedAt);
    }
  }

  // 2. Address match against enrollments (latest first).
  if (options.channel === "email") {
    const email = normalizeEmail(options.fromAddress);
    if (email) {
      // normalizeEmail lowercases, stored addresses keep whatever case they were
      // seeded with, and an exact comparison silently loses the match — which is
      // how two positive replies from Aminoogian@gmail.com came back "no
      // matching enrollment". Compare case-insensitively at both ends.
      const rows = await db
        .select({
          id: sequenceEnrollments.id,
          contactId: sequenceEnrollments.contactId,
          status: sequenceEnrollments.status,
        })
        .from(sequenceEnrollments)
        .where(sql`lower(${sequenceEnrollments.emailAddress}) = ${email}`)
        .orderBy(desc(sequenceEnrollments.enrolledAt))
        .limit(1);
      if (rows[0]) return admitEnrollment(rows[0], options.receivedAt);
      // Fallback: any contact with this email (reply from a different alias).
      const [contact] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          or(
            sql`lower(${contacts.email}) = ${email}`,
            sql`lower(${contacts.workEmail}) = ${email}`,
            sql`lower(${contacts.personalEmail}) = ${email}`,
          ),
        )
        .limit(1);
      if (contact) {
        const [enrollment] = await db
          .select({
            id: sequenceEnrollments.id,
            contactId: sequenceEnrollments.contactId,
            status: sequenceEnrollments.status,
          })
          .from(sequenceEnrollments)
          .where(eq(sequenceEnrollments.contactId, contact.id))
          .orderBy(desc(sequenceEnrollments.enrolledAt))
          .limit(1);
        if (enrollment) return admitEnrollment(enrollment, options.receivedAt);
        return { ...unmatched, contactId: contact.id };
      }
    }
  } else {
    const phone = normalizePhone(options.fromAddress);
    if (phone) {
      const rows = await db
        .select({
          id: sequenceEnrollments.id,
          contactId: sequenceEnrollments.contactId,
          status: sequenceEnrollments.status,
          phoneNumber: sequenceEnrollments.phoneNumber,
        })
        .from(sequenceEnrollments)
        .orderBy(desc(sequenceEnrollments.enrolledAt));
      const match = rows.find((r) => normalizePhone(r.phoneNumber) === phone);
      if (match) return admitEnrollment(match, options.receivedAt);
    }
  }
  return unmatched;
}

/**
 * Free-tier Calendly: IMAP notifications are From Calendly, not the invitee.
 * Parse name+time from subject, match via name/positive cascade, apply Call Booked.
 * Skips LLM so these never show as ooo/unknown / "Not assigned" from From-match.
 */
async function ingestCalendlyNotification(options: {
  fromAddress?: string | null;
  subject?: string | null;
  body: string;
  externalId?: string | null;
  receivedAt?: Date;
}): Promise<InboundIngestResult | null> {
  if (!isCalendlyNotificationAddress(options.fromAddress)) return null;

  const parsed = parseCalendlyNotificationEmail({
    subject: options.subject,
    body: options.body,
  });
  if (!parsed) return null;

  // Marketing / non-event Calendly mail — log and skip LLM (no fake assignment).
  if (parsed.kind === "marketing") {
    const [row] = await db
      .insert(inboundMessages)
      .values({
        enrollmentId: null,
        contactId: null,
        channel: "email",
        fromAddress: options.fromAddress ?? null,
        subject: options.subject ?? null,
        rawBody: options.body,
        externalId: options.externalId ?? null,
        receivedAt: options.receivedAt ?? new Date(),
        classifiedIntent: "courtesy",
        confidence: 1,
        actionTaken: "Calendly marketing — ignored",
      })
      .onConflictDoNothing({ target: inboundMessages.externalId })
      .returning();
    if (!row) return { id: null, duplicate: true, matched: false };
    return {
      id: row.id,
      duplicate: false,
      matched: false,
      intent: "courtesy",
      actionTaken: "Calendly marketing — ignored",
    };
  }

  const booking: ParsedCalendlyBooking = {
    event:
      parsed.kind === "created" ? "invitee.created" : "invitee.canceled",
    // Never use Calendly's From address as invitee email.
    email: null,
    name: parsed.inviteeName,
    phone: null,
    timezone: "America/New_York",
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    scheduledEventUri: null,
    inviteeUri: null,
    cancelUrl: null,
    rawPayload: {
      source: "imap_email",
      subject: parsed.rawSubject,
      invitee_name: parsed.inviteeName,
      event_title: parsed.eventTitle,
    },
    source: "email",
    notifiedAt: options.receivedAt ?? new Date(),
  };

  const result = await applyCalendlyBooking(booking);

  const timeNote = parsed.startTime
    ? parsed.startTime.toLocaleString("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "time TBD";

  let actionTaken: string;
  if (result.matched && result.contactName) {
    actionTaken = `Calendly booking matched to ${result.contactName}${
      result.matchVia ? ` (${result.matchVia})` : ""
    }`;
  } else {
    actionTaken = `Calendly booking unmatched — ${parsed.inviteeName ?? "unknown"} @ ${timeNote}${
      result.reason ? ` (${result.reason})` : ""
    }; manual review`;
  }

  const [row] = await db
    .insert(inboundMessages)
    .values({
      enrollmentId: result.enrollmentId ?? null,
      contactId: result.contactId ?? null,
      channel: "email",
      fromAddress: options.fromAddress ?? null,
      subject: options.subject ?? null,
      rawBody: options.body,
      externalId: options.externalId ?? null,
      receivedAt: options.receivedAt ?? new Date(),
      classifiedIntent: "positive",
      confidence: 1,
      actionTaken,
    })
    .onConflictDoNothing({ target: inboundMessages.externalId })
    .returning();
  if (!row) return { id: null, duplicate: true, matched: false };

  if (result.enrollmentId) {
    await logEnrollmentEvent({
      enrollmentId: result.enrollmentId,
      eventType: "reply_received",
      actor: "calendly_email",
      payload: {
        inbound_id: row.id,
        channel: "email",
        from: options.fromAddress,
        calendly: true,
        invitee_name: parsed.inviteeName,
        match_via: result.matchVia ?? null,
      },
    });
    await logEnrollmentEvent({
      enrollmentId: result.enrollmentId,
      eventType: "classified",
      actor: "calendly_email",
      payload: {
        inbound_id: row.id,
        intent: "positive",
        confidence: 1,
        via: "calendly_email",
        action: result.action,
      },
    });
  }

  return {
    id: row.id,
    duplicate: false,
    matched: result.matched,
    intent: "positive",
    actionTaken,
  };
}

/**
 * Ingest one inbound message: dedupe → store → classify → rule engine.
 * Bounce webhooks pass a pre-classified intent (no LLM needed).
 */
export async function ingestInboundMessage(options: {
  channel: OutreachChannel;
  fromAddress?: string | null;
  subject?: string | null;
  body: string;
  externalId?: string | null;
  inReplyTo?: string | null;
  receivedAt?: Date;
  preclassifiedIntent?: "bounce_hard" | "bounce_soft" | "complaint";
}): Promise<InboundIngestResult> {
  if (options.externalId) {
    const [existing] = await db
      .select({ id: inboundMessages.id })
      .from(inboundMessages)
      .where(eq(inboundMessages.externalId, options.externalId))
      .limit(1);
    if (existing) return { id: existing.id, duplicate: true, matched: false };
  }

  // Calendly notification emails (free-tier IMAP) — before From-based match/LLM.
  if (options.channel === "email") {
    const calendly = await ingestCalendlyNotification(options);
    if (calendly) return calendly;
  }

  const receivedAt = options.receivedAt ?? new Date();
  const { enrollmentId, contactId, refusedReason } = await matchEnrollment({
    ...options,
    receivedAt,
  });

  const [row] = await db
    .insert(inboundMessages)
    .values({
      enrollmentId,
      contactId,
      channel: options.channel,
      fromAddress: options.fromAddress ?? null,
      subject: options.subject ?? null,
      rawBody: options.body,
      externalId: options.externalId ?? null,
      receivedAt,
    })
    .onConflictDoNothing({ target: inboundMessages.externalId })
    .returning();
  if (!row) return { id: null, duplicate: true, matched: false };

  const classification = options.preclassifiedIntent
    ? { intent: options.preclassifiedIntent, confidence: 1, via: "heuristic" as const }
    : await classifyInbound({
        body: options.body,
        subject: options.subject,
        channel: options.channel === "imessage" ? "imessage" : "email",
      });

  await db
    .update(inboundMessages)
    .set({ classifiedIntent: classification.intent, confidence: classification.confidence })
    .where(eq(inboundMessages.id, row.id));

  await logEnrollmentEvent({
    enrollmentId,
    eventType: "reply_received",
    payload: {
      inbound_id: row.id,
      channel: options.channel,
      from: options.fromAddress,
    },
  });
  await logEnrollmentEvent({
    enrollmentId,
    eventType: "classified",
    actor: classification.via === "llm" ? "system" : `heuristic`,
    payload: {
      inbound_id: row.id,
      intent: classification.intent,
      confidence: classification.confidence,
      via: classification.via,
    },
  });

  if (!enrollmentId) {
    // Say which of the two it was. "Refused" means we know whose message this is
    // and deliberately did not treat it as a reply, which reads very differently
    // in the Replies tab from never having recognised the sender at all.
    const actionTaken = refusedReason
      ? `not treated as a reply — ${refusedReason}; logged only`
      : "no matching enrollment — logged only";
    await db
      .update(inboundMessages)
      .set({ actionTaken })
      .where(eq(inboundMessages.id, row.id));
    return {
      id: row.id,
      duplicate: false,
      matched: false,
      intent: classification.intent,
      actionTaken,
    };
  }

  const [enrollment] = await db
    .select()
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.id, enrollmentId))
    .limit(1);
  if (!enrollment) {
    return { id: row.id, duplicate: false, matched: false, intent: classification.intent };
  }

  const [stored] = await db
    .select()
    .from(inboundMessages)
    .where(eq(inboundMessages.id, row.id))
    .limit(1);

  const outcome = await applyReplyRules(enrollment, stored, classification.intent);
  await db
    .update(inboundMessages)
    .set({ actionTaken: outcome.actionTaken })
    .where(eq(inboundMessages.id, row.id));

  // Reply-rate health: real replies only (OOO/auto excluded by classifier).
  if (
    !["ooo", "bounce_hard", "bounce_soft", "complaint"].includes(classification.intent)
  ) {
    const [lastSent] = await db
      .select({ profileId: outreachMessages.sendingProfileId })
      .from(outreachMessages)
      .where(
        and(
          eq(outreachMessages.enrollmentId, enrollmentId),
          eq(outreachMessages.status, "sent"),
        ),
      )
      .orderBy(desc(outreachMessages.sentAt))
      .limit(1);
    if (lastSent?.profileId) {
      await bumpProfileCounters(lastSent.profileId, {
        totalReplies: 1,
        ...(classification.intent.startsWith("positive") ? { totalPositive: 1 } : {}),
      });
    }
  }

  // Template performance counters. Recomputed from history rather than
  // incremented: re-ingesting a thread must not keep inflating the numbers.
  try {
    await recomputeTemplateCounters();
  } catch (error) {
    console.error("[outreach] template counter recompute failed", error);
  }

  return {
    id: row.id,
    duplicate: false,
    matched: true,
    intent: classification.intent,
    actionTaken: outcome.actionTaken,
  };
}
