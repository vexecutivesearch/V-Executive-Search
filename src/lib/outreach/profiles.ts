import { promises as dns } from "node:dns";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  outreachMessages,
  sendingProfiles,
  type SendingProfile,
} from "@/lib/db/schema";

/**
 * Multi-domain rotation. Profiles are polymorphic (email_domain today,
 * imessage_number schema-ready); dispatch asks the pool for capacity,
 * whatever the kind. Flows never reference a specific profile — profile
 * choice lives entirely here, so rotation and flows stay decoupled.
 */

export const RAMP_BASE = 5;
export const RAMP_INCREMENT = 5;
export const RAMP_CEILING = 50;
export const BOUNCE_VIOLATION_RATE = 0.02;
export const COMPLAINT_VIOLATION_RATE = 0.001;
/** Reply-rate weighting phases in only after this many sends. */
export const HEALTH_MIN_SENDS_FOR_REPLY_WEIGHT = 200;
const CLEAN_WEEK_MS = 7 * 86_400_000;
const ACTIVE_AFTER_CLEAN_WEEKS = 4;

export function rampCap(rampStage: number): number {
  return Math.min(RAMP_CEILING, RAMP_BASE + RAMP_INCREMENT * Math.max(0, rampStage));
}

/** Health 0..1 — bounce/complaint dominate early (fast, dense signals);
 * reply rate phases in after the profile has real volume. */
export function profileHealth(profile: {
  totalSent: number;
  totalDelivered: number;
  totalBounced: number;
  totalComplaints: number;
  totalReplies: number;
}): number {
  const sent = Math.max(1, profile.totalSent);
  const bounceRate = profile.totalBounced / sent;
  const complaintRate = profile.totalComplaints / sent;
  const deliveredRate = profile.totalDelivered / sent;

  // Delivered-vs-bounced is the cleanest day-one proxy.
  let health =
    0.6 * Math.max(0, 1 - bounceRate / BOUNCE_VIOLATION_RATE / 2) +
    0.3 * Math.max(0, 1 - complaintRate / COMPLAINT_VIOLATION_RATE / 2) +
    0.1 * Math.min(1, deliveredRate + 0.2);

  if (profile.totalSent >= HEALTH_MIN_SENDS_FOR_REPLY_WEIGHT) {
    // 1–5% reply is healthy; OOO/auto-replies were excluded by the classifier.
    const replyRate = profile.totalReplies / sent;
    const replyScore = Math.min(1, replyRate / 0.03);
    health = health * 0.75 + replyScore * 0.25;
  }
  return Math.max(0, Math.min(1, health));
}

export function hasViolation(profile: {
  totalSent: number;
  totalBounced: number;
  totalComplaints: number;
}): boolean {
  if (profile.totalSent < 20) return false; // too sparse to judge
  const bounceRate = profile.totalBounced / profile.totalSent;
  const complaintRate = profile.totalComplaints / profile.totalSent;
  return bounceRate > BOUNCE_VIOLATION_RATE || complaintRate > COMPLAINT_VIOLATION_RATE;
}

/** Messages already sent today by profile (capacity accounting). */
export async function sentTodayByProfile(): Promise<Map<string, number>> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const rows = await db
    .select({
      profileId: outreachMessages.sendingProfileId,
      count: sql<number>`count(*)`,
    })
    .from(outreachMessages)
    .where(
      and(
        eq(outreachMessages.status, "sent"),
        gte(outreachMessages.sentAt, startOfDay),
      ),
    )
    .groupBy(outreachMessages.sendingProfileId);
  const map = new Map<string, number>();
  for (const row of rows) {
    if (row.profileId) map.set(row.profileId, Number(row.count));
  }
  return map;
}

export type ProfilePick = {
  profile: SendingProfile;
  remaining: number;
};

/**
 * Weighted round-robin on remaining daily capacity, health-weighted once
 * reply data matures. Returns null when the whole pool is exhausted
 * (dispatch defers with capacity_exhausted — no silent drops).
 */
