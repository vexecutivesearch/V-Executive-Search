import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  companyActivities,
  contacts,
  type ConsentSource,
} from "@/lib/db/schema";
import { normalizeCompanyKey } from "@/lib/company-name";
import { disclosureForVersion } from "@/lib/consent/disclosure";
import { recordConsent } from "@/lib/outreach/consent";
import { isPersonalEmail, parsePhoneValue } from "@/lib/phone-utils";
import { businessListDate } from "@/lib/timezone";
import type { LeadSource } from "@/lib/db/schema";

/**
 * The consented inbound lane.
 *
 * A lead that arrives here submitted an E-SIGN form, so it carries the one
 * artifact that permits SMS. It is deliberately NOT auto-enrolled into a
 * sequence: this pass lands the lead with its consent intact and puts it in
 * the operator's review queue.
 *
 * A Meta Lead Ads webhook can be added later as a second caller with
 * `source: "meta_lead_ad"` and `leadSource: "inbound_meta"` — Meta's own form
 * fields may not be able to carry the disclosure wording, which is why the
 * self-hosted page is the default and Meta ads point at it.
 */

export type InboundLeadSubmission = {
  companyName: string;
  contactName: string;
  workEmail: string;
  phone: string;
  hiringFor: string;
  /** Unchecked by default and not required to submit. */
  smsConsent: boolean;
  disclosureVersion: string;
  /**
   * `src` from the link that brought them here, e.g. `call:<companyId>` from
   * an opt-in link emailed off a call. Attribution only — it never affects
   * what is captured or whether the submission is accepted.
   */
  sourceTag: string;
};

export type InboundLeadFieldErrors = Partial<
  Record<keyof InboundLeadSubmission, string>
>;

function str(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Validate a submission. SMS consent is never required to submit — a form that
 * refuses the lead without the checkbox is not consent, it is a condition.
 */
export function parseInboundLeadSubmission(
  raw: unknown,
):
  | { ok: true; value: InboundLeadSubmission }
  | { ok: false; errors: InboundLeadFieldErrors } {
  const body = (raw ?? {}) as Record<string, unknown>;
  const value: InboundLeadSubmission = {
    companyName: str(body.company_name ?? body.companyName),
    contactName: str(body.contact_name ?? body.contactName),
    workEmail: str(body.work_email ?? body.workEmail).toLowerCase(),
    phone: str(body.phone),
    hiringFor: str(body.hiring_for ?? body.hiringFor),
    smsConsent:
      body.sms_consent === true ||
      body.sms_consent === "on" ||
      body.sms_consent === "true" ||
      body.smsConsent === true,
    disclosureVersion: str(body.disclosure_version ?? body.disclosureVersion),
    sourceTag: str(body.src ?? body.sourceTag).slice(0, 120),
  };

  const errors: InboundLeadFieldErrors = {};
  if (!value.companyName) errors.companyName = "Company name is required.";
  if (!value.contactName) errors.contactName = "Your name is required.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.workEmail)) {
    errors.workEmail = "Enter a valid work email address.";
  }
  if (!parsePhoneValue(value.phone)) {
    errors.phone = "Enter a phone number we can reach you on.";
  }
  if (!value.hiringFor) {
    errors.hiringFor = "Tell us what you are hiring for.";
  }
  if (value.smsConsent && !disclosureForVersion(value.disclosureVersion)) {
    // The stored artifact is the wording we can reproduce. If we cannot
    // resolve the version the visitor saw, we cannot honestly claim consent.
    errors.disclosureVersion =
      "This form is out of date. Reload the page and submit again.";
  }

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

/** Work-email domain, ignoring free mailbox providers. */
export function domainFromWorkEmail(email: string): string | null {
  const domain = email.split("@")[1]?.trim().toLowerCase() ?? "";
  if (!domain || isPersonalEmail(email)) return null;
  return domain.replace(/^www\./, "") || null;
}

async function matchCompany(
  companyName: string,
  domain: string | null,
): Promise<{ id: string; name: string } | null> {
  if (domain) {
    const [byDomain] = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(eq(companies.domain, domain))
      .limit(1);
    if (byDomain) return byDomain;
  }

  // Normalised name is the same key the job-scrape ingest and company-first
  // discovery dedupe on, so an inbound lead lands on the existing row rather
  // than creating a twin.
  const nameKey = normalizeCompanyKey(companyName);
  if (!nameKey) return null;
  const rows = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies);
  return rows.find((row) => normalizeCompanyKey(row.name) === nameKey) ?? null;
}

