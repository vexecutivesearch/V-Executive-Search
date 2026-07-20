import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  companyIcp,
  contacts,
  jobListings,
  outreachMessages,
  sequenceEnrollments,
  type Contact,
} from "@/lib/db/schema";
import {
  DEFAULT_STEP_SPECS,
  draftSequence,
  type DraftContext,
  type StepSpec,
} from "@/lib/outreach-draft";
import { ensureDefaultFlow } from "@/lib/outreach/default-flow";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { seedOutreachTemplates } from "@/lib/outreach/seed-templates";
import { getOrCreateOutreachSettings } from "@/lib/outreach/settings";
import { isSuppressed } from "@/lib/outreach/suppression";
import { resolveContactTimezone } from "@/lib/outreach/timezone-infer";

export type EnrollmentResult =
  | { enrolled: true; enrollmentId: string; channelPlan: "email_and_text" | "email_only" }
  | { enrolled: false; reason: string };

const SENDER_NAME = process.env.OUTREACH_SENDER_NAME ?? "Alejandro O Delgado";
const SENDER_FIRM = process.env.OUTREACH_SENDER_FIRM ?? "Villatoro Executive Search";

function pickEmail(
  contact: Contact,
  workPreferred: boolean,
): string | null {
  const work = contact.workEmail?.trim() || null;
  const personal = contact.personalEmail?.trim() || null;
  const generic = contact.email?.trim() || null;
  const ordered = workPreferred
    ? [work, generic, personal]
    : [personal, generic, work];
  return ordered.find(Boolean) ?? null;
}

function pickPhone(contact: Contact): string | null {
  return (
    contact.personalPhone?.trim() ||
    contact.phone?.trim() ||
    (contact.phones ?? []).find((p) => p.kind === "mobile")?.number ||
    null
  );
}

/** Eligibility per the confirmed enrollment rules. Returns null when OK. */
async function ineligibilityReason(
  contact: Contact,
  companyStatus: string,
  icpStatus: string,
  emailAddress: string | null,
): Promise<string | null> {
  if (!emailAddress) return "no email address";
  if (contact.emailDeliverable !== true) return "email not verified deliverable";
  if (companyStatus !== "new") return `company status is ${companyStatus}`;
  if (icpStatus === "fail") return "ICP fail";

  const [icpRow] = await db
    .select({ flags: companyIcp.exclusionFlags })
    .from(companyIcp)
    .where(eq(companyIcp.companyId, contact.companyId))
    .limit(1);
  if (icpRow?.flags?.includes("staffing_agency")) return "staffing agency";

  const [prior] = await db
    .select({ id: sequenceEnrollments.id })
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.contactId, contact.id))
    .limit(1);
  if (prior) return "already enrolled previously";

  const emailSupp = await isSuppressed({ channel: "email", email: emailAddress });
  if (emailSupp.suppressed) return `email suppressed (${emailSupp.reason})`;

  return null;
}

/**
 * Enroll a single contact: drafts ALL steps transactionally (any step failing
 * the sanitizer after retries → no enrollment, failure logged and retried on
 * the next enrich pass), pins the enrollment to the default flow, and holds
 * everything behind the approval gate.
 */
