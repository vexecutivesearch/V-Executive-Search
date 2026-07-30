import { db } from "@/lib/db";
import { enrollmentEvents } from "@/lib/db/schema";

/**
 * Append-only audit log — every decision the system makes is reconstructable.
 * Doubles as the compliance record (who was contacted, when, why, and what
 * stopped it). Non-negotiable for debugging; failures here must never break
 * the calling flow, so errors are logged and swallowed.
 */
export async function logEnrollmentEvent(options: {
  enrollmentId?: string | null;
  eventType: string;
  actor?: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(enrollmentEvents).values({
      enrollmentId: options.enrollmentId ?? null,
      eventType: options.eventType,
      actor: options.actor ?? "system",
      payload: options.payload ?? {},
    });
  } catch (error) {
    console.error("[outreach] enrollment event write failed", options.eventType, error);
  }
}
