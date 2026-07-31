/**
 * Seed one live test lead for the end to end sequence check: Miguel at Autism
 * One, hiring an ABA Therapy Assistant.
 *
 * Writes company + contact + job listing and nothing else. No enrollment, no
 * call_list_entries row, nothing drafted or queued — same shape as the v12
 * clean slate seeds, because the whole point of the test is to drive
 * add to Call List → enroll → day 0 email and SMS → reply → auto reply with
 * the booking link from the UI.
 *
 * Refuses to write when it would create a second record on this email or phone
 * (two records on one identifier is what breaks inbound reply matching, which
 * is keyed on the enrollment's address and number) or when either identifier is
 * suppressed, since enrollment would then reject the lead. Re-running after a
 * successful seed reports the existing ids and writes nothing.
 *
 * `--remove` tears the lead back down so the test can be run again from a clean
 * slate: every row this company owns, children first, plus any suppression this
 * lead's own email or phone picked up during the test. It touches nothing
 * outside this company, and like the seed it does nothing without `--apply`.
 *
 * Usage:
 *   npx tsx scripts/seed-lead-autism-one.ts                    # dry run, writes nothing
 *   npx tsx scripts/seed-lead-autism-one.ts --apply            # write
 *   npx tsx scripts/seed-lead-autism-one.ts --remove --apply   # tear back down
 *
 * Requires DATABASE_URL in .env.local.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  callListEntries,
  companies,
  companyActivities,
  companyIcp,
  contacts,
  enrollmentEvents,
  inboundMessages,
  jobListings,
  outreachMessages,
  sequenceEnrollments,
  suppressions,
} from "@/lib/db/schema";
import { jobUrlFingerprint } from "@/lib/hiring-signals";

const APPLY = process.argv.includes("--apply");
const REMOVE = process.argv.includes("--remove");

/**
 * Everything about the lead in one place.
 *
 * The 239 number is a Naples / Fort Myers area code, but the market and the
 * role location are set to West Palm Beach so the lead lands inside the CRM's
 * working market instead of hiding behind a market filter. Change `market` and
 * the locations together if you want it to sit in Naples instead.
 */
const LEAD = {
  company: {
    name: "Autism One",
    domain: "autism.one",
    industry: "Healthcare & Life Sciences",
    estimatedEmployees: 14,
    leadScore: 74,
    // One listing, so not multiple_openings; a reposted role is what makes a
    // single opening worth a call and keeps the lead in the hot filter.
    hiringSignals: { reposted_role: true },
    market: "West Palm Beach, FL",
    /**
     * The listing blurb. This is the one field the drafter reads as free text
     * (it reaches the prompt as the internal reason to call note), so it is
     * written the way the copy should sound: no dashes, no test harness
     * chatter that Claude could echo into a real email.
     */
    reasonToCall:
      "Hiring an ABA Therapy Assistant to support BCBA supervised sessions for children on the autism spectrum: running one to one therapy plans, logging session data, and coaching parents so the program carries over at home. Full time in clinic, RBT certification preferred but they will train the right candidate. Small practice with no in house recruiter, so the owner is screening applicants himself.",
    callOpener:
      "Hi Miguel, saw Autism One is hiring an ABA Therapy Assistant and figured it would be worth a quick intro.",
  },
  contact: {
    name: "Miguel",
    title: "Owner",
    email: "miguel@autism.one",
    /** E.164 — the worker and the inbound matcher both normalize to this. */
    phone: "+12397890148",
    location: "West Palm Beach, FL",
  },
  listing: {
    title: "ABA Therapy Assistant",
    url: "https://autism.one/careers",
    location: "West Palm Beach, FL",
  },
} as const;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
  }
}

type Holder = { id: string; contact: string; company: string };

