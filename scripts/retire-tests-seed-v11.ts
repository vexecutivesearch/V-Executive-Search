/**
 * Retire tonight's spent Proven Theory test leads, quarantine the chat.db
 * history that was ingested as replies, and seed Proven Theory LLC v11.
 *
 * Nothing is deleted. Sent messages, enrollment_events, company_activities and
 * Call List notes all stay exactly where they are; enrollments are stopped and
 * their phone numbers released so an inbound text has one unambiguous owner.
 *
 * Alison Minoogian is deliberately untouched: she is a real prospect with a
 * confirmed meeting on Friday, not a spent test.
 *
 * Run with `--apply` to write; without it, prints the plan and changes nothing.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);
const APPLY = process.argv.includes("--apply");

/** Enrollments whose test is finished and whose number should be freed. */
const RETIRE = [
  {
    enrollmentId: "d7df713d-c7ce-480a-b934-62e1abbdf1ef",
    contactId: "9ebea25d-8700-422b-a5af-04d1ade47d1f",
    company: "Proven Theory LLC v10",
    phone: "+13212307946",
    releasedTo: "Proven Theory LLC v11",
    reason:
      "v10 test complete: it proved the missing SMS auto-reply. The email positive at 21:13 ET sent an email reply; the texted positive at 21:15 ET hit the conversation-wide fifteen minute guard, was skipped, and no imessage row was ever created. Number released to Proven Theory LLC v11 so inbound texts have exactly one owner.",
  },
  {
    enrollmentId: "c02d9a1b-58c1-4314-9505-3375ec45b52a",
    contactId: "2c0a28ec-5375-45e1-acc9-9366c57ad36e",
    company: "Proven Theory LLC v8",
    phone: "+17864083193",
    releasedTo: null,
    reason:
      "v8 test complete: SMS auto-reply queued then cancelled by the email positive's sweep, which is what the keepAutoReplies change was written for, plus the Jeff Willson Calendly time-fallback match. Number released so no retired enrollment holds it.",
  },
  {
    enrollmentId: "de4cddaf-811e-4661-bffd-b6601ecf6141",
    contactId: "3bbdfab6-e4fa-4d01-ba31-e0bfd0a9081c",
    company: "Proven Theory LLC v6",
    phone: "+12392204737",
    releasedTo: null,
    reason:
      "v6 was stopped by admin but kept its phone_number and a next_step_at of Aug 1, leaving a retired enrollment on the worker watchlist. Released for hygiene.",
  },
] as const;

async function retire() {
  for (const target of RETIRE) {
    const [before] = await sql`
      select se.status, se.stop_reason, se.stopped_by, se.phone_number,
             se.next_step_at::text as next_step_at
      from sequence_enrollments se where se.id = ${target.enrollmentId}
    `;
    if (!before) {
      console.log(`  ! ${target.company}: enrollment not found, skipping`);
      continue;
    }

    const [counts] = await sql`
      select
        count(*) filter (where status = 'sent')::int as sent,
        count(*) filter (where status = 'cancelled')::int as already_cancelled,
        count(*) filter (where status in ('drafted', 'queued'))::int as pending
      from outreach_messages where enrollment_id = ${target.enrollmentId}
    `;
    const [events] = await sql`
      select count(*)::int as n from enrollment_events
      where enrollment_id = ${target.enrollmentId}
    `;
    const [activities] = await sql`
      select count(*)::int as n from company_activities ca
      join sequence_enrollments se on se.company_id = ca.company_id
      where se.id = ${target.enrollmentId}
    `;

    console.log(
      `\n  ${target.company} (${target.phone})\n` +
        `    before: status=${before.status} phone=${before.phone_number} next_step_at=${before.next_step_at}\n` +
        `    messages: ${counts.sent} sent, ${counts.already_cancelled} already cancelled, ${counts.pending} pending to cancel\n` +
        `    preserving ${events.n} enrollment_event(s), ${activities.n} activity row(s)`,
    );
    if (!APPLY) continue;

    // Cancel only what never went out. Sent history is untouchable.
    await sql`
      update outreach_messages
      set status = 'cancelled', updated_at = now()
      where enrollment_id = ${target.enrollmentId}
        and status in ('drafted', 'queued')
    `;
    await sql`
      update sequence_enrollments
      set status = 'stopped',
          stop_reason = ${`${target.company.split(" ").pop()} test complete — number released`},
          stopped_by = 'user',
          next_step_at = null,
          phone_number = null,
          updated_at = now()
      where id = ${target.enrollmentId}
    `;
    // Clearing the contact's phone fields is what actually takes the number off
    // the worker watchlist and leaves one holder.
    await sql`
      update contacts
      set phone = null, personal_phone = null, phones = '[]'::jsonb
      where id = ${target.contactId}
    `;
    await sql`
      insert into enrollment_events (enrollment_id, event_type, actor, payload)
      values (
        ${target.enrollmentId}, 'manual_intervention', 'user',
        ${JSON.stringify({
          action: "phone_released",
          phone: target.phone,
          reason: `${target.reason} Prior enrollment state: status=${before.status}, stop_reason=${before.stop_reason}, stopped_by=${before.stopped_by}, phone_number=${before.phone_number}, next_step_at=${before.next_step_at}. No rows deleted.`,
          released_to: target.releasedTo,
          preserved: [
            `outreach_messages: ${counts.sent} sent retained, ${counts.already_cancelled} already cancelled, ${counts.pending} never-sent step(s) cancelled by this release`,
            `enrollment_events: ${events.n} event(s) retained (append-only)`,
            `company_activities: ${activities.n} activity row(s) retained`,
          ],
        })}::jsonb
      )
    `;
    console.log(`    → released`);
  }
}

