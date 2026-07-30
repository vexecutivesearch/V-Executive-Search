import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { callListEntries, companyActivities } from "@/lib/db/schema";

/**
 * Keep the Call List in sync with the Outreach Sequencer: every automated
 * touch writes a timestamped line into call_list_entries.notes (visible on
 * the Call List row) and a companyActivities row (company dossier / history).
 */

function stampLine(line: string): string {
  const ts = new Date().toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `[${ts}] ${line.trim()}`;
}

export async function recordCallListOutreachEvent(options: {
  companyId: string;
  contactId?: string | null;
  /** Short human line, e.g. "Outreach intro email sent: Support for…" */
  summary: string;
  /** companyActivities type */
  activityType?: "email" | "note" | "call";
  /** Bump attempts + lastContactAt (real outbound touches). */
  bumpAttempt?: boolean;
}): Promise<void> {
  const line = stampLine(options.summary);
  try {
    const [entry] = await db
      .select()
      .from(callListEntries)
      .where(eq(callListEntries.companyId, options.companyId))
      .limit(1);
    if (entry) {
      const prev = entry.notes?.trim() ? `${entry.notes.trim()}\n` : "";
      await db
        .update(callListEntries)
        .set({
          notes: `${prev}${line}`,
          attempts: options.bumpAttempt ? entry.attempts + 1 : entry.attempts,
          lastContactAt: options.bumpAttempt ? new Date() : entry.lastContactAt,
          updatedAt: new Date(),
        })
        .where(eq(callListEntries.id, entry.id));
    }
  } catch (error) {
    console.error("[outreach] call-list note append failed", error);
  }

  try {
    await db.insert(companyActivities).values({
      companyId: options.companyId,
      contactId: options.contactId ?? null,
      type: options.activityType ?? "note",
      summary: options.summary,
      source: "outreach",
    });
  } catch (error) {
    console.error("[outreach] company activity insert failed", error);
  }
}
