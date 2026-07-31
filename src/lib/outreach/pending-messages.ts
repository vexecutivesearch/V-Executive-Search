import { and, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { outreachMessages } from "@/lib/db/schema";
import { BOOKING_CONFIRMATION_KIND } from "@/lib/outreach/booking-confirmation";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { REPLY_TEMPLATE_KINDS } from "@/lib/outreach/reply-playbook";

/**
 * Pending messages that answer a person rather than continue a sequence.
 *
 * A cancel sweep exists to stop the *remaining steps* once a conversation has
 * moved on. These kinds are not steps. Each one is a message we already owe
 * somebody who just spoke to us, sitting in the queue waiting on the Mac
 * worker's next five minute poll, and cancelling it reads to the contact as
 * being ignored on the thread they wrote to.
 */
export const CONVERSATION_MESSAGE_KINDS = [
  ...REPLY_TEMPLATE_KINDS,
  BOOKING_CONFIRMATION_KIND,
] as const;

/**
 * Which pending rows a cancel sweep is allowed to take.
 *
 * `keepAutoReplies` protects the messages above. A contact who answers by text
 * and by email seconds apart lands in the reply rules twice, and the second
 * pass used to cancel the SMS reply the first pass had just queued; the same
 * hole let a Calendly booking three minutes later cancel it instead. The
 * worker polls once every five minutes, so anything cancelled inside that
 * window is gone before it can be claimed.
 *
 * Suppression paths (opt out, complaint, wrong person, admin stop) deliberately
 * leave this off: a pending message must never survive a stop request.
 */
export function pendingStepsCancelFilter(
  enrollmentId: string,
  keepAutoReplies: boolean,
) {
  return and(
    eq(outreachMessages.enrollmentId, enrollmentId),
    inArray(outreachMessages.status, ["drafted", "queued"]),
    ...(keepAutoReplies
      ? [notInArray(outreachMessages.stepKind, [...CONVERSATION_MESSAGE_KINDS])]
      : []),
  );
}

/** Cancel the remaining sequence steps, and say how many went. */
export async function stopPendingSteps(
  enrollmentId: string,
  actor: string,
  options: { keepAutoReplies?: boolean } = {},
): Promise<number> {
  const result = await db
    .update(outreachMessages)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      pendingStepsCancelFilter(enrollmentId, Boolean(options.keepAutoReplies)),
    )
    .returning({ id: outreachMessages.id });
  if (result.length) {
    await logEnrollmentEvent({
      enrollmentId,
      eventType: "cancelled",
      actor,
      payload: {
        messages_cancelled: result.length,
        kept_auto_replies: Boolean(options.keepAutoReplies),
      },
    });
  }
  return result.length;
}
