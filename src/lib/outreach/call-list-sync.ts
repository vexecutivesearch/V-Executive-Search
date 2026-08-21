import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  callListEntries,
  companyActivities,
  type CallStatus,
} from "@/lib/db/schema";
import { canAutoAdvanceStatus, TERMINAL_STATUSES } from "@/lib/call-status";
import { ensureNotesNewestFirst } from "@/lib/outreach/call-list-notes";

/**
 * Keep the Call List in sync with the Outreach Sequencer: every automated
 * touch writes a timestamped line into call_list_entries.notes (visible on
 * the Call List row), updates call_status when appropriate, and a
 * companyActivities row (company dossier / history).
 *
 * Automated lines are prepended so newest notes appear at the top.
 */

function stampLine(line: string): string {
  // Vercel and the worker both run TZ=UTC; stamp Eastern so the times on a row
  // read the same as the business day they happened in.
  const ts = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
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
  activityType?: "email" | "note" | "call" | "meeting";
  /** Bump attempts + lastContactAt (real outbound touches). */
  bumpAttempt?: boolean;
  /**
   * Advance Call List workflow status. Skipped when the row is already in a
   * terminal status (won / not interested / DNC / bad contact), and — unless
   * allowRegression is set — when it would move the row BACKWARD in the
   * funnel (a courtesy reply must not demote a booked call).
   */
  callStatus?: CallStatus;
  /**
   * Permit a backward move. Only for events that genuinely undo progress,
   * e.g. a Calendly cancellation reverting Call Booked.
   */
  allowRegression?: boolean;
}): Promise<void> {
  const line = stampLine(options.summary);
  try {
    const [entry] = await db
      .select()
      .from(callListEntries)
      .where(eq(callListEntries.companyId, options.companyId))
      .limit(1);
    if (entry) {
      const prev = ensureNotesNewestFirst(entry.notes).trim();
      const nextNotes = prev ? `${line}\n${prev}` : line;
      const terminal = TERMINAL_STATUSES.has(entry.callStatus);
      const advance =
        options.callStatus &&
        !terminal &&
        (options.allowRegression ||
          canAutoAdvanceStatus(entry.callStatus, options.callStatus));
      const nextStatus = advance ? options.callStatus! : entry.callStatus;
      const statusChanged = nextStatus !== entry.callStatus;
      const [row] = await db
        .update(callListEntries)
        .set({
          notes: nextNotes,
          attempts: options.bumpAttempt ? entry.attempts + 1 : entry.attempts,
          lastContactAt: options.bumpAttempt ? new Date() : entry.lastContactAt,
          callStatus: nextStatus,
          callStatusUpdatedAt: statusChanged
            ? new Date()
            : entry.callStatusUpdatedAt,
          updatedAt: new Date(),
        })
        .where(eq(callListEntries.id, entry.id))
        .returning();
      updated = row ?? null;
    }
  } catch (error) {
    console.error("[outreach] call-list note prepend failed", error);
  }

  try {
    await db.insert(companyActivities).values({
      companyId: options.companyId,
      contactId: options.contactId ?? null,
      type: options.activityType ?? "note",
      summary: options.summary,
      source: options.source ?? "outreach",
    });
  } catch (error) {
    console.error("[outreach] company activity insert failed", error);
  }

  return updated;
}

/**
 * Map inbound outreach intents onto Call List workflow statuses.
 *
 * A positive reply is interest, not a booking: `meeting_scheduled` ("Call
 * Booked") is reserved for applyCalendlyBooking, which fires only on a real
 * Calendly invitee.created event.
 */
export function callStatusForReplyIntent(intent: string): CallStatus | undefined {
  switch (intent) {
    case "positive":
    case "positive_link_request":
      return "replied_interested";
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
