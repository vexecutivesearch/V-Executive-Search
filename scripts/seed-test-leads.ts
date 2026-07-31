/**
 * Seed the live test leads for end to end sequence checks.
 *
 * Each lead is company + contact + job listing and nothing else. No enrollment,
 * no call_list_entries row, nothing drafted or queued, the same shape as the v12
 * clean slate seeds, because the point of the test is to drive add to Call List
 * → enroll → day 0 email and SMS → reply → auto reply with the booking link
 * from the UI.
 *
 * Refuses to write when it would create a second record on a lead's email or
 * phone (two records on one identifier is what makes an inbound reply
 * ambiguous, since matching is keyed on the enrollment's address and number) or
 * when either identifier is suppressed, since enrollment would then reject the
 * lead. A lead that already exists is reported and left alone.
 *
 * `--remove` tears a lead back down so its round can be run again: every row
 * the company owns, children first, plus any suppression the lead's own email
 * or phone picked up during the test. It touches nothing outside that company.
 *
 * Usage:
 *   npx tsx scripts/seed-test-leads.ts                                # dry run, all leads
 *   npx tsx scripts/seed-test-leads.ts --apply                        # write any that are missing
 *   npx tsx scripts/seed-test-leads.ts --lead=miguels-roofing --apply # just one
 *   npx tsx scripts/seed-test-leads.ts --lead=autism-one --remove --apply
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
  type HiringSignals,
} from "@/lib/db/schema";
import { jobUrlFingerprint } from "@/lib/hiring-signals";

const APPLY = process.argv.includes("--apply");
const REMOVE = process.argv.includes("--remove");

type Lead = {
  /** --lead= selector. */
  slug: string;
  company: {
    name: string;
    /** Null when the contact is on a personal address and the firm has no site. */
    domain: string | null;
    industry: string;
    estimatedEmployees: number;
    leadScore: number;
    hiringSignals: HiringSignals;
    market: string;
    /**
     * The listing blurb. This is the one field the drafter reads as free text
     * (it reaches the prompt as the internal reason to call note), so it is
     * written the way the copy should sound: no test harness chatter that
     * Claude could echo into a real email.
     */
    reasonToCall: string;
    callOpener: string;
  };
  /**
   * Null for a lead whose contact details are not known yet: company and
   * listing land in the CRM, and enrollment stays impossible until someone
   * supplies a real address. Never invent one — a cold send to a mailbox that
   * does not exist is a hard bounce against the sending domain.
   */
  contact: {
    name: string;
    title: string;
    email: string;
    /** E.164 — the worker and the inbound matcher both normalize to this. */
    phone: string;
    location: string;
  } | null;
  listing: {
    title: string;
    url: string | null;
    location: string;
    /** "manual_seed" keeps the drafter from claiming we found it on a board. */
    board: string;
  };
};

