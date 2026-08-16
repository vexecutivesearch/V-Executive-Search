import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  contacts,
  outreachMessages,
  sequenceEnrollments,
  type SequenceEnrollment,
} from "@/lib/db/schema";
import { requestImessageCheck } from "@/lib/imessage-check";
import { phoneIsTextEligible } from "@/lib/outreach/channel-plan";
import { pickPhone } from "@/lib/outreach/contact-handles";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import type { SendNodeConfig } from "@/lib/outreach/flow-types";
import { nextNodeId, triggerNode } from "@/lib/outreach/flow-types";
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

/**
 * Put a just-upgraded enrollment back on the day-0 text step it skipped.
 *
 * Resuming at the next remaining text is not an option: text_1 is the
 * introduction ("my name is Alejandro... I've just emailed you"), and text_2
 * opens with "Alejandro again". Jumping straight to text_2 greets a stranger
 * as a repeat contact.
 *
 * Only rewound when the sequence has sent nothing at all, which means we are
 * still genuinely at day 0 and text_1 goes out alongside the intro exactly as
 * designed. An enrollment whose intro already went out days ago is left alone
 * — a "just emailed you" text arriving days late is worse than none.
 *
 * `node_state.wait_until` is deliberately left untouched, so re-entering the
 * wait after the text honours the original day-2 deadline instead of
 * restarting the cadence.
 */
async function rewindToDayZeroText(
  enrollment: SequenceEnrollment,
): Promise<boolean> {
  if (!enrollment.flowVersionId || !enrollment.currentNodeId) return false;

  const [sent] = await db
    .select({ id: outreachMessages.id })
    .from(outreachMessages)
    .where(
      and(
        eq(outreachMessages.enrollmentId, enrollment.id),
        eq(outreachMessages.status, "sent"),
      ),
    )
    .limit(1);
  if (sent) return false;

  const { loadFlowGraph } = await import("@/lib/outreach/flow-engine");
  const graph = await loadFlowGraph(enrollment.flowVersionId);
  if (!graph) return false;

  const textNode = graph.nodes.find(
    (n) =>
      n.type === "send" &&
      (n.config as SendNodeConfig | undefined)?.channel === "imessage",
  );
  if (!textNode) return false;

  // Only rewind — never skip the enrollment forward past a step it has not
  // reached (jumping over an unsent intro would drop the email entirely).
  const order = new Map<string, number>();
  let cursor: string | null = triggerNode(graph)?.id ?? null;
  for (let i = 0; cursor && !order.has(cursor); i += 1) {
    order.set(cursor, i);
    cursor = nextNodeId(graph, cursor);
  }
  const here = order.get(enrollment.currentNodeId);
  const target = order.get(textNode.id);
  if (here === undefined || target === undefined || here <= target) return false;

  await db
    .update(sequenceEnrollments)
    .set({
      currentNodeId: textNode.id,
      nextStepAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(sequenceEnrollments.id, enrollment.id));
  return true;
}

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
  /** Upgraded and put back on the day-0 text they had skipped. */
  dayZeroTextRestored: number;
  /** Upgraded too late to restore text_1 — the intro had already gone out. */
  dayZeroTextMissed: number;
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
    dayZeroTextRestored: 0,
    dayZeroTextMissed: 0,
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

    const restored = await rewindToDayZeroText(enrollment);
    if (restored) summary.dayZeroTextRestored += 1;
    else summary.dayZeroTextMissed += 1;

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
        day_zero_text_restored: restored,
        detail: restored
          ? "phone found before the intro went out — rewound to the day-0 text so it leads the text sequence"
          : "phone found after the intro had sent — text_1 would be stale, so the sequence resumes at its next text step",
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
          "sequence upgraded to email + SMS. " +
          (restored
            ? "Nothing had sent yet, so the intro text was restored and leads the text sequence."
            : "The intro email had already gone out, so the sequence resumes at its next text step.") +
          " Already-sent emails are unaffected.",
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
