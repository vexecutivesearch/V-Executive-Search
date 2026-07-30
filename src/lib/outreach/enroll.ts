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
  getLastDraftFailureReason,
  type StepSpec,
} from "@/lib/outreach-draft";
import { buildDraftContext } from "@/lib/outreach/draft-context";
import { ensureDefaultFlow } from "@/lib/outreach/default-flow";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { seedOutreachTemplates } from "@/lib/outreach/seed-templates";
import { getOrCreateOutreachSettings } from "@/lib/outreach/settings";
import { isSuppressed } from "@/lib/outreach/suppression";
import { resolveContactTimezone } from "@/lib/outreach/timezone-infer";

export type EnrollmentResult =
  | {
      enrolled: true;
      enrollmentId: string;
      channelPlan: "email_and_text" | "email_only";
      /** True when a live dispatch pass ran after enroll (email may send in-window). */
      dispatched?: boolean;
    }
  | { enrolled: false; reason: string };

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
  options?: { bypassIcpFail?: boolean },
): Promise<string | null> {
  if (!emailAddress) return "no email address";
  if (contact.emailDeliverable !== true) return "email not verified deliverable";
  if (companyStatus !== "new") return `company status is ${companyStatus}`;
  // Intentional Call List adds skip ICP fail — the recruiter already chose them.
  if (icpStatus === "fail" && !options?.bypassIcpFail) return "ICP fail";

  const [icpRow] = await db
    .select({ flags: companyIcp.exclusionFlags })
    .from(companyIcp)
    .where(eq(companyIcp.companyId, contact.companyId))
    .limit(1);
  if (icpRow?.flags?.includes("staffing_agency") && !options?.bypassIcpFail) {
    return "staffing agency";
  }

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
 * the sanitizer after retries → no enrollment). Claude personalizes off the
 * pinned job listing when `jobListingId` is provided.
 *
 * When requireApproval is off (or autoApprove is set), messages are marked
 * approved. When advanceNow is set — or live settings allow (enabled, not
 * dry-run, approval not required / auto-approved) — the flow advances so
 * day-0 steps queue, and a dispatch pass runs for in-window email send.
 */
