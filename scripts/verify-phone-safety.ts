/**
 * Is any outreach aimed at a company switchboard?
 *
 * `contacts.phone` falls back to the company's main line when Apollo has no
 * direct dial, and `contacts.personal_phone` takes whatever ContactOut returns
 * including a company number. Reading either field directly therefore aims a
 * first-person text ("Hey, my name is Alejandro, I've just emailed you") at a
 * receptionist — and because every contact at the firm falls back to the SAME
 * line, all of them text one switchboard. `pickPhone` exists to stop that by
 * dropping anything classified `kind = "company"`.
 *
 * This checks the result rather than the function: what is actually stored on
 * live enrollments, and whether the same number is doing duty for several
 * people. Three shapes matter, in order of severity:
 *
 *   1. an enrollment's phone_number equals its own company's main line
 *   2. an enrollment's phone_number is a number stored with kind 'company'
 *   3. one number is the send target for several contacts, at one company or
 *      across companies — the giveaway for a switchboard that was never
 *      labelled as one
 *
 * Usage:
 *   npx tsx scripts/verify-phone-safety.ts
 *   npx tsx scripts/verify-phone-safety.ts --problems
 *
 * Read only. Requires DATABASE_URL in .env.local.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { fail, readOnlySql, show } from "./lib/read-only-sql";

const ARGV = process.argv.slice(2);
const PROBLEMS_ONLY = ARGV.includes("--problems");

const sql = readOnlySql();

async function main() {
  console.log("\n=== Phone safety: no switchboard as a text or dial target ===\n");

  /* --- 1. enrollment pinned to its own company's main line ------------- */
  const mainLineTargets = await sql<{
    company: string;
    contact: string;
    enrollment_status: string;
    phone_number: string;
    company_phone: string;
    texts_sent: number;
    texts_queued: number;
  }>`
    select co.name as company, ct.name as contact,
           e.status::text as enrollment_status,
           e.phone_number, co.phone as company_phone,
           (select count(*)::int from outreach_messages m
             where m.enrollment_id = e.id and m.channel = 'imessage'
               and m.status = 'sent') as texts_sent,
           (select count(*)::int from outreach_messages m
             where m.enrollment_id = e.id and m.channel = 'imessage'
               and m.status = 'queued') as texts_queued
    from sequence_enrollments e
    join companies co on co.id = e.company_id
    join contacts ct on ct.id = e.contact_id
    where e.phone_number is not null
      and co.phone is not null
      and regexp_replace(e.phone_number, '[^0-9]', '', 'g')
          = regexp_replace(co.phone, '[^0-9]', '', 'g')
    order by texts_sent desc, co.name
  `;

  console.log("Enrollments whose text target IS the company main line");
  if (mainLineTargets.length) {
    console.table(mainLineTargets);
  } else {
    console.log("None. No enrollment is pointed at its own company's switchboard.");
  }

  /* --- 2. enrollment pinned to a number stored as kind 'company' ------- */
  const companyKindTargets = await sql<{
    company: string;
    contact: string;
    enrollment_status: string;
    phone_number: string;
    kinds: string;
    texts_sent: number;
  }>`
    select co.name as company, ct.name as contact,
           e.status::text as enrollment_status, e.phone_number,
           (select string_agg(distinct coalesce(p ->> 'kind', 'unlabelled'), ', ')
              from jsonb_array_elements(coalesce(ct.phones, '[]'::jsonb)) as p
             where regexp_replace(p ->> 'number', '[^0-9]', '', 'g')
                 = regexp_replace(e.phone_number, '[^0-9]', '', 'g')) as kinds,
           (select count(*)::int from outreach_messages m
             where m.enrollment_id = e.id and m.channel = 'imessage'
               and m.status = 'sent') as texts_sent
    from sequence_enrollments e
    join companies co on co.id = e.company_id
    join contacts ct on ct.id = e.contact_id
    where e.phone_number is not null
      and exists (
        select 1
        from jsonb_array_elements(coalesce(ct.phones, '[]'::jsonb)) as p
        where p ->> 'kind' = 'company'
          and regexp_replace(p ->> 'number', '[^0-9]', '', 'g')
            = regexp_replace(e.phone_number, '[^0-9]', '', 'g')
      )
    order by texts_sent desc, co.name
  `;

  console.log("\nEnrollments whose text target is a number labelled kind = 'company'");
  if (companyKindTargets.length) {
    console.table(companyKindTargets);
    console.log(
      "pickPhone filters kind = 'company' out before choosing, so any row here " +
        "was written by a path that read contacts.phone directly.",
    );
  } else {
    console.log("None. Every enrolled number is a direct line by its own label.");
  }

  /* --- 2b. text target classified as a business line ------------------- */
  const businessLineTexts = await sql<{
    company: string;
    contact: string;
    enrollment_status: string;
    phone_number: string;
    contact_class: string;
    texts_sent: number;
    texts_queued: number;
  }>`
    select co.name as company, ct.name as contact,
           e.status::text as enrollment_status, e.phone_number,
           ct.phone_classification::text as contact_class,
           (select count(*)::int from outreach_messages m
             where m.enrollment_id = e.id and m.channel = 'imessage'
               and m.status = 'sent') as texts_sent,
           (select count(*)::int from outreach_messages m
             where m.enrollment_id = e.id and m.channel = 'imessage'
               and m.status = 'queued') as texts_queued
    from sequence_enrollments e
    join companies co on co.id = e.company_id
    join contacts ct on ct.id = e.contact_id
    where e.phone_number is not null
      and ct.phone_classification = 'business_line'
    order by texts_sent desc, texts_queued desc, co.name
    limit 100
  `;

  console.log("\nText targets whose contact is classified 'business_line'");
  if (businessLineTexts.length) {
    console.table(businessLineTexts);
    console.log(
      "The classification exists to decide what may be DIALED, where " +
        "business_line is the permitted class. For text the polarity is " +
        "reversed: a business line is the switchboard, so a first-person text " +
        "to one lands on a receptionist. A row here with a send is a failure.",
    );
  } else {
    console.log("None. No enrolled text target is classified as a business line.");
  }

  /* --- the classification split itself, for context -------------------- */
  if (!PROBLEMS_ONLY) {
    const classSplit = await sql<{
      scope: string;
      classification: string;
      rows: number;
    }>`
      select 'contacts' as scope, phone_classification::text as classification,
             count(*)::int as rows
      from contacts
      group by 1, 2
      union all
      select 'companies', phone_classification::text, count(*)::int
      from companies
      group by 1, 2
      order by scope, rows desc
    `;
    console.log("\nStored phone classification, by scope");
    if (classSplit.length) {
      console.table(classSplit);
      console.log(
        "contacts default to 'mobile' and companies to 'business_line'. Those " +
          "defaults are deliberate and opposite: an unclassified contact number " +
          "is assumed unsafe to dial, an unclassified company number assumed to " +
          "be the main line. A large 'unknown' bucket means the classifier is " +
          "not running, and unknown is gated exactly like mobile.",
      );
    }
  }

  /* --- 3. one number, several people ----------------------------------- */
  const sharedNumbers = await sql<{
    digits: string;
    contacts: number;
    companies: number;
    who: string;
    where_used: string;
  }>`
    select regexp_replace(e.phone_number, '[^0-9]', '', 'g') as digits,
           count(distinct e.contact_id)::int as contacts,
           count(distinct e.company_id)::int as companies,
           string_agg(distinct ct.name, ', ') as who,
           string_agg(distinct co.name, ', ') as where_used
    from sequence_enrollments e
    join contacts ct on ct.id = e.contact_id
    join companies co on co.id = e.company_id
    where e.phone_number is not null
      and length(regexp_replace(e.phone_number, '[^0-9]', '', 'g')) >= 10
    group by 1
    having count(distinct e.contact_id) > 1
    order by contacts desc
    limit 50
  `;

  console.log("\nOne number set as the text target for more than one contact");
  if (sharedNumbers.length) {
    console.table(sharedNumbers);
    console.log(
      "Several people sharing one number is the shape of an unlabelled " +
        "switchboard. Same company: probably the main line. Different " +
        "companies: almost certainly a bad number rather than a coincidence.",
    );
  } else {
    console.log("None. Every enrolled number reaches exactly one contact.");
  }

  /* --- how the data got that way (context, never a failure) ------------ */
  if (!PROBLEMS_ONLY) {
    const fallbackShape = await sql<{
      bucket: string;
      contacts: number;
    }>`
      select case
               when ct.personal_phone is not null then 'has a personal_phone'
               when exists (
                 select 1 from jsonb_array_elements(coalesce(ct.phones, '[]'::jsonb)) as p
                 where coalesce(p ->> 'kind', 'other') <> 'company'
               ) then 'has a direct number in phones[]'
               when ct.phone is not null
                 and co.phone is not null
                 and regexp_replace(ct.phone, '[^0-9]', '', 'g')
                   = regexp_replace(co.phone, '[^0-9]', '', 'g')
                 then 'contacts.phone IS the company line'
               when ct.phone is not null then 'has contacts.phone only, origin unclear'
               else 'no number at all'
             end as bucket,
             count(*)::int as contacts
      from contacts ct
      join companies co on co.id = ct.company_id
      group by 1
      order by contacts desc
    `;
    console.log("\nWhere contact numbers come from — the reason pickPhone has to filter");
    if (fallbackShape.length) console.table(fallbackShape);

    const switchboards = await sql<{
      company: string;
      company_phone: string;
      contacts_sharing_it: number;
    }>`
      select co.name as company, co.phone as company_phone,
             count(*)::int as contacts_sharing_it
      from companies co
      join contacts ct on ct.company_id = co.id
      where co.phone is not null
        and ct.phone is not null
        and regexp_replace(ct.phone, '[^0-9]', '', 'g')
          = regexp_replace(co.phone, '[^0-9]', '', 'g')
      group by co.id, co.name, co.phone
      having count(*) > 1
      order by contacts_sharing_it desc
      limit 25
    `;
    console.log(
      "\nCompanies where several contacts carry the main line on contacts.phone",
    );
    if (switchboards.length) {
      console.table(switchboards);
      console.log(
        "These rows are fine as stored data. They are only dangerous if " +
          "something reads contacts.phone instead of calling pickPhone.",
      );
    } else {
      console.log("None.");
    }
  }

  /* --- suppression cover ------------------------------------------------ */
  const suppressedButEnrolled = await sql<{
    company: string;
    contact: string;
    phone_number: string;
    reason: string;
    enrollment_status: string;
    queued_texts: number;
  }>`
    select co.name as company, ct.name as contact, e.phone_number,
           s.reason, e.status::text as enrollment_status,
           (select count(*)::int from outreach_messages m
             where m.enrollment_id = e.id and m.channel = 'imessage'
               and m.status = 'queued') as queued_texts
    from sequence_enrollments e
    join contacts ct on ct.id = e.contact_id
    join companies co on co.id = e.company_id
    join suppressions s
      on s.phone is not null
     and regexp_replace(s.phone, '[^0-9]', '', 'g')
       = regexp_replace(e.phone_number, '[^0-9]', '', 'g')
     and s.channel in ('imessage', 'all')
    where e.phone_number is not null
      and e.status in ('active', 'paused', 'waiting_on_reply', 'waiting_on_manual')
    order by queued_texts desc
    limit 50
  `;

  console.log("\nLive enrollments pointed at a suppressed number");
  if (suppressedButEnrolled.length) {
    console.table(suppressedButEnrolled);
    console.log(
      "The worker queue re-checks suppression before handing anything over, so " +
        "these are held rather than sent — but a suppressed contact still on an " +
        "active sequence is worth closing out by hand.",
    );
  } else {
    console.log("None.");
  }

  /* --- verdict ----------------------------------------------------------- */
  const problems: string[] = [];
  if (mainLineTargets.length) {
    problems.push(
      `${mainLineTargets.length} enrollment(s) target their own company's main line`,
    );
  }
  if (companyKindTargets.length) {
    problems.push(
      `${companyKindTargets.length} enrollment(s) target a number labelled kind = 'company'`,
    );
  }
  const textedBusinessLine = businessLineTexts.filter(
    (r) => r.texts_sent + r.texts_queued > 0,
  );
  if (textedBusinessLine.length) {
    problems.push(
      `${textedBusinessLine.length} enrollment(s) have a text sent or queued to a number classified 'business_line'`,
    );
  }
  const crossCompany = sharedNumbers.filter((r) => r.companies > 1);
  if (crossCompany.length) {
    problems.push(
      `${crossCompany.length} number(s) are the text target at more than one company`,
    );
  }

  console.log("\n=== Verdict ===");
  if (problems.length) {
    console.table(problems.map((p) => ({ problem: p })));
    fail("at least one sequence is aimed at a shared or switchboard number.");
  } else {
    console.log(
      "PASS: no enrolled number is a company main line, none is labelled " +
        "kind = 'company', and none is shared across companies." +
        (sharedNumbers.length
          ? ` ${sharedNumbers.length} number(s) are shared between contacts at one company — review the table above.`
          : ""),
    );
  }
  console.log(
    `\nChecked ${show(mainLineTargets.length + companyKindTargets.length + sharedNumbers.length)} ` +
      "suspicious row(s) in total.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
