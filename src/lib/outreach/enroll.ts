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
  getLastDraftViolations,
  type StepSpec,
} from "@/lib/outreach-draft";
import { verifyEmailAddress } from "@/lib/email-verify";
import { contactIsCallable } from "@/lib/lead-score";
import { compareContactsForOutreach } from "@/lib/contact-title-priority";
import {
  channelPlanLabel,
  channelPlanReasonLabel,
  explainChannelPlan,
  filterStepSpecsForPlan,
  type ChannelPlan,
} from "@/lib/outreach/channel-plan";
import { pickPhone } from "@/lib/outreach/contact-handles";
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
      channelPlan: ChannelPlan;
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

/**
 * Why the picked email cannot carry the sequence, or null when it can.
 * Unverified emails are MX-checked inline and persisted, so a lead is
 * enrollable the moment it's added (the daily verify pass may not have
 * reached a same-day import yet).
 */
async function emailUnusableReason(
  contact: Contact,
  emailAddress: string | null,
): Promise<string | null> {
  if (!emailAddress) return "no email address";
  if (contact.emailDeliverable === false) return "email not deliverable";
  if (contact.emailDeliverable !== true) {
    const verdict = await verifyEmailAddress(emailAddress);
    await db
      .update(contacts)
      .set({
        emailDeliverable: verdict.deliverable,
        emailVerifiedAt: new Date(),
      })
      .where(eq(contacts.id, contact.id));
    if (!verdict.deliverable) {
      return `email not deliverable (${verdict.reason})`;
    }
  }
  return null;
}

