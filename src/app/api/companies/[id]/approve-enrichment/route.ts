import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { companies, contacts } from "@/lib/db/schema";
import { isContactOutCreditsAvailable } from "@/lib/contactout-credits";
import { setCompanyReviewStatus } from "@/lib/discovery/review-queue";
import { revealSingleDecisionMaker } from "@/lib/enrich/single-contact";
import { contactIsCallable } from "@/lib/lead-score";
import { recomputeCompanyScores } from "@/lib/recompute-company-scores";
import { businessListDate } from "@/lib/timezone";
import { manualEnrichContext, PaidEgressBlockedError } from "@/lib/paid-egress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Approve for Enrichment — the ONE paid step of company-first discovery.
 * Reveals exactly one top-ranked decision-maker for the company's vertical,
 * verifies the email, and stops. `{ additional: true }` is the explicit
 * "Find Additional Contact" action that reveals one more.
 *
 * Phone is opt-in (`include_phone`), NOT defaulted on, and the mobile comes
 * from ContactOut only — 1 ContactOut credit, no 9-credit Apollo mobile
 * fallback on this path.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "APOLLO_API_KEY is not configured." },
      { status: 503 },
    );
  }
  const contactOutKey = process.env.CONTACTOUT_API_KEY;
  const { id } = await params;

  let body: { include_phone?: boolean; additional?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    // empty body = approve with the email-only default
  }
  const includePhone = body.include_phone === true;
  const additional = body.additional === true;

  // ContactOut stays the first leg of the waterfall (cheapest reliable source).
  const sampleLinkedIn =
    (
      await db
        .select({ linkedinUrl: contacts.linkedinUrl })
        .from(contacts)
        .where(eq(contacts.companyId, id))
        .limit(20)
    ).find((c) => c.linkedinUrl)?.linkedinUrl ?? null;
  const contactOutAvailable = contactOutKey
    ? await isContactOutCreditsAvailable(contactOutKey, sampleLinkedIn)
    : false;

  try {
    if (!additional) {
      await setCompanyReviewStatus(id, "approved");
    }

    const result = await revealSingleDecisionMaker({
      companyId: id,
      apiKey,
      contactOutApiKey: contactOutKey,
      contactOutAvailable,
      includePhone,
      allowAdditional: additional,
      context: manualEnrichContext(id),
    });

    const finalContacts = await db
      .select()
      .from(contacts)
      .where(eq(contacts.companyId, id));
    if (finalContacts.some(contactIsCallable)) {
      await db
        .update(companies)
        .set({
          enrichRunDate: businessListDate(),
          enrichedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(companies.id, id));
      await recomputeCompanyScores([id]);
    }

    revalidatePath("/crm");
    revalidatePath(`/companies/${id}`);

    return NextResponse.json({
      ok: true,
      ...result,
      cost_note: includePhone
        ? "One contact revealed: 1 Apollo email credit + 1 ContactOut credit for the mobile. Apollo's 9-credit mobile is never used here."
        : "One contact revealed: 1 Apollo email credit. Mobile was not requested.",
    });
  } catch (err) {
    if (err instanceof PaidEgressBlockedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    const message = err instanceof Error ? err.message : "Enrichment failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
