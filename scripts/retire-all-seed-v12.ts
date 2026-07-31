/**
 * Clean slate for the July 30 outreach test campaign: delete every record that
 * exists only because of that testing, then seed three fresh leads (Proven
 * Theory LLC v12, Sun and Wave v2 for Alison, Go Max Pool Cleaning for Max).
 *
 * In scope: all twelve test companies — Proven Theory LLC and every vN variant,
 * Sun and Wave Studio Hair Salon (Alison, booking and all), ODV Outreach Test Co
 * — with their contacts (every Miguel Lozano row), job listings, enrollments,
 * outreach messages in every state, enrollment events, call list entries, ICP
 * annotations, company activities, and the inbound replies attached to those
 * enrollments.
 *
 * Out of scope, deliberately: the 24 quarantined chat.db rows (the operator's
 * own July 19 texts, mis-ingested and already detached). They have
 * enrollment_id IS NULL, so the inbound delete below cannot reach them — it is
 * keyed on enrollment_id. Deleting the test contacts does null their contact_id
 * via ON DELETE SET NULL, but every one of them carries from_address, raw_body,
 * received_at and the quarantine annotation, so no content is lost. The script
 * asserts all 24 are still present and intact afterwards and aborts if not.
 *
 * Also out of scope: outreach_settings and anything to do with the send window.
 *
 * The new leads get company + contact + listing + ICP pass and nothing else —
 * no enrollment, no call_list_entries row, nothing queued. The user adds them
 * from the UI when ready.
 *
 * Run with `--apply` to write; without it, prints the plan and changes nothing.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);
const APPLY = process.argv.includes("--apply");

/** Every company that exists only because of this test campaign. */
const TEST_COMPANIES = [
  { id: "647ddd4c-a5bd-4a3d-ab81-0fc60d53160d", name: "Proven Theory LLC" },
  { id: "9534b5de-7adb-4e59-a170-b43a4ae6fa7b", name: "Proven Theory LLC v2" },
  { id: "1c8c387f-19d3-46b1-a51e-29c56f057377", name: "Proven Theory LLC v3" },
  { id: "92aab9b4-128b-4b53-8e5b-1805b9cadc59", name: "Proven Theory LLC v4" },
  { id: "49eb4c38-a069-4d3e-a2b2-d03b1abeebc5", name: "Proven Theory LLC v5" },
  { id: "81d88098-75d7-43fb-92e2-6ae09e2078af", name: "Proven Theory LLC v6" },
  { id: "6461a38d-fe7e-47de-90a4-9aaad0502c7f", name: "Proven Theory LLC v7" },
  { id: "53b96f06-482d-4b27-9b28-3bbcfac2c287", name: "Proven Theory LLC v8" },
  { id: "3cf186b9-a611-4735-8575-c2b1d711394f", name: "Proven Theory LLC v10" },
  { id: "d2b1fc58-bb51-4b3c-b8ca-b4282d6f19c4", name: "Proven Theory LLC v11" },
  {
    id: "17c229ec-09f8-4c61-b0bf-922dfab70510",
    name: "Sun and Wave Studio Hair Salon (Alison)",
  },
  { id: "f1f8c7b3-a613-44aa-b18b-486e1a063ac3", name: "ODV Outreach Test Co" },
] as const;

const COMPANY_IDS = TEST_COMPANIES.map((c) => c.id);

/** Guard: the quarantined rows must come out the other side untouched. */
async function quarantineFingerprint() {
  const [row] = await sql`
    select count(*)::int as rows,
           count(from_address)::int as with_from_address,
           count(raw_body)::int as with_body,
           md5(string_agg(id::text || coalesce(raw_body,'') || received_at::text,
                          '|' order by id)) as digest
    from inbound_messages
    where action_taken ilike 'quarantined%'
  `;
  return row as {
    rows: number;
    with_from_address: number;
    with_body: number;
    digest: string;
  };
}