export async function enrollContact(
  contactId: string,
  options?: {
    staggerDays?: number;
    actor?: string;
    /** Skip the Approvals tab for this enrollment (call-list path). */
    autoApprove?: boolean;
    /** Advance the flow immediately so day-0 steps are queued for dispatch. */
    advanceNow?: boolean;
    /** Job listing the user selected — Claude personalizes off this role. */
    jobListingId?: string | null;
  },
): Promise<EnrollmentResult> {
  const settings = await getOrCreateOutreachSettings();
  await seedOutreachTemplates();

  const autoApprove =
    Boolean(options?.autoApprove) || !settings.requireApproval;
  // Advance whenever messages are approved (approval off, or call-list
  // auto-approve) so day-0 steps queue even in dry-run for preview.
  const advanceNow = Boolean(options?.advanceNow) || autoApprove;
  const shouldDispatch = settings.enabled && !settings.dryRun && autoApprove;

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
  const fromCallList = options?.actor === "call_list";
  const reason = await ineligibilityReason(
    contact,
    company.status,
    company.icpStatus,
    emailAddress,
    { bypassIcpFail: fromCallList },
  );
  if (reason) {
    if (fromCallList) {
      try {
        const { recordCallListOutreachEvent } = await import(
          "@/lib/outreach/call-list-sync"
        );
        await recordCallListOutreachEvent({
          companyId: company.id,
          contactId: contact.id,
          summary: `Outreach enroll failed: ${reason}`,
        });
      } catch {
        /* non-fatal */
      }
    }
    return { enrolled: false, reason };
  }

  const companyEnrollments = await db
    .select({ id: sequenceEnrollments.id })
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.companyId, company.id));
  if (companyEnrollments.length >= settings.maxContactsPerCompany) {
    return { enrolled: false, reason: "company contact cap reached" };
  }

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

  let focusListing =
    options?.jobListingId
      ? listings.find((l) => l.id === options.jobListingId) ?? null
      : null;
  if (options?.jobListingId && !focusListing) {
    const [pinned] = await db
      .select()
      .from(jobListings)
      .where(
        and(
          eq(jobListings.id, options.jobListingId),
          eq(jobListings.companyId, company.id),
        ),
      )
      .limit(1);
    focusListing = pinned ?? null;
  }

  const timezone = resolveContactTimezone({
    timezoneOverride: contact.timezoneOverride,
    contactLocation: contact.contactLocation,
    jobLocation:
      contact.jobLocation ?? focusListing?.location ?? listings[0]?.location,
    companyLocation: company.sourceMarket,
  });

  const specs: StepSpec[] = DEFAULT_STEP_SPECS.filter(
    (spec) => spec.channel === "email" || textEligible,
  );

  const context = buildDraftContext({
    contact,
    company,
    listings,
    focusListing,
  });

  const drafted = await draftSequence({ specs, context });
  if (!drafted) {
    const draftFailure = getLastDraftFailureReason() ?? "unknown";
    const failReason =
      draftFailure === "missing_anthropic_api_key"
        ? "drafting failed: ANTHROPIC_API_KEY missing on this deploy"
        : `drafting failed: ${draftFailure}`;
    await logEnrollmentEvent({
      eventType: "error",
      actor: options?.actor ?? "system",
      payload: {
        stage: "transactional_drafting",
        contact_id: contact.id,
        company_id: company.id,
        job_listing_id: focusListing?.id ?? null,
        draft_failure: draftFailure,
        detail: failReason,
      },
    });
    if (options?.actor === "call_list") {
      try {
        const { recordCallListOutreachEvent } = await import(
          "@/lib/outreach/call-list-sync"
        );
        await recordCallListOutreachEvent({
          companyId: company.id,
          contactId: contact.id,
          summary: `Outreach enroll failed: ${failReason}`,
        });
      } catch {
        /* non-fatal */
      }
    }
    return { enrolled: false, reason: failReason };
  }

  const { versionId } = await ensureDefaultFlow();

  const [enrollment] = await db
    .insert(sequenceEnrollments)
    .values({
      contactId: contact.id,
      companyId: company.id,
      jobListingId: focusListing?.id ?? null,
      status: "active",
      timezone,
      emailAddress,
      phoneNumber: textEligible ? phone : null,
      flowVersionId: versionId,
      currentNodeId: null,
      nodeState: options?.staggerDays
        ? {
            wait_until: new Date(
              Date.now() + options.staggerDays * 86_400_000,
            ).toISOString(),
          }
        : {},
      nextStepAt: options?.staggerDays
        ? new Date(Date.now() + options.staggerDays * 86_400_000)
        : new Date(),
    })
    .returning();

  const approvedAt = autoApprove ? new Date() : null;
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
      job_listing_id: focusListing?.id ?? null,
      primary_job_title: context.primaryJobTitle,
      timezone,
      channel_plan: textEligible ? "email_and_text" : "email_only",
      steps: drafted.map((s) => s.stepKind),
      stagger_days: options?.staggerDays ?? 0,
      job_titles: context.jobTitles,
      auto_approve: autoApprove,
    },
  });
  await logEnrollmentEvent({
    enrollmentId: enrollment.id,
    eventType: "drafted",
    payload: {
      steps: drafted.length,
      transactional: true,
      job_listing_id: focusListing?.id ?? null,
      primary_job_title: context.primaryJobTitle,
    },
  });
  if (autoApprove) {
    await logEnrollmentEvent({
      enrollmentId: enrollment.id,
      eventType: "approved",
      actor: options?.actor ?? "system",
      payload: {
        steps: drafted.length,
        source: options?.actor ?? "system",
        require_approval: settings.requireApproval,
      },
    });
  }

  try {
    const { recordCallListOutreachEvent } = await import(
      "@/lib/outreach/call-list-sync"
    );
    const plan = textEligible ? "email + SMS" : "email-only";
    const roleBit = context.primaryJobTitle
      ? ` about "${context.primaryJobTitle}"`
      : "";
    await recordCallListOutreachEvent({
      companyId: company.id,
      contactId: contact.id,
      bumpAttempt: false,
      summary: `Outreach sequence enrolled (${plan}, ${drafted.length} steps)${roleBit}${
        options?.actor === "call_list" ? " via Call List" : ""
      }. Next: ${drafted[0]?.stepKind ?? "intro"}.`,
    });
  } catch (error) {
    console.error("[outreach] call-list enroll note failed", error);
  }

  if (advanceNow) {
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

  let dispatched = false;
  if (shouldDispatch) {
    try {
      const { runOutreachDispatch } = await import("@/lib/outreach/dispatch");
      await runOutreachDispatch(new Date());
      dispatched = true;
    } catch (error) {
      console.error("[outreach] dispatch after enroll failed", error);
    }
  }

  return {
    enrolled: true,
    enrollmentId: enrollment.id,
    channelPlan: textEligible ? "email_and_text" : "email_only",
    dispatched,
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