export async function enrollContact(
  contactId: string,
  options?: {
    staggerDays?: number;
    actor?: string;
    /** Skip the Approvals tab for this enrollment (call-list path). */
    autoApprove?: boolean;
    /** Advance the flow immediately so the intro is queued for dispatch. */
    advanceNow?: boolean;
  },
): Promise<EnrollmentResult> {
  const settings = await getOrCreateOutreachSettings();
  await seedOutreachTemplates();

  const [contact] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  if (!contact) return { enrolled: false, reason: "contact not found" };

  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, contact.companyId))
    .limit(1);
  if (!company) return { enrolled: false, reason: "company not found" };

  const emailAddress = pickEmail(contact, settings.workEmailPreferred);
  const reason = await ineligibilityReason(
    contact,
    company.status,
    company.icpStatus,
    emailAddress,
  );
  if (reason) return { enrolled: false, reason };

  // Company-level cap: 2–3 contacts per company.
  const companyEnrollments = await db
    .select({ id: sequenceEnrollments.id })
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.companyId, company.id));
  if (companyEnrollments.length >= settings.maxContactsPerCompany) {
    return { enrolled: false, reason: "company contact cap reached" };
  }

  // iMessage: verified capability required; unknown → email-only sequence.
  const phone = pickPhone(contact);
  let textEligible = contact.imessageCapable === true && Boolean(phone);
  if (textEligible && phone) {
    const phoneSupp = await isSuppressed({ channel: "imessage", phone });
    if (phoneSupp.suppressed) textEligible = false;
  }

  const listings = await db
    .select()
    .from(jobListings)
    .where(eq(jobListings.companyId, company.id))
    .orderBy(desc(jobListings.lastSeenAt))
    .limit(8);

  const timezone = resolveContactTimezone({
    timezoneOverride: contact.timezoneOverride,
    contactLocation: contact.contactLocation,
    jobLocation: contact.jobLocation ?? listings[0]?.location,
    companyLocation: company.sourceMarket,
  });

  const specs: StepSpec[] = DEFAULT_STEP_SPECS.filter(
    (spec) => spec.channel === "email" || textEligible,
  );

  const jobTitles = [...new Set(listings.map((l) => l.title).filter(Boolean))];
  const jobDetails = listings.map((l) => {
    const parts = [l.title];
    if (l.location) parts.push(`location: ${l.location}`);
    if (l.salaryText) parts.push(`comp: ${l.salaryText}`);
    if (l.board && l.board !== "manual_seed") parts.push(`board: ${l.board}`);
    return parts.join(", ");
  });

  const context: DraftContext = {
    contactName: contact.name || null,
    contactTitle: contact.title,
    companyName: company.name,
    industry: company.industry,
    estimatedEmployees: company.estimatedEmployees,
    jobTitles,
    jobDetails,
    jobLocation: listings[0]?.location ?? null,
    hiringSignals: Object.entries(company.hiringSignals ?? {})
      .filter(([, v]) => v)
      .map(([k]) => k.replace(/_/g, " ")),
    reasonToCall: company.reasonToCall,
    market: company.sourceMarket,
    senderName: SENDER_NAME,
    senderFirm: SENDER_FIRM,
  };

  const drafted = await draftSequence({ specs, context });
  if (!drafted) {
    await logEnrollmentEvent({
      eventType: "error",
      actor: options?.actor ?? "system",
      payload: {
        stage: "transactional_drafting",
        contact_id: contact.id,
        company_id: company.id,
        detail: "one or more steps failed drafting/sanitization — no enrollment created; retried next pass",
      },
    });
    return { enrolled: false, reason: "drafting failed (will retry next pass)" };
  }

  const { versionId } = await ensureDefaultFlow();

  const [enrollment] = await db
    .insert(sequenceEnrollments)
    .values({
      contactId: contact.id,
      companyId: company.id,
      status: "active",
      timezone,
      emailAddress,
      phoneNumber: textEligible ? phone : null,
      flowVersionId: versionId,
      currentNodeId: null,
      nodeState: options?.staggerDays
        ? { wait_until: new Date(Date.now() + options.staggerDays * 86_400_000).toISOString() }
        : {},
      nextStepAt: options?.staggerDays
        ? new Date(Date.now() + options.staggerDays * 86_400_000)
        : new Date(),
    })
    .returning();

  const approvedAt = options?.autoApprove ? new Date() : null;
  await db.insert(outreachMessages).values(
    drafted.map((step) => ({
      enrollmentId: enrollment.id,
      stepKind: step.stepKind,
      channel: step.channel,
      status: "drafted" as const,
      subject: step.subject,
      body: step.body,
      templateId: step.templateId,
      approvedAt,
    })),
  );

  await logEnrollmentEvent({
    enrollmentId: enrollment.id,
    eventType: "enrolled",
    actor: options?.actor ?? "system",
    payload: {
      contact_id: contact.id,
      company_id: company.id,
      timezone,
      channel_plan: textEligible ? "email_and_text" : "email_only",
      steps: drafted.map((s) => s.stepKind),
      stagger_days: options?.staggerDays ?? 0,
      job_titles: jobTitles,
      auto_approve: Boolean(options?.autoApprove),
    },
  });
  await logEnrollmentEvent({
    enrollmentId: enrollment.id,
    eventType: "drafted",
    payload: { steps: drafted.length, transactional: true },
  });
  if (options?.autoApprove) {
    await logEnrollmentEvent({
      enrollmentId: enrollment.id,
      eventType: "approved",
      actor: options.actor ?? "system",
      payload: { steps: drafted.length, source: options.actor ?? "system" },
    });
  }

  if (options?.advanceNow) {
    try {
      const { advanceEnrollment } = await import("@/lib/outreach/flow-engine");
      const [fresh] = await db
        .select()
        .from(sequenceEnrollments)
        .where(eq(sequenceEnrollments.id, enrollment.id))
        .limit(1);
      if (fresh) await advanceEnrollment(fresh, new Date());
    } catch (error) {
      console.error("[outreach] advance after enroll failed", error);
    }
  }

  return {
    enrolled: true,
    enrollmentId: enrollment.id,
    channelPlan: textEligible ? "email_and_text" : "email_only",
  };
}