const LEADS: Lead[] = [
  {
    slug: "autism-one",
    company: {
      name: "Autism One",
      domain: "autism.one",
      industry: "Healthcare & Life Sciences",
      estimatedEmployees: 14,
      leadScore: 74,
      // One listing, so not multiple_openings; a reposted role is what makes a
      // single opening worth a call and keeps the lead in the hot filter.
      hiringSignals: { reposted_role: true },
      // The 239 number is a Naples area code, but the market and role location
      // are West Palm Beach so the lead lands inside the working market
      // instead of hiding behind a market filter.
      market: "West Palm Beach, FL",
      reasonToCall:
        "Hiring an ABA Therapy Assistant to support BCBA supervised sessions for children on the autism spectrum: running one to one therapy plans, logging session data, and coaching parents so the program carries over at home. Full time in clinic, RBT certification preferred but they will train the right candidate. Small practice with no in house recruiter, so the owner is screening applicants himself.",
      callOpener:
        "Hi Miguel, saw Autism One is hiring an ABA Therapy Assistant and figured it would be worth a quick intro.",
    },
    contact: {
      name: "Miguel",
      title: "Owner",
      email: "miguel@autism.one",
      phone: "+12397890148",
      location: "West Palm Beach, FL",
    },
    listing: {
      title: "ABA Therapy Assistant",
      url: "https://autism.one/careers",
      location: "West Palm Beach, FL",
      board: "company_careers",
    },
  },
  {
    slug: "miguels-roofing",
    company: {
      name: "Miguel's Roofing",
      // Personal Gmail contact, no company site to point at, so no domain and
      // low confidence rather than an invented one.
      domain: null,
      industry: "Construction",
      estimatedEmployees: 11,
      leadScore: 72,
      hiringSignals: { reposted_role: true },
      market: "Miami, FL",
      reasonToCall:
        "Hiring a Roofing Technician for residential repairs and reroofs across Miami Dade: tear off and dry in, shingle and tile work, and keeping the crew moving through the day. Owner run crew with no recruiter, so the owner is fielding applicants himself between jobs.",
      callOpener:
        "Hi Miguel, saw Miguel's Roofing is hiring a Roofing Technician and figured it would be worth a quick intro.",
    },
    contact: {
      name: "Miguel",
      title: "Owner",
      email: "ptmproventheory@gmail.com",
      phone: "+13059634759",
      location: "Miami, FL",
    },
    listing: {
      title: "Roofing Technician",
      url: null,
      location: "Miami, FL",
      board: "manual_seed",
    },
  },
  {
    slug: "miguel-rx-library",
    company: {
      name: "Miguel RX Library",
      domain: null,
      industry: "Pharmaceuticals",
      estimatedEmployees: 9,
      leadScore: 72,
      hiringSignals: { reposted_role: true },
      market: "Miami, FL",
      reasonToCall:
        "Hiring a Pharmacy Technician to work the retail counter and the compounding bench: filling and labeling prescriptions, running insurance claims through, keeping inventory straight, and looking after patients at pickup. Independent pharmacy with no recruiter of its own, so the owner screens applicants between shifts.",
      callOpener:
        "Hi Miguel, saw Miguel RX Library is hiring a Pharmacy Technician and figured it would be worth a quick intro.",
    },
    // No address or mobile supplied for this one yet, so it seeds as a lead
    // without a contact and cannot enroll until one is added.
    contact: null,
    listing: {
      title: "Pharmacy Technician",
      url: null,
      location: "Miami, FL",
      board: "manual_seed",
    },
  },
];

function selectedLeads(): Lead[] {
  const flag = process.argv.find((a) => a.startsWith("--lead="));
  if (!flag) return LEADS;
  const slug = flag.slice("--lead=".length);
  const picked = LEADS.filter((l) => l.slug === slug);
  if (!picked.length) {
    throw new Error(
      `unknown --lead=${slug}. Known leads: ${LEADS.map((l) => l.slug).join(", ")}`,
    );
  }
  return picked;
}

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

async function suppressionsFor(lead: Lead) {
  if (!lead.contact) return [];
  return db
    .select({
      channel: suppressions.channel,
      reason: suppressions.reason,
      email: suppressions.email,
      phone: suppressions.phone,
    })
    .from(suppressions)
    .where(sql`lower(coalesce(${suppressions.email}, '')) = ${lead.contact.email.toLowerCase()}
      or ${suppressions.phone} = ${lead.contact.phone}`);
}

/** Match on domain when the lead has one, otherwise on the exact name. */
async function existingCompany(lead: Lead) {
  const name = lead.company.name.trim().toLowerCase();
  const [row] = await db
    .select({ id: companies.id, name: companies.name, status: companies.status })
    .from(companies)
    .where(
      lead.company.domain
        ? sql`lower(coalesce(${companies.domain}, '')) = ${lead.company.domain}
            or lower(trim(${companies.name})) = ${name}`
        : sql`lower(trim(${companies.name})) = ${name}`,
    )
    .limit(1);
  return row ?? null;
}

