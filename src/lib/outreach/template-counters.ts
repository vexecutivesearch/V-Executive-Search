import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  inboundMessages,
  outreachMessages,
  outreachTemplates,
  type OutreachChannel,
} from "@/lib/db/schema";

/**
 * Template performance counters, derived from message history.
 *
 * These used to be incremented on the inbound path, which made them unbounded:
 * one reply bumped *every* template the enrollment had ever sent with, there
 * was no check that the reply arrived after the send, and each inbound message
 * in a thread counted again. Meanwhile the denominator was counted from
 * outreach_messages. Numerator and denominator measured different things, so
 * reply rate could read 1550%.
 *
 * Everything here derives from history instead, under one attribution rule:
 * an inbound reply belongs to the last message sent before it arrived, and a
 * send can only ever be credited with one reply. Replies are therefore capped
 * by sends by construction, and a recompute is idempotent no matter how many
 * times the same conversation is re-ingested.
 */

/** Automated noise, not a human reply. Complaints count only as opt-outs. */
const NOISE_INTENTS = new Set(["ooo", "bounce_hard", "bounce_soft"]);
const OPT_OUT_INTENTS = new Set(["opt_out", "complaint"]);

export type SentMessageRecord = {
  id: string;
  enrollmentId: string;
  channel: OutreachChannel;
  templateId: string | null;
  sentAt: Date | null;
};

export type InboundRecord = {
  enrollmentId: string | null;
  channel: OutreachChannel;
  receivedAt: Date;
  intent: string | null;
};

export type TemplateCounters = {
  sends: number;
  replies: number;
  positives: number;
  optOuts: number;
};

export function isNoiseIntent(intent: string | null): boolean {
  return intent != null && NOISE_INTENTS.has(intent);
}

export function isPositiveIntent(intent: string | null): boolean {
  return intent != null && intent.startsWith("positive");
}

export function isOptOutIntent(intent: string | null): boolean {
  return intent != null && OPT_OUT_INTENTS.has(intent);
}

/** A complaint is an opt-out but never a reply (see ca6984d). */
export function isReplyIntent(intent: string | null): boolean {
  return !isNoiseIntent(intent) && intent !== "complaint";
}

/**
 * Percentage math for the admin table. Null denominator means "no data yet",
 * which renders as an em dash rather than 0%. The clamp is deliberate belt and
 * braces: a rate above 100% is always a bug, so never render one.
 */
export function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.min(1, Math.max(0, numerator / denominator));
}

/**
 * The send an inbound message is answering: the most recent one that went out
 * before it arrived, preferring the channel it came back on so a reply by text
 * credits the text rather than the email that shipped alongside it.
 */
export function attributeInboundToSend(
  inbound: InboundRecord,
  sends: SentMessageRecord[],
): SentMessageRecord | null {
  if (!inbound.enrollmentId) return null;
  const candidates = sends.filter(
    (s) =>
      s.enrollmentId === inbound.enrollmentId &&
      s.sentAt != null &&
      s.sentAt.getTime() <= inbound.receivedAt.getTime(),
  );
  if (candidates.length === 0) return null;
  const sameChannel = candidates.filter((s) => s.channel === inbound.channel);
  const pool = sameChannel.length > 0 ? sameChannel : candidates;
  return pool.reduce((latest, s) =>
    s.sentAt!.getTime() > latest.sentAt!.getTime() ? s : latest,
  );
}

/**
 * Roll message history up per template. Counts are over *sends*, not inbound
 * messages: a thread with twenty replies still marks its one send as replied.
 */
