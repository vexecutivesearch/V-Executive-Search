import { desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  consentRecords,
  type ConsentChannelScope,
  type ConsentRecord,
  type ConsentSource,
} from "@/lib/db/schema";
import { normalizeEmail, normalizePhone } from "@/lib/outreach/suppression";

/**
 * The single gate every future SMS send consults.
 *
 * `suppressions` answers "must we stop?". This answers "were we ever
 * permitted?", which is a different question with a different default: no
 * record means no consent, and cold B2B email posture
 * ("legitimate interest — B2B recruitment outreach") is not consent to text.
 *
 * A revoked record is treated as absent. It is kept on the table because
 * retention guidance is five years and it still proves consent existed for the
 * window it covered — but it never authorizes a send.
 */

export type SmsConsentQuery = {
  contactId?: string | null;
  phone?: string | null;
};

export function consentCoversSms(
  record: Pick<ConsentRecord, "channelScope">,
): boolean {
  return record.channelScope === "sms" || record.channelScope === "both";
}

export function consentCoversEmail(
  record: Pick<ConsentRecord, "channelScope">,
): boolean {
  return record.channelScope === "email" || record.channelScope === "both";
}

export function isConsentRevoked(
  record: Pick<ConsentRecord, "revokedAt">,
): boolean {
  return record.revokedAt != null;
}

function capturedMs(record: Pick<ConsentRecord, "capturedAt">): number {
  const value = new Date(record.capturedAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

/**
 * Pick the record that governs texting this identity, or null.
 *
 * When a phone number is being asked about, the record must cover THAT number:
 * consent is given for a specific mobile, so a record captured for the same
 * person's other number does not authorize this one.
 */
export function selectGoverningSmsConsent(
  records: ConsentRecord[],
  query: SmsConsentQuery,
): ConsentRecord | null {
  const phone = normalizePhone(query.phone);
  const contactId = query.contactId?.trim() || null;
  if (!phone && !contactId) return null;

  const matches = records.filter((record) => {
    if (isConsentRevoked(record)) return false;
    if (!consentCoversSms(record)) return false;
    if (phone) return normalizePhone(record.phone) === phone;
    return record.contactId === contactId;
  });

  if (!matches.length) return null;
  return [...matches].sort((a, b) => capturedMs(b) - capturedMs(a))[0];
}

/** Digits-only comparison in SQL — records store the phone as submitted. */
function phoneDigitsMatch(phone: string): SQL {
  return sql`regexp_replace(coalesce(${consentRecords.phone}, ''), '[^0-9]', '', 'g') LIKE ${`%${phone}`}`;
}

/**
 * The consent record permitting SMS to this contact/number, or null.
 * Null is the answer for every cold lead: nothing was ever captured.
 */
export async function hasSmsConsent(
  query: SmsConsentQuery,
): Promise<ConsentRecord | null> {
  const phone = normalizePhone(query.phone);
  const contactId = query.contactId?.trim() || null;
  if (!phone && !contactId) return null;

  const clauses: SQL[] = [];
  if (contactId) clauses.push(sql`${eq(consentRecords.contactId, contactId)}`);
  if (phone) clauses.push(phoneDigitsMatch(phone));

  const rows = await db
    .select()
    .from(consentRecords)
    .where(
      sql`${isNull(consentRecords.revokedAt)} AND (${
        clauses.length === 1 ? clauses[0] : or(...clauses)!
      })`,
    )
    .orderBy(desc(consentRecords.capturedAt));

  return selectGoverningSmsConsent(rows, query);
}

export type RecordConsentInput = {
  contactId?: string | null;
  companyId?: string | null;
  email?: string | null;
  phone?: string | null;
  channelScope: ConsentChannelScope;
  /** Verbatim wording the person saw — resolved server-side, never posted. */
  disclosureText: string;
  source: ConsentSource;
  sourceIdentifier?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  capturedAt?: Date;
};

/**
 * Write a consent artifact. Structured so a Meta Lead Ads webhook can later
 * land here as a second source with `source: "meta_lead_ad"` and its form id,
 * writing the same row shape with no other change.
 */
export async function recordConsent(
  input: RecordConsentInput,
): Promise<ConsentRecord> {
  const [row] = await db
    .insert(consentRecords)
    .values({
      contactId: input.contactId ?? null,
      companyId: input.companyId ?? null,
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      channelScope: input.channelScope,
      disclosureText: input.disclosureText,
      source: input.source,
      sourceIdentifier: input.sourceIdentifier ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
    })
    .returning();
  return row;
}

/**
 * Withdraw consent. Never deletes: the row is the five-year retention record,
 * and a deleted row cannot show what was permitted when a message went out.
 */
export async function revokeConsent(options: {
  consentRecordId: string;
  reason: string;
  revokedAt?: Date;
}): Promise<ConsentRecord | null> {
  const [row] = await db
    .update(consentRecords)
    .set({
      revokedAt: options.revokedAt ?? new Date(),
      revokedReason: options.reason,
    })
    .where(eq(consentRecords.id, options.consentRecordId))
    .returning();
  return row ?? null;
}

/** Consent records for a company — the dossier view of what we may send. */
export async function consentRecordsForCompany(
  companyId: string,
): Promise<ConsentRecord[]> {
  return db
    .select()
    .from(consentRecords)
    .where(eq(consentRecords.companyId, companyId))
    .orderBy(desc(consentRecords.capturedAt));
}

export { normalizeEmail, normalizePhone };
