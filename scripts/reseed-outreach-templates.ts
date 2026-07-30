/**
 * Refresh Template bank seed exemplars in Neon.
 *
 * Usage: npx tsx scripts/reseed-outreach-templates.ts
 * Requires: DATABASE_URL in .env.local
 */
import { config } from "dotenv";

config({ path: ".env.local" });

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL missing — load .env.local first");
    process.exit(1);
  }
  const { seedOutreachTemplates } = await import(
    "@/lib/outreach/seed-templates"
  );
  const changed = await seedOutreachTemplates();
  console.log(`seedOutreachTemplates: ${changed} row(s) changed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