export function attributeTemplateCounters(
  sends: SentMessageRecord[],
  inbounds: InboundRecord[],
): Map<string, TemplateCounters> {
  const counters = new Map<string, TemplateCounters>();
  const ensure = (templateId: string): TemplateCounters => {
    let entry = counters.get(templateId);
    if (!entry) {
      entry = { sends: 0, replies: 0, positives: 0, optOuts: 0 };
      counters.set(templateId, entry);
    }
    return entry;
  };

  for (const send of sends) {
    if (send.templateId) ensure(send.templateId).sends += 1;
  }

  // Index by enrollment so a busy inbound table does not turn this quadratic.
  const byEnrollment = new Map<string, SentMessageRecord[]>();
  for (const send of sends) {
    const bucket = byEnrollment.get(send.enrollmentId);
    if (bucket) bucket.push(send);
    else byEnrollment.set(send.enrollmentId, [send]);
  }

  const replied = new Set<string>();
  const positive = new Set<string>();
  const optedOut = new Set<string>();
  for (const inbound of inbounds) {
    const candidates = inbound.enrollmentId
      ? (byEnrollment.get(inbound.enrollmentId) ?? [])
      : [];
    const send = attributeInboundToSend(inbound, candidates);
    if (!send?.templateId) continue;
    if (isReplyIntent(inbound.intent)) replied.add(send.id);
    if (isPositiveIntent(inbound.intent)) positive.add(send.id);
    if (isOptOutIntent(inbound.intent)) optedOut.add(send.id);
  }

  const byId = new Map(sends.map((s) => [s.id, s]));
  const credit = (ids: Set<string>, field: keyof TemplateCounters) => {
    for (const id of ids) {
      const templateId = byId.get(id)?.templateId;
      if (templateId) ensure(templateId)[field] += 1;
    }
  };
  credit(replied, "replies");
  credit(positive, "positives");
  credit(optedOut, "optOuts");

  return counters;
}

/** Read history and roll it up. Does not write. */
export async function computeTemplateCounters(): Promise<
  Map<string, TemplateCounters>
> {
  const sends = await db
    .select({
      id: outreachMessages.id,
      enrollmentId: outreachMessages.enrollmentId,
      channel: outreachMessages.channel,
      templateId: outreachMessages.templateId,
      sentAt: outreachMessages.sentAt,
    })
    .from(outreachMessages)
    .where(
      and(
        eq(outreachMessages.status, "sent"),
        isNotNull(outreachMessages.templateId),
        isNotNull(outreachMessages.sentAt),
      ),
    );
  if (sends.length === 0) return new Map();

  // Only enrollments that actually sent something can have attributable
  // replies, which keeps this off the full inbound table.
  const enrollmentIds = [...new Set(sends.map((s) => s.enrollmentId))];
  const inbounds = await db
    .select({
      enrollmentId: inboundMessages.enrollmentId,
      channel: inboundMessages.channel,
      receivedAt: inboundMessages.receivedAt,
      intent: inboundMessages.classifiedIntent,
    })
    .from(inboundMessages)
    .where(inArray(inboundMessages.enrollmentId, enrollmentIds));

  return attributeTemplateCounters(sends, inbounds);
}

/**
 * Recompute every template's stored counters from history. Self healing: safe
 * to run at any time, and running it twice changes nothing the second time.
 */
export async function recomputeTemplateCounters(): Promise<number> {
  const counters = await computeTemplateCounters();
  const templates = await db
    .select({
      id: outreachTemplates.id,
      timesUsed: outreachTemplates.timesUsed,
      timesReplied: outreachTemplates.timesReplied,
      timesPositive: outreachTemplates.timesPositive,
      timesOptOut: outreachTemplates.timesOptOut,
    })
    .from(outreachTemplates);

  let updated = 0;
  for (const template of templates) {
    const next = counters.get(template.id) ?? {
      sends: 0,
      replies: 0,
      positives: 0,
      optOuts: 0,
    };
    if (
      template.timesUsed === next.sends &&
      template.timesReplied === next.replies &&
      template.timesPositive === next.positives &&
      template.timesOptOut === next.optOuts
    ) {
      continue;
    }
    await db
      .update(outreachTemplates)
      .set({
        timesUsed: next.sends,
        timesReplied: next.replies,
        timesPositive: next.positives,
        timesOptOut: next.optOuts,
        updatedAt: new Date(),
      })
      .where(eq(outreachTemplates.id, template.id));
    updated += 1;
  }
  return updated;
}
