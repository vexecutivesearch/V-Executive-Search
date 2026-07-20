import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { providerUsageEvents } from "@/lib/db/schema";

/**
 * SerpApi (Google Jobs) usage accounting — CRM side.
 *
 * The worker's local meter is authoritative for the budget guard; the worker
 * also posts one usage event per Google query here (provider_usage_events,
 * provider="serpapi"). This module sums those events for the current billing
 * period so the pipeline config can hand the worker a CRM-side count — the
 * worker then takes max(local, CRM), which can only ever OVER-count (fail
 * safe: skip Google early), never blind-overspend.
 *
 * Never scrape SerpApi's dashboard; we count our own calls.
 */

export type SerpapiPlanConfig = {
  monthlyPlan: number;
  budgetPct: number;
  renewalDay: number;
  runCap: number;
  pageMinYield: number;
  maxPages: number;
  maxPagesCold: number;
  coldMarketDays: number;
  adaptiveEnabled: boolean;
  adaptiveEmptyRuns: number;
  adaptiveIntervalDays: number;
};

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFloat(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Every knob config-driven (env on Vercel; worker env can still override). */
export function serpapiPlanConfig(): SerpapiPlanConfig {
  return {
    monthlyPlan: envInt("SERPAPI_MONTHLY_PLAN", 15000),
    budgetPct: envFloat("SERPAPI_BUDGET_PCT", 0.8),
    renewalDay: envInt("SERPAPI_RENEWAL_DAY", 11),
    runCap: envInt("SERPAPI_RUN_CAP", 200),
    pageMinYield: envFloat("GOOGLE_PAGE_MIN_YIELD", 0.3),
    maxPages: envInt("GOOGLE_MAX_PAGES", 5),
    maxPagesCold: envInt("GOOGLE_MAX_PAGES_COLD", 10),
    coldMarketDays: envInt("GOOGLE_COLD_MARKET_DAYS", 7),
    adaptiveEnabled: process.env.GOOGLE_ADAPTIVE_ENABLED !== "false",
    adaptiveEmptyRuns: envInt("GOOGLE_ADAPTIVE_EMPTY_RUNS", 3),
    adaptiveIntervalDays: envInt("GOOGLE_ADAPTIVE_INTERVAL_DAYS", 2),
  };
}

/** Start of the current SerpApi billing period (plan renews on renewalDay). */
export function serpapiPeriodStart(renewalDay: number, now = new Date()): Date {
  const day = Math.min(28, Math.max(1, Math.trunc(renewalDay)));
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (now.getUTCDate() >= day) {
    return new Date(Date.UTC(year, month, day));
  }
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Month-to-date SerpApi searches from worker-posted usage events.
 * Failed searches count too — SerpApi bills the attempt.
 */
export async function serpapiMonthToDate(
  renewalDay: number,
  now = new Date(),
): Promise<number> {
  const periodStart = serpapiPeriodStart(renewalDay, now);
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${providerUsageEvents.estimatedCost}), 0)`,
    })
    .from(providerUsageEvents)
    .where(
      and(
        eq(providerUsageEvents.provider, "serpapi"),
        gte(providerUsageEvents.createdAt, periodStart),
      ),
    );
  return Number(row?.total ?? 0);
}
