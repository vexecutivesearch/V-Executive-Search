import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { sendingProfiles } from "@/lib/db/schema";
import {
  CATALOG_SENDING_DOMAINS,
  DEFAULT_REPLY_TO_ADDRESS,
  fromAddressForDomain,
  rootDomainOf,
} from "@/lib/outreach/sending-domains-catalog";

/** Matches rampCap(0) — keep this file free of a profiles.ts import cycle. */
const WARMUP_FLOOR = 5;

export {
  CATALOG_SENDING_DOMAINS,
  DEFAULT_REPLY_TO_ADDRESS,
  ESTABLISHED_SENDING_DOMAINS,
  FROM_LOCAL_PART,
  NEW_SENDING_DOMAINS,
  fromAddressForDomain,
  rootDomainOf,
} from "@/lib/outreach/sending-domains-catalog";
export type { CatalogSendingDomain } from "@/lib/outreach/sending-domains-catalog";

export type EnsureCatalogResult = {
  created: string[];
  existing: string[];
};

/**
 * Idempotent: insert any catalog domain that is not already a sending
 * profile. Existing rows are left untouched (status, ramp, counters).
 *
 * New rows enter `warming` at ramp stage 0 so pickSendingProfile can
 * rotate them immediately. Resend already verified these domains; the
 * Admin "Verify DNS" button is still the gate if a row is later reset
 * to `new`.
 */
export async function ensureCatalogSendingProfiles(
  now = new Date(),
): Promise<EnsureCatalogResult> {
  const pool = await db
    .select()
    .from(sendingProfiles)
    .where(eq(sendingProfiles.kind, "email_domain"));

  const have = new Set(
    pool
      .map((row) => row.domain?.trim().toLowerCase())
      .filter((domain): domain is string => Boolean(domain)),
  );
  const templateFrom =
    pool.find((row) => row.fromAddress)?.fromAddress ?? null;
  const replyTo =
    pool.find((row) => row.replyToAddress)?.replyToAddress?.trim() ||
    DEFAULT_REPLY_TO_ADDRESS;

  const created: string[] = [];
  const existing: string[] = [];

  for (const domain of CATALOG_SENDING_DOMAINS) {
    if (have.has(domain)) {
      existing.push(domain);
      continue;
    }
    await db.insert(sendingProfiles).values({
      kind: "email_domain",
      label: domain,
      domain,
      fromAddress: fromAddressForDomain(domain, templateFrom),
      replyToAddress: replyTo,
      rootDomain: rootDomainOf(domain),
      status: "warming",
      dailyLimit: WARMUP_FLOOR,
      rampStage: 0,
      verifiedAt: now,
      warmingStartedAt: now,
      cleanSince: now,
      updatedAt: now,
    });
    have.add(domain);
    created.push(domain);
  }

  return { created, existing };
}