async function holdersOfEmail(email: string): Promise<Holder[]> {
  const value = email.toLowerCase();
  return db
    .select({
      id: contacts.id,
      contact: contacts.name,
      company: companies.name,
    })
    .from(contacts)
    .innerJoin(companies, eq(companies.id, contacts.companyId))
    .where(sql`lower(coalesce(${contacts.email}, '')) = ${value}
      or lower(coalesce(${contacts.workEmail}, '')) = ${value}
      or lower(coalesce(${contacts.personalEmail}, '')) = ${value}
      or lower(${contacts.personalEmails}::text) like ${`%${value}%`}`);
}

async function holdersOfPhone(phone: string): Promise<Holder[]> {
  return db
    .select({
      id: contacts.id,
      contact: contacts.name,
      company: companies.name,
    })
    .from(contacts)
    .innerJoin(companies, eq(companies.id, contacts.companyId))
    .where(sql`${contacts.phone} = ${phone}
      or ${contacts.personalPhone} = ${phone}
      or ${contacts.companyPhone} = ${phone}
      or ${contacts.phones}::text like ${`%${phone}%`}`);
}

async function suppressionsForLead() {
  const email = LEAD.contact.email.toLowerCase();
  return db
    .select({
      channel: suppressions.channel,
      reason: suppressions.reason,
      email: suppressions.email,
      phone: suppressions.phone,
    })
    .from(suppressions)
    .where(sql`lower(coalesce(${suppressions.email}, '')) = ${email}
      or ${suppressions.phone} = ${LEAD.contact.phone}`);
}

async function existingCompany() {
  const [row] = await db
    .select({ id: companies.id, name: companies.name, status: companies.status })
    .from(companies)
    .where(
      sql`lower(coalesce(${companies.domain}, '')) = ${LEAD.company.domain}
        or lower(trim(${companies.name})) = ${LEAD.company.name.toLowerCase()}`,
    )
    .limit(1);
  return row ?? null;
}

async function preflight(): Promise<boolean> {
  console.log("\n=== preflight ===");
  let ok = true;

  const emailHolders = await holdersOfEmail(LEAD.contact.email);
  if (emailHolders.length) {
    ok = false;
    console.error(
      `  ABORT  ${LEAD.contact.email} is already on ${emailHolders.length} contact(s): ` +
        `${JSON.stringify(emailHolders)}\n` +
        "         Two records on one address make inbound replies ambiguous. Delete the old one first.",
    );
  } else {
    console.log(`  ok     ${LEAD.contact.email} is unused`);
  }

  const phoneHolders = await holdersOfPhone(LEAD.contact.phone);
  if (phoneHolders.length) {
    ok = false;
    console.error(
      `  ABORT  ${LEAD.contact.phone} is already on ${phoneHolders.length} contact(s): ` +
        `${JSON.stringify(phoneHolders)}\n` +
        "         The worker watchlist and the inbound matcher both key on the number. Delete the old one first.",
    );
  } else {
    console.log(`  ok     ${LEAD.contact.phone} is unused`);
  }

  const suppressed = await suppressionsForLead();
  if (suppressed.length) {
    ok = false;
    console.error(
      `  ABORT  this lead is suppressed: ${JSON.stringify(suppressed)}\n` +
        "         A suppressed address stops enrollment outright, and a suppressed number\n" +
        "         silently drops the SMS half of the sequence. Clear the row first.",
    );
  } else {
    console.log("  ok     neither identifier is suppressed");
  }

  return ok;
}

