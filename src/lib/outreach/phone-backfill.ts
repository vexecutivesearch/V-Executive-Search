import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  contacts,
  sequenceEnrollments,
  type SequenceEnrollment,
} from "@/lib/db/schema";
import { requestImessageCheck } from "@/lib/imessage-check";
import { phoneIsTextEligible } from "@/lib/outreach/channel-plan";
import { pickPhone } from "@/lib/outreach/contact-handles";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { isSuppressed } from "@/lib/outreach/suppression";

/**
 * Attach newly-enriched phone numbers to live email-only enrollments.
 *
 * A channel plan is decided once, at enroll time, so an enrollment created
 * before its contact had a phone stays email-only forever — the text steps
 * were never drafted and the flow skips every text node because
 * `enrollment.phone_number` is null.
 *
 * Re-enrolling is the wrong repair: enrollContact refuses a contact that has
 * enrolled before, refuses a company already moved past "new", and would
 * re-draft and re-send the intro email to someone who already received it.
 *
 * Attaching the number in place is enough. The default flow walks through
 * every text node regardless of plan, and handleSendNode drafts a step at
 * node entry when no message row exists — so the remaining text steps start
 * working on their existing schedule, and sent emails are left untouched.
 * Text steps the flow has already walked past are intentionally not revived;
 * a day-0 text should not go out on day six.
 */

/** Enrollments still walking the graph — completed/stopped can't benefit. */
export const LIVE_ENROLLMENT_STATUSES = [
  "active",
  "paused",
  "waiting_on_reply",
  "waiting_on_manual",
] as const;

const LIVE_STATUSES = LIVE_ENROLLMENT_STATUSES;

export type PhoneBackfillSummary = {
  scanned: number;
  attached: number;
  skippedNoPhone: number;
  skippedSuppressed: number;
  skippedNotTextable: number;
  /** Upgraded but still missing a capability answer — a check was requested. */
  pendingCapabilityCheck: number;
};

export async function backfillEnrollmentPhones(options?: {
  limit?: number;
  actor?: string;
}): Promise<PhoneBackfillSummary> {
  const limit = options?.limit ?? 200;
  const actor = options?.actor ?? "system:phone_backfill";
  const summary: PhoneBackfillSummary = {
    scanned: 0,
    attached: 0,
    skippedNoPhone: 0,
    skippedSuppressed: 0,
    skippedNotTextable: 0,
    pendingCapabilityCheck: 0,
  };

  const rows = await db
    .select({ enrollment: sequenceEnrollments, contact: contacts })
    .from(sequenceEnrollments)
    .innerJoin(contacts, eq(contacts.id, sequenceEnrollments.contactId))
    .where(
      and(
        isNull(sequenceEnrollments.phoneNumber),
        inArray(sequenceEnrollments.status, [...LIVE_STATUSES]),
      ),
    )
    .limit(limit);

  let capabilityCheckRequested = false;

  for (const { enrollment, contact } of rows) {
    summary.scanned += 1;

    const phone = pickPhone(contact);
    if (!phone) {
      summary.skippedNoPhone += 1;
      continue;
    }

    // An unchecked contact waits for the Mac worker rather than being
    // assumed textable — nudge the check and pick it up on a later pass.
    if (contact.imessageCapable === null) {
      summary.pendingCapabilityCheck += 1;
      if (!capabilityCheckRequested) {
        capabilityCheckRequested = true;
        try {
          await requestImessageCheck();
        } catch (error) {
          console.error("[outreach] imessage check request failed", error);
        }
      }
      continue;
    }

    const suppression = await isSuppressed({ channel: "imessage", phone });

    // Same gate enrollment uses, so a backfilled enrollment is never in a
    // state a fresh enrollment could not have reached.
    if (
      !phoneIsTextEligible({
        hasPhone: true,
        imessageCapable: contact.imessageCapable,
        phoneSuppressed: suppression.suppressed,
      })
    ) {
      if (suppression.suppressed) summary.skippedSuppressed += 1;
      else summary.skippedNotTextable += 1;
      continue;
    }

    await db
      .update(sequenceEnrollments)
      .set({ phoneNumber: phone, updatedAt: new Date() })
      .where(
        and(
          eq(sequenceEnrollments.id, enrollment.id),
          // Only claim it if it is still unset — a concurrent dispatch pass
          // must not double-attach or clobber a number set in between.
          isNull(sequenceEnrollments.phoneNumber),
        ),
      );

    summary.attached += 1;
    await logEnrollmentEvent({
      enrollmentId: enrollment.id,
      eventType: "channel_upgraded",
      actor,
      payload: {
        contact_id: contact.id,
        company_id: enrollment.companyId,
        from_plan: "email_only",
        to_plan: "email_and_text",
        phone,
        detail:
          "phone found after enrollment — remaining text steps will draft at node entry",
      },
    });

    try {
      const { recordCallListOutreachEvent } = await import(
        "@/lib/outreach/call-list-sync"
      );
      await recordCallListOutreachEvent({
        companyId: enrollment.companyId,
        contactId: contact.id,
        bumpAttempt: false,
        summary:
          `Phone found for ${contact.name} after enrollment (${phone}) — ` +
          "sequence upgraded to email + SMS. Remaining text steps send on " +
          "their existing schedule; already-sent emails are unaffected.",
      });
    } catch (error) {
      console.error("[outreach] backfill call-list note failed", error);
    }
  }

  return summary;
}

/** Whether this enrollment would gain text steps from a backfill pass. */
export function enrollmentCanUpgrade(
  enrollment: Pick<SequenceEnrollment, "phoneNumber" | "status">,
  contact: {
    personalPhone?: string | null;
    phone?: string | null;
    imessageCapable?: boolean | null;
  },
): boolean {
  if (enrollment.phoneNumber) return false;
  if (!(LIVE_STATUSES as readonly string[]).includes(enrollment.status)) {
    return false;
  }
  return phoneIsTextEligible({
    hasPhone: Boolean(pickPhone(contact)),
    imessageCapable: contact.imessageCapable ?? null,
    // Suppression is checked against the live table in the backfill itself.
    phoneSuppressed: false,
  });
}
