import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  suppressions,
  type OutreachChannel,
  type Suppression,
} from "@/lib/db/schema";

/**
 * Per-channel suppression — checked before EVERY send, even mid-flow.
 * A contact can be email-suppressed but text-eligible ("stop emailing me"),
 * fully suppressed (opt_out / data_deletion), or number-suppressed via STOP.
 */

export function normalizeEmail(email: string | null | undefined): string | null {
  const cleaned = (email ?? "").trim().toLowerCase();
  return cleaned.includes("@") ? cleaned : null;
}

/** Digits-only tail (last 10) so +1 formatting variants match. */
export function normalizePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

function channelMatches(rule: OutreachChannel | "all", channel: OutreachChannel): boolean {
  return rule === "all" || rule === channel;
}

/** Is this email/phone suppressed for the given channel? */
export async function isSuppressed(options: {
  channel: OutreachChannel;
  email?: string | null;
  phone?: string | null;
}): Promise<{ suppressed: boolean; reason?: string }> {
  const email = normalizeEmail(options.email);
  const phone = normalizePhone(options.phone);
  if (!email && !phone) return { suppressed: false };

  const clauses = [];
  if (email) clauses.push(eq(suppressions.email, email));
  if (phone) clauses.push(eq(suppressions.phone, phone));

  const rows = await db
    .select()
    .from(suppressions)
    .where(clauses.length === 1 ? clauses[0] : or(...clauses));

  for (const row of rows) {
    if (channelMatches(row.channel, options.channel)) {
      return { suppressed: true, reason: row.reason };
    }
  }
  return { suppressed: false };
}

export async function addSuppression(options: {
  email?: string | null;
  phone?: string | null;
  channel: OutreachChannel | "all";
  reason: string;
  legalBasis?: string;
  contactId?: string | null;
}): Promise<Suppression | null> {
  const email = normalizeEmail(options.email);
  const phone = normalizePhone(options.phone);
  if (!email && !phone) return null;

  const [row] = await db
    .insert(suppressions)
    .values({
      email,
      phone,
      channel: options.channel,
      reason: options.reason,
      legalBasis: options.legalBasis ?? null,
      contactId: options.contactId ?? null,
    })
    .returning();
  return row;
}

/**
 * DNC CSV import: one email or phone per cell, matched across both columns.
 * Returns count imported (duplicates skipped by value match).
 */
export async function importDncList(
  values: string[],
  reason = "DNC import",
): Promise<number> {
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const raw of values) {
    const email = normalizeEmail(raw);
    if (email) {
      emails.add(email);
      continue;
    }
    const phone = normalizePhone(raw);
    if (phone) phones.add(phone);
  }
  if (!emails.size && !phones.size) return 0;

  const existing = await db
    .select({ email: suppressions.email, phone: suppressions.phone })
    .from(suppressions)
    .where(
      or(
        emails.size
          ? and(isNotNull(suppressions.email), inArray(suppressions.email, [...emails]))
          : undefined,
        phones.size
          ? and(isNotNull(suppressions.phone), inArray(suppressions.phone, [...phones]))
          : undefined,
      ),
    );
  for (const row of existing) {
    if (row.email) emails.delete(row.email);
    if (row.phone) phones.delete(row.phone);
  }

  const rows = [
    ...[...emails].map((email) => ({
      email,
      phone: null as string | null,
      channel: "all" as const,
      reason,
      legalBasis: "do-not-contact list",
    })),
    ...[...phones].map((phone) => ({
      email: null as string | null,
      phone,
      channel: "all" as const,
      reason,
      legalBasis: "do-not-contact list",
    })),
  ];
  if (!rows.length) return 0;
  await db.insert(suppressions).values(rows);
  return rows.length;
}
