import { and, desc, eq, gte } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { CONTACTOUT_LOCK_MS } from "@/lib/contactout-credits";
import { db } from "@/lib/db";
import { providerUsageEvents } from "@/lib/db/schema";
import {
  dailyUsage,
  paidEgressEnabled,
  providerDailyCap,
} from "@/lib/paid-egress";
import { getOrCreateSettings } from "@/lib/pipeline-config";
import { businessDayStartUtc } from "@/lib/timezone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only ContactOut diagnostics — spends no credits and makes no provider
 * calls. Answers "is ContactOut actually working?" from the audit trail
 * instead of inferring it from empty enrichment results.
 */
export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.CONTACTOUT_API_KEY ?? "";
  const cap = providerDailyCap("contactout");
  const usedToday = await dailyUsage("contactout");
  const settings = await getOrCreateSettings();

  const exhaustedAt = settings.contactoutCreditsExhaustedAt;
  const lockExpiresAt = exhaustedAt
    ? new Date(exhaustedAt.getTime() + CONTACTOUT_LOCK_MS)
    : null;
  const locked = Boolean(lockExpiresAt && lockExpiresAt.getTime() > Date.now());

  const since = businessDayStartUtc();
  const events = await db
    .select()
    .from(providerUsageEvents)
    .where(
      and(
        eq(providerUsageEvents.provider, "contactout"),
        gte(providerUsageEvents.createdAt, since),
      ),
    )
    .orderBy(desc(providerUsageEvents.createdAt))
    .limit(200);

  const failures: Record<string, number> = {};
  let succeeded = 0;
  let phoneLookups = 0;
  for (const event of events) {
    if (!event.blocked) {
      succeeded += 1;
      const params = (event.metadata?.params ?? {}) as Record<string, unknown>;
      if (params.include_phone === "true") phoneLookups += 1;
      continue;
    }
    const reason = String(event.metadata?.reason ?? "unknown");
    failures[reason] = (failures[reason] ?? 0) + 1;
  }

  const problems: string[] = [];
  if (!apiKey) problems.push("CONTACTOUT_API_KEY is not set");
  if (!paidEgressEnabled("contactout")) {
    problems.push(
      "ContactOut paid egress is disabled — check PAID_EGRESS_ENABLED / CONTACTOUT_EGRESS_ENABLED / CONTACTOUT_PAID_EGRESS_ENABLED",
    );
  }
  if (locked) {
    problems.push(
      `ContactOut is credit-locked until ${lockExpiresAt!.toISOString()} — a sample/placeholder response was seen`,
    );
  }
  if (usedToday >= cap) {
    problems.push(
      `Daily safety cap reached — ${usedToday}/${cap} estimated credits since midnight ET. Raise CONTACTOUT_DAILY_CREDIT_CAP.`,
    );
  }
  if (failures.auth) problems.push(`${failures.auth} auth failure(s) today — the API key was rejected`);
  if (failures.out_of_credits) {
    problems.push(`${failures.out_of_credits} out-of-credit response(s) today`);
  }
  if (failures.rate_limited) {
    problems.push(`${failures.rate_limited} rate-limited response(s) today`);
  }
  if (succeeded > 0 && phoneLookups === 0) {
    problems.push(
      `${succeeded} ContactOut call(s) today but zero phone lookups — reveals are being sent as email-only, so no phone was ever requested`,
    );
  }

  return NextResponse.json({
    ok: problems.length === 0,
    api_key_configured: Boolean(apiKey),
    paid_egress_enabled: paidEgressEnabled("contactout"),
    daily_cap: cap,
    used_today: usedToday,
    remaining_today: Math.max(0, cap - usedToday),
    credit_locked: locked,
    credit_lock_expires_at: locked ? lockExpiresAt : null,
    since: since.toISOString(),
    calls_succeeded_today: succeeded,
    phone_lookups_today: phoneLookups,
    failures_today: failures,
    problems,
    recent_events: events.slice(0, 25).map((e) => ({
      at: e.createdAt,
      endpoint: e.endpoint,
      context: e.egressContext,
      blocked: e.blocked,
      estimated_cost: e.estimatedCost,
      reason: e.metadata?.reason ?? null,
      status: e.metadata?.status ?? null,
    })),
  });
}
