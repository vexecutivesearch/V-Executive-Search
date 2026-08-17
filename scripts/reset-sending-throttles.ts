/**
 * Clear the throttle on every sending domain and restore its earned capacity.
 *
 * A violation does two things: flips status to `throttled` and rolls ramp_stage
 * back one step. Clearing the status alone leaves the lost step behind, so this
 * restores both, and seeds `clean_since` so the warm-up clock starts now rather
 * than waiting for a tick to notice.
 *
 * ORDER MATTERS. tickWarmupStateMachine runs at the top of every dispatch pass
 * and re-throttles anything still over BOUNCE_VIOLATION_RATE — rolling back a
 * ramp step again as it does. Running this while the deployed threshold is
 * still lower than the profile's rate therefore makes capacity WORSE, not
 * better. Deploy the threshold you want first, then run this. It is idempotent,
 * so re-running after a deploy is safe and is the intended recovery.
 *
 * Usage:
 *   npx tsx scripts/reset-sending-throttles.ts                  # show the plan
 *   npx tsx scripts/reset-sending-throttles.ts --apply          # write it
 *   npx tsx scripts/reset-sending-throttles.ts --apply --restore-step
 *
 * --restore-step also gives back the ramp step the throttle took away.
 *
 * Requires DATABASE_URL in .env.local.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);
const APPLY = process.argv.includes("--apply");
const RESTORE_STEP = process.argv.includes("--restore-step");

/** Mirrors src/lib/outreach/profiles.ts. */
const RAMP_BASE = 5;
const RAMP_INCREMENT = 5;
const RAMP_CEILING = 50;
const BOUNCE_VIOLATION_RATE = 0.05;
const COMPLAINT_VIOLATION_RATE = 0.001;
const MIN_SENT_TO_JUDGE = 20;

const rampCap = (stage: number) =>
  Math.min(RAMP_CEILING, RAMP_BASE + RAMP_INCREMENT * Math.max(0, stage));

async function main() {
  console.log(APPLY ? "=== APPLYING ===\n" : "=== DRY RUN (pass --apply) ===\n");

  const rows = (await sql`
    select id, label, status, ramp_stage, daily_limit, paused_reason,
           total_sent, total_bounced, total_complaints, clean_since
    from sending_profiles
    where kind = 'email_domain'
    order by label
  `) as Array<Record<string, string | number | null>>;

  let before = 0;
  let after = 0;
  let willRethrottle = 0;

  for (const row of rows) {
    const sent = Number(row.total_sent);
    const bounceRate = sent ? Number(row.total_bounced) / sent : 0;
    const complaintRate = sent ? Number(row.total_complaints) / sent : 0;
    const judged = sent >= MIN_SENT_TO_JUDGE;
    const violates =
      judged &&
      (bounceRate > BOUNCE_VIOLATION_RATE ||
        complaintRate > COMPLAINT_VIOLATION_RATE);

    const currentStage = Number(row.ramp_stage);
    const currentCap = Math.min(Number(row.daily_limit), rampCap(currentStage));
    const wasThrottled = row.status === "throttled";
    const nextStage =
      RESTORE_STEP && wasThrottled ? currentStage + 1 : currentStage;
    const nextCap = rampCap(nextStage);

    before += currentCap;
    after += nextCap;

    console.log(
      `${String(row.label).padEnd(21)} ${String(row.status).padEnd(10)} ` +
        `${(bounceRate * 100).toFixed(1)}% bounce on ${sent} sends  ` +
        `${currentCap}/day (stage ${currentStage}) -> ${nextCap}/day (stage ${nextStage})`,
    );
    if (row.paused_reason) console.log(`   was: ${row.paused_reason}`);

    if (violates) {
      willRethrottle += 1;
      console.log(
        `   !! still over the ${BOUNCE_VIOLATION_RATE * 100}% line. The next dispatch pass ` +
          `will re-throttle it and take a ramp step back. Deploy a higher ` +
          `threshold, or dilute/clean the counters, before relying on this.`,
      );
    }

    if (APPLY) {
      await sql`
        update sending_profiles
           set status = 'warming',
               paused_reason = null,
               ramp_stage = ${nextStage},
               daily_limit = ${nextCap},
               clean_since = coalesce(clean_since, now()),
               updated_at = now()
         where id = ${row.id}::uuid
      `;
    }
  }

  console.log(`\npool ceiling: ${before}/day -> ${after}/day`);
  if (willRethrottle) {
    console.log(
      `${willRethrottle} profile(s) will be re-throttled by the next pass unless ` +
        `the deployed BOUNCE_VIOLATION_RATE is above their rate.`,
    );
  }
  if (!APPLY) console.log("Nothing written. Re-run with --apply.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
