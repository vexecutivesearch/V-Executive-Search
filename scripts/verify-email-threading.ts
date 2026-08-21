/**
 * Do follow-up emails land in the thread they refer to?
 *
 * A follow-up sent with fresh headers and a new subject arrives as an unrelated
 * cold email, so the recipient reads "following up on my note" with no note
 * above it. `threadHeaders` fixes that by setting In-Reply-To to the newest
 * send on the enrollment, References to the whole chain, and reusing the FIRST
 * send's subject with a single Re: prefix.
 *
 * None of that is verifiable from the message body, so this checks the three
 * facts the database does record:
 *
 *   1. every sent email has a Message-ID — without one nothing downstream can
 *      thread, and a null here is the root cause of every other failure below
 *   2. the sent event names what it replied to (`threaded_to` in the payload)
 *      for every send after the first on an enrollment
 *   3. the stored subject is the intro's subject with exactly one Re:, and the
 *      row agrees with what the contact actually received
 *
 * Usage:
 *   npx tsx scripts/verify-email-threading.ts
 *   npx tsx scripts/verify-email-threading.ts --days 30
 *   npx tsx scripts/verify-email-threading.ts --problems
 *
 * Read only. Requires DATABASE_URL in .env.local.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { fail, readOnlySql, show } from "./lib/read-only-sql";

const ARGV = process.argv.slice(2);
const PROBLEMS_ONLY = ARGV.includes("--problems");
const daysArg = ARGV.indexOf("--days");
const DAYS = daysArg > -1 ? Math.max(1, Number(ARGV[daysArg + 1]) || 30) : 30;

const sql = readOnlySql();

/** Mirrors threadHeaders: strip every leading Re:, then add exactly one. */
function expectedSubject(rootSubject: string | null): string | null {
  const root = rootSubject?.trim();
  if (!root) return null;
  return `Re: ${root.replace(/^(?:re:\s*)+/i, "")}`;
}

