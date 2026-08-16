/**
 * Take the seeded test addresses back out of the warm-up counters.
 *
 * Warm-up health decides whether a sending domain can ramp, so it has to
 * measure real prospecting. Three of the four bounces on the pool came from
 * miguel@rxlibrary.com, a mailbox invented during the July debugging that was
 * never going to accept mail. The fourth, kirk@stangelawfirm.com, is a real
 * prospect and a real permanent bounce, so it stays: removing it would be
 * editing away the signal the guardrail exists to catch.
 *
 * Only bounces attributable to a seeded test address are removed, and only on
 * the profile that actually carried them, read from the webhook's own inbound
 * rows (external_id = resend:email.bounced:<resend_id>). total_sent and
 * total_delivered are left alone: dropping the sends too would raise the
 * remaining real bounce rate rather than lower it.
 *
 * Usage:
 *   npx tsx scripts/reset-test-bounce-counters.ts           # show the plan
 *   npx tsx scripts/reset-test-bounce-counters.ts --apply   # write it
 *
 * Requires DATABASE_URL in .env.local.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);
const APPLY = process.argv.includes("--apply");

/**
 * Addresses on domains invented for testing. Real inboxes used in tests
 * (a personal Gmail, an iCloud address) are deliberately NOT here: mail to
 * them behaves like mail to a prospect, so their outcomes are real signal.
 */
const TEST_ADDRESSES = ["miguel@rxlibrary.com", "miguel@autism.one"];

const BOUNCE_VIOLATION_RATE = 0.02;

async function main() {
  console.log(APPLY ? "=== APPLYING ===\n" : "=== DRY RUN (pass --apply) ===\n");

  const bounces = (await sql`
    select sp.id as profile_id, sp.label as profile,
           se.email_address as recipient,
           im.received_at::timestamp(0)::text as at,
           im.subject
    from inbound_messages im
    join outreach_messages om on om.resend_id = split_part(im.external_id, ':', 3)
    join sending_profiles sp on sp.id = om.sending_profile_id
    left join sequence_enrollments se on se.id = om.enrollment_id
    where im.external_id like 'resend:email.bounced:%'
    order by im.received_at
  `) as Array<Record<string, string>>;

  const removeByProfile = new Map<string, { label: string; n: number }>();
  for (const b of bounces) {
    const isTest = TEST_ADDRESSES.some(
      (a) => a.toLowerCase() === (b.recipient ?? "").toLowerCase(),
    );
    console.log(
      `${b.at}  ${b.profile.padEnd(21)} ${(b.recipient ?? "(unknown)").padEnd(26)} ` +
        `${b.subject}  ${isTest ? "-> REMOVE (seeded test address)" : "-> KEEP (real prospect)"}`,
    );
    if (!isTest) continue;
    const entry = removeByProfile.get(b.profile_id) ?? { label: b.profile, n: 0 };
    entry.n += 1;
    removeByProfile.set(b.profile_id, entry);
  }

  console.log("");
  const profiles = (await sql`
    select id, label, total_sent, total_bounced, total_complaints
    from sending_profiles where kind = 'email_domain' order by label
  `) as Array<Record<string, string | number>>;

  for (const p of profiles) {
    const remove = removeByProfile.get(String(p.id))?.n ?? 0;
    const before = Number(p.total_bounced);
    const after = Math.max(0, before - remove);
    const sent = Number(p.total_sent);
    const rateBefore = sent ? (before / sent) * 100 : 0;
    const rateAfter = sent ? (after / sent) * 100 : 0;
    const stillViolating = sent >= 20 && after / Math.max(sent, 1) > BOUNCE_VIOLATION_RATE;

    console.log(
      `${String(p.label).padEnd(21)} bounced ${before} -> ${after} on ${sent} sends ` +
        `(${rateBefore.toFixed(1)}% -> ${rateAfter.toFixed(1)}%)` +
        (remove ? "" : "  [no test bounces]"),
    );
    if (stillViolating) {
      console.log(
        `   still over the ${BOUNCE_VIOLATION_RATE * 100}% line on real bounces — stays throttled ` +
          `until clean volume dilutes it`,
      );
    }

    if (APPLY && remove) {
      await sql`
        update sending_profiles
           set total_bounced = ${after}, updated_at = now()
         where id = ${p.id}::uuid
      `;
      // The tick only starts a clean soak when it sees a clean profile with no
      // clean_since; seed it now so the clock does not wait for Monday's cron.
      if (!stillViolating) {
        await sql`
          update sending_profiles
             set clean_since = coalesce(clean_since, now()),
                 paused_reason = case when status = 'throttled' then paused_reason else null end,
                 updated_at = now()
           where id = ${p.id}::uuid
        `;
      }
    }
  }

  if (!APPLY) console.log("\nNothing written. Re-run with --apply.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
