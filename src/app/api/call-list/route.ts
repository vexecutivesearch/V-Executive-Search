import { eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  callListEntries,
  companies,
  companyActivities,
  contacts,
} from "@/lib/db/schema";
import { isCallStatus } from "@/lib/call-status";
import { contactIsCallable } from "@/lib/lead-score";
import { compareContactsForOutreach } from "@/lib/contact-title-priority";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Call-list add LLM-drafts a full outreach sequence for EVERY enriched
 * contact at the company (up to maxContactsPerCompany, in parallel — each
 * contact's sequence takes ~15–25s of Claude drafting, worst case more when
 * the sanitizer forces retries).
 */
export const maxDuration = 120;

/** List entries, or check membership for one company (?company_id=). */
export async function GET(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get("company_id");

  if (companyId) {
    const [entry] = await db
      .select()
      .from(callListEntries)
      .where(eq(callListEntries.companyId, companyId))
      .limit(1);
    return NextResponse.json({ entry: entry ?? null });
  }

  const entries = await db
    .select()
    .from(callListEntries)
    .orderBy(
      sql`GREATEST(
        COALESCE(${callListEntries.lastContactAt}, 'epoch'::timestamp),
        COALESCE(${callListEntries.callStatusUpdatedAt}, 'epoch'::timestamp),
        ${callListEntries.updatedAt}
      ) DESC`,
    );
  return NextResponse.json({ entries });
}

type OutreachAttempt = {
  /** True when at least one contact enrolled (primary's result leads). */
  enrolled: boolean;
  enrollmentId?: string;
  channelPlan?: string;
  reason?: string;
  dispatched?: boolean;
  /** Multi-contact detail (companies typically have 2–3 enriched contacts). */
  contactsEnrolled?: number;
  contactsAttempted?: number;
  /** Channel plan per enrolled contact, primary first. */
  contactPlans?: string[];
};

/**
 * Enroll every reachable contact at the company in outreach; never throws.
 * All contacts are enrolled (and drafted) BEFORE the single dispatch pass —
 * the first send flips the company to "contacted", which would make any
 * later enroll refuse.
 */
async function attemptCompanyOutreach(
  companyId: string,
  primaryContactId: string | null,
  jobListingId: string | null,
): Promise<OutreachAttempt | null> {
  try {
    const { getOrCreateOutreachSettings } = await import(
      "@/lib/outreach/settings"
    );
    const settings = await getOrCreateOutreachSettings();
    if (!settings.autoEnroll) {
      return { enrolled: false, reason: "auto_enroll disabled" };
    }
    const { enrollCompanyContacts } = await import("@/lib/outreach/enroll");
    const summary = await enrollCompanyContacts({
      companyId,
      primaryContactId,
      jobListingId,
      actor: "call_list",
      autoApprove: true,
      advanceNow: true,
    });
    // Nothing eligible (cap reached / everyone already enrolled): stay quiet,
    // like the old single-contact retry did.
    if (!summary.outcomes.length) return null;

    const enrolledOutcomes = summary.outcomes.filter((o) => o.result.enrolled);
    const primary =
      summary.outcomes.find((o) => o.contactId === primaryContactId) ??
      summary.outcomes[0];
    const lead = primary.result.enrolled
      ? primary.result
      : enrolledOutcomes[0]?.result;

    return {
      enrolled: enrolledOutcomes.length > 0,
      ...(lead?.enrolled
        ? { enrollmentId: lead.enrollmentId, channelPlan: lead.channelPlan }
        : {}),
      ...(!enrolledOutcomes.length && !primary.result.enrolled
        ? { reason: primary.result.reason }
        : {}),
      dispatched: summary.dispatched,
      contactsEnrolled: enrolledOutcomes.length,
      contactsAttempted: summary.outcomes.length,
      contactPlans: enrolledOutcomes.map((o) =>
        o.result.enrolled ? o.result.channelPlan : "",
      ),
    };
  } catch (error) {
    console.error("[call-list] outreach enroll failed (non-fatal):", error);
    return { enrolled: false, reason: "enroll_error" };
  }
}