async function seed() {
  const [company] = await db
    .insert(companies)
    .values({
      name: LEAD.company.name,
      domain: LEAD.company.domain,
      domainConfidence: "high",
      status: "new",
      firstSeen: new Date().toISOString().slice(0, 10),
      leadScore: LEAD.company.leadScore,
      hiringSignals: LEAD.company.hiringSignals,
      reasonToCall: LEAD.company.reasonToCall,
      callOpener: LEAD.company.callOpener,
      icpStatus: "pass",
      estimatedEmployees: LEAD.company.estimatedEmployees,
      industry: LEAD.company.industry,
      // enrichedAt stays null so the lead is still a candidate for an enrich
      // run; the contact below is already complete enough to enroll without one.
      sourceMarket: LEAD.company.market,
    })
    .returning({ id: companies.id });

  // imessage_capable drives channel_plan at enrollment: true plus a number
  // gives email_and_text, which is the pair this test is checking.
  const [contact] = await db
    .insert(contacts)
    .values({
      companyId: company!.id,
      name: LEAD.contact.name,
      title: LEAD.contact.title,
      email: LEAD.contact.email,
      workEmail: LEAD.contact.email,
      personalEmail: LEAD.contact.email,
      phone: LEAD.contact.phone,
      personalPhone: LEAD.contact.phone,
      phones: [
        { number: LEAD.contact.phone, source: "apollo", kind: "mobile" },
      ],
      sourceProvider: "manual_test",
      imessageCapable: true,
      emailDeliverable: true,
      locationMatched: true,
      contactLocation: LEAD.contact.location,
      jobLocation: LEAD.contact.location,
      revealStatus: "revealed",
      revealChannels: "email_phone",
      isPrimary: true,
    })
    .returning({ id: contacts.id });

  const now = new Date();
  const [listing] = await db
    .insert(jobListings)
    .values({
      companyId: company!.id,
      title: LEAD.listing.title,
      board: "company_careers",
      url: LEAD.listing.url,
      location: LEAD.listing.location,
      searchName: LEAD.listing.title,
      salaryCurrency: "USD",
      // Same fingerprint ingest would stamp, so a later scrape of this URL
      // resights the row instead of adding a duplicate listing.
      urlFingerprint: jobUrlFingerprint(LEAD.listing.url),
      sightingsCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      lastSeenRunDate: now.toISOString().slice(0, 10),
    })
    .returning({ id: jobListings.id });

  return {
    companyId: company!.id,
    contactId: contact!.id,
    jobListingId: listing!.id,
  };
}

async function verify(companyId: string) {
  console.log("\n=== verify (the conditions enrollment checks) ===");

  const [company] = await db
    .select({
      status: companies.status,
      icpStatus: companies.icpStatus,
      reasonToCall: companies.reasonToCall,
    })
    .from(companies)
    .where(eq(companies.id, companyId));
  const [contact] = await db
    .select({
      email: contacts.email,
      phone: contacts.phone,
      emailDeliverable: contacts.emailDeliverable,
      imessageCapable: contacts.imessageCapable,
    })
    .from(contacts)
    .where(eq(contacts.companyId, companyId));
  const listings = await db
    .select({ title: jobListings.title })
    .from(jobListings)
    .where(eq(jobListings.companyId, companyId));
  const enrollments = await db
    .select({ id: sequenceEnrollments.id })
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.companyId, companyId));
  const callList = await db
    .select({ id: callListEntries.id })
    .from(callListEntries)
    .where(eq(callListEntries.companyId, companyId));

  check(
    "company status is new (enroll refuses anything else)",
    company?.status === "new",
    company?.status,
  );
  check("icp_status is pass", company?.icpStatus === "pass", company?.icpStatus);
  check(
    "the listing blurb is on the company as the reason to call",
    Boolean(company?.reasonToCall),
  );
  check(
    "contact holds the email",
    contact?.email === LEAD.contact.email,
    contact?.email,
  );
  check(
    "contact holds the phone in E.164",
    contact?.phone === LEAD.contact.phone,
    contact?.phone,
  );
  check(
    "email_deliverable is true (enroll requires it)",
    contact?.emailDeliverable === true,
  );
  check(
    "imessage_capable is true, so the plan is email_and_text",
    contact?.imessageCapable === true,
  );
  check(
    `the ${LEAD.listing.title} listing exists`,
    listings.some((l) => l.title === LEAD.listing.title),
    listings,
  );
  check(
    "no enrollment yet (you enroll from the UI)",
    enrollments.length === 0,
    enrollments.length,
  );
  check(
    "no Call List row yet (you add it from the UI)",
    callList.length === 0,
    callList.length,
  );
  check(
    "exactly one contact holds this email",
    (await holdersOfEmail(LEAD.contact.email)).length === 1,
  );
  check(
    "exactly one contact holds this phone",
    (await holdersOfPhone(LEAD.contact.phone)).length === 1,
  );
}

