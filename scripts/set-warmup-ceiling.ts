/**
 * Set the per-profile warm-up ceiling so the pool can send a target volume/day.
 *
 * The effective cap is min(daily_limit, rampCap(ramp_stage)), and
 * tickWarmupStateMachine rewrites daily_limit from rampCap(stage) whenever it
 * ramps a profile. Raising daily_limit alone therefore lasts until the next
 * ramp; the stage has to move with it, which is what this does.
 *
 * Usage:
 *   npx tsx scripts/set-warmup-ceiling.ts             # show the plan
 *   npx tsx scripts/set-warmup-ceiling.ts --apply     # write it
 *
 * Requires DATABASE_URL in .env.local.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);
const APPLY = process.argv.includes("--apply");

const RAMP_BASE = 5;
const RAMP_INCREMENT = 5;
const RAMP_CEILING = 50;
const BOUNCE_VIOLATION_RATE = 0.05; // mirrors src/lib/outreach/profiles.ts
const COMPLAINT_VIOLATION_RATE = 0.001;
/** hasViolation ignores profiles below this many sends. */
const MIN_SENT_TO_JUDGE = 20;

const rampCap = (stage: number) =>
  Math.min(RAMP_CEILING, RAMP_BASE + RAMP_INCREMENT * Math.max(0, stage));

/** Lowest stage whose rampCap reaches `target`. */
function stageFor(target: number): number {
  for (let stage = 0; stage <= 20; stage += 1) {
    if (rampCap(stage) >= target) return stage;
  }
  return 20;
}

/**
 * Established domains keep the ~100/day pool they already earned.
 * The five 2026-08-21 domains stay off this map so a --apply leaves them
 * at the 5/day warm-up floor until they earn a raise.
 */
const DEFAULT_TARGETS: Record<string, number> = {
  "vexecsearch.com": 35,
  "vexecutivesearch.co": 35,
  "vtalentsearch.com": 30,
};

/**
 * `--target N` applies the same ceiling to every domain, for draining a
 * backlog. RAMP_CEILING (50) is the highest the state machine will ever award
 * on its own, so it is the ceiling to reach for rather than exceed.
 */
const targetArg = process.argv.indexOf("--target");
const UNIFORM_TARGET =
  targetArg > -1 ? Math.max(1, Number(process.argv[targetArg + 1]) || 0) : null;

async function main() {
  const rows = (await sql`
    select id, label, status, ramp_stage, daily_limit,
           total_sent, total_bounced, total_complaints
    from sending_profiles where kind = 'email_domain' order by label
  `) as Array<Record<string, string | number>>;

  let before = 0;
  let after = 0;
  console.log(APPLY ? "=== APPLYING ===" : "=== DRY RUN (pass --apply) ===\n");

  for (const row of rows) {
    const label = String(row.label);
    const target = UNIFORM_TARGET ?? DEFAULT_TARGETS[label];
    const currentCap = Math.min(
      Number(row.daily_limit),
      rampCap(Number(row.ramp_stage)),
    );
    before += currentCap;
    if (!target) {
      after += currentCap;
      console.log(`${label}: no target set, leaving at ${currentCap}/day`);
      continue;
    }
    const stage = stageFor(target);
    const limit = Math.min(target, rampCap(stage));
    after += limit;

    console.log(
      `${label}: ${currentCap}/day (stage ${row.ramp_stage}, limit ${row.daily_limit}) ` +
        `-> ${limit}/day (stage ${stage}, limit ${limit})`,
    );

    // The counters are cumulative and never reset, so a profile can be clean
    // today and still trip the moment it crosses the judging threshold.
    const sent = Number(row.total_sent);
    const bounceRate = sent ? Number(row.total_bounced) / sent : 0;
    const complaintRate = sent ? Number(row.total_complaints) / sent : 0;
    const wouldViolate =
      bounceRate > BOUNCE_VIOLATION_RATE || complaintRate > COMPLAINT_VIOLATION_RATE;
    if (wouldViolate && sent >= MIN_SENT_TO_JUDGE) {
      console.log(
        `   WARNING  already violating (${(bounceRate * 100).toFixed(1)}% bounce on ${sent} sends). ` +
          `The tick keeps it throttled; it still sends, but it cannot ramp until the rate falls under ` +
          `${BOUNCE_VIOLATION_RATE * 100}%.`,
      );
    } else if (wouldViolate) {
      const sendsUntilJudged = MIN_SENT_TO_JUDGE - sent;
      console.log(
        `   WARNING  ${(bounceRate * 100).toFixed(1)}% bounce on ${sent} sends is under the ` +
          `${MIN_SENT_TO_JUDGE}-send judging floor. In ${sendsUntilJudged} more send(s) the tick will ` +
          `throttle it and cut this raise back to ${rampCap(Math.max(0, stage - 1))}/day.`,
      );
    }

    if (APPLY) {
      await sql`
        update sending_profiles
           set ramp_stage = ${stage}, daily_limit = ${limit}, updated_at = now()
         where id = ${row.id}::uuid
      `;
    }
  }

  console.log(`\npool ceiling: ${before}/day -> ${after}/day`);
  if (!APPLY) console.log("Nothing written. Re-run with --apply.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