async function plan() {
  const rows = await sql`
    select co.name, co.status,
           (select count(*)::int from contacts ct where ct.company_id = co.id) as contacts,
           (select count(*)::int from job_listings jl where jl.company_id = co.id) as listings,
           (select count(*)::int from sequence_enrollments se where se.company_id = co.id) as enrollments,
           (select count(*)::int from outreach_messages om
              join sequence_enrollments se on se.id = om.enrollment_id
              where se.company_id = co.id) as messages,
           (select count(*)::int from enrollment_events ev
              join sequence_enrollments se on se.id = ev.enrollment_id
              where se.company_id = co.id) as events,
           (select count(*)::int from inbound_messages im
              join sequence_enrollments se on se.id = im.enrollment_id
              where se.company_id = co.id) as inbound,
           (select count(*)::int from call_list_entries cl where cl.company_id = co.id) as call_list,
           (select count(*)::int from company_activities ca where ca.company_id = co.id) as activities
    from companies co
    where co.id = any(${COMPANY_IDS}::uuid[])
    order by co.name
  `;
  console.table(rows);
}

async function teardown() {
  // Deleted in dependency order rather than leaning on ON DELETE CASCADE, so
  // every count is reportable and so the rows that put a number on the worker
  // watchlist (sequence_enrollments.phone_number) go first.
  const enrollmentIds = (
    await sql`
      select id from sequence_enrollments
      where company_id = any(${COMPANY_IDS}::uuid[])
    `
  ).map((r) => r.id as string);

  console.log(`\n  ${enrollmentIds.length} enrollment(s) in scope`);
  if (!APPLY) return;

  const del = async (label: string, rows: unknown[]) =>
    console.log(`    → ${rows.length} ${label} deleted`);

  if (enrollmentIds.length) {
    // Keyed on enrollment_id, which is exactly why the quarantined rows
    // (enrollment_id IS NULL) are unreachable from here.
    await del(
      "inbound reply row(s)",
      await sql`
        delete from inbound_messages
        where enrollment_id = any(${enrollmentIds}::uuid[])
        returning id
      `,
    );
    await del(
      "outreach message(s)",
      await sql`
        delete from outreach_messages
        where enrollment_id = any(${enrollmentIds}::uuid[])
        returning id
      `,
    );
    await del(
      "enrollment event(s)",
      await sql`
        delete from enrollment_events
        where enrollment_id = any(${enrollmentIds}::uuid[])
        returning id
      `,
    );
    await del(
      "enrollment(s) (releases every held phone number)",
      await sql`
        delete from sequence_enrollments
        where id = any(${enrollmentIds}::uuid[])
        returning id
      `,
    );
  }

  await del(
    "Call List entry/ies",
    await sql`
      delete from call_list_entries where company_id = any(${COMPANY_IDS}::uuid[])
      returning id
    `,
  );
  await del(
    "company activity/ies",
    await sql`
      delete from company_activities where company_id = any(${COMPANY_IDS}::uuid[])
      returning id
    `,
  );
  await del(
    "ICP annotation(s)",
    await sql`
      delete from company_icp where company_id = any(${COMPANY_IDS}::uuid[])
      returning id
    `,
  );
  await del(
    "job listing(s)",
    await sql`
      delete from job_listings where company_id = any(${COMPANY_IDS}::uuid[])
      returning id
    `,
  );
  await del(
    "contact(s) (every Miguel Lozano row, Alison, ODV)",
    await sql`
      delete from contacts where company_id = any(${COMPANY_IDS}::uuid[])
      returning id
    `,
  );
  await del(
    "company/ies",
    await sql`
      delete from companies where id = any(${COMPANY_IDS}::uuid[])
      returning id
    `,
  );
}

/* ------------------------------------------------------------------ seeding */

