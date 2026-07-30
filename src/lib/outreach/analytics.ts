import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  enrollmentEvents,
  inboundMessages,
  outreachMessages,
  outreachTemplates,
  sendingProfiles,
  sequenceEnrollments,
} from "@/lib/db/schema";
import { profileHealth } from "@/lib/outreach/profiles";

/**
 * Phase 6 — analytics + ROI. Rollups per template, per branch (A/B split),
 * per profile, per industry/role; outcome attribution ties flows to real
 * conversions; underperformers get auto-flagged for deactivation.
 */

export type TemplateStats = {
  id: string;
  name: string;
  kind: string;
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

/** Auto-flag: enough volume, zero positives, opt-out heavy. */
const FLAG_MIN_SENDS = 30;
const FLAG_MAX_POSITIVE_RATE = 0.0;
const FLAG_MIN_OPTOUT_RATE = 0.05;

export async function templateStats(): Promise<TemplateStats[]> {
  const templates = await db.select().from(outreachTemplates);
  const sendCounts = await db
    .select({ templateId: outreachMessages.templateId, count: sql<number>`count(*)` })
    .from(outreachMessages)
    .where(and(eq(outreachMessages.status, "sent"), isNotNull(outreachMessages.templateId)))
    .groupBy(outreachMessages.templateId);
  const sends = new Map(sendCounts.map((r) => [r.templateId, Number(r.count)]));

  return templates.map((t) => {
    const sent = sends.get(t.id) ?? t.timesUsed;
    return {
      id: t.id,
      name: t.name,
      kind: t.kind,
      isActive: t.isActive,
      sends: sent,
      replies: t.timesReplied,
      positives: t.timesPositive,
      optOuts: t.timesOptOut,
      replyRate: sent > 0 ? t.timesReplied / sent : null,
      positiveRate: sent > 0 ? t.timesPositive / sent : null,
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