/**
 * The chat.db backfill. These rows are real messages and stay in the table with
 * their bodies and contact attribution; what gets removed is the false claim
 * that they answered an outreach send, because most of them predate the first
 * send on the enrollment they were attached to by eleven days.
 */
async function quarantinePhantomInbound() {
  const phantom = await sql`
    select im.id, im.received_at::text as received_at, im.channel,
           im.from_address, im.classified_intent as intent,
           left(im.raw_body, 60) as body, im.enrollment_id,
           co.name as company_name,
           (select min(om.sent_at)::text from outreach_messages om
              where om.enrollment_id = im.enrollment_id and om.status = 'sent')
             as first_send_at
    from inbound_messages im
    join sequence_enrollments se on se.id = im.enrollment_id
    join companies co on co.id = se.company_id
    where im.channel = 'imessage'
      and im.enrollment_id is not null
      and (
        (select min(om.sent_at) from outreach_messages om
           where om.enrollment_id = im.enrollment_id and om.status = 'sent')
          > im.received_at
        or (select min(om.sent_at) from outreach_messages om
              where om.enrollment_id = im.enrollment_id and om.status = 'sent')
             is null
      )
    order by im.received_at asc
  `;

  console.log(`\n  ${phantom.length} inbound row(s) predate any send:`);
  for (const row of phantom) {
    console.log(
      `    ${row.received_at}  ${row.company_name}  ${JSON.stringify(row.body)}`,
    );
  }
  if (!APPLY || !phantom.length) return phantom.length;

  const ids = phantom.map((r) => r.id as string);
  // Detach, annotate, keep. contact_id stays so the row still reads under the
  // right person in the CRM.
  await sql`
    update inbound_messages
    set enrollment_id = null,
        action_taken = 'quarantined — chat.db history backfill, predates the first send on that enrollment; not a reply'
    where id = any(${ids}::uuid[])
  `;
  console.log(`    → ${ids.length} detached and annotated (none deleted)`);
  return ids.length;
}

/** The operator's own note, texted to themselves, that landed on stopped v4. */
async function quarantineSelfNote() {
  const rows = await sql`
    select id, received_at::text as received_at, enrollment_id
    from inbound_messages
    where external_id = 'chatdb:104676A0-3C4D-400E-ACCD-ACD64BFEC942'
  `;
  if (!rows.length) {
    console.log("\n  self-note row not found (already handled?)");
    return;
  }
  console.log(
    `\n  operator self-note at ${rows[0].received_at} attached to enrollment ${rows[0].enrollment_id}`,
  );
  if (!APPLY) return;
  await sql`
    update inbound_messages
    set enrollment_id = null,
        action_taken = 'quarantined — operator note texted to self, matched a retired v4 test enrollment that still held the number; not a reply'
    where id = ${rows[0].id}
  `;
  console.log("    → detached and annotated");
}

