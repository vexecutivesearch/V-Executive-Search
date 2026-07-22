import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  contacts,
  inboundMessages,
  outreachMessages,
  sequenceEnrollments,
  type OutreachChannel,
} from "@/lib/db/schema";
import { classifyInbound } from "@/lib/outreach/classify";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { applyReplyRules } from "@/lib/outreach/rules";
import { bumpProfileCounters } from "@/lib/outreach/profiles";
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

/** Find the live enrollment for a reply, by threading id or address. */
async function matchEnrollment(options: {
  channel: OutreachChannel;
  fromAddress?: string | null;
  inReplyTo?: string | null;
}): Promise<{ enrollmentId: string | null; contactId: string | null }> {
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
        .select({ id: sequenceEnrollments.id, contactId: sequenceEnrollments.contactId })
        .from(sequenceEnrollments)
        .where(eq(sequenceEnrollments.id, message.enrollmentId))
        .limit(1);
      if (enrollment) return { enrollmentId: enrollment.id, contactId: enrollment.contactId };
    }
  }

  // 2. Address match against enrollments (latest first).
  if (options.channel === "email") {
    const email = normalizeEmail(options.fromAddress);
    if (email) {
      const rows = await db
        .select({ id: sequenceEnrollments.id, contactId: sequenceEnrollments.contactId })
        .from(sequenceEnrollments)
        .where(eq(sequenceEnrollments.emailAddress, email))
        .orderBy(desc(sequenceEnrollments.enrolledAt))
        .limit(1);
      if (rows[0]) return { enrollmentId: rows[0].id, contactId: rows[0].contactId };
      // Fallback: any contact with this email (reply from a different alias).
      const [contact] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          or(
            eq(contacts.email, email),
            eq(contacts.workEmail, email),
            eq(contacts.personalEmail, email),
          ),
        )
        .limit(1);
      if (contact) {
        const [enrollment] = await db
          .select({ id: sequenceEnrollments.id, contactId: sequenceEnrollments.contactId })
          .from(sequenceEnrollments)
          .where(eq(sequenceEnrollments.contactId, contact.id))
          .orderBy(desc(sequenceEnrollments.enrolledAt))
          .limit(1);
        if (enrollment) return { enrollmentId: enrollment.id, contactId: enrollment.contactId };
        return { enrollmentId: null, contactId: contact.id };
      }
    }
  } else {
    const phone = normalizePhone(options.fromAddress);
    if (phone) {
      const rows = await db
        .select({
          id: sequenceEnrollments.id,
          contactId: sequenceEnrollments.contactId,
          phoneNumber: sequenceEnrollments.phoneNumber,
        })
        .from(sequenceEnrollments)
        .orderBy(desc(sequenceEnrollments.enrolledAt));
      const match = rows.find((r) => normalizePhone(r.phoneNumber) === phone);
      if (match) return { enrollmentId: match.id, contactId: match.contactId };
    }
  }
  return { enrollmentId: null, contactId: null };
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

  const { enrollmentId, contactId } = await matchEnrollment(options);

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
      receivedAt: options.receivedAt ?? new Date(),
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
    await db
      .update(inboundMessages)
      .set({ actionTaken: "no matching enrollment — logged only" })
      .where(eq(inboundMessages.id, row.id));
    return {
      id: row.id,
      duplicate: false,
      matched: false,
      intent: classification.intent,
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

  // Template performance counters.
  try {
    const sentMessages = await db
      .select({ templateId: outreachMessages.templateId })
      .from(outreachMessages)
      .where(
        and(
          eq(outreachMessages.enrollmentId, enrollmentId),
          eq(outreachMessages.status, "sent"),
          inArray(outreachMessages.channel, ["email", "imessage"]),
        ),
      );
    const templateIds = [...new Set(sentMessages.map((m) => m.templateId).filter(Boolean))] as string[];
    if (templateIds.length && !["ooo", "bounce_hard", "bounce_soft"].includes(classification.intent)) {
      const { outreachTemplates } = await import("@/lib/db/schema");
      const { sql } = await import("drizzle-orm");
      await db
        .update(outreachTemplates)
        .set({
          timesReplied: sql`${outreachTemplates.timesReplied} + 1`,
          ...(classification.intent.startsWith("positive")
            ? { timesPositive: sql`${outreachTemplates.timesPositive} + 1` }
            : {}),
          ...(classification.intent === "opt_out"
            ? { timesOptOut: sql`${outreachTemplates.timesOptOut} + 1` }
            : {}),
          updatedAt: new Date(),
        })
        .where(inArray(outreachTemplates.id, templateIds));
    }
  } catch (error) {
    console.error("[outreach] template counter update failed", error);
  }

  return {
    id: row.id,
    duplicate: false,
    matched: true,
    intent: classification.intent,
    actionTaken: outcome.actionTaken,
  };
}
