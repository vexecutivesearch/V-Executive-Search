import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { contacts, sequenceEnrollments } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only outreach channel diagnostics.
 *
 * "email only" on an enrollment means exactly one thing — no phone number was
 * attached — but that has several possible upstream causes. This separates
 * them so the fix is obvious: contacts with no phone at all (an enrichment
 * problem) versus contacts that have a phone but never got an iMessage
 * capability answer (a Mac worker problem).
 */
export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const hasPhone = or(
    isNotNull(contacts.personalPhone),
    isNotNull(contacts.phone),
  );

  const [contactStats] = await db
    .select({
      total: sql<number>`count(*)`,
      withPhone: sql<number>`count(*) filter (where ${hasPhone})`,
      withoutPhone: sql<number>`count(*) filter (where not ${hasPhone})`,
      capabilityUnknown: sql<number>`count(*) filter (where ${contacts.imessageCapable} is null)`,
      capabilityTrue: sql<number>`count(*) filter (where ${contacts.imessageCapable} = true)`,
      capabilityFalse: sql<number>`count(*) filter (where ${contacts.imessageCapable} = false)`,
      textReady: sql<number>`count(*) filter (where ${hasPhone} and ${contacts.imessageCapable} = true)`,
      phoneButNoCapability: sql<number>`count(*) filter (where ${hasPhone} and ${contacts.imessageCapable} is null)`,
    })
    .from(contacts);

  const [enrollmentStats] = await db
    .select({
      total: sql<number>`count(*)`,
      withPhone: sql<number>`count(*) filter (where ${sequenceEnrollments.phoneNumber} is not null)`,
      emailOnly: sql<number>`count(*) filter (where ${sequenceEnrollments.phoneNumber} is null and ${sequenceEnrollments.emailAddress} is not null)`,
      textOnly: sql<number>`count(*) filter (where ${sequenceEnrollments.emailAddress} is null and ${sequenceEnrollments.phoneNumber} is not null)`,
    })
    .from(sequenceEnrollments);

  // Enrollments that are email-only even though the contact now has a phone —
  // these were enrolled before the number arrived and will not pick it up,
  // because the channel plan is fixed at enroll time.
  const [staleEmailOnly] = await db
    .select({ count: sql<number>`count(*)` })
    .from(sequenceEnrollments)
    .innerJoin(contacts, eq(contacts.id, sequenceEnrollments.contactId))
    .where(
      and(
        isNull(sequenceEnrollments.phoneNumber),
        hasPhone,
        ne(sequenceEnrollments.status, "stopped"),
      ),
    );

  const problems: string[] = [];
  const n = (v: unknown) => Number(v ?? 0);

  if (n(contactStats?.withoutPhone) > 0 && n(contactStats?.total) > 0) {
    const pct = Math.round(
      (n(contactStats.withoutPhone) / n(contactStats.total)) * 100,
    );
    if (pct >= 50) {
      problems.push(
        `${pct}% of contacts (${n(contactStats.withoutPhone)}/${n(contactStats.total)}) have no phone number — text steps are impossible for them. Check ContactOut phone enrichment.`,
      );
    }
  }
  if (n(contactStats?.phoneButNoCapability) > 0) {
    problems.push(
      `${n(contactStats.phoneButNoCapability)} contact(s) have a phone but no iMessage capability answer — the Mac worker check has not run for them, so they enroll email-only despite being textable.`,
    );
  }
  if (n(staleEmailOnly?.count) > 0) {
    problems.push(
      `${n(staleEmailOnly.count)} active enrollment(s) are email-only but their contact now has a phone. The channel plan is fixed at enroll time, so these will never text — re-enroll them to pick up the number.`,
    );
  }

  return NextResponse.json({
    ok: problems.length === 0,
    contacts: {
      total: n(contactStats?.total),
      with_phone: n(contactStats?.withPhone),
      without_phone: n(contactStats?.withoutPhone),
      imessage_capability_unknown: n(contactStats?.capabilityUnknown),
      imessage_capability_true: n(contactStats?.capabilityTrue),
      imessage_capability_false: n(contactStats?.capabilityFalse),
      text_ready: n(contactStats?.textReady),
      phone_but_no_capability_answer: n(contactStats?.phoneButNoCapability),
    },
    enrollments: {
      total: n(enrollmentStats?.total),
      email_and_text: n(enrollmentStats?.withPhone),
      email_only: n(enrollmentStats?.emailOnly),
      text_only: n(enrollmentStats?.textOnly),
      email_only_but_contact_now_has_phone: n(staleEmailOnly?.count),
    },
    notes: [
      "An enrollment's CHANNELS column is derived purely from whether a phone number was attached at enroll time.",
      "contacts.imessage_capable is an address well-formedness check, NOT a verified Apple ID match — it returns true for effectively any valid address. The real iMessage-vs-SMS decision happens at send time against Apple's IDS registry, which is keyed on phone numbers.",
      "Because of that, sending iMessage to an email handle is not currently supported anywhere in the send path: enrollments store only a phone number, and the worker queue filters on it.",
    ],
    problems,
  });
}
