import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  callListEntries,
  callOutcomes,
  companies,
  contacts,
  type CallListEntry,
  type CallOutcomeKind,
  type CallOutcomeRow,
} from "@/lib/db/schema";
import {
  buildDialTargets,
  findDialTarget,
  type DialTarget,
} from "@/lib/call-dial-targets";
import { callOutcomeSummary, callStatusForOutcome } from "@/lib/call-outcomes";
import { recordCallListOutreachEvent } from "@/lib/outreach/call-list-sync";

/**
 * Recording a human dial.
 *
 * The dial gate is re-run here rather than trusted from the client. The UI
 * makes a mobile unclickable, but "unreachable" has to mean unreachable: a
 * logged call is a claim that we dialed a number, and accepting that claim for
 * a mobile would let the request the UI refuses to make happen anyway.
 */

export type LogCallInput = {
  entryId: string;
  outcome: CallOutcomeKind;
  phone?: string | null;
  contactId?: string | null;
  notes?: string | null;
  loggedBy?: string | null;
};

export type LogCallResult =
  | { ok: true; entry: CallListEntry; outcome: CallOutcomeRow }
  | { ok: false; status: number; error: string };

export async function dialTargetsForCompany(
  companyId: string,
): Promise<DialTarget[]> {
  const [company] = await db
    .select({
      name: companies.name,
      phone: companies.phone,
      phoneClassification: companies.phoneClassification,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!company) return [];

  const companyContacts = await db
    .select()
    .from(contacts)
    .where(eq(contacts.companyId, companyId));

  return buildDialTargets({ company, contacts: companyContacts });
}

export async function logCall(input: LogCallInput): Promise<LogCallResult> {
  const [entry] = await db
    .select()
    .from(callListEntries)
    .where(eq(callListEntries.id, input.entryId))
    .limit(1);
  if (!entry) {
    return { ok: false, status: 404, error: "Call list entry not found" };
  }

  const notes = input.notes?.trim() || null;
  let phone: string | null = null;
  let classification: DialTarget["classification"] | null = null;

  const submitted = input.phone?.trim();
  if (submitted) {
    const targets = await dialTargetsForCompany(entry.companyId);
    const target = findDialTarget(targets, submitted);
    if (!target) {
      return {
        ok: false,
        status: 422,
        error: "That number is not on file for this company.",
      };
    }
    if (!target.allowed) {
      return { ok: false, status: 422, error: target.reason ?? "Not dialable." };
    }
    phone = target.number;
    classification = target.classification;
  }

  const [row] = await db
    .insert(callOutcomes)
    .values({
      companyId: entry.companyId,
      callListEntryId: entry.id,
      contactId: input.contactId ?? entry.primaryContactId ?? null,
      outcome: input.outcome,
      phone,
      phoneClassification: classification,
      notes,
      loggedBy: input.loggedBy?.trim() || null,
    })
    .returning();

  const updated = await recordCallListOutreachEvent({
    companyId: entry.companyId,
    contactId: input.contactId ?? entry.primaryContactId ?? null,
    summary: callOutcomeSummary(input.outcome, { phone, notes }),
    activityType: "call",
    bumpAttempt: true,
    callStatus: callStatusForOutcome(input.outcome) ?? undefined,
    source: "call_list",
  });

  return { ok: true, entry: updated ?? entry, outcome: row };
}