type Seed = {
  label: string;
  company: {
    name: string;
    domain: string;
    leadScore: number;
    hiringSignals: Record<string, unknown>;
    reasonToCall: string;
    callOpener: string;
    estimatedEmployees: number;
    industry: string;
    sourceMarket: string;
  };
  contact: {
    name: string;
    title: string;
    email: string;
    /** null keeps the lead email-only: enroll picks channel_plan email_only. */
    phone: string | null;
    location: string;
  };
  listing: { title: string; url: string; location: string };
};

const SEEDS: Seed[] = [
  {
    label: "Proven Theory LLC v12",
    company: {
      name: "Proven Theory LLC v12",
      domain: "proventheory-v12.test",
      leadScore: 78,
      hiringSignals: { new_company: true, multiple_openings: 1 },
      reasonToCall:
        "Retest listing — Recruiting Job Assistant opening; intentional Proven Theory v12 dry run on a clean slate: user adds to the Call List from the UI to test add → enroll → day-0 email + SMS → positive reply → auto-reply → Calendly booking.",
      callOpener:
        "Hi Miguel — saw you're hiring a Recruiting Job Assistant and figured it'd be worth a quick intro.",
      estimatedEmployees: 8,
      industry: "Marketing & Advertising",
      sourceMarket: "Miami, FL",
    },
    contact: {
      name: "Miguel Lozano",
      title: "Founder",
      email: "hello@proventheory.co",
      phone: "+13212307946",
      location: "Miami, FL",
    },
    listing: {
      title: "Recruiting Job Assistant",
      url: "https://www.proventheory.co/pages/contact",
      location: "Miami, FL (Remote-friendly)",
    },
  },
  {
    // Rebuilt from the deleted record: same email, same number, same salon
    // shape and the same Hair Stylist listing.
    label: "Sun and Wave Studio Hair Salon v2 (Alison)",
    company: {
      name: "Sun and Wave Studio Hair Salon v2",
      domain: "sunandwavestudio-v2.test",
      leadScore: 72,
      hiringSignals: { reposted_role: true },
      reasonToCall:
        "Stylist chair has been reposted three times — independent salon with no in-house recruiter, owner is doing the hiring herself.",
      callOpener:
        "Hi Alison — saw Sun and Wave is still looking for a stylist and figured it'd be worth a quick intro.",
      estimatedEmployees: 6,
      industry: "Consumer Services",
      sourceMarket: "West Palm Beach, FL",
    },
    contact: {
      name: "Alison Minoogian",
      title: "Owner",
      email: "Aminoogian@gmail.com",
      phone: "+15618010303",
      location: "Jupiter, FL",
    },
    listing: {
      title: "Hair Stylist",
      url: "https://sunandwavestudio-v2.test/careers",
      location: "Jupiter, FL",
    },
  },
  {
    label: "Go Max Pool Cleaning (Max)",
    company: {
      name: "Go Max Pool Cleaning",
      domain: "gomaxpoolcleaning.test",
      leadScore: 70,
      hiringSignals: { reposted_role: true },
      reasonToCall:
        "Pool Service Technician role has been open and reposted — owner-operated route business with no recruiter, so hiring sits on the owner's desk. Email-only lead: no mobile on file, so outreach is email-only by design.",
      callOpener:
        "Hi Max — saw Go Max Pool Cleaning is hiring a Pool Service Technician and figured it'd be worth a quick intro.",
      estimatedEmployees: 9,
      industry: "Consumer Services",
      sourceMarket: "West Palm Beach, FL",
    },
    contact: {
      name: "Max",
      title: "Owner",
      email: "obertidelgado@bellsouth.net",
      phone: null,
      location: "West Palm Beach, FL",
    },
    listing: {
      title: "Pool Service Technician",
      url: "https://gomaxpoolcleaning.test/careers",
      location: "West Palm Beach, FL",
    },
  },
];

