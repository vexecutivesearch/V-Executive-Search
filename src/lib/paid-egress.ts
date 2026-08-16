import { and, eq, gte, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { providerUsageEvents } from "@/lib/db/schema";
import { businessDayStartUtc } from "@/lib/timezone";

export type PaidProvider = "apollo" | "contactout";

export type PaidEgressContext =
  | `manual_enrich:${string}`
  | "health_check"
  | "manual_script"
  | "automated_scrape"
  | "scheduled_pipeline";

export type PaidEgressMetadata = {
  companyId?: string | null;
  contactId?: string | null;
  recordsReturned?: number;
  estimatedCost?: number;
  metadata?: Record<string, unknown>;
};

export class PaidEgressBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaidEgressBlockedError";
  }
}

export function manualEnrichContext(companyId: string): PaidEgressContext {
  return `manual_enrich:${companyId}`;
}

export function isManualEnrichContext(
  context: PaidEgressContext | null | undefined,
): context is `manual_enrich:${string}` {
  return Boolean(context?.startsWith("manual_enrich:"));
}

function triggerSource(context: PaidEgressContext): string {
  return context.split(":")[0] || context;
}

function providerEnvPrefix(provider: PaidProvider): string {
  return provider === "apollo" ? "APOLLO" : "CONTACTOUT";
}

function envFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value.trim() === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function paidEgressEnabled(provider: PaidProvider): boolean {
  const prefix = providerEnvPrefix(provider);
  if (!envFlag(process.env.PAID_EGRESS_ENABLED, true)) return false;
  if (!envFlag(process.env[`${prefix}_EGRESS_ENABLED`], true)) return false;
  return envFlag(process.env[`${prefix}_PAID_EGRESS_ENABLED`], true);
}

/**
 * Internal safety cap on estimated credits per business day — a guardrail so
 * a bug can't drain the provider balance. NOT the provider's real balance.
 * ContactOut default follows the credit-governance formula in the playbook:
 * daily enrich quota (25) × contacts per company (3) × credits per contact (2).
 */
export function providerDailyCap(provider: PaidProvider): number {
  const prefix = providerEnvPrefix(provider);
  const raw = process.env[`${prefix}_DAILY_CREDIT_CAP`];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return provider === "apollo" ? 200 : 150;
}

/**
 * Endpoints the provider documents as costing nothing, so they can never
 * consume a credit cap no matter what an older row happened to record.
 *
 * Apollo's People API Search is explicitly "Credit usage: 0 credits"
 * (https://docs.apollo.io/docs/api-pricing). It used to be logged at 1 credit
 * a call, and discovery makes up to four per company, so a normal batch could
 * exhaust a day's budget on calls that were never billed. Excluding the
 * endpoint here — rather than only fixing what new rows record — also
 * discounts the rows already written under the old accounting.
 *
 * ContactOut's people/search is NOT free: it is sent with `reveal_info: true`
 * and bills per revealed profile, so it stays counted.
 */
const ZERO_COST_ENDPOINTS: Record<PaidProvider, readonly string[]> = {
  apollo: ["mixed_people/api_search"],
  contactout: [],
};

export function endpointConsumesCredits(
  provider: PaidProvider,
  endpoint: string,
): boolean {
  return !ZERO_COST_ENDPOINTS[provider].includes(endpoint);
}

export async function dailyUsage(provider: PaidProvider): Promise<number> {
  const free = ZERO_COST_ENDPOINTS[provider];
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${providerUsageEvents.estimatedCost}), 0)`,
    })
    .from(providerUsageEvents)
    .where(
      and(
        eq(providerUsageEvents.provider, provider),
        eq(providerUsageEvents.blocked, false),
        // Business-day window (midnight ET) — a UTC window rolls at 8 PM ET
        // and charges evening usage against the next day's budget.
        gte(providerUsageEvents.createdAt, businessDayStartUtc()),
        ...(free.length
          ? [notInArray(providerUsageEvents.endpoint, [...free])]
          : []),
      ),
    );
  return Number(row?.total ?? 0);
}

export async function recordProviderUsageEvent(
  provider: PaidProvider,
  endpoint: string,
  context: PaidEgressContext,
  details: PaidEgressMetadata & { blocked?: boolean } = {},
): Promise<void> {
  try {
    await db.insert(providerUsageEvents).values({
      provider,
      endpoint,
      egressContext: context,
      triggerSource: triggerSource(context),
      companyId: details.companyId ?? null,
      contactId: details.contactId ?? null,
      recordsReturned: details.recordsReturned ?? 0,
      estimatedCost: details.estimatedCost ?? 0,
      blocked: details.blocked ?? false,
      metadata: details.metadata,
    });
  } catch (err) {
    console.error("Failed to log provider usage event", err);
  }
}

export async function assertPaidEgressAllowed(
  provider: PaidProvider,
  endpoint: string,
  context: PaidEgressContext | null | undefined,
  details: PaidEgressMetadata = {},
): Promise<void> {
  const normalizedContext = context ?? "automated_scrape";
  const estimatedCost = details.estimatedCost ?? 1;

  if (!paidEgressEnabled(provider)) {
    await recordProviderUsageEvent(provider, endpoint, normalizedContext, {
      ...details,
      estimatedCost: 0,
      blocked: true,
      metadata: {
        ...(details.metadata ?? {}),
        reason: "provider_disabled",
      },
    });
    throw new PaidEgressBlockedError(
      `${provider} paid egress is disabled for ${endpoint}`,
    );
  }

  if (!isManualEnrichContext(normalizedContext)) {
    await recordProviderUsageEvent(provider, endpoint, normalizedContext, {
      ...details,
      estimatedCost: 0,
      blocked: true,
      metadata: {
        ...(details.metadata ?? {}),
        reason: "non_manual_context",
      },
    });
    throw new PaidEgressBlockedError(
      `${provider} paid egress blocked for ${normalizedContext} (${endpoint})`,
    );
  }

  const cap = providerDailyCap(provider);
  if (cap >= 0) {
    const used = await dailyUsage(provider);
    if (used + estimatedCost > cap) {
      await recordProviderUsageEvent(provider, endpoint, normalizedContext, {
        ...details,
        estimatedCost: 0,
        blocked: true,
        metadata: {
          ...(details.metadata ?? {}),
          reason: "daily_cap_reached",
          cap,
          usedToday: used,
        },
      });
      throw new PaidEgressBlockedError(
        `${provider} daily safety cap reached — ${used}/${cap} estimated credits used since midnight ET. ` +
          `This is the app's own guardrail, not your ${provider} balance; ` +
          `set ${providerEnvPrefix(provider)}_DAILY_CREDIT_CAP on Vercel to raise it. Resets at midnight ET.`,
      );
    }
  }
}