/** Eligibility per the confirmed enrollment rules. Returns null when OK. */
async function ineligibilityReason(
  contact: Contact,
  companyStatus: string,
  icpStatus: string,
  channels: {
    /** Email that will carry the sequence, or null for text-only plans. */
    emailAddress: string | null;
    /** Phone that will carry a text-only sequence, or null. */
    textOnlyPhone: string | null;
  },
  options?: { bypassIcpFail?: boolean },
): Promise<string | null> {
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

  if (channels.emailAddress) {
    const emailSupp = await isSuppressed({
      channel: "email",
      email: channels.emailAddress,
    });
    if (emailSupp.suppressed) return `email suppressed (${emailSupp.reason})`;
  }
  if (channels.textOnlyPhone) {
    // A text-only plan lives or dies on this one number.
    const phoneSupp = await isSuppressed({
      channel: "imessage",
      phone: channels.textOnlyPhone,
    });
    if (phoneSupp.suppressed) return `phone suppressed (${phoneSupp.reason})`;
  }

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
    /**
     * Skip the internal dispatch pass. Multi-contact callers must enroll
     * every contact first and dispatch once at the end: the first send flips
     * the company to "contacted", which would make every later enroll refuse
     * with "company status is contacted".
     */
    deferDispatch?: boolean;
  },
): Promise<EnrollmentResult> {
  const settings = await getOrCreateOutreachSettings();
  await seedOutreachTemplates();

  const autoApprove =
    Boolean(options?.autoApprove) || !settings.requireApproval;
  // Advance whenever messages are approved (approval off, or call-list
  // auto-approve) so day-0 steps queue even in dry-run for preview.
  const advanceNow = Boolean(options?.advanceNow) || autoApprove;
  const shouldDispatch =
    settings.enabled &&
    !settings.dryRun &&
    autoApprove &&
    !options?.deferDispatch;

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

  const pickedEmail = pickEmail(contact, settings.workEmailPreferred);
  const phone = pickPhone(contact);
  const fromCallList = options?.actor === "call_list";

  // A missing or undeliverable email is only fatal when there is no phone to
  // fall back to — otherwise the contact enrolls with a text-only plan (the
  // Mac worker's IDS check + SMS fallback can text any number).
  const emailReason = await emailUnusableReason(contact, pickedEmail);
  if (emailReason && !phone) {
    if (fromCallList) {
      try {
        const { recordCallListOutreachEvent } = await import(
          "@/lib/outreach/call-list-sync"
        );
        await recordCallListOutreachEvent({
          companyId: company.id,
          contactId: contact.id,
          summary: `Outreach enroll failed: ${emailReason} (and no phone number)`,
        });
      } catch {
        /* non-fatal */
      }
    }
    return { enrolled: false, reason: emailReason };
  }
  const textOnly = Boolean(emailReason);
  const emailAddress = textOnly ? null : pickedEmail;

  const reason = await ineligibilityReason(
    contact,
    company.status,
    company.icpStatus,
    { emailAddress, textOnlyPhone: textOnly ? phone : null },
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

  // Email plans only add text steps for verified iMessage numbers; text-only
  // plans take any phone (worker falls back to SMS when IDS says no iMessage).
  let phoneSuppressed = false;
  if (!textOnly && contact.imessageCapable === true && phone) {
    const phoneSupp = await isSuppressed({ channel: "imessage", phone });
    phoneSuppressed = phoneSupp.suppressed;
  }
  const { plan: channelPlan, reason: channelPlanReason } = explainChannelPlan({
    emailUsable: !textOnly,
    hasPhone: Boolean(phone),
    imessageCapable: contact.imessageCapable,
    phoneSuppressed,
  });
  if (!channelPlan) {
    // Unreachable in practice: no-email-no-phone already failed above.
    return { enrolled: false, reason: "no reachable channel" };
  }
  const textEligible = channelPlan === "email_and_text";

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

  const specs: StepSpec[] = filterStepSpecsForPlan(
    channelPlan,
    DEFAULT_STEP_SPECS,
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
    const { step, violations } = getLastDraftViolations();
    // Name the step and the lint that stopped it, so the note in the CRM is
    // enough to act on without opening the deploy logs.
    const because = violations.length
      ? ` (${step ?? "unknown step"}: ${violations.join("; ")})`
      : step
        ? ` (${step})`
        : "";
    const failReason =
      draftFailure === "missing_anthropic_api_key"
        ? "drafting failed: ANTHROPIC_API_KEY missing on this deploy"
        : `drafting failed: ${draftFailure}${because}`;
    await logEnrollmentEvent({
      eventType: "error",
      actor: options?.actor ?? "system",
      payload: {
        stage: "transactional_drafting",
        contact_id: contact.id,
        company_id: company.id,
        job_listing_id: focusListing?.id ?? null,
        draft_failure: draftFailure,
        failed_step: step,
        violations,
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
          summary: `Outreach enroll failed: ${failReason}`.slice(0, 400),
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
      phoneNumber: textOnly || textEligible ? phone : null,
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
      channel_plan: channelPlan,
      channel_plan_reason: channelPlanReason,
      imessage_capable: contact.imessageCapable,
      has_phone: Boolean(phone),
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
    const plan = channelPlanLabel(channelPlan);
    // Name why text steps were left off — otherwise "email only" reads as a
    // sequencer fault rather than missing contact data.
    const planBit =
      channelPlan === "email_only"
        ? `${plan} — ${channelPlanReasonLabel(channelPlanReason)}`
        : plan;
    const roleBit = context.primaryJobTitle
      ? ` about "${context.primaryJobTitle}"`
      : "";
    await recordCallListOutreachEvent({
      companyId: company.id,
      contactId: contact.id,
      bumpAttempt: false,
      summary: `Outreach sequence enrolled (${planBit}, ${drafted.length} steps)${roleBit}${
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
    channelPlan,
    dispatched,
  };
}

export type CompanyEnrollmentOutcome = {
  contactId: string;
  contactName: string;
  result: EnrollmentResult;
};

export type CompanyEnrollmentSummary = {
  /** One outcome per contact attempted (empty when nothing was eligible). */
  outcomes: CompanyEnrollmentOutcome[];
  enrolledCount: number;
  /** True when a single live dispatch pass ran after ALL enrolls. */
  dispatched: boolean;
};

/**
 * Enroll every reachable contact at a company (capped by
 * maxContactsPerCompany, ordered by outreach title priority, the given
 * primary first), then run ONE dispatch pass at the end.
 *
 * Drafting runs in parallel across contacts — each Claude sequence takes
 * ~15–25s and the call-list route has a hard time budget. Dispatch MUST stay
 * deferred until every contact is enrolled: the first send flips the company
 * to "contacted", after which enrollContact refuses new enrollments.
 */
export async function enrollCompanyContacts(options: {
  companyId: string;
  /** Stays first in the enroll order; falls back to title priority. */
  primaryContactId?: string | null;
  jobListingId?: string | null;
  actor?: string;
  autoApprove?: boolean;
  advanceNow?: boolean;
}): Promise<CompanyEnrollmentSummary> {
  const settings = await getOrCreateOutreachSettings();

  const companyContacts = await db
    .select()
    .from(contacts)
    .where(eq(contacts.companyId, options.companyId));

  const priorEnrollments = await db
    .select({ contactId: sequenceEnrollments.contactId })
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.companyId, options.companyId));
  const alreadyEnrolled = new Set(priorEnrollments.map((r) => r.contactId));
  const capRemaining = Math.max(
    0,
    settings.maxContactsPerCompany - priorEnrollments.length,
  );

  const ordered = companyContacts
    .filter(contactIsCallable)
    .filter((c) => !alreadyEnrolled.has(c.id))
    .sort(compareContactsForOutreach);
  if (options.primaryContactId) {
    const idx = ordered.findIndex((c) => c.id === options.primaryContactId);
    if (idx > 0) ordered.unshift(...ordered.splice(idx, 1));
  }
  const targets = ordered.slice(0, capRemaining);
  if (!targets.length) {
    return { outcomes: [], enrolledCount: 0, dispatched: false };
  }

  // Pre-warm shared idempotent state once so the parallel enrolls below can
  // only ever hit the row-exists path (no first-insert races).
  await seedOutreachTemplates();
  await ensureDefaultFlow();

  const outcomes: CompanyEnrollmentOutcome[] = await Promise.all(
    targets.map(async (contact) => ({
      contactId: contact.id,
      contactName: contact.name,
      result: await enrollContact(contact.id, {
        actor: options.actor,
        autoApprove: options.autoApprove,
        advanceNow: options.advanceNow,
        jobListingId: options.jobListingId ?? null,
        deferDispatch: true,
      }),
    })),
  );

  const enrolledCount = outcomes.filter((o) => o.result.enrolled).length;
  let dispatched = false;
  const autoApprove = Boolean(options.autoApprove) || !settings.requireApproval;
  if (enrolledCount > 0 && settings.enabled && !settings.dryRun && autoApprove) {
    try {
      const { runOutreachDispatch } = await import("@/lib/outreach/dispatch");
      await runOutreachDispatch(new Date());
      dispatched = true;
    } catch (error) {
      console.error("[outreach] dispatch after multi-enroll failed", error);
    }
  }

  return { outcomes, enrolledCount, dispatched };
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
