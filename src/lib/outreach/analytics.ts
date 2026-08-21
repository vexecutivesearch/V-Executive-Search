import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  callOutcomes,
  companies,
  consentRecords,
  enrollmentEvents,
  inboundMessages,
  optInLinkSends,
  outreachMessages,
  outreachTemplates,
  sendingProfiles,
  sequenceEnrollments,
  type CallOutcomeKind,
  type ConsentSource,
  type LeadSource,
} from "@/lib/db/schema";
import { summarizeCallOutcomes, type CallFunnel } from "@/lib/call-outcomes";
import { LEAD_SOURCES, normalizeLeadSource } from "@/lib/lead-lanes";
import { profileHealth } from "@/lib/outreach/profiles";
import { computeTemplateCounters, rate } from "@/lib/outreach/template-counters";

/**
 * Phase 6 — analytics + ROI. Rollups per template, per branch (A/B split),
 * per profile, per industry/role; outcome attribution ties flows to real
 * conversions; underperformers get auto-flagged for deactivation.
 */

export type TemplateStats = {
  id: string;
  name: string;
  kind: string;
  channel: string;
  isProven: boolean;
  isActive: boolean;
  sends: number;
  replies: number;
  positives: number;
  optOuts: number;
  replyRate: number | null;
  positiveRate: number | null;
  flagged: boolean;
  flagReason: string | null;
};

export type ProfileStats = {
  id: string;
  label: string;
  status: string;
  rootDomain: string | null;
  dailyLimit: number;
  sent: number;
  delivered: number;
  bounced: number;
  complaints: number;
  replies: number;
  positives: number;
  health: number;
};

export type BranchStats = {
  flowVersionId: string;
  splitNode: string;
  branch: string;
  enrollments: number;
  positives: number;
  outcomes: number;
};

export type OutcomeStats = {
  flowVersionId: string | null;
  outcome: string;
  count: number;
};

export type IndustryStats = {
  industry: string;
  enrollments: number;
  replies: number;
  positives: number;
};

export type CallStats = CallFunnel & {
  /** Companies dialed at least once — the reach, as opposed to the attempts. */
  companiesCalled: number;
  optInLinksSent: number;
  optInLinkFailures: number;
  /** Companies that were sent a link and then submitted the form. */
  optInConversions: number;
  /** optInConversions / companies sent a link, or null with no sends. */
  optInConversionRate: number | null;
};

export type ConsentSourceStats = {
  source: ConsentSource;
  captured: number;
  revoked: number;
  /** Records whose scope includes SMS and that are still live. */
  liveSms: number;
};

export type LaneStats = {
  leadSource: LeadSource;
  companies: number;
  enrollments: number;
  replies: number;
  positives: number;
  meetings: number;
  callsPlaced: number;
  connects: number;
  optInLinksSent: number;
  consentRecords: number;
  replyRate: number | null;
  bookingRate: number | null;
  connectRate: number | null;
};

/** Auto-flag: enough volume, zero positives, opt-out heavy. */
const FLAG_MIN_SENDS = 30;
const FLAG_MAX_POSITIVE_RATE = 0.0;
const FLAG_MIN_OPTOUT_RATE = 0.05;

/**
 * Sends, replies and positives all come from the same attribution pass over
 * message history, so the numerator can never outrun the denominator. The
 * stored times_* columns are a cache of exactly this and are not read here.
 */
export async function templateStats(): Promise<TemplateStats[]> {
  const templates = await db.select().from(outreachTemplates);
  const counters = await computeTemplateCounters();

  return templates.map((t) => {
    const counts = counters.get(t.id) ?? {
      sends: 0,
      replies: 0,
      positives: 0,
      optOuts: 0,
    };
    return {
      id: t.id,
      name: t.name,
      kind: t.kind,
      channel: t.channel,
      isProven: t.isProven,
      isActive: t.isActive,
      sends: counts.sends,
      replies: counts.replies,
      positives: counts.positives,
      optOuts: counts.optOuts,
      replyRate: rate(counts.replies, counts.sends),
      positiveRate: rate(counts.positives, counts.sends),
      flagged: Boolean(t.flaggedAt),
      flagReason: t.flagReason,
    };
  });
}