/**
 * Auto-enroll hook — called at the end of enrich ingest. Never throws:
 * enrollment problems must not break ingest. 2–3 contacts per company,
 * intros staggered across days.
 */
export async function autoEnrollForCompanies(
  companyIds: string[],
): Promise<{ enrolled: number; skipped: number }> {
  let enrolled = 0;
  let skipped = 0;
  try {
    const settings = await getOrCreateOutreachSettings();
    if (!settings.autoEnroll) return { enrolled, skipped };

    const unique = [...new Set(companyIds)];
    if (!unique.length) return { enrolled, skipped };

    const contactRows = await db
      .select()
      .from(contacts)
      .where(inArray(contacts.companyId, unique));

    const byCompany = new Map<string, Contact[]>();
    for (const contact of contactRows) {
      const list = byCompany.get(contact.companyId) ?? [];
      list.push(contact);
      byCompany.set(contact.companyId, list);
    }

    for (const [, companyContacts] of byCompany) {
      // Prefer primary + revealed contacts first.
      const ordered = [...companyContacts].sort((a, b) => {
        const score = (c: Contact) =>
          (c.isPrimary ? 2 : 0) + (c.emailDeliverable === true ? 1 : 0);
        return score(b) - score(a);
      });
      let index = 0;
      for (const contact of ordered.slice(0, settings.maxContactsPerCompany)) {
        const result = await enrollContact(contact.id, {
          staggerDays: index * settings.introStaggerDays,
        });
        if (result.enrolled) {
          enrolled += 1;
          index += 1;
        } else {
          skipped += 1;
        }
      }
    }
  } catch (error) {
    console.error("[outreach] auto-enroll failed (non-fatal for ingest):", error);
  }
  return { enrolled, skipped };
}

/** Cancel all pending sequences for other contacts at a company (one
 * conversation per company once someone says yes). */
export async function cancelSiblingEnrollments(
  companyId: string,
  keepEnrollmentId: string,
  reason: string,
): Promise<number> {
  const siblings = await db
    .select()
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.companyId, companyId),
        inArray(sequenceEnrollments.status, [
          "active",
          "paused",
          "waiting_on_reply",
          "waiting_on_manual",
        ]),
      ),
    );

  let cancelled = 0;
  for (const sibling of siblings) {
    if (sibling.id === keepEnrollmentId) continue;
    await db
      .update(sequenceEnrollments)
      .set({
        status: "stopped",
        stopReason: reason,
        stoppedBy: "rule:positive",
        updatedAt: new Date(),
      })
      .where(eq(sequenceEnrollments.id, sibling.id));
    await db
      .update(outreachMessages)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(outreachMessages.enrollmentId, sibling.id),
          inArray(outreachMessages.status, ["drafted", "queued"]),
        ),
      );
    await logEnrollmentEvent({
      enrollmentId: sibling.id,
      eventType: "cancelled",
      actor: "rule:positive",
      payload: { reason },
    });
    cancelled += 1;
  }
  return cancelled;
}
