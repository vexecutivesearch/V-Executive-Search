import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  inboundMessages,
  outreachMessages,
  type SequenceEnrollment,
} from "@/lib/db/schema";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { workerCanClaim } from "@/lib/outreach/imessage-queue";
import { sanitizeOutreachBody } from "@/lib/outreach/sanitizer";
import { getOrCreateOutreachSettings } from "@/lib/outreach/settings";

/**
 * "Your meeting is booked" text for conversations that live on SMS.
 *
 * Calendly emails its own confirmation to whoever booked, so an email thread
 * is already covered. A thread carried over text is not: it simply goes quiet
 * after the booking, which reads as nobody being home.
 */

export const BOOKING_CONFIRMATION_KIND = "booking_confirmation" as const;

/** Statuses that mean a confirmation already exists for this conversation. */
const LIVE_CONFIRMATION_STATUSES = ["drafted", "queued", "sent"] as const;

export type ConversationChannel = "imessage" | "email" | null;

/**
 * Which channel this conversation actually runs on, judged from the replies
 * we hold rather than from which channel we happened to send on.
 *
 * Mixed threads resolve to SMS: any inbound text at all makes this an SMS
 * conversation. Tonight's v8 contact answered by text and by email seven
 * seconds apart, and the two directions are not symmetric. Emailing someone
 * twice costs nothing because Calendly is emailing them anyway, whereas
 * staying silent on the thread where they actually texted us is the exact
 * gap this closes. Silence is the expensive mistake, so SMS wins the tie.
 */
export async function conversationChannel(
  enrollmentId: string,
): Promise<ConversationChannel> {
  const replies = await db
    .select({ channel: inboundMessages.channel })
    .from(inboundMessages)
    .where(eq(inboundMessages.enrollmentId, enrollmentId))
    .orderBy(desc(inboundMessages.receivedAt));

  if (!replies.length) return null;
  if (replies.some((r) => r.channel === "imessage")) return "imessage";
  return "email";
}

/** US zone label without a dash, e.g. "ET". Empty when it cannot be clean. */
function zoneLabel(timeZone: string, at: Date): string {
  const short =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  const us = short.match(/^([ECMP])[SD]T$/);
  if (us) return `${us[1]}T`;
  // Anything like "GMT+5" or "GMT-5" would smuggle a dash past the sanitizer.
  return /^[A-Z]{2,5}$/.test(short) ? short : "";
}