async function main() {
  console.log(`\n=== Email threading, last ${DAYS} day(s) ===\n`);

  /* --- 1. Message-ID present on every send ---------------------------- */
  const [ids] = await sql<{ sent: number; with_id: number; with_resend_id: number }>`
    select count(*)::int as sent,
           count(message_id)::int as with_id,
           count(resend_id)::int as with_resend_id
    from outreach_messages
    where channel = 'email' and status = 'sent'
      and sent_at >= now() - (${DAYS} || ' days')::interval
  `;

  console.table([
    {
      sent_emails: ids?.sent ?? 0,
      with_message_id: ids?.with_id ?? 0,
      missing_message_id: (ids?.sent ?? 0) - (ids?.with_id ?? 0),
      with_resend_deep_link: ids?.with_resend_id ?? 0,
    },
  ]);
  if ((ids?.sent ?? 0) > (ids?.with_id ?? 0)) {
    console.log(
      "Sends with no Message-ID cannot be threaded onto and cannot be replied " +
        "to by the auto-responder. Resend's own id cannot substitute.",
    );
  }

  /* --- 2 and 3. follow-ups that opened a new thread -------------------- */
  const chains = await sql<{
    enrollment_id: string;
    company: string;
    contact: string;
    step_kind: string;
    sent_at: string;
    subject: string | null;
    message_id: string | null;
    root_subject: string | null;
    root_message_id: string | null;
    position: number;
    threaded_to: string | null;
  }>`
    with sends as (
      select m.id, m.enrollment_id, m.step_kind, m.sent_at, m.subject, m.message_id,
             row_number() over (partition by m.enrollment_id order by m.sent_at) as position,
             first_value(m.subject) over (
               partition by m.enrollment_id order by m.sent_at
             ) as root_subject,
             first_value(m.message_id) over (
               partition by m.enrollment_id order by m.sent_at
             ) as root_message_id
      from outreach_messages m
      where m.channel = 'email' and m.status = 'sent'
    )
    select s.enrollment_id, co.name as company, ct.name as contact,
           s.step_kind, s.sent_at, s.subject, s.message_id,
           s.root_subject, s.root_message_id, s.position::int as position,
           (select ev.payload ->> 'threaded_to'
              from enrollment_events ev
             where ev.enrollment_id = s.enrollment_id
               and ev.event_type = 'sent'
               and ev.payload ->> 'message_id' = s.id::text
             order by ev.created_at desc
             limit 1) as threaded_to
    from sends s
    join sequence_enrollments e on e.id = s.enrollment_id
    join companies co on co.id = e.company_id
    join contacts ct on ct.id = e.contact_id
    where s.position > 1
      and s.sent_at >= now() - (${DAYS} || ' days')::interval
    order by s.sent_at desc
    limit 200
  `;

  const unthreaded = chains.filter((row) => !row.threaded_to);
  const wrongSubject = chains.filter((row) => {
    const want = expectedSubject(row.root_subject);
    return want !== null && (row.subject ?? "").trim() !== want;
  });
  const doubleRe = chains.filter((row) =>
    /^(?:re:\s*){2,}/i.test((row.subject ?? "").trim()),
  );

  console.log(
    `\nFollow-up sends in this window (anything after the first email on an enrollment): ${chains.length}`,
  );

  console.log("\nFollow-ups sent WITHOUT an In-Reply-To");
  if (unthreaded.length) {
    console.table(
      unthreaded.map((r) => ({
        company: r.company,
        contact: r.contact,
        step: r.step_kind,
        sent: show(r.sent_at),
        subject: show(r.subject),
        root_had_message_id: r.root_message_id ? "yes" : "no — nothing to thread onto",
      })),
    );
    console.log(
      "Each of these arrived as a new cold email. Where the root had no " +
        "Message-ID, threadHeaders had nothing to build a chain from and the " +
        "real fix is upstream.",
    );
  } else {
    console.log("None. Every follow-up named the message it replied to.");
  }

  console.log("\nFollow-ups whose stored subject is not the intro's subject with one Re:");
  if (wrongSubject.length) {
    console.table(
      wrongSubject.map((r) => ({
        company: r.company,
        contact: r.contact,
        step: r.step_kind,
        sent: show(r.sent_at),
        intro_subject: show(r.root_subject),
        expected: show(expectedSubject(r.root_subject)),
        stored: show(r.subject),
      })),
    );
    console.log(
      "Dispatch writes back the threaded subject after sending, so the stored " +
        "value is what the contact saw. A mismatch means either the write-back " +
        "did not happen or the send predates threading.",
    );
  } else {
    console.log("None. Every follow-up reuses the intro's subject with one Re:.");
  }

  if (doubleRe.length) {
    console.log("\n!! Subjects carrying a stacked Re: Re: prefix");
    console.table(
      doubleRe.map((r) => ({
        company: r.company,
        step: r.step_kind,
        subject: show(r.subject),
      })),
    );
  }

  /* --- context ---------------------------------------------------------- */
  if (!PROBLEMS_ONLY) {
    const perStep = await sql<{
      step_kind: string;
      sent: number;
      threaded: number;
    }>`
      select m.step_kind, count(*)::int as sent,
             count(*) filter (
               where exists (
                 select 1 from enrollment_events ev
                 where ev.enrollment_id = m.enrollment_id
                   and ev.event_type = 'sent'
                   and ev.payload ->> 'message_id' = m.id::text
                   and ev.payload ->> 'threaded_to' is not null
               )
             )::int as threaded
      from outreach_messages m
      where m.channel = 'email' and m.status = 'sent'
        and m.sent_at >= now() - (${DAYS} || ' days')::interval
      group by m.step_kind
      order by sent desc
    `;
    console.log("\nThreading by step kind (intro is expected to be unthreaded)");
    if (perStep.length) console.table(perStep);

    const replies = await sql<{
      step_kind: string;
      sent: number;
      with_deep_link: number;
    }>`
      select m.step_kind, count(*)::int as sent,
             count(m.resend_id)::int as with_deep_link
      from outreach_messages m
      where m.channel = 'email' and m.status = 'sent'
        and m.sent_at >= now() - (${DAYS} || ' days')::interval
      group by m.step_kind
      order by sent desc
    `;
    console.log("\nResend deep link recorded per step (the Call List note links to it)");
    if (replies.length) console.table(replies);
  }

  /* --- verdict ----------------------------------------------------------- */
  const problems: string[] = [];
  if ((ids?.sent ?? 0) > (ids?.with_id ?? 0)) {
    problems.push(
      `${(ids?.sent ?? 0) - (ids?.with_id ?? 0)} sent email(s) have no Message-ID`,
    );
  }
  if (unthreaded.length) {
    problems.push(`${unthreaded.length} follow-up(s) sent with no In-Reply-To`);
  }
  if (wrongSubject.length) {
    problems.push(`${wrongSubject.length} follow-up(s) did not reuse the intro subject`);
  }
  if (doubleRe.length) {
    problems.push(`${doubleRe.length} subject(s) carry a stacked Re: prefix`);
  }

  console.log("\n=== Verdict ===");
  if (problems.length) {
    console.table(problems.map((p) => ({ problem: p })));
    fail("follow-up emails are not threading onto the intro.");
  } else {
    console.log(
      "PASS: every send has a Message-ID, every follow-up replies to the chain, " +
        "and every subject is the intro's with a single Re:.",
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