async function preflight(lead: Lead): Promise<boolean> {
  console.log("  preflight");
  if (!lead.contact) {
    console.log("    ok   no contact to check (company and listing only)");
    return true;
  }
  let ok = true;

  const emailHolders = await holdersOfEmail(lead.contact.email);
  if (emailHolders.length) {
    ok = false;
    console.error(
      `    ABORT  ${lead.contact.email} is already on ${emailHolders.length} contact(s): ` +
        `${JSON.stringify(emailHolders)}\n` +
        "           Two records on one address make inbound replies ambiguous. Delete the old one first.",
    );
  } else {
    console.log(`    ok   ${lead.contact.email} is unused`);
  }

  const phoneHolders = await holdersOfPhone(lead.contact.phone);
  if (phoneHolders.length) {
    ok = false;
    console.error(
      `    ABORT  ${lead.contact.phone} is already on ${phoneHolders.length} contact(s): ` +
        `${JSON.stringify(phoneHolders)}\n` +
        "           The worker watchlist and the inbound matcher both key on the number. Delete the old one first.",
    );
  } else {
    console.log(`    ok   ${lead.contact.phone} is unused`);
  }

  const suppressed = await suppressionsFor(lead);
  if (suppressed.length) {
    ok = false;
    console.error(
      `    ABORT  this lead is suppressed: ${JSON.stringify(suppressed)}\n` +
        "           A suppressed address stops enrollment outright, and a suppressed number\n" +
        "           silently drops the SMS half of the sequence. Clear the row first.",
    );
  } else {
    console.log("    ok   neither identifier is suppressed");
  }

  return ok;
}

async function seed(lead: Lead) {
  const [company] = await db
    .insert(companies)
    .values({
      name: lead.company.name,
      domain: lead.company.domain,
      domainConfidence: lead.company.domain ? "high" : "low",
      status: "new",
      firstSeen: new Date().toISOString().slice(0, 10),
      leadScore: lead.company.leadScore,
      hiringSignals: lead.company.hiringSignals,
      reasonToCall: lead.company.reasonToCall,
      callOpener: lead.company.callOpener,
      icpStatus: "pass",
      estimatedEmployees: lead.company.estimatedEmployees,
      industry: lead.company.industry,
      // enrichedAt stays null so the lead is still a candidate for an enrich
      // run; the contact below is already complete enough to enroll without one.
      sourceMarket: lead.company.market,
    })
    .returning({ id: companies.id });

  // imessage_capable drives channel_plan at enrollment: true plus a number
  // gives email_and_text, which is the pair these tests are checking. The one
  // address is written to all three email columns so the work-email-preferred
  // toggle cannot change which address enrollment picks.
  const [contact] = lead.contact
    ? await db
        .insert(contacts)
        .values({
          companyId: company!.id,
          name: lead.contact.name,
          title: lead.contact.title,
          email: lead.contact.email,
          workEmail: lead.contact.email,
          personalEmail: lead.contact.email,
          phone: lead.contact.phone,
          personalPhone: lead.contact.phone,
          phones: [
            { number: lead.contact.phone, source: "apollo", kind: "mobile" },
          ],
          sourceProvider: "manual_test",
          imessageCapable: true,
          emailDeliverable: true,
          locationMatched: true,
          contactLocation: lead.contact.location,
          jobLocation: lead.contact.location,
          revealStatus: "revealed",
          revealChannels: "email_phone",
          isPrimary: true,
        })
        .returning({ id: contacts.id })
    : [null];

  const now = new Date();
  const [listing] = await db
    .insert(jobListings)
    .values({
      companyId: company!.id,
      title: lead.listing.title,
      board: lead.listing.board,
      url: lead.listing.url,
      location: lead.listing.location,
      searchName: lead.listing.title,
      salaryCurrency: "USD",
      // Same fingerprint ingest would stamp, so a later scrape of this URL
      // resights the row instead of adding a duplicate listing.
      urlFingerprint: jobUrlFingerprint(lead.listing.url),
      sightingsCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      lastSeenRunDate: now.toISOString().slice(0, 10),
    })
    .returning({ id: jobListings.id });

  return {
    companyId: company!.id,
    contactId: contact?.id ?? null,
    jobListingId: listing!.id,
  };
}