export async function profileStats(): Promise<ProfileStats[]> {
  const rows = await db.select().from(sendingProfiles);
  return rows.map((p) => ({
    id: p.id,
    label: p.label,
    status: p.status,
    rootDomain: p.rootDomain,
    dailyLimit: p.dailyLimit,
    sent: p.totalSent,
    delivered: p.totalDelivered,
    bounced: p.totalBounced,
    complaints: p.totalComplaints,
    replies: p.totalReplies,
    positives: p.totalPositive,
    health: profileHealth(p),
  }));
}

/** Per-branch analytics from split assignments recorded in node_state. */
export async function branchStats(): Promise<BranchStats[]> {
  const enrollments = await db
    .select({
      id: sequenceEnrollments.id,
      flowVersionId: sequenceEnrollments.flowVersionId,
      nodeState: sequenceEnrollments.nodeState,
      status: sequenceEnrollments.status,
    })
    .from(sequenceEnrollments)
    .where(isNotNull(sequenceEnrollments.flowVersionId));

  const outcomes = await db
    .select({ enrollmentId: enrollmentEvents.enrollmentId, count: sql<number>`count(*)` })
    .from(enrollmentEvents)
    .where(eq(enrollmentEvents.eventType, "outcome"))
    .groupBy(enrollmentEvents.enrollmentId);
  const outcomeMap = new Map(outcomes.map((o) => [o.enrollmentId, Number(o.count)]));

  const stats = new Map<string, BranchStats>();
  for (const enrollment of enrollments) {
    const assignments = enrollment.nodeState?.split_assignments ?? {};
    for (const [node, branch] of Object.entries(assignments)) {
      const key = `${enrollment.flowVersionId}|${node}|${branch}`;
      const entry =
        stats.get(key) ??
        ({
          flowVersionId: enrollment.flowVersionId!,
          splitNode: node,
          branch: String(branch),
          enrollments: 0,
          positives: 0,
          outcomes: 0,
        } satisfies BranchStats);
      entry.enrollments += 1;
      if (enrollment.status === "replied_positive") entry.positives += 1;
      entry.outcomes += outcomeMap.get(enrollment.id) ?? 0;
      stats.set(key, entry);
    }
  }
  return [...stats.values()];
}

/** Outcome attribution: outcome events + companies that reached meeting/client
 * after a positive reply, attributed to the flow version that produced them. */
export async function outcomeStats(): Promise<OutcomeStats[]> {
  const events = await db
    .select({
      enrollmentId: enrollmentEvents.enrollmentId,
      payload: enrollmentEvents.payload,
    })
    .from(enrollmentEvents)
    .where(eq(enrollmentEvents.eventType, "outcome"));

  const counts = new Map<string, OutcomeStats>();
  for (const event of events) {
    const payload = (event.payload ?? {}) as { outcome?: string; flow_version_id?: string };
    const outcome = payload.outcome ?? "outcome";
    const key = `${payload.flow_version_id ?? "none"}|${outcome}`;
    const entry =
      counts.get(key) ??
      ({ flowVersionId: payload.flow_version_id ?? null, outcome, count: 0 } satisfies OutcomeStats);
    entry.count += 1;
    counts.set(key, entry);
  }

  // Meeting/client status changes attribute back to the enrollment's flow.
  const meetings = await db
    .select({
      flowVersionId: sequenceEnrollments.flowVersionId,
      count: sql<number>`count(distinct ${sequenceEnrollments.companyId})`,
    })
    .from(sequenceEnrollments)
    .innerJoin(companies, eq(companies.id, sequenceEnrollments.companyId))
    .where(
      and(
        eq(sequenceEnrollments.status, "replied_positive"),
        inArray(companies.status, ["meeting", "client"]),
      ),
    )
    .groupBy(sequenceEnrollments.flowVersionId);
  for (const row of meetings) {
    const key = `${row.flowVersionId ?? "none"}|meeting_booked`;
    const entry =
      counts.get(key) ??
      ({ flowVersionId: row.flowVersionId, outcome: "meeting_booked", count: 0 } satisfies OutcomeStats);
    entry.count += Number(row.count);
    counts.set(key, entry);
  }
  return [...counts.values()];
}

