import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  callListEntries,
  contacts,
  optInLinkSends,
  type OptInLinkSend,
} from "@/lib/db/schema";
import { consentBusinessName } from "@/lib/consent/disclosure";
import {
  optInEmailSubject,
  optInEmailText,
  optInFormUrl,
} from "@/lib/consent/opt-in-link";
import { pickSendingProfile } from "@/lib/outreach/profiles";
import {
  defaultFromAddress,
  resolveProfileApiKey,
  sendOutreachEmail,
} from "@/lib/outreach/resend-send";
import { applyFromDisplayName } from "@/lib/outreach/sending-domains-catalog";
import { getOrCreateOutreachSettings } from "@/lib/outreach/settings";
import { recordCallListOutreachEvent } from "@/lib/outreach/call-list-sync";
import { isPersonalEmail } from "@/lib/phone-utils";

/**
 * Email the opt-in form from the call screen.
 *
 * The failed attempt is recorded too. A send that vanished on an SMTP error
 * would leave the operator believing the prospect had been given the link, and
 * opt-in conversion is measured against sends — an unrecorded send silently
 * inflates it.
 */

export type SendOptInLinkInput = {
  entryId: string;
  contactId?: string | null;
  /** Overrides the contact's stored address when the operator got a better one. */
  email?: string | null;
  sentBy?: string | null;
  callOutcomeId?: string | null;
};

export type SendOptInLinkResult =
  | { ok: true; send: OptInLinkSend }
  | { ok: false; status: number; error: string; send?: OptInLinkSend };

function bestEmail(contact: {
  workEmail: string | null;
  email: string | null;
  personalEmail: string | null;
}): string | null {
  if (contact.workEmail) return contact.workEmail;
  if (contact.email && !isPersonalEmail(contact.email)) return contact.email;
  return contact.email ?? contact.personalEmail ?? null;
}

export async function sendOptInLink(
  input: SendOptInLinkInput,
): Promise<SendOptInLinkResult> {
  const [entry] = await db
    .select()
    .from(callListEntries)
    .where(eq(callListEntries.id, input.entryId))
    .limit(1);
  if (!entry) {
    return { ok: false, status: 404, error: "Call list entry not found" };
  }

  const contactId = input.contactId ?? entry.primaryContactId ?? null;
  let contactName: string | null = null;
  let email = input.email?.trim().toLowerCase() || null;

  if (contactId) {
    const [contact] = await db
      .select({
        name: contacts.name,
        email: contacts.email,
        workEmail: contacts.workEmail,
        personalEmail: contacts.personalEmail,
      })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    if (contact) {
      contactName = contact.name;
      email = email ?? bestEmail(contact);
    }
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return {
      ok: false,
      status: 422,
      error: "No email address on file for this contact — add one first.",
    };
  }

  // The company id doubles as the source identifier, so a consent record that
  // arrives later can be traced back to the call that earned it.
  const formUrl = optInFormUrl(`call:${entry.companyId}`);
  if (!formUrl) {
    return {
      ok: false,
      status: 500,
      error: "NEXT_PUBLIC_APP_URL is not set, so the form link cannot be built.",
    };
  }

  const settings = await getOrCreateOutreachSettings();
  const pick = await pickSendingProfile("email_domain");
  const profile = pick?.profile ?? null;
  const apiKey = resolveProfileApiKey(profile);
  const from = applyFromDisplayName(
    profile?.fromAddress ?? defaultFromAddress() ?? "",
  );
  if (!apiKey || !from.includes("@")) {
    return {
      ok: false,
      status: 500,
      error: "No sending identity configured — set RESEND_API_KEY and a from address.",
    };
  }

  const businessName = consentBusinessName();
  const senderName = process.env.OUTREACH_SENDER_NAME ?? "Alejandro O Delgado";
  const result = await sendOutreachEmail({
    apiKey,
    from,
    to: email,
    replyTo: profile?.replyToAddress ?? settings.replyToAddress,
    subject: optInEmailSubject(businessName),
    textBody: optInEmailText({
      contactName,
      senderName,
      businessName,
      formUrl,
    }),
  });

  const [send] = await db
    .insert(optInLinkSends)
    .values({
      companyId: entry.companyId,
      contactId,
      callOutcomeId: input.callOutcomeId ?? null,
      email,
      formUrl,
      sentBy: input.sentBy?.trim() || null,
      error: result.ok ? null : result.error,
    })
    .returning();

  await recordCallListOutreachEvent({
    companyId: entry.companyId,
    contactId,
    summary: result.ok
      ? `Opt-in link emailed to ${email}`
      : `Opt-in link send FAILED to ${email}: ${result.error}`,
    activityType: "email",
    source: "call_list",
  });

  if (!result.ok) {
    return { ok: false, status: 502, error: result.error, send };
  }

  return { ok: true, send };
}