/** Where the lead currently stands, for a re-run or before a teardown. */
async function describe(companyId: string) {
  const [company] = await db
    .select({
      status: companies.status,
      icpStatus: companies.icpStatus,
      enrichedAt: companies.enrichedAt,
    })
    .from(companies)
    .where(eq(companies.id, companyId));
  const contactRows = await db
    .select({
      name: contacts.name,
      email: contacts.email,
      phone: contacts.phone,
      emailDeliverable: contacts.emailDeliverable,
      imessageCapable: contacts.imessageCapable,
    })
    .from(contacts)
    .where(eq(contacts.companyId, companyId));
  const listings = await db
    .select({ title: jobListings.title, location: jobListings.location })
    .from(jobListings)
    .where(eq(jobListings.companyId, companyId));
  const enrollments = await db
    .select({
      id: sequenceEnrollments.id,
      status: sequenceEnrollments.status,
      emailAddress: sequenceEnrollments.emailAddress,
      // Non-null here is what puts the number on the worker's watchlist.
      phoneNumber: sequenceEnrollments.phoneNumber,
      nextStepAt: sequenceEnrollments.nextStepAt,
    })
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.companyId, companyId));
  const messages = enrollments.length
    ? await db
        .select({
          stepKind: outreachMessages.stepKind,
          channel: outreachMessages.channel,
          status: outreachMessages.status,
        })
        .from(outreachMessages)
        .innerJoin(
          sequenceEnrollments,
          eq(sequenceEnrollments.id, outreachMessages.enrollmentId),
        )
        .where(eq(sequenceEnrollments.companyId, companyId))
    : [];
  const callList = await db
    .select({ callStatus: callListEntries.callStatus })
    .from(callListEntries)
    .where(eq(callListEntries.companyId, companyId));

  console.log("\n=== current state ===");
  console.log(`  company        ${JSON.stringify(company)}`);
  console.log(`  contact(s)     ${JSON.stringify(contactRows)}`);
  console.log(`  listing(s)     ${JSON.stringify(listings)}`);
  console.log(`  call list      ${JSON.stringify(callList)}`);
  console.log(`  enrollment(s)  ${JSON.stringify(enrollments)}`);
  console.log(`  message(s)     ${JSON.stringify(messages)}`);
}

/**
 * Delete every row this lead owns, children first rather than leaning on
 * ON DELETE CASCADE, so each count is reportable. Enrollments go before
 * anything else that references them, and the inbound delete is keyed on
 * enrollment_id, which is what keeps it away from unattached inbound rows.
 */
