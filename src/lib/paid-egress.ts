import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { providerUsageEvents } from "@/lib/db/schema";

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

function paidEgressEnabled(provider: PaidProvider): boolean {
  const prefix = providerEnvPrefix(provider);
  if (!envFlag(process.env.PAID_EGRESS_ENABLED, true)) return false;
  if (!envFlag(process.env[`${prefix}_EGRESS_ENABLED`], true)) return false;
  return envFlag(process.env[`${prefix}_PAID_EGRESS_ENABLED`], true);
}

function providerDailyCap(provider: PaidProvider): number {
  const prefix = providerEnvPrefix(provider);
  const raw = process.env[`${prefix}_DAILY_CREDIT_CAP`];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return provider === "apollo" ? 200 : 50;
}

function todayStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function dailyUsage(provider: PaidProvider): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${providerUsageEvents.estimatedCost}), 0)`,
    })
    .from(providerUsageEvents)
    .where(
      and(
        eq(providerUsageEvents.provider, provider),
        eq(providerUsageEvents.blocked, false),
        gte(providerUsageEvents.createdAt, todayStart()),
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
  if (cap >= 0 && (await dailyUsage(provider)) + estimatedCost > cap) {
    await recordProviderUsageEvent(provider, endpoint, normalizedContext, {
      ...details,
      estimatedCost: 0,
      blocked: true,
      metadata: {
        ...(details.metadata ?? {}),
        reason: "daily_cap_reached",
        cap,
      },
    });
    throw new PaidEgressBlockedError(
      `${provider} daily cap reached for ${endpoint}`,
    );
  }
}