export async function industryStats(): Promise<IndustryStats[]> {
  const rows = await db
    .select({
      industry: companies.industry,
      enrollmentId: sequenceEnrollments.id,
      status: sequenceEnrollments.status,
    })
    .from(sequenceEnrollments)
    .innerJoin(companies, eq(companies.id, sequenceEnrollments.companyId));

  const replied = await db
    .select({ enrollmentId: inboundMessages.enrollmentId })
    .from(inboundMessages)
    .where(
      and(
        isNotNull(inboundMessages.enrollmentId),
        sql`${inboundMessages.classifiedIntent} not in ('ooo','bounce_hard','bounce_soft','complaint')`,
      ),
    );
  const repliedSet = new Set(replied.map((r) => r.enrollmentId));

  const map = new Map<string, IndustryStats>();
  for (const row of rows) {
    const industry = row.industry?.trim() || "Unknown";
    const entry =
      map.get(industry) ??
      ({ industry, enrollments: 0, replies: 0, positives: 0 } satisfies IndustryStats);
    entry.enrollments += 1;
    if (repliedSet.has(row.enrollmentId)) entry.replies += 1;
    if (row.status === "replied_positive") entry.positives += 1;
    map.set(industry, entry);
  }
  return [...map.values()].sort((a, b) => b.enrollments - a.enrollments);
}

/**
 * Is human calling worth doing?
 *
 * The denominator for conversion is companies sent a link, not links sent: a
 * second link to the same company after a follow-up call is one prospect being
 * chased twice, and counting it twice would understate the rate.
 *
 * A conversion is a consent record for that company captured at or after its
 * first link send. The `src=call:<companyId>` tag on the form URL also counts
 * it, which covers the case where the submitted work email resolved to a
 * different company row than the one that was called.
 */
export async function callStats(): Promise<CallStats> {
  const outcomes = await db
    .select({
      companyId: callOutcomes.companyId,
      outcome: callOutcomes.outcome,
    })
    .from(callOutcomes);

  const sends = await db
    .select({
      companyId: optInLinkSends.companyId,
      sentAt: optInLinkSends.sentAt,
      error: optInLinkSends.error,
    })
    .from(optInLinkSends);

  const consents = await db
    .select({
      companyId: consentRecords.companyId,
      capturedAt: consentRecords.capturedAt,
      sourceIdentifier: consentRecords.sourceIdentifier,
    })
    .from(consentRecords);

  const funnel = summarizeCallOutcomes(outcomes);

  const firstSendByCompany = new Map<string, number>();
  let optInLinkFailures = 0;
  for (const send of sends) {
    if (send.error) optInLinkFailures += 1;
    const at = new Date(send.sentAt).getTime();
    const seen = firstSendByCompany.get(send.companyId);
    if (seen == null || at < seen) firstSendByCompany.set(send.companyId, at);
  }

  const taggedCompanies = new Set<string>();
  const consentAfter = new Map<string, number>();
  for (const consent of consents) {
    const tag = consent.sourceIdentifier?.match(/src=call:([0-9a-f-]+)/i)?.[1];
    if (tag) taggedCompanies.add(tag);
    if (!consent.companyId) continue;
    const at = new Date(consent.capturedAt).getTime();
    const seen = consentAfter.get(consent.companyId);
    if (seen == null || at > seen) consentAfter.set(consent.companyId, at);
  }

  let optInConversions = 0;
  for (const [companyId, sentAt] of firstSendByCompany) {
    const captured = consentAfter.get(companyId);
    if (taggedCompanies.has(companyId) || (captured != null && captured >= sentAt)) {
      optInConversions += 1;
    }
  }

  return {
    ...funnel,
    companiesCalled: new Set(outcomes.map((o) => o.companyId)).size,
    optInLinksSent: sends.length,
    optInLinkFailures,
    optInConversions,
    optInConversionRate: rate(optInConversions, firstSendByCompany.size),
  };
}

