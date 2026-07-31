/**
 * Bring the live template bank in line with the current seed: apply the
 * renames, then rebuild the performance counters from message history.
 *
 * The counters shipped as running totals that were incremented on every
 * inbound message, which credited every template an enrollment had ever used
 * and never checked the reply arrived after the send. Reply rates above 100%
 * were the result. Recomputing is safe to repeat and cannot double count.
 *
 * Usage: npx tsx scripts/repair-template-bank.ts
 * Requires: DATABASE_URL in .env.local
 */
import { config } from "dotenv";

config({ path: ".env.local" });

/** Bank rows that predate the seed list and so are not renamed by seeding. */
const UNMANAGED_RENAMES: Array<{ from: string; to: string }> = [
  { from: "Text 1, soft intro", to: "Text 1, soft opener" },
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL missing — load .env.local first");
    process.exit(1);
  }
  const { db } = await import("@/lib/db");
  const { outreachTemplates } = await import("@/lib/db/schema");
  const { seedOutreachTemplates } = await import(
    "@/lib/outreach/seed-templates"
  );
  const { recomputeTemplateCounters } = await import(
    "@/lib/outreach/template-counters"
  );
  const { eq, sql } = await import("drizzle-orm");

  const before = await db
    .select({
      name: outreachTemplates.name,
      sends: outreachTemplates.timesUsed,
      replies: outreachTemplates.timesReplied,
      positives: outreachTemplates.timesPositive,
      optOuts: outreachTemplates.timesOptOut,
    })
    .from(outreachTemplates)
    .orderBy(outreachTemplates.kind, outreachTemplates.name);
  console.log("=== before ===");
  console.table(before);

  const seeded = await seedOutreachTemplates();
  console.log(`renamed/refreshed ${seeded} seed row(s)`);

  for (const { from, to } of UNMANAGED_RENAMES) {
    const [taken] = await db
      .select({ id: outreachTemplates.id })
      .from(outreachTemplates)
      .where(eq(outreachTemplates.name, to))
      .limit(1);
    if (taken) continue;
    const renamed = await db
      .update(outreachTemplates)
      .set({ name: to, updatedAt: new Date() })
      .where(eq(outreachTemplates.name, from))
      .returning({ id: outreachTemplates.id });
    if (renamed.length) console.log(`renamed unmanaged row: ${from} -> ${to}`);
  }

  const updated = await recomputeTemplateCounters();
  console.log(`recomputed counters on ${updated} row(s)`);

  const after = await db
    .select({
      name: outreachTemplates.name,
      kind: outreachTemplates.kind,
      channel: outreachTemplates.channel,
      proven: outreachTemplates.isProven,
      sends: outreachTemplates.timesUsed,
      replies: outreachTemplates.timesReplied,
      positives: outreachTemplates.timesPositive,
      optOuts: outreachTemplates.timesOptOut,
    })
    .from(outreachTemplates)
    .orderBy(outreachTemplates.kind, outreachTemplates.name);
  console.log("=== after ===");
  console.table(
    after.map((t) => ({
      ...t,
      replyRate: t.sends > 0 ? `${((t.replies / t.sends) * 100).toFixed(1)}%` : "—",
      positiveRate:
        t.sends > 0 ? `${((t.positives / t.sends) * 100).toFixed(1)}%` : "—",
    })),
  );

  const impossible = await db
    .select({ name: outreachTemplates.name })
    .from(outreachTemplates)
    .where(sql`${outreachTemplates.timesReplied} > ${outreachTemplates.timesUsed}`);
  if (impossible.length) {
    console.error("still impossible:", impossible.map((t) => t.name));
    process.exit(1);
  }
  console.log("every reply count is within its send count");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