async function seed() {
  const created: Record<string, string>[] = [];
  for (const s of SEEDS) {
    const [existing] = await sql`
      select id from companies where name = ${s.company.name}
    `;
    if (existing) {
      console.log(`\n  ${s.label} already exists: ${existing.id}`);
      continue;
    }
    console.log(
      `\n  seeding ${s.label} — ${s.contact.email}${s.contact.phone ? ` / ${s.contact.phone}` : " (email-only, no phone)"}`,
    );
    if (!APPLY) continue;

    const [company] = await sql`
      insert into companies (
        name, domain, domain_confidence, status, first_seen, lead_score,
        hiring_signals, reason_to_call, call_opener, icp_status,
        estimated_employees, industry, enriched_at, enrich_run_date, source_market
      ) values (
        ${s.company.name}, ${s.company.domain}, 'high', 'new',
        '2026-07-30', ${s.company.leadScore},
        ${JSON.stringify(s.company.hiringSignals)}::jsonb,
        ${s.company.reasonToCall}, ${s.company.callOpener},
        'pass', ${s.company.estimatedEmployees}, ${s.company.industry},
        now(), '2026-07-30', ${s.company.sourceMarket}
      ) returning id
    `;

    // imessage_capable drives channel_plan at enrollment: true plus a number
    // gives email_and_text, false gives email_only with phone_number null —
    // which is what stops Max generating phantom SMS steps.
    const textable = s.contact.phone !== null;
    const [contact] = await sql`
      insert into contacts (
        company_id, name, title, email, work_email, personal_email, phone,
        personal_phone, phones, source_provider, imessage_capable,
        email_deliverable, location_matched, contact_location, job_location,
        reveal_status, reveal_channels, is_primary
      ) values (
        ${company.id}, ${s.contact.name}, ${s.contact.title}, ${s.contact.email},
        ${s.contact.email}, ${s.contact.email}, ${s.contact.phone},
        ${s.contact.phone},
        ${JSON.stringify(
          s.contact.phone
            ? [{ kind: "mobile", number: s.contact.phone, source: "apollo" }]
            : [],
        )}::jsonb,
        'manual_test', ${textable}, true, true, ${s.contact.location},
        ${s.contact.location}, 'revealed',
        ${textable ? "email_phone" : "email"}, true
      ) returning id
    `;

    const [listing] = await sql`
      insert into job_listings (
        company_id, title, board, url, location, search_name,
        salary_currency, sightings_count, first_seen_at, last_seen_at,
        last_seen_run_date
      ) values (
        ${company.id}, ${s.listing.title}, 'company_careers', ${s.listing.url},
        ${s.listing.location}, ${s.listing.title}, 'USD', 1, now(), now(),
        '2026-07-30'
      ) returning id
    `;

    console.log(`    company_id     ${company.id}`);
    console.log(`    contact_id     ${contact.id}`);
    console.log(`    job_listing_id ${listing.id}`);
    created.push({
      label: s.label,
      company_id: company.id as string,
      contact_id: contact.id as string,
      job_listing_id: listing.id as string,
    });
  }
  return created;
}

async function main() {
  console.log(APPLY ? "=== APPLYING ===" : "=== DRY RUN (pass --apply) ===");

  const before = await quarantineFingerprint();
  console.log(
    `\nquarantined chat.db rows before: ${before.rows} (digest ${before.digest.slice(0, 12)})`,
  );

  console.log("\n--- what gets deleted ---");
  await plan();
  console.log("\n--- 1. delete every test record ---");
  await teardown();
  console.log("\n--- 2. seed the three fresh leads ---");
  await seed();

  const after = await quarantineFingerprint();
  console.log(
    `\nquarantined chat.db rows after: ${after.rows} (digest ${after.digest.slice(0, 12)})`,
  );
  if (after.rows !== before.rows || after.digest !== before.digest) {
    throw new Error(
      `quarantined rows changed (${before.rows} -> ${after.rows}) — investigate`,
    );
  }
  console.log(
    `  ✓ all ${after.rows} intact: bodies, timestamps and from_address unchanged`,
  );
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
