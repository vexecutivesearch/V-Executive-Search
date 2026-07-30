import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  callListEntries,
  companyActivities,
  type CallStatus,
} from "@/lib/db/schema";
import { TERMINAL_STATUSES } from "@/lib/call-status";

/**
 * Keep the Call List in sync with the Outreach Sequencer: every automated
 * touch writes a timestamped line into call_list_entries.notes (visible on
 * the Call List row), updates call_status when appropriate, and a
 * companyActivities row (company dossier / history).
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
  /**
   * Advance Call List workflow status. Skipped when the row is already in a
   * terminal status (won / not interested / DNC / bad contact).
   */
  callStatus?: CallStatus;
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
      const terminal = TERMINAL_STATUSES.has(entry.callStatus);
      const nextStatus =
        options.callStatus && !terminal ? options.callStatus : entry.callStatus;
      const statusChanged = nextStatus !== entry.callStatus;
      await db
        .update(callListEntries)
        .set({
          notes: `${prev}${line}`,
          attempts: options.bumpAttempt ? entry.attempts + 1 : entry.attempts,
          lastContactAt: options.bumpAttempt ? new Date() : entry.lastContactAt,
          callStatus: nextStatus,
          callStatusUpdatedAt: statusChanged
            ? new Date()
            : entry.callStatusUpdatedAt,
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

/** Map inbound outreach intents onto Call List workflow statuses. */
export function callStatusForReplyIntent(intent: string): CallStatus | undefined {
  switch (intent) {
    case "positive":
    case "positive_link_request":
      return "meeting_scheduled";
    case "info_request":
    case "courtesy":
      return "spoke_follow_up";
    case "negative":
      return "not_interested";
    case "opt_out":
    case "complaint":
    case "data_deletion":
      return "do_not_contact";
    case "wrong_person":
      return "bad_contact";
    default:
      return undefined;
  }
}
