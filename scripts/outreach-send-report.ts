/**
 * Where outreach email actually stands: what sent, which domain sent it, what
 * is still waiting, and when the waiting will go out.
 *
 * "I don't see the email in Resend" almost always means one of three things,
 * and this separates them:
 *   - it sent, to the WORK address, so searching the personal one finds nothing
 *   - it is deferred behind warm-up capacity and will go out on a later day
 *   - it is scheduled for a future in-window slot
 *
 * Usage:
 *   npx tsx scripts/outreach-send-report.ts
 *   npx tsx scripts/outreach-send-report.ts --days 3
 *
 * Read only. Requires DATABASE_URL in .env.local.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

const daysArg = process.argv.indexOf("--days");
const DAYS = daysArg > -1 ? Math.max(1, Number(process.argv[daysArg + 1]) || 1) : 1;

/** Mirrors rampCap() in src/lib/outreach/profiles.ts. */
const RAMP_BASE = 5;
const RAMP_INCREMENT = 5;
const RAMP_CEILING = 50;
const rampCap = (stage: number) =>
  Math.min(RAMP_CEILING, RAMP_BASE + RAMP_INCREMENT * Math.max(0, stage));

const et = (ts: string | Date | null) =>
  ts
    ? new Date(ts).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";

async function main() {
  console.log(`\n=== Outreach email report — last ${DAYS} day(s) ===\n`);

  const [settings] = (await sql`
    select enabled, dry_run, require_approval, daily_send_cap,
           send_window_start_hour, send_window_end_hour
    from outreach_settings limit 1
  `) as Array<Record<string, unknown>>;

  if (!settings) {
    console.log("No outreach_settings row — nothing has been configured yet.");
    return;
  }
  console.log("Global switches");
  console.table([
    {
      enabled: settings.enabled,
      dry_run: settings.dry_run,
      require_approval: settings.require_approval,
      daily_send_cap: settings.daily_send_cap,
      window: `${settings.send_window_start_hour}:00–${settings.send_window_end_hour}:00 contact-local`,
    },
  ]);
  if (!settings.enabled) console.log("!! kill switch is OFF — nothing sends");
  if (settings.dry_run) console.log("!! dry-run is ON — nothing sends");

  // --- capacity, per sending domain -------------------------------------
  const profiles = (await sql`
    select p.id, p.label, p.from_address, p.status, p.ramp_stage, p.daily_limit,
           p.total_sent, p.total_bounced, p.total_complaints, p.last_ramp_at,
           (select count(*) from outreach_messages m
             where m.sending_profile_id = p.id
               and m.status = 'sent'
               and m.sent_at >= date_trunc('day', now())) as sent_today
    from sending_profiles p
    where p.kind = 'email_domain'
    order by p.label
  `) as Array<Record<string, unknown>>;

  console.log("\nSending domains — today's capacity");
  if (!profiles.length) {
    console.log(
      "No email_domain sending profiles. Dispatch falls back to the single " +
        "default identity (RESEND_API_KEY + from address) with no per-domain cap.",
    );
  } else {
    let capacityToday = 0;
    let usedToday = 0;
    console.table(
      profiles.map((p) => {
        const cap = Math.min(
          Number(p.daily_limit),
          rampCap(Number(p.ramp_stage)),
        );
        const used = Number(p.sent_today);
        capacityToday += cap;
        usedToday += used;
        return {
          domain: p.label,
          from: p.from_address,
          status: p.status,
          ramp_stage: p.ramp_stage,
          cap_per_day: cap,
          sent_today: used,
          remaining: Math.max(0, cap - used),
          lifetime_sent: p.total_sent,
          bounced: p.total_bounced,
          next_ramp_eligible: p.last_ramp_at
            ? et(
                new Date(
                  new Date(String(p.last_ramp_at)).getTime() + 7 * 86_400_000,
                ),
              )
            : "any clean tick",
        };
      }),
    );
    console.log(
      `Pool capacity today: ${usedToday}/${capacityToday} used, ` +
        `${Math.max(0, capacityToday - usedToday)} left.`,
    );
    console.log(
      "Ramp adds +5/day per domain per clean week, ceiling 50. " +
        `Mature pool of ${profiles.length} domain(s) = ${profiles.length * RAMP_CEILING}/day.`,
    );
  }

  // --- what sent, and to which address ----------------------------------
  const sent = (await sql`
    select m.step_kind, m.channel, count(*) as n
    from outreach_messages m
    where m.status = 'sent'
      and m.sent_at >= now() - (${DAYS} || ' days')::interval
    group by m.step_kind, m.channel
    order by m.channel, m.step_kind
  `) as Array<Record<string, unknown>>;

  console.log(`\nSent in the last ${DAYS} day(s)`);
  if (sent.length) console.table(sent);
  else console.log("Nothing sent in this window.");

  const addressSplit = (await sql`
    select case
             when e.email_address = c.work_email then 'work_email'
             when e.email_address = c.personal_email then 'personal_email'
             when e.email_address is null then 'none (text-only)'
             else 'other/legacy'
           end as address_used,
           count(*) as n
    from outreach_messages m
    join sequence_enrollments e on e.id = m.enrollment_id
    join contacts c on c.id = e.contact_id
    where m.status = 'sent' and m.channel = 'email'
      and m.sent_at >= now() - (${DAYS} || ' days')::interval
    group by 1 order by n desc
  `) as Array<Record<string, unknown>>;

  console.log("\nWhich address the sent emails went to");
  if (addressSplit.length) {
    console.table(addressSplit);
    console.log(
      "Searching Resend for a personal address finds nothing when the " +
        "sequence sent to the work address.",
    );
  } else {
    console.log("No emails sent in this window.");
  }

  // --- what has NOT sent, and why ---------------------------------------
  // A drafted row has no scheduled_for: the flow has not reached that step
  // yet, so it is a future follow-up rather than a held send. Only queued rows
  // are actually waiting on the dispatcher.
  const pending = (await sql`
    select m.status,
           case
             when m.status = 'drafted'
               then 'later step — flow has not reached it yet (not a backlog)'
             else coalesce(m.deferred_reason,
                    case when m.scheduled_for > now() then 'waiting for its scheduled slot'
                         when m.approved_at is null then 'waiting on approval'
                         else 'due now — next dispatch pass' end)
           end as reason,
           count(*) as n,
           min(m.scheduled_for) as earliest_slot
    from outreach_messages m
    join sequence_enrollments e on e.id = m.enrollment_id
    where m.channel = 'email'
      and m.status in ('drafted','queued')
      and e.status in ('active','paused','waiting_on_reply','waiting_on_manual')
    group by 1, 2 order by n desc
  `) as Array<Record<string, unknown>>;

  console.log("\nEmails NOT yet sent");
  if (pending.length) {
    console.table(
      pending.map((r) => ({
        status: r.status,
        why: r.reason,
        count: r.n,
        earliest_slot_et: et(r.earliest_slot as string | null),
      })),
    );
  } else {
    console.log("Nothing pending — every email on a live enrollment has sent.");
  }

  const queuedTotal = pending
    .filter((r) => r.status === "queued")
    .reduce((sum, r) => sum + Number(r.n), 0);
  const deferredTotal = pending
    .filter((r) => String(r.reason).includes("exhausted"))
    .reduce((sum, r) => sum + Number(r.n), 0);

  if (queuedTotal > 0) {
    console.log(
      `${queuedTotal} email(s) are queued and waiting on the dispatcher. ` +
        "Drafted rows above are later flow steps, not a backlog.",
    );
  }

  if (deferredTotal > 0) {
    const poolPerDay = profiles.reduce(
      (sum, p) =>
        sum + Math.min(Number(p.daily_limit), rampCap(Number(p.ramp_stage))),
      0,
    );
    // Whichever ceiling is lower is the one that actually binds.
    const cap = Number(settings.daily_send_cap) || Infinity;
    const perDay = Math.min(poolPerDay || Infinity, cap);
    const binding = poolPerDay && poolPerDay <= cap ? "sending pool" : "daily_send_cap";
    console.log(
      `\n${deferredTotal} email(s) are held behind capacity. The binding ceiling ` +
        `is the ${binding} at ${perDay}/day (pool ${poolPerDay}, cap ${cap}), so ` +
        `about ${Math.ceil(deferredTotal / Math.max(1, perDay))} more sending ` +
        `day(s) to drain, before counting anything added meanwhile.`,
    );
    console.log(
      "They are not lost: each dispatch pass retries them, and they send as " +
        "capacity frees up. A queued email deferred for roughly a day is " +
        "escalated to failed and alerted rather than sitting forever.",
    );
  }

  // --- what actually goes out on the next sending day -------------------
  const poolPerDay = profiles.reduce(
    (sum, p) =>
      sum + Math.min(Number(p.daily_limit), rampCap(Number(p.ramp_stage))),
    0,
  );
  const cap = Number(settings.daily_send_cap) || Infinity;
  const emailCeiling = Math.min(poolPerDay || Infinity, cap);

  const [nextDay] = (await sql`
    select
      -- Already queued and due by the end of the next sending day.
      (select count(*) from outreach_messages m
        join sequence_enrollments e on e.id = m.enrollment_id
        where m.channel='email' and m.status='queued'
          and e.status in ('active','paused','waiting_on_reply','waiting_on_manual')
          and (m.scheduled_for is null
               or m.scheduled_for < date_trunc('day', now()) + interval '2 days')
      ) as email_ready,
      (select count(*) from outreach_messages m
        join sequence_enrollments e on e.id = m.enrollment_id
        where m.channel='imessage' and m.status='queued'
          and e.status in ('active','paused','waiting_on_reply','waiting_on_manual')
          and (m.scheduled_for is null
               or m.scheduled_for < date_trunc('day', now()) + interval '2 days')
      ) as text_ready,
      -- Enrollments whose wait expires in the next 24-48h: each one queues its
      -- next drafted step, adding to tomorrow's load.
      (select count(*) from sequence_enrollments e
        where e.status = 'active'
          and e.next_step_at is not null
          and e.next_step_at < date_trunc('day', now()) + interval '2 days'
      ) as enrollments_waking
  `) as Array<Record<string, unknown>>;

  const emailReady = Number(nextDay?.email_ready ?? 0);
  const textReady = Number(nextDay?.text_ready ?? 0);
  const waking = Number(nextDay?.enrollments_waking ?? 0);

  console.log("\n=== Next sending day ===");
  console.table([
    {
      channel: "email",
      queued_and_due: emailReady,
      ceiling_per_day: emailCeiling,
      will_send: Math.min(emailReady, emailCeiling),
      still_waiting_after: Math.max(0, emailReady - emailCeiling),
    },
    {
      channel: "imessage",
      queued_and_due: textReady,
      ceiling_per_day: cap,
      will_send: Math.min(textReady, cap),
      still_waiting_after: Math.max(0, textReady - cap),
    },
  ]);
  console.log(
    `Plus ${waking} enrollment(s) whose wait expires by then — each queues its ` +
      "next step, which competes for the same ceilings.",
  );
  if (emailReady > emailCeiling) {
    console.log(
      `Email backlog needs about ${Math.ceil(emailReady / Math.max(1, emailCeiling))} ` +
        "sending day(s) to clear at the current ceiling, ignoring new adds.",
    );
  }

  console.log(
    "\nDispatch runs */15 12-23 Mon-Fri and */15 0-6 Tue-Sat UTC — " +
      "nothing dispatches on a Sunday.\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