/** Approve a company onto the call list ("Add to Call List: Yes"). */
export async function POST(request: NextRequest) {
  let body: {
    company_id?: string;
    contact_id?: string;
    job_listing_id?: string;
    call_status?: string;
    assigned_to?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const companyId = body.company_id?.trim();
  if (!companyId) {
    return NextResponse.json({ error: "company_id is required" }, { status: 400 });
  }

  const jobListingId = body.job_listing_id?.trim() || null;

  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!company) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }

  // Do Not Contact has to mean it here too. Enrollment already refuses these
  // (setCompanyReviewStatus parks them at status 'skipped'), but without this
  // the row would still land on the Call List and in the CSV export as if it
  // were callable.
  if (company.reviewStatus === "do_not_contact") {
    return NextResponse.json(
      {
        error:
          "This company is marked Do Not Contact. Change the review status before adding it to the call list.",
      },
      { status: 409 },
    );
  }

  const [existing] = await db
    .select()
    .from(callListEntries)
    .where(eq(callListEntries.companyId, companyId))
    .limit(1);
  if (existing) {
    // Re-adding is the natural retry after a failed enroll (e.g. the email
    // hadn't been verified yet when the row was first added). Retry every
    // eligible contact still missing an enrollment; when everyone is already
    // enrolled (or the company cap is reached) this returns null and stays
    // quiet.
    const outreach = await attemptCompanyOutreach(
      companyId,
      existing.primaryContactId,
      jobListingId ?? existing.jobListingId,
    );
    return NextResponse.json({ entry: existing, already_on_list: true, outreach });
  }

  // Primary contact: explicit pick, else best callable by outreach priority.
  let primaryContactId = body.contact_id?.trim() || null;
  if (!primaryContactId) {
    const companyContacts = await db
      .select()
      .from(contacts)
      .where(eq(contacts.companyId, companyId));
    const best = [...companyContacts]
      .filter(contactIsCallable)
      .sort(compareContactsForOutreach)[0];
    primaryContactId = best?.id ?? null;
  }

  const callStatus =
    body.call_status && isCallStatus(body.call_status)
      ? body.call_status
      : "ready_to_call";

  const [entry] = await db
    .insert(callListEntries)
    .values({
      companyId,
      primaryContactId,
      jobListingId,
      callStatus,
      assignedTo: body.assigned_to?.trim() || null,
    })
    .onConflictDoNothing({ target: callListEntries.companyId })
    .returning();

  if (!entry) {
    const [raced] = await db
      .select()
      .from(callListEntries)
      .where(eq(callListEntries.companyId, companyId))
      .limit(1);
    return NextResponse.json({ entry: raced, already_on_list: true });
  }

  await db.insert(companyActivities).values({
    companyId,
    contactId: primaryContactId,
    type: "note",
    summary: jobListingId
      ? "Added to call list (outreach pinned to selected job listing)"
      : "Added to call list",
    source: "call_list",
  });

  // Outreach: adding to the call list is the intentional trigger — draft a
  // personalized sequence for EVERY reachable contact off the selected job
  // listing, auto-approve, and advance so day-0 steps are queued. One
  // dispatch pass runs after all contacts are enrolled; actual send still
  // respects Master send + dry-run on the Outreach Overview tab.
  let outreach: OutreachAttempt | null = null;
  if (primaryContactId) {
    outreach = await attemptCompanyOutreach(
      companyId,
      primaryContactId,
      jobListingId,
    );
  } else {
    outreach = { enrolled: false, reason: "no primary contact" };
  }

  if (outreach && !outreach.enrolled && primaryContactId) {
    // enrollContact already notes most failures; catch empty primary / disabled.
    if (
      outreach.reason === "auto_enroll disabled" ||
      outreach.reason === "enroll_error"
    ) {
      try {
        const { recordCallListOutreachEvent } = await import(
          "@/lib/outreach/call-list-sync"
        );
        await recordCallListOutreachEvent({
          companyId,
          contactId: primaryContactId,
          summary: `Outreach enroll failed: ${outreach.reason}`,
        });
      } catch {
        /* non-fatal */
      }
    }
  }

  return NextResponse.json({ entry, already_on_list: false, outreach });
}