async function verify(lead: Lead, companyId: string) {
  console.log("  verify (the conditions enrollment checks)");

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
  if (lead.contact) {
    check(
      "contact holds the email",
      contact?.email === lead.contact.email,
      contact?.email,
    );
    check(
      "contact holds the phone in E.164",
      contact?.phone === lead.contact.phone,
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
  } else {
    check("no contact, as intended for this lead", contact === undefined);
    console.log(
      "        it cannot enroll until a real address and mobile are added",
    );
  }
  check(
    `the ${lead.listing.title} listing exists`,
    listings.some((l) => l.title === lead.listing.title),
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
  if (lead.contact) {
    check(
      "exactly one contact holds this email",
      (await holdersOfEmail(lead.contact.email)).length === 1,
    );
    check(
      "exactly one contact holds this phone",
      (await holdersOfPhone(lead.contact.phone)).length === 1,
    );
  }
}

/** Where a lead currently stands, for a re-run or before a teardown. */
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

  console.log(`    company        ${JSON.stringify(company)}`);
  console.log(`    contact(s)     ${JSON.stringify(contactRows)}`);
  console.log(`    listing(s)     ${JSON.stringify(listings)}`);
  console.log(`    call list      ${JSON.stringify(callList)}`);
  console.log(`    enrollment(s)  ${JSON.stringify(enrollments)}`);
  console.log(`    message(s)     ${JSON.stringify(messages)}`);
}

/**
 * Delete every row this lead owns, children first rather than leaning on
 * ON DELETE CASCADE, so each count is reportable. Enrollments go before
 * anything else that references them, and the inbound delete is keyed on
 * enrollment_id, which is what keeps it away from unattached inbound rows.
 */
async function remove(lead: Lead, companyId: string) {
  const enrollmentIds = (
    await db
      .select({ id: sequenceEnrollments.id })
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.companyId, companyId))
  ).map((r) => r.id);

  console.log(`    ${enrollmentIds.length} enrollment(s) in scope`);
  if (!APPLY) {
    console.log("    Dry run only. Re-run with --remove --apply to delete.");
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
  if (lead.contact) {
    await report(
      "suppression(s) on this lead's email or phone",
      await db
        .delete(suppressions)
        .where(
          sql`lower(coalesce(${suppressions.email}, '')) = ${lead.contact.email.toLowerCase()}
            or ${suppressions.phone} = ${lead.contact.phone}`,
        )
        .returning({ id: suppressions.id }),
    );
  }
}

async function handle(lead: Lead) {
  console.log(
    `\n=== ${lead.slug} — ${lead.company.name} / ` +
      (lead.contact
        ? `${lead.contact.name} ${lead.contact.email} ${lead.contact.phone}`
        : "no contact yet") +
      `\n    listing: ${lead.listing.title}, ${lead.listing.location}`,
  );

  const existing = await existingCompany(lead);

  if (REMOVE) {
    if (!existing) {
      console.log("  Nothing to remove: this lead is not in the database.");
      return;
    }
    console.log(`  removing ${existing.name} (${existing.id})`);
    await describe(existing.id);
    await remove(lead, existing.id);
    if (await existingCompany(lead)) {
      failures += 1;
      console.error("  WARNING: the company row is still there.");
    } else if (APPLY) {
      console.log("  Gone. Re-run without --remove to seed a fresh copy.");
    }
    return;
  }

  if (existing) {
    console.log(`  Already seeded: ${existing.name} (${existing.id}). Nothing written.`);
    await describe(existing.id);
    return;
  }

  if (!(await preflight(lead))) {
    failures += 1;
    console.error("  Preflight failed. Nothing written for this lead.");
    return;
  }

  if (!APPLY) {
    console.log("  Dry run only. Re-run with --apply to write these three rows.");
    return;
  }

  const ids = await seed(lead);
  console.log(`    company_id      ${ids.companyId}`);
  console.log(`    contact_id      ${ids.contactId ?? "(none)"}`);
  console.log(`    job_listing_id  ${ids.jobListingId}`);
  await verify(lead, ids.companyId);
}

async function main() {
  console.log(
    APPLY ? "=== APPLYING ===" : "=== DRY RUN (pass --apply to write) ===",
  );
  for (const lead of selectedLeads()) {
    await handle(lead);
  }
  console.log(
    failures === 0
      ? "\nALL CHECKS PASSED — open the CRM, pick the listing, and Add to Call List to enroll."
      : `\n${failures} CHECK(S) FAILED`,
  );
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