export async function pickSendingProfile(
  kind: "email_domain" | "imessage_number",
  random: () => number = Math.random,
): Promise<ProfilePick | null> {
  const pool = await db
    .select()
    .from(sendingProfiles)
    .where(
      and(
        eq(sendingProfiles.kind, kind),
        inArray(sendingProfiles.status, ["warming", "active", "throttled"]),
      ),
    );
  if (!pool.length) return null;

  const sentToday = await sentTodayByProfile();
  const candidates = pool
    .map((profile) => {
      const cap = Math.min(profile.dailyLimit, rampCap(profile.rampStage));
      const used = sentToday.get(profile.id) ?? 0;
      const remaining = Math.max(0, cap - used);
      return { profile, remaining, health: profileHealth(profile) };
    })
    .filter((c) => c.remaining > 0);
  if (!candidates.length) return null;

  const weights = candidates.map((c) => c.remaining * (0.5 + c.health));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = random() * total;
  for (let i = 0; i < candidates.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

/** Record webhook/send outcomes on the profile counters. */
export async function bumpProfileCounters(
  profileId: string,
  bump: Partial<
    Record<
      "totalSent" | "totalDelivered" | "totalBounced" | "totalComplaints" | "totalReplies" | "totalPositive",
      number
    >
  >,
): Promise<void> {
  const sets: Record<string, unknown> = { updatedAt: new Date() };
  if (bump.totalSent) sets.totalSent = sql`${sendingProfiles.totalSent} + ${bump.totalSent}`;
  if (bump.totalDelivered) sets.totalDelivered = sql`${sendingProfiles.totalDelivered} + ${bump.totalDelivered}`;
  if (bump.totalBounced) sets.totalBounced = sql`${sendingProfiles.totalBounced} + ${bump.totalBounced}`;
  if (bump.totalComplaints) sets.totalComplaints = sql`${sendingProfiles.totalComplaints} + ${bump.totalComplaints}`;
  if (bump.totalReplies) sets.totalReplies = sql`${sendingProfiles.totalReplies} + ${bump.totalReplies}`;
  if (bump.totalPositive) sets.totalPositive = sql`${sendingProfiles.totalPositive} + ${bump.totalPositive}`;
  await db.update(sendingProfiles).set(sets).where(eq(sendingProfiles.id, profileId));
}

/**
 * Warm-up state machine tick (run daily from the dispatch cron):
 *  - violation → throttled, cap rolled back ONE step (not just frozen)
 *  - clean week while throttled → resume warming at the reduced cap
 *  - clean week while warming → +1 ramp step (cap +5 to ceiling)
 *  - 4 clean weeks at ramp → active
 */
export async function tickWarmupStateMachine(now = new Date()): Promise<void> {
  const pool = await db
    .select()
    .from(sendingProfiles)
    .where(inArray(sendingProfiles.status, ["warming", "active", "throttled"]));

  for (const profile of pool) {
    const violated = hasViolation(profile);

    if (violated && profile.status !== "throttled") {
      await db
        .update(sendingProfiles)
        .set({
          status: "throttled",
          rampStage: Math.max(0, profile.rampStage - 1),
          dailyLimit: rampCap(Math.max(0, profile.rampStage - 1)),
          cleanSince: null,
          pausedReason: "bounce/complaint rate violation",
          updatedAt: now,
        })
        .where(eq(sendingProfiles.id, profile.id));
      continue;
    }

    if (!violated && !profile.cleanSince) {
      await db
        .update(sendingProfiles)
        .set({ cleanSince: now, updatedAt: now })
        .where(eq(sendingProfiles.id, profile.id));
      continue;
    }

    const cleanMs = profile.cleanSince ? now.getTime() - profile.cleanSince.getTime() : 0;
    const rampDue =
      !profile.lastRampAt || now.getTime() - profile.lastRampAt.getTime() >= CLEAN_WEEK_MS;

    if (profile.status === "throttled" && cleanMs >= CLEAN_WEEK_MS) {
      await db
        .update(sendingProfiles)
        .set({ status: "warming", pausedReason: null, updatedAt: now })
        .where(eq(sendingProfiles.id, profile.id));
      continue;
    }

    if (profile.status === "warming" && cleanMs >= CLEAN_WEEK_MS && rampDue) {
      const nextStage = profile.rampStage + 1;
      const fourCleanWeeks =
        profile.warmingStartedAt &&
        now.getTime() - profile.warmingStartedAt.getTime() >= ACTIVE_AFTER_CLEAN_WEEKS * CLEAN_WEEK_MS &&
        cleanMs >= ACTIVE_AFTER_CLEAN_WEEKS * CLEAN_WEEK_MS;
      await db
        .update(sendingProfiles)
        .set({
          rampStage: nextStage,
          dailyLimit: rampCap(nextStage),
          lastRampAt: now,
          status: fourCleanWeeks ? "active" : "warming",
          updatedAt: now,
        })
        .where(eq(sendingProfiles.id, profile.id));
    }
  }
}

export type DnsCheckResult = {
  ok: boolean;
  spf: { ok: boolean; detail: string };
  dkim: { ok: boolean; detail: string };
  dmarc: { ok: boolean; detail: string };
  checkedAt: string;
};

async function txtRecords(host: string): Promise<string[]> {
  try {
    const records = await dns.resolveTxt(host);
    return records.map((chunks) => chunks.join(""));
  } catch {
    return [];
  }
}

/**
 * DNS verification gate: SPF + DKIM + DMARC must resolve before a profile
 * can enter warm-up. Unverified profiles cannot send, period.
 */
export async function verifyProfileDns(domain: string): Promise<DnsCheckResult> {
  const spfRecords = await txtRecords(domain);
  const spf = spfRecords.find((r) => r.toLowerCase().startsWith("v=spf1"));
  const spfOk = Boolean(spf && /include:.*amazonses\.com|include:.*resend/i.test(spf));

  const dkimHost = `resend._domainkey.${domain}`;
  const dkimRecords = await txtRecords(dkimHost);
  const dkimOk = dkimRecords.some((r) => r.includes("p="));

  const root = domain.split(".").slice(-2).join(".");
  const dmarcRecords = [
    ...(await txtRecords(`_dmarc.${domain}`)),
    ...(await txtRecords(`_dmarc.${root}`)),
  ];
  const dmarcOk = dmarcRecords.some((r) => r.toLowerCase().startsWith("v=dmarc1"));

  return {
    ok: spfOk && dkimOk && dmarcOk,
    spf: {
      ok: spfOk,
      detail: spf ?? `no v=spf1 TXT on ${domain} (needs include for Resend/SES)`,
    },
    dkim: {
      ok: dkimOk,
      detail: dkimOk ? `${dkimHost} present` : `no DKIM key at ${dkimHost}`,
    },
    dmarc: {
      ok: dmarcOk,
      detail: dmarcOk ? "v=DMARC1 present" : `no _dmarc TXT on ${domain} or ${root}`,
    },
    checkedAt: new Date().toISOString(),
  };
}

/** Records to create, shown in the Admin "add domain" flow. */
export function requiredDnsRecords(domain: string): Array<{
  type: string;
  host: string;
  value: string;
  note: string;
}> {
  return [
    {
      type: "TXT",
      host: domain,
      value: "v=spf1 include:amazonses.com ~all",
      note: "SPF — authorizes Resend (SES) to send for this domain",
    },
    {
      type: "TXT",
      host: `resend._domainkey.${domain}`,
      value: "p=<paste the DKIM public key shown in the Resend dashboard>",
      note: "DKIM — copy the exact record from Resend after adding the domain there",
    },
    {
      type: "TXT",
      host: `_dmarc.${domain}`,
      value: "v=DMARC1; p=none; rua=mailto:dmarc@" + domain,
      note: "DMARC — start at p=none, tighten after clean warm-up",
    },
    {
      type: "MX",
      host: domain,
      value: "feedback-smtp.us-east-1.amazonses.com (priority 10)",
      note: "Only if replies should route through this domain",
    },
  ];
}
