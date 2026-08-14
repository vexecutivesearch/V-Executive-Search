import { eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  callListEntries,
  companies,
  companyActivities,
  contacts,
  sequenceEnrollments,
} from "@/lib/db/schema";
import { isCallStatus } from "@/lib/call-status";
import { contactIsCallable } from "@/lib/lead-score";
import { compareContactsForOutreach } from "@/lib/contact-title-priority";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Call-list add may LLM-draft a full outreach sequence. */
export const maxDuration = 60;

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
  enrolled: boolean;
  enrollmentId?: string;
  channelPlan?: string;
  reason?: string;
  dispatched?: boolean;
};

/** Enroll a call-list contact in outreach; never throws. */
async function attemptOutreachEnroll(
  contactId: string,
  jobListingId: string | null,
): Promise<OutreachAttempt> {
  try {
    const { getOrCreateOutreachSettings } = await import(
      "@/lib/outreach/settings"
    );
    const settings = await getOrCreateOutreachSettings();
    if (!settings.autoEnroll) {
      return { enrolled: false, reason: "auto_enroll disabled" };
    }
    const { enrollContact } = await import("@/lib/outreach/enroll");
    const result = await enrollContact(contactId, {
      actor: "call_list",
      autoApprove: true,
      advanceNow: true,
      jobListingId,
    });
    return { ...result };
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

  const [existing] = await db
    .select()
    .from(callListEntries)
    .where(eq(callListEntries.companyId, companyId))
    .limit(1);
  if (existing) {
    // Re-adding is the natural retry after a failed enroll (e.g. the email
    // hadn't been verified yet when the row was first added). If the primary
    // contact never got an enrollment, attempt outreach again now.
    let outreach: OutreachAttempt | null = null;
    const retryContactId = existing.primaryContactId;
    if (retryContactId) {
      const [prior] = await db
        .select({ id: sequenceEnrollments.id })
        .from(sequenceEnrollments)
        .where(eq(sequenceEnrollments.contactId, retryContactId))
        .limit(1);
      if (!prior) {
        outreach = await attemptOutreachEnroll(
          retryContactId,
          jobListingId ?? existing.jobListingId,
        );
      }
    }
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
  // personalized email+SMS sequence off the selected job listing, auto-approve,
  // and advance so day-0 email + SMS are queued. Actual send still respects
  // Master send + dry-run on the Outreach Overview tab (enroll runs dispatch
  // when enabled && !dryRun).
  let outreach: OutreachAttempt | null = null;
  if (primaryContactId) {
    outreach = await attemptOutreachEnroll(primaryContactId, jobListingId);
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