async function remove(companyId: string) {
  const enrollmentIds = (
    await db
      .select({ id: sequenceEnrollments.id })
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.companyId, companyId))
  ).map((r) => r.id);

  console.log(`\n  ${enrollmentIds.length} enrollment(s) in scope`);
  if (!APPLY) {
    console.log("  Dry run only. Re-run with --remove --apply to delete.");
    return;
  }

  const report = async (label: string, rows: unknown[]) =>
    console.log(`    ${rows.length} ${label}`);

  for (const enrollmentId of enrollmentIds) {
    await report(
      "inbound reply row(s)",
      await db
        .delete(inboundMessages)
        .where(eq(inboundMessages.enrollmentId, enrollmentId))
        .returning({ id: inboundMessages.id }),
    );
    await report(
      "outreach message(s), queued texts included",
      await db
        .delete(outreachMessages)
        .where(eq(outreachMessages.enrollmentId, enrollmentId))
        .returning({ id: outreachMessages.id }),
    );
    await report(
      "enrollment event(s)",
      await db
        .delete(enrollmentEvents)
        .where(eq(enrollmentEvents.enrollmentId, enrollmentId))
        .returning({ id: enrollmentEvents.id }),
    );
  }
  await report(
    "enrollment(s), which releases the number from the worker watchlist",
    await db
      .delete(sequenceEnrollments)
      .where(eq(sequenceEnrollments.companyId, companyId))
      .returning({ id: sequenceEnrollments.id }),
  );
  await report(
    "Call List entry/ies",
    await db
      .delete(callListEntries)
      .where(eq(callListEntries.companyId, companyId))
      .returning({ id: callListEntries.id }),
  );
  await report(
    "company activity/ies",
    await db
      .delete(companyActivities)
      .where(eq(companyActivities.companyId, companyId))
      .returning({ id: companyActivities.id }),
  );
  await report(
    "ICP annotation(s)",
    await db
      .delete(companyIcp)
      .where(eq(companyIcp.companyId, companyId))
      .returning({ id: companyIcp.id }),
  );
  await report(
    "job listing(s)",
    await db
      .delete(jobListings)
      .where(eq(jobListings.companyId, companyId))
      .returning({ id: jobListings.id }),
  );
  await report(
    "contact(s)",
    await db
      .delete(contacts)
      .where(eq(contacts.companyId, companyId))
      .returning({ id: contacts.id }),
  );
  await report(
    "company",
    await db
      .delete(companies)
      .where(eq(companies.id, companyId))
      .returning({ id: companies.id }),
  );
  // Scoped to this lead's own identifiers: a suppression left over from an
  // opt-out test would otherwise block the next seed.
  await report(
    "suppression(s) on this lead's email or phone",
    await db
      .delete(suppressions)
      .where(
        sql`lower(coalesce(${suppressions.email}, '')) = ${LEAD.contact.email.toLowerCase()}
          or ${suppressions.phone} = ${LEAD.contact.phone}`,
      )
      .returning({ id: suppressions.id }),
  );
}

async function main() {
  console.log(APPLY ? "=== APPLYING ===" : "=== DRY RUN (pass --apply to write) ===");
  console.log(
    `\n${LEAD.company.name} / ${LEAD.contact.name} ${LEAD.contact.email} ${LEAD.contact.phone}` +
      `\nlisting: ${LEAD.listing.title}, ${LEAD.listing.location}`,
  );

  const existing = await existingCompany();

  if (REMOVE) {
    if (!existing) {
      console.log("\nNothing to remove: this lead is not in the database.");
      return;
    }
    console.log(`\n--- removing ${existing.name} (${existing.id}) ---`);
    await describe(existing.id);
    await remove(existing.id);
    const after = await existingCompany();
    console.log(
      after
        ? "\nWARNING: the company row is still there."
        : "\nGone. Re-run without --remove to seed a fresh copy.",
    );
    if (after) process.exitCode = 1;
    return;
  }

  if (existing) {
    console.log(
      `\nAlready seeded: ${existing.name} (${existing.id}). Nothing written.` +
        "\nPass --remove --apply to tear it down and start the round over.",
    );
    await describe(existing.id);
    return;
  }

  if (!(await preflight())) {
    console.error("\nPreflight failed. Nothing written.");
    process.exitCode = 1;
    return;
  }

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to write these three rows.");
    return;
  }

  const ids = await seed();
  console.log("\n=== written ===");
  console.log(`  company_id      ${ids.companyId}`);
  console.log(`  contact_id      ${ids.contactId}`);
  console.log(`  job_listing_id  ${ids.jobListingId}`);

  await verify(ids.companyId);

  console.log(
    failures === 0
      ? "\nALL CHECKS PASSED — open the CRM, pick the ABA Therapy Assistant listing, " +
          "and Add to Call List to enroll and start the sequence."
      : `\n${failures} CHECK(S) FAILED`,
  );
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
