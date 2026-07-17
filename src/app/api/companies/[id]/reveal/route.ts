import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { companies, contacts } from "@/lib/db/schema";
import { isContactOutCreditsAvailable } from "@/lib/contactout-credits";
import {
  revealSelectedContacts,
  type RevealSelection,
} from "@/lib/enrich/discovery";
import { getCompanyById } from "@/lib/queries";
import { requestImessageCheck } from "@/lib/imessage-check";
import { contactIsCallable } from "@/lib/lead-score";
import { recomputeCompanyScores } from "@/lib/recompute-company-scores";
import { businessListDate } from "@/lib/timezone";
import { manualEnrichContext, PaidEgressBlockedError } from "@/lib/paid-egress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Reveal — paid, per selection ONLY. Spends reveal credits on the chosen
 * contact(s) and channel(s); phone is opt-in per contact. Already-revealed
 * contacts are never re-charged.
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

  let body: { selections?: Array<{ contact_id?: string; channels?: string }> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const selections: RevealSelection[] = (body.selections ?? [])
    .filter((s) => typeof s.contact_id === "string" && s.contact_id)
    .map((s) => ({
      contactId: s.contact_id!,
      channels: s.channels === "email_phone" ? "email_phone" : "email",
    }));

  if (!selections.length) {
    return NextResponse.json(
      { error: "selections[] with contact_id is required" },
      { status: 400 },
    );
  }

  const wantsPhone = selections.some((s) => s.channels === "email_phone");
  const sampleLinkedIn = wantsPhone
    ? (
        await db
          .select({ linkedinUrl: contacts.linkedinUrl })
          .from(contacts)
          .where(eq(contacts.companyId, id))
          .limit(20)
      ).find((c) => c.linkedinUrl)?.linkedinUrl ?? null
    : null;
  const contactOutAvailable =
    wantsPhone && contactOutKey
      ? await isContactOutCreditsAvailable(contactOutKey, sampleLinkedIn)
      : false;

  try {
    const result = await revealSelectedContacts({
      companyId: id,
      selections,
      apiKey,
      contactOutApiKey: contactOutKey,
      contactOutAvailable,
      context: manualEnrichContext(id),
    });

    // Same post-enrich promotion the legacy flow uses: callable → call sheet.
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
    if (
      finalContacts.some((c) => c.personalEmail && c.imessageCapable == null)
    ) {
      await requestImessageCheck();
    }

    revalidatePath("/crm");
    revalidatePath(`/companies/${id}`);

    const company = await getCompanyById(id);
    return NextResponse.json({
      ok: true,
      ...result,
      company,
      message:
        result.revealed > 0
          ? `Revealed ${result.revealed} contact${result.revealed === 1 ? "" : "s"} — ${result.emailsFound} email${result.emailsFound === 1 ? "" : "s"}, ${result.phonesFound} phone${result.phonesFound === 1 ? "" : "s"} found`
          : result.skippedAlreadyRevealed > 0
            ? "Already revealed — no credits spent"
            : "No contact data found for the selection",
    });
  } catch (err) {
    if (err instanceof PaidEgressBlockedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    const message = err instanceof Error ? err.message : "Reveal failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