/** "Monday Aug 3 at 9 AM ET" — no dashes, the sanitizer rejects them. */
export function formatBookingWhen(
  start: Date,
  timeZone = "America/New_York",
): string {
  const weekday = start.toLocaleDateString("en-US", {
    timeZone,
    weekday: "long",
  });
  const month = start.toLocaleDateString("en-US", { timeZone, month: "short" });
  const day = start.toLocaleDateString("en-US", { timeZone, day: "numeric" });
  const clock = start
    .toLocaleTimeString("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    // On the hour reads better as "9 AM" than "9:00 AM".
    .replace(/:00(?=\s)/, "");
  const zone = zoneLabel(timeZone, start);
  return `${weekday} ${month} ${day} at ${clock}${zone ? ` ${zone}` : ""}`;
}

/** The confirmation copy. Single source of truth, also seeded as the exemplar. */
export function bookingConfirmationText(when: string | null): string {
  return when
    ? `Great, your meeting is booked for ${when}. Looking forward to speaking.`
    : "Great, your meeting is booked. Looking forward to speaking.";
}

export type BookingConfirmationResult = {
  queued: boolean;
  /** Why nothing was queued. Null when a confirmation is on its way. */
  reason: string | null;
  body: string | null;
};

function skip(reason: string): BookingConfirmationResult {
  return { queued: false, reason, body: null };
}

/**
 * Queue one confirmation text for a booking, or explain why not.
 *
 * Exactly one confirmation per enrollment, ever. That covers duplicate
 * Calendly notifications for the same event (the IMAP poll and the webhook can
 * both deliver it) and reschedules alike: someone who moves their call has
 * already had the "we are here" reassurance this text exists to give.
 */
export async function queueBookingConfirmationText(options: {
  enrollment: SequenceEnrollment;
  startTime: Date | null;
  actor: string;
  /** Calendly event/invitee URI, recorded for traceability. */
  bookingKey?: string | null;
}): Promise<BookingConfirmationResult> {
  const { enrollment } = options;

  const settings = await getOrCreateOutreachSettings();
  if (!settings.textEnabled) {
    return skip("the text channel is switched off in Admin, Safety switches");
  }

  if (!enrollment.phoneNumber) {
    return skip("enrollment has no phone number");
  }

  const channel = await conversationChannel(enrollment.id);
  if (channel !== "imessage") {
    return skip(
      channel === "email"
        ? "conversation is over email, Calendly sends its own confirmation"
        : "no inbound replies, so there is no SMS conversation to confirm on",
    );
  }

  const [existing] = await db
    .select({
      id: outreachMessages.id,
      status: outreachMessages.status,
    })
    .from(outreachMessages)
    .where(
      and(
        eq(outreachMessages.enrollmentId, enrollment.id),
        eq(outreachMessages.stepKind, BOOKING_CONFIRMATION_KIND),
        inArray(outreachMessages.status, [...LIVE_CONFIRMATION_STATUSES]),
      ),
    )
    .limit(1);
  if (existing) {
    return skip(`a booking confirmation is already ${existing.status}`);
  }

  const when = options.startTime
    ? formatBookingWhen(options.startTime, enrollment.timezone)
    : null;
  const body = bookingConfirmationText(when);

  const check = sanitizeOutreachBody(body, { channel: "imessage" });
  if (!check.ok) {
    const reason = `confirmation text failed the sanitizer: ${check.violations.join("; ")}`;
    console.error(`[outreach] ${reason}`);
    await logEnrollmentEvent({
      enrollmentId: enrollment.id,
      eventType: "error",
      actor: options.actor,
      payload: {
        booking_confirmation: true,
        failed: true,
        reason,
        manual_note:
          "no booking confirmation text went out, confirm with the contact by hand",
      },
    });
    return { queued: false, reason, body: null };
  }

  if (!workerCanClaim(enrollment.status)) {
    const reason = `enrollment status ${enrollment.status} is never claimed by the Mac worker`;
    console.error(`[outreach] booking confirmation not queued: ${reason}`);
    await logEnrollmentEvent({
      enrollmentId: enrollment.id,
      eventType: "error",
      actor: options.actor,
      payload: {
        booking_confirmation: true,
        failed: true,
        reason,
        manual_note:
          "no booking confirmation text went out, confirm with the contact by hand",
      },
    });
    return { queued: false, reason, body: null };
  }

  const [queued] = await db
    .insert(outreachMessages)
    .values({
      enrollmentId: enrollment.id,
      stepKind: BOOKING_CONFIRMATION_KIND,
      channel: "imessage",
      status: "queued",
      body: check.cleaned,
      approvedAt: new Date(),
      scheduledFor: new Date(Date.now() - 1_000),
    })
    .returning({ id: outreachMessages.id });

  await logEnrollmentEvent({
    enrollmentId: enrollment.id,
    eventType: "rule_action",
    actor: options.actor,
    payload: {
      booking_confirmation: true,
      channel: "imessage",
      queued_message_id: queued?.id ?? null,
      meeting_at: options.startTime?.toISOString() ?? null,
      booking_key: options.bookingKey ?? null,
    },
  });

  return { queued: true, reason: null, body: check.cleaned };
}

/**
 * Drop a confirmation the worker has not sent yet. A booking cancelled inside
 * the worker's five minute poll window must not still text "your meeting is
 * booked" minutes later.
 */
export async function cancelPendingBookingConfirmation(
  enrollmentId: string,
  actor: string,
): Promise<number> {
  const cancelled = await db
    .update(outreachMessages)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(outreachMessages.enrollmentId, enrollmentId),
        eq(outreachMessages.stepKind, BOOKING_CONFIRMATION_KIND),
        inArray(outreachMessages.status, ["drafted", "queued"]),
      ),
    )
    .returning({ id: outreachMessages.id });

  if (cancelled.length) {
    await logEnrollmentEvent({
      enrollmentId,
      eventType: "cancelled",
      actor,
      payload: {
        booking_confirmation: true,
        messages_cancelled: cancelled.length,
        reason: "booking cancelled before the confirmation text went out",
      },
    });
  }
  return cancelled.length;
}
