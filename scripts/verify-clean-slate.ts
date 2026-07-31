/**
 * Verification for the v12 clean slate. Read-only; every check must pass.
 *
 * Mirrors the failure modes that bit earlier sessions: a retired enrollment
 * still holding a phone number (which is what /api/outreach/watchlist selects
 * on, so the worker keeps watching a dead lead), two records claiming one
 * number or address, and steps left drafted or queued.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

const NEW_COMPANIES = [
  "Proven Theory LLC v12",
  "Sun and Wave Studio Hair Salon v2",
  "Go Max Pool Cleaning",
];

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
  }
}

async function main() {
  console.log("\n=== the three new leads ===");
  const leads = await sql`
    select co.name as company, co.id as company_id, co.status, co.icp_status,
           ct.id as contact_id, ct.name as contact, ct.email, ct.phone,
           ct.imessage_capable, ct.email_deliverable,
           jl.id as job_listing_id, jl.title as listing,
           (select count(*)::int from sequence_enrollments se
              where se.company_id = co.id) as enrollments,
           (select count(*)::int from call_list_entries cl
              where cl.company_id = co.id) as call_list_rows
    from companies co
    join contacts ct on ct.company_id = co.id
    join job_listings jl on jl.company_id = co.id
    where co.name = any(${NEW_COMPANIES})
    order by co.name
  `;
  console.table(leads);

  console.log("\n=== checks ===");
  check("all three new leads exist", leads.length === 3, leads.length);
  check(
    "every new lead is status=new + icp_status=pass (Call-List eligible)",
    leads.every((l) => l.status === "new" && l.icp_status === "pass"),
  );
  check(
    "every new lead has email_deliverable=true (enroll requires it)",
    leads.every((l) => l.email_deliverable === true),
  );
  check(
    "zero enrollments on the new leads",
    leads.every((l) => l.enrollments === 0),
  );
  check(
    "zero Call List rows on the new leads (user adds them from the UI)",
    leads.every((l) => l.call_list_rows === 0),
  );

  const max = leads.find((l) => l.company === "Go Max Pool Cleaning");
  check(
    "Max is email-only: no phone, imessage_capable=false (no phantom SMS)",
    max?.phone === null && max?.imessage_capable === false,
    { phone: max?.phone, imessage_capable: max?.imessage_capable },
  );

  // Identifier ownership: exactly one record each.
  for (const [label, column, value] of [
    ["+13212307946 (v12)", "phone", "+13212307946"],
    ["+15618010303 (Alison)", "phone", "+15618010303"],
    ["hello@proventheory.co", "email", "hello@proventheory.co"],
    ["Aminoogian@gmail.com", "email", "aminoogian@gmail.com"],
    ["obertidelgado@bellsouth.net", "email", "obertidelgado@bellsouth.net"],
  ] as const) {
    const holders =
      column === "phone"
        ? await sql`
            select ct.id, ct.name, co.name as company
            from contacts ct join companies co on co.id = ct.company_id
            where ct.phone = ${value} or ct.personal_phone = ${value}
               or ct.company_phone = ${value}
               or ct.phones::text like ${"%" + value + "%"}
          `
        : await sql`
            select ct.id, ct.name, co.name as company
            from contacts ct join companies co on co.id = ct.company_id
            where lower(coalesce(ct.email,'')) = ${value}
               or lower(coalesce(ct.work_email,'')) = ${value}
               or lower(coalesce(ct.personal_email,'')) = ${value}
               or lower(ct.personal_emails::text) like ${"%" + value + "%"}
          `;
    check(
      `${label} held by exactly 1 contact${holders.length === 1 ? ` (${holders[0].company})` : ""}`,
      holders.length === 1,
      holders,
    );
  }

  // The worker watchlist is literally this query.
  const watch = await sql`
    select se.phone_number, se.status, co.name as company
    from sequence_enrollments se join companies co on co.id = se.company_id
    where se.phone_number is not null
  `;
  check(
    "worker SMS watchlist holds no stale test number",
    !watch.some((w) =>
      ["+13212307946", "+15618010303", "+15614018355", "+17864083193", "+12392204737"].includes(
        w.phone_number as string,
      ),
    ),
    watch,
  );
  console.log(`        watchlist currently: ${JSON.stringify(watch)}`);

  const pending = await sql`
    select om.status, om.channel, co.name as company
    from outreach_messages om
    join sequence_enrollments se on se.id = om.enrollment_id
    join companies co on co.id = se.company_id
    where om.status in ('drafted','queued')
  `;
  check("nothing drafted or queued anywhere", pending.length === 0, pending);

  const scheduled = await sql`
    select co.name as company, se.status, se.next_step_at::text as next_step_at
    from sequence_enrollments se join companies co on co.id = se.company_id
    where se.next_step_at is not null
  `;
  check(
    "no enrollment has a scheduled next step",
    scheduled.length === 0,
    scheduled,
  );

  const leftovers = await sql`
    select id, name from companies
    where name ilike '%proven theory%' and name <> 'Proven Theory LLC v12'
       or name ilike '%odv %'
       or name = 'Sun and Wave Studio Hair Salon'
  `;
  check("every old Proven Theory / ODV / Alison company gone", leftovers.length === 0, leftovers);

  const miguel = await sql`
    select ct.id, ct.name, co.name as company
    from contacts ct join companies co on co.id = ct.company_id
    where ct.name ilike '%miguel%lozano%'
       or lower(coalesce(ct.email,'')) = 'info@cultura.company'
       or lower(coalesce(ct.personal_email,'')) = 'miguelalozano@icloud.com'
  `;
  check(
    "only the v12 Miguel Lozano contact remains",
    miguel.length === 1 && miguel[0].company === "Proven Theory LLC v12",
    miguel,
  );

  const alison = await sql`
    select ct.id, co.name as company from contacts ct
    join companies co on co.id = ct.company_id
    where ct.name ilike '%minoogian%'
  `;
  check(
    "only the v2 Alison contact remains",
    alison.length === 1 &&
      alison[0].company === "Sun and Wave Studio Hair Salon v2",
    alison,
  );

  const booking = await sql`
    select count(*)::int as n from enrollment_events
    where event_type = 'calendly_booking'
  `;
  check(
    "no Calendly booking record survives (Alison's Friday meeting cleared)",
    (booking[0].n as number) === 0,
    booking,
  );

  const quarantined = await sql`
    select count(*)::int as rows, count(from_address)::int as with_from_address,
           count(raw_body)::int as with_body, count(contact_id)::int as with_contact_id
    from inbound_messages where action_taken ilike 'quarantined%'
  `;
  const q = quarantined[0] as Record<string, number>;
  check(
    "all 24 quarantined July 19 chat.db rows still present with bodies",
    q.rows === 24 && q.with_body === 24 && q.with_from_address === 24,
    q,
  );
  console.log(
    `        (contact_id is now null on ${24 - q.with_contact_id} of them — the FK is ON DELETE SET NULL; from_address still carries the number)`,
  );

  const totals = await sql`
    select (select count(*)::int from companies) as companies,
           (select count(*)::int from contacts) as contacts,
           (select count(*)::int from sequence_enrollments) as enrollments,
           (select count(*)::int from outreach_messages) as messages,
           (select count(*)::int from call_list_entries) as call_list
  `;
  console.log(`\n=== table totals ===\n${JSON.stringify(totals[0], null, 1)}`);

  const window = await sql`
    select send_window_start_hour, send_window_end_hour, enabled, dry_run,
           auto_enroll
    from outreach_settings
  `;
  console.log(
    `\n=== outreach_settings (not modified by this work) ===\n${JSON.stringify(window[0], null, 1)}`,
  );

  console.log(
    failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
  );
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