export async function consentSourceStats(): Promise<ConsentSourceStats[]> {
  const rows = await db
    .select({
      source: consentRecords.source,
      channelScope: consentRecords.channelScope,
      revokedAt: consentRecords.revokedAt,
    })
    .from(consentRecords);

  const map = new Map<ConsentSource, ConsentSourceStats>();
  for (const row of rows) {
    const entry =
      map.get(row.source) ??
      ({
        source: row.source,
        captured: 0,
        revoked: 0,
        liveSms: 0,
      } satisfies ConsentSourceStats);
    entry.captured += 1;
    if (row.revokedAt) entry.revoked += 1;
    else if (row.channelScope === "sms" || row.channelScope === "both") {
      entry.liveSms += 1;
    }
    map.set(row.source, entry);
  }
  return [...map.values()].sort((a, b) => b.captured - a.captured);
}

/**
 * Reply and booking rates split by the lane a lead arrived on, so cold and
 * consented inbound can be compared rather than averaged together.
 */
export async function laneStats(): Promise<LaneStats[]> {
  const companyRows = await db
    .select({ id: companies.id, leadSource: companies.leadSource })
    .from(companies);
  const laneByCompany = new Map(
    companyRows.map((c) => [c.id, normalizeLeadSource(c.leadSource)]),
  );

  const enrollments = await db
    .select({
      id: sequenceEnrollments.id,
      companyId: sequenceEnrollments.companyId,
      status: sequenceEnrollments.status,
    })
    .from(sequenceEnrollments);

  const replied = await db
    .select({ enrollmentId: inboundMessages.enrollmentId })
    .from(inboundMessages)
    .where(
      and(
        isNotNull(inboundMessages.enrollmentId),
        sql`${inboundMessages.classifiedIntent} not in ('ooo','bounce_hard','bounce_soft','complaint')`,
      ),
    );
  const repliedSet = new Set(replied.map((r) => r.enrollmentId));

  const meetings = await db
    .select({ id: companies.id })
    .from(companies)
    .where(inArray(companies.status, ["meeting", "client"]));
  const meetingSet = new Set(meetings.map((m) => m.id));

  const outcomes = await db
    .select({ companyId: callOutcomes.companyId, outcome: callOutcomes.outcome })
    .from(callOutcomes);

  const sends = await db
    .select({ companyId: optInLinkSends.companyId })
    .from(optInLinkSends)
    .where(isNull(optInLinkSends.error));

  const consents = await db
    .select({ companyId: consentRecords.companyId })
    .from(consentRecords)
    .where(isNull(consentRecords.revokedAt));

  const blank = (leadSource: LeadSource): LaneStats => ({
    leadSource,
    companies: 0,
    enrollments: 0,
    replies: 0,
    positives: 0,
    meetings: 0,
    callsPlaced: 0,
    connects: 0,
    optInLinksSent: 0,
    consentRecords: 0,
    replyRate: null,
    bookingRate: null,
    connectRate: null,
  });
  const map = new Map<LeadSource, LaneStats>(
    LEAD_SOURCES.map((lane) => [lane, blank(lane)]),
  );
  const lane = (companyId: string | null): LaneStats | null => {
    if (!companyId) return null;
    const found = laneByCompany.get(companyId);
    return found ? (map.get(found) ?? null) : null;
  };

  for (const company of companyRows) {
    const entry = map.get(normalizeLeadSource(company.leadSource))!;
    entry.companies += 1;
    if (meetingSet.has(company.id)) entry.meetings += 1;
  }
  for (const enrollment of enrollments) {
    const entry = lane(enrollment.companyId);
    if (!entry) continue;
    entry.enrollments += 1;
    if (repliedSet.has(enrollment.id)) entry.replies += 1;
    if (enrollment.status === "replied_positive") entry.positives += 1;
  }
  for (const outcome of outcomes) {
    const entry = lane(outcome.companyId);
    if (!entry) continue;
    entry.callsPlaced += 1;
    if ((outcome.outcome as CallOutcomeKind) === "connected") entry.connects += 1;
  }
  for (const send of sends) {
    const entry = lane(send.companyId);
    if (entry) entry.optInLinksSent += 1;
  }
  for (const consent of consents) {
    const entry = lane(consent.companyId);
    if (entry) entry.consentRecords += 1;
  }

  for (const entry of map.values()) {
    entry.replyRate = rate(entry.replies, entry.enrollments);
    entry.bookingRate = rate(entry.meetings, entry.companies);
    entry.connectRate = rate(entry.connects, entry.callsPlaced);
  }

  return [...map.values()];
}

