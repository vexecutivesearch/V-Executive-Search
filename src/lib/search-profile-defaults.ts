import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { searchProfiles } from "@/lib/db/schema";

/** One-time backfill: per-search LinkedIn distance defaults for existing profiles. */
export async function backfillLinkedinDistanceDefaults(): Promise<number> {
  const defaults: Record<string, number | null> = {
    "Market scan": 25,
    Manager: 25,
    Director: 25,
    Coordinator: 25,
    Specialist: 25,
    Assistant: 25,
    Analyst: 25,
    Sales: 25,
    // Legacy contact-title profiles (pre-broad-scan)
    "HR Director": 25,
    "VP People": 25,
    "Head of Talent": null,
  };

  let updated = 0;
  for (const [name, distance] of Object.entries(defaults)) {
    const rows = await db
      .select({ id: searchProfiles.id })
      .from(searchProfiles)
      .where(and(eq(searchProfiles.name, name), isNull(searchProfiles.linkedinDistance)));

    for (const row of rows) {
      await db
        .update(searchProfiles)
        .set({ linkedinDistance: distance })
        .where(eq(searchProfiles.id, row.id));
      updated += 1;
    }
  }
  return updated;
}