export type LandedInboundLead = {
  companyId: string;
  contactId: string;
  consentRecordId: string | null;
  companyCreated: boolean;
  /** True when the submission carried an SMS consent artifact. */
  smsConsent: boolean;
};

export async function landInboundLead(options: {
  submission: InboundLeadSubmission;
  source: ConsentSource;
  leadSource: LeadSource;
  /** Form id, Meta form id, or inbound message id. */
  sourceIdentifier: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<LandedInboundLead> {
  const { submission } = options;
  const domain = domainFromWorkEmail(submission.workEmail);
  const phone = parsePhoneValue(submission.phone) ?? submission.phone.trim();

  const existing = await matchCompany(submission.companyName, domain);

  let companyId: string;
  let companyCreated = false;
  if (existing) {
    // An inbound hand-raise supersedes cold provenance for channel decisions,
    // but nothing the pipeline already knows is overwritten.
    await db
      .update(companies)
      .set({
        leadSource: options.leadSource,
        domain: sql`COALESCE(${companies.domain}, ${domain})`,
        reviewStatus: "pending",
        reviewStatusUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(companies.id, existing.id));
    companyId = existing.id;
  } else {
    const [created] = await db
      .insert(companies)
      .values({
        name: submission.companyName,
        domain,
        domainConfidence: domain ? "high" : "low",
        firstSeen: businessListDate(),
        leadSource: options.leadSource,
        reviewStatus: "pending",
        reviewStatusUpdatedAt: new Date(),
        reasonToCall: `Inbound: hiring for ${submission.hiringFor}`,
      })
      .returning({ id: companies.id });
    companyId = created.id;
    companyCreated = true;
  }

  const [contact] = await db
    .insert(contacts)
    .values({
      companyId,
      name: submission.contactName,
      title: null,
      email: submission.workEmail,
      workEmail: submission.workEmail,
      phone,
      personalPhone: phone,
      phones: [
        {
          number: phone,
          source: "contactout",
          kind: "mobile",
          // Self-reported on the form; unverified number types are mobiles.
          classification: "unknown",
        },
      ],
      phoneClassification: "unknown",
      sourceProvider: "inbound_form",
      revealStatus: "revealed",
      isPrimary: true,
    })
    .returning({ id: contacts.id });

  let consentRecordId: string | null = null;
  if (submission.smsConsent) {
    const disclosure = disclosureForVersion(submission.disclosureVersion);
    if (disclosure) {
      const record = await recordConsent({
        contactId: contact.id,
        companyId,
        email: submission.workEmail,
        phone,
        channelScope: "both",
        disclosureText: disclosure.text,
        source: options.source,
        sourceIdentifier: submission.sourceTag
          ? `${options.sourceIdentifier} src=${submission.sourceTag}`
          : options.sourceIdentifier,
        ipAddress: options.ipAddress ?? null,
        userAgent: options.userAgent ?? null,
      });
      consentRecordId = record.id;
    }
  }

  await db.insert(companyActivities).values({
    companyId,
    contactId: contact.id,
    type: "note",
    summary: submission.smsConsent
      ? `Inbound opt-in form — hiring for ${submission.hiringFor}. Written SMS consent captured.`
      : `Inbound opt-in form — hiring for ${submission.hiringFor}. No SMS consent given (email only).`,
    source: "inbound_form",
  });

  return {
    companyId,
    contactId: contact.id,
    consentRecordId,
    companyCreated,
    smsConsent: submission.smsConsent,
  };
}
