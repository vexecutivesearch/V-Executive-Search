import { db } from "@/lib/db";
import { outreachSettings, type OutreachSettings } from "@/lib/db/schema";

/**
 * Global outreach safety overrides — kill switch, dry-run, approval gate,
 * daily caps. These sit ABOVE sequences/flows and are never expressed inside
 * them. Ships disabled + dry-run + approval-required: nothing sends until
 * the admin flips the switches deliberately.
 */
export async function getOrCreateOutreachSettings(): Promise<OutreachSettings> {
  const [existing] = await db.select().from(outreachSettings).limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(outreachSettings)
    .values({})
    .returning();
  return created;
}
