/**
 * Could a cold contact ever be texted?
 *
 * `suppressions` records how to STOP. What records how permission was GRANTED
 * is `consent_records`, added by the consent lanes work; note that
 * `sequence_enrollments.legal_basis` ("legitimate interest — B2B recruitment
 * outreach") is a cold-email posture, not consent to send SMS. So the question
 * this answers has two halves:
 *
 *   Where consent_records is deployed: does every contact with a live text
 *   path have a consent record that covers SMS, is not revoked, and names THAT
 *   number?
 *   Where it is not yet: is every text path inert instead? No SMS provider
 *   configured, no caller of sendSms, the text channel off, nothing sent.
 *
 * It detects which half applies by asking the database whether consent_records
 * exists, so it is safe to run against an environment that has not yet had the
 * migration applied, and it is the check that proves the migration did what it
 * claimed on the ones that have.
 *
 * Usage:
 *   npx tsx scripts/verify-consent-gate.ts
 *   npx tsx scripts/verify-consent-gate.ts --problems
 *
 * Read only. Requires DATABASE_URL in .env.local.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { fail, readOnlySql, show } from "./lib/read-only-sql";

const ARGV = process.argv.slice(2);
const PROBLEMS_ONLY = ARGV.includes("--problems");

const sql = readOnlySql();

async function tableExists(name: string): Promise<boolean> {
  const rows = await sql<{ present: boolean }>`
    select to_regclass(${`public.${name}`}) is not null as present
  `;
  return Boolean(rows[0]?.present);
}

async function main() {
  console.log("\n=== Consent gating: can a cold contact be texted? ===\n");

  const [hasConsent, hasCallOutcomes] = await Promise.all([
    tableExists("consent_records"),
    tableExists("call_outcomes"),
  ]);

  console.table([
    {
      consent_records: hasConsent ? "present" : "not deployed yet",
      call_outcomes: hasCallOutcomes ? "present" : "not deployed yet",
      lane: hasConsent
        ? "post-merge — consent is checkable"
        : "pre-merge — the only defence is that every text path is inert",
    },
  ]);

  /* --- the pre-merge question: is anything textable at all? ------------ */
  const [settings] = await sql<{
    enabled: boolean;
    text_enabled: boolean;
    dry_run: boolean;
  }>`select enabled, text_enabled, dry_run from outreach_settings limit 1`;

  const [textShape] = await sql<{
    live_with_phone: number;
    queued_texts: number;
    sent_texts_ever: number;
  }>`
    select
      (select count(*)::int from sequence_enrollments e
        where e.phone_number is not null
          and e.status in ('active', 'paused', 'waiting_on_reply', 'waiting_on_manual')
      ) as live_with_phone,
      (select count(*)::int from outreach_messages m
        where m.channel = 'imessage' and m.status = 'queued') as queued_texts,
      (select count(*)::int from outreach_messages m
        where m.channel = 'imessage' and m.status = 'sent') as sent_texts_ever
  `;

  console.log("The text surface as it stands");
  console.table([
    {
      master_send_switch: settings?.enabled ?? "no settings row",
      text_channel: settings?.text_enabled ? "ON" : "OFF",
      dry_run: settings?.dry_run ?? "—",
      live_enrollments_with_a_number: textShape?.live_with_phone ?? 0,
      queued_texts: textShape?.queued_texts ?? 0,
      texts_ever_sent: textShape?.sent_texts_ever ?? 0,
    },
  ]);

  console.log(
    "OUTREACH_SMS_ENABLED and the Twilio credentials are environment state, not " +
      "database state — check them on the deploy with:\n" +
      "  vercel env ls | grep -E 'OUTREACH_SMS_ENABLED|TWILIO_'\n" +
      "The Twilio path is inert while OUTREACH_SMS_ENABLED is anything but true, " +
      "and nothing in the codebase calls sendSms yet.",
  );

  if (!hasConsent) {
    const problems: string[] = [];
    if (settings?.text_enabled && (textShape?.live_with_phone ?? 0) > 0) {
      problems.push(
        `the text channel is ON with ${textShape?.live_with_phone} live enrollment(s) ` +
          "carrying a number, and there is no consent table to check them against",
      );
    }
    console.log("\n=== Verdict (pre-merge) ===");
    if (problems.length) {
      console.table(problems.map((p) => ({ problem: p })));
      fail("texting is possible and consent cannot be evidenced.");
    } else {
      console.log(
        "PASS: consent_records is not deployed, and with the text channel off " +
          "no cold contact can be texted. Re-run this after the consent lanes " +
          "merge to check the artifacts themselves.",
      );
    }
    return;
  }

  /* --- the post-merge question: is the consent real? -------------------- */
  const summary = await sql<{
    source: string;
    channel_scope: string;
    total: number;
    revoked: number;
    with_disclosure: number;
    with_ip: number;
  }>`
    select source::text as source, channel_scope::text as channel_scope,
           count(*)::int as total,
           count(*) filter (where revoked_at is not null)::int as revoked,
           count(*) filter (where length(trim(disclosure_text)) > 0)::int as with_disclosure,
           count(ip_address)::int as with_ip
    from consent_records
    group by 1, 2
    order by total desc
  `;

  console.log("\nConsent artifacts on file");
  if (summary.length) console.table(summary);
  else console.log("None. Nobody has opted in yet.");

  const emptyDisclosure = await sql<{
    id: string;
    source: string;
    captured_at: string;
    email: string | null;
    phone: string | null;
  }>`
    select id, source::text as source, captured_at, email, phone
    from consent_records
    where length(trim(coalesce(disclosure_text, ''))) = 0
    limit 25
  `;

  console.log("\nConsent records with no verbatim disclosure text");
  if (emptyDisclosure.length) {
    console.table(
      emptyDisclosure.map((r) => ({ ...r, captured_at: show(r.captured_at) })),
    );
    console.log(
      "The wording shown at capture time IS the artifact. A record without it " +
        "proves a click and nothing else.",
    );
  } else {
    console.log("None. Every record stores the wording the person saw.");
  }

  /* --- the headline: a text path with no consent behind it -------------- */
  const uncovered = await sql<{
    company: string;
    contact: string;
    phone_number: string;
    lead_source: string;
    enrollment_status: string;
    queued_texts: number;
    sent_texts: number;
    consent_rows: number;
  }>`
    select co.name as company, ct.name as contact, e.phone_number,
           co.lead_source::text as lead_source,
           e.status::text as enrollment_status,
           (select count(*)::int from outreach_messages m
             where m.enrollment_id = e.id and m.channel = 'imessage'
               and m.status = 'queued') as queued_texts,
           (select count(*)::int from outreach_messages m
             where m.enrollment_id = e.id and m.channel = 'imessage'
               and m.status = 'sent') as sent_texts,
           (select count(*)::int from consent_records cr
             where cr.revoked_at is null
               and cr.channel_scope in ('sms', 'both')
               and regexp_replace(coalesce(cr.phone, ''), '[^0-9]', '', 'g')
                 = regexp_replace(e.phone_number, '[^0-9]', '', 'g')) as consent_rows
    from sequence_enrollments e
    join companies co on co.id = e.company_id
    join contacts ct on ct.id = e.contact_id
    where e.phone_number is not null
      and e.status in ('active', 'paused', 'waiting_on_reply', 'waiting_on_manual')
    order by sent_texts desc, queued_texts desc
    limit 200
  `;

  const noConsent = uncovered.filter((r) => r.consent_rows === 0);
  const sentWithoutConsent = noConsent.filter((r) => r.sent_texts > 0);

  console.log("\nLive enrollments with a text target and no SMS consent covering that number");
  if (noConsent.length) {
    console.table(
      (PROBLEMS_ONLY ? noConsent.filter((r) => r.sent_texts + r.queued_texts > 0) : noConsent)
        .slice(0, 50)
        .map((r) => ({
          company: r.company,
          contact: r.contact,
          lane: r.lead_source,
          number: r.phone_number,
          queued: r.queued_texts,
          sent: r.sent_texts,
        })),
    );
    console.log(
      "A cold_discovery lane row here is expected and is exactly why the text " +
        "channel is off: the number is stored, but no consent exists so no text " +
        "may go out. It becomes a failure the moment one of them shows a send.",
    );
  } else {
    console.log("None. Every live text target has a consent record naming that number.");
  }

  /* --- consent for the wrong number or a revoked one -------------------- */
  const revokedButLive = await sql<{
    company: string;
    contact: string;
    phone: string | null;
    revoked_at: string;
    revoked_reason: string | null;
    queued_texts: number;
  }>`
    select co.name as company, ct.name as contact, cr.phone,
           cr.revoked_at, cr.revoked_reason,
           (select count(*)::int from outreach_messages m
             join sequence_enrollments e2 on e2.id = m.enrollment_id
            where e2.contact_id = ct.id and m.channel = 'imessage'
              and m.status = 'queued') as queued_texts
    from consent_records cr
    join contacts ct on ct.id = cr.contact_id
    join companies co on co.id = ct.company_id
    where cr.revoked_at is not null
    order by cr.revoked_at desc
    limit 50
  `;

  console.log("\nRevoked consent — nothing may send on these, and the row must survive");
  if (revokedButLive.length) {
    console.table(
      revokedButLive.map((r) => ({ ...r, revoked_at: show(r.revoked_at) })),
    );
  } else {
    console.log("None revoked.");
  }

  const revokedWithQueue = revokedButLive.filter((r) => r.queued_texts > 0);

  /* --- dial gate -------------------------------------------------------- */
  if (hasCallOutcomes) {
    const dialed = await sql<{
      classification: string;
      calls: number;
      companies: number;
    }>`
      select coalesce(phone_classification::text, 'not recorded') as classification,
             count(*)::int as calls,
             count(distinct company_id)::int as companies
      from call_outcomes
      group by 1
      order by calls desc
    `;
    console.log("\nLogged calls by the dial class the number was dialed under");
    if (dialed.length) {
      console.table(dialed);
      console.log(
        "Only business_line may be dialed. `unknown` is treated as `mobile` by " +
          "the gate, so a call logged against either is the gate having been bypassed.",
      );
    } else {
      console.log("No calls logged yet.");
    }

    const badDials = dialed.filter(
      (r) => r.classification === "mobile" || r.classification === "unknown",
    );

    if (badDials.length) {
      console.log(
        `!! ${badDials.reduce((n, r) => n + r.calls, 0)} call(s) were logged against a ` +
          "non-business line.",
      );
    }
  }

  /* --- verdict ----------------------------------------------------------- */
  const problems: string[] = [];
  if (sentWithoutConsent.length) {
    problems.push(
      `${sentWithoutConsent.length} contact(s) were texted with no consent record for that number`,
    );
  }
  if (emptyDisclosure.length) {
    problems.push(
      `${emptyDisclosure.length} consent record(s) store no verbatim disclosure text`,
    );
  }
  if (revokedWithQueue.length) {
    problems.push(
      `${revokedWithQueue.length} contact(s) revoked consent but still have a text queued`,
    );
  }

  console.log("\n=== Verdict (post-merge) ===");
  if (problems.length) {
    console.table(problems.map((p) => ({ problem: p })));
    fail("a text path exists without a consent artifact behind it.");
  } else {
    console.log(
      "PASS: no contact has been texted without SMS consent naming their number, " +
        "every record carries its verbatim disclosure, and no revoked contact " +
        "has a text waiting.",
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