async function seedV11() {
  const [existing] = await sql`
    select id from companies where name = 'Proven Theory LLC v11'
  `;
  if (existing) {
    console.log(`\n  Proven Theory LLC v11 already exists: ${existing.id}`);
    return;
  }
  console.log("\n  seeding Proven Theory LLC v11 (mirrors the v8/v10 shape)");
  if (!APPLY) return;

  const [company] = await sql`
    insert into companies (
      name, domain, domain_confidence, status, first_seen, lead_score,
      hiring_signals, reason_to_call, call_opener, icp_status,
      estimated_employees, industry, enriched_at, enrich_run_date, source_market
    ) values (
      'Proven Theory LLC v11', 'proventheory-v11.test', 'high', 'new',
      '2026-07-30T04:00:00.000Z', 78,
      ${JSON.stringify({ new_company: true, multiple_openings: 1 })}::jsonb,
      'Retest listing — Recruiting Job Assistant opening; intentional Proven Theory v11 dry run: user adds to Call List from the UI to test add → enroll → day-0 send, now that a texted positive gets a texted answer.',
      'Hi Miguel — saw you''re hiring a Recruiting Job Assistant and figured it''d be worth a quick intro.',
      'pass', 8, 'Marketing & Advertising', now(),
      '2026-07-30T04:00:00.000Z', 'Miami, FL'
    ) returning id
  `;

  const [contact] = await sql`
    insert into contacts (
      company_id, name, title, email, work_email, phone, personal_phone,
      phones, source_provider, imessage_capable, email_deliverable,
      location_matched, contact_location, job_location, reveal_status,
      reveal_channels, is_primary
    ) values (
      ${company.id}, 'Miguel Lozano', 'Founder', 'info@cultura.company',
      'info@cultura.company', '+13212307946', '+13212307946',
      ${JSON.stringify([
        { kind: "mobile", number: "+13212307946", source: "apollo" },
      ])}::jsonb,
      'manual_test', true, true, true, 'Miami, FL', 'Miami, FL',
      'revealed', 'email_phone', true
    ) returning id
  `;

  const [listing] = await sql`
    insert into job_listings (
      company_id, title, board, url, location, search_name,
      salary_currency, sightings_count, first_seen_at, last_seen_at,
      last_seen_run_date
    ) values (
      ${company.id}, 'Recruiting Job Assistant', 'company_careers',
      'https://www.proventheory.co/pages/contact', 'Miami, FL (Remote-friendly)',
      'Recruiting Job Assistant', 'USD', 1, now(), now(),
      '2026-07-30T04:00:00.000Z'
    ) returning id
  `;

  console.log(`    company_id     ${company.id}`);
  console.log(`    contact_id     ${contact.id}`);
  console.log(`    job_listing_id ${listing.id}`);
}

async function verify() {
  console.log("\n=== VERIFY: who holds +13212307946 ===");
  console.log(
    JSON.stringify(
      await sql`
        select ct.id, ct.name, co.name as company_name, ct.phone,
               (select count(*)::int from sequence_enrollments se
                  where se.contact_id = ct.id
                    and se.status not in ('stopped', 'suppressed')) as active_enrollments
        from contacts ct join companies co on co.id = ct.company_id
        where ct.phone = '+13212307946' or ct.personal_phone = '+13212307946'
      `,
      null,
      1,
    ),
  );

  console.log("\n=== VERIFY: any enrollment still holding a phone ===");
  console.log(
    JSON.stringify(
      await sql`
        select co.name as company_name, se.status, se.phone_number,
               se.next_step_at::text as next_step_at
        from sequence_enrollments se join companies co on co.id = se.company_id
        where se.phone_number is not null
        order by se.enrolled_at asc
      `,
      null,
      1,
    ),
  );

  console.log("\n=== VERIFY: Alison untouched ===");
  console.log(
    JSON.stringify(
      await sql`
        select se.status, se.phone_number, se.email_address,
               (select count(*)::int from outreach_messages om
                  where om.enrollment_id = se.id and om.status = 'sent') as sent,
               (select count(*)::int from outreach_messages om
                  where om.enrollment_id = se.id and om.status = 'queued') as queued
        from sequence_enrollments se
        where se.id = 'b4d41451-0ea5-40dd-8cd3-413dc2bdd133'
      `,
      null,
      1,
    ),
  );

  console.log("\n=== VERIFY: v11 ready to add to Call List ===");
  console.log(
    JSON.stringify(
      await sql`
        select co.id as company_id, co.name, co.domain, co.status, co.icp_status,
               ct.id as contact_id, ct.name as contact_name, ct.email, ct.phone,
               jl.id as job_listing_id, jl.title,
               (select count(*)::int from sequence_enrollments se
                  where se.company_id = co.id) as enrollments,
               (select count(*)::int from call_list_entries cl
                  where cl.company_id = co.id) as call_list_rows
        from companies co
        left join contacts ct on ct.company_id = co.id
        left join job_listings jl on jl.company_id = co.id
        where co.name = 'Proven Theory LLC v11'
      `,
      null,
      1,
    ),
  );
}

async function main() {
  console.log(APPLY ? "=== APPLYING ===" : "=== DRY RUN (pass --apply) ===");
  console.log("\n--- 1. retire spent test enrollments ---");
  await retire();
  console.log("\n--- 2. quarantine chat.db backfill ---");
  await quarantinePhantomInbound();
  await quarantineSelfNote();
  console.log("\n--- 3. seed v11 ---");
  await seedV11();
  if (APPLY) await verify();
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