/** Auto-flag underperforming templates for deactivation (never auto-disable). */
export async function flagUnderperformingTemplates(): Promise<number> {
  const stats = await templateStats();
  let flagged = 0;
  for (const t of stats) {
    if (t.flagged || !t.isActive) continue;
    if (t.sends < FLAG_MIN_SENDS) continue;
    const optOutRate = t.sends > 0 ? t.optOuts / t.sends : 0;
    const shouldFlag =
      (t.positiveRate ?? 0) <= FLAG_MAX_POSITIVE_RATE && optOutRate >= FLAG_MIN_OPTOUT_RATE;
    const noTraction = (t.replyRate ?? 0) === 0 && t.sends >= FLAG_MIN_SENDS * 2;
    if (shouldFlag || noTraction) {
      await db
        .update(outreachTemplates)
        .set({
          flaggedAt: new Date(),
          flagReason: shouldFlag
            ? `${t.sends} sends, 0 positives, ${(optOutRate * 100).toFixed(1)}% opt-out`
            : `${t.sends} sends with zero replies`,
          updatedAt: new Date(),
        })
        .where(eq(outreachTemplates.id, t.id));
      flagged += 1;
    }
  }
  return flagged;
}

export async function overviewCounts(): Promise<{
  enrollments: Record<string, number>;
  messages: Record<string, number>;
  sends: number;
  replies: number;
  positives: number;
  unreadNotifications: number;
}> {
  const enrollmentRows = await db
    .select({ status: sequenceEnrollments.status, count: sql<number>`count(*)` })
    .from(sequenceEnrollments)
    .groupBy(sequenceEnrollments.status);
  const messageRows = await db
    .select({ status: outreachMessages.status, count: sql<number>`count(*)` })
    .from(outreachMessages)
    .groupBy(outreachMessages.status);
  const replies = await db
    .select({ count: sql<number>`count(*)` })
    .from(inboundMessages)
    .where(
      sql`${inboundMessages.classifiedIntent} not in ('ooo','bounce_hard','bounce_soft','complaint') or ${inboundMessages.classifiedIntent} is null`,
    );
  const positives = await db
    .select({ count: sql<number>`count(*)` })
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.status, "replied_positive"));
  const { outreachNotifications } = await import("@/lib/db/schema");
  const unread = await db
    .select({ count: sql<number>`count(*)` })
    .from(outreachNotifications)
    .where(sql`${outreachNotifications.readAt} is null`);

  const enrollments: Record<string, number> = {};
  for (const row of enrollmentRows) enrollments[row.status] = Number(row.count);
  const messages: Record<string, number> = {};
  for (const row of messageRows) messages[row.status] = Number(row.count);

  return {
    enrollments,
    messages,
    sends: messages.sent ?? 0,
    replies: Number(replies[0]?.count ?? 0),
    positives: Number(positives[0]?.count ?? 0),
    unreadNotifications: Number(unread[0]?.count ?? 0),
  };
}
