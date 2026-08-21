import { eq, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { outreachMessages, sequenceEnrollments } from "@/lib/db/schema";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { ingestInboundMessage } from "@/lib/outreach/inbound";
import { bumpProfileCounters } from "@/lib/outreach/profiles";
import { TWILIO_ERROR_OPTED_OUT } from "@/lib/outreach/sms/twilio";
import { addSuppression, isSuppressed } from "@/lib/outreach/suppression";

/**
 * Twilio callback handling, kept out of the route so it can be tested without
 * a request object. Two callback shapes arrive on the same endpoint: an inbound
 * SMS from a prospect, and a delivery-status transition on something we sent.
 *
 * Inbound goes through ingestInboundMessage — the same entry point the Mac
 * mini's chat.db reader and the IMAP poll use. A second ingest path would mean a
 * second classifier, a second rule engine and two versions of the truth.
 */

/**
 * Carrier-standard opt-out keywords. Twilio's Advanced Opt-Out already stops
 * the traffic at their edge; this list exists so OUR suppression table agrees
 * with theirs, which is what an audit actually looks at.
 */
export const SMS_OPT_OUT_KEYWORDS = [
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
] as const;

/**
 * Whole-message match only. "Can we cancel Thursday?" is a reschedule, not an
 * opt-out, and substring matching would silently suppress a live conversation.
 */
export function isOptOutMessage(body: string | null | undefined): boolean {
  const cleaned = (body ?? "")
    .replace(/[\s.!,'"]+/g, " ")
    .trim()
    .toUpperCase();
  return (SMS_OPT_OUT_KEYWORDS as readonly string[]).includes(cleaned);
}

export type TwilioInboundPayload = {
  messageSid: string;
  from: string;
  to: string | null;
  body: string;
  numMedia: number;
};

export type TwilioStatusPayload = {
  messageSid: string;
  status: string;
  errorCode: number | null;
  errorMessage: string | null;
  to: string | null;
};

export type TwilioWebhookEvent =
  | { kind: "inbound"; payload: TwilioInboundPayload }
  | { kind: "status"; payload: TwilioStatusPayload }
  | { kind: "ignored"; reason: string };

/** Delivery states that end the message's life one way or the other. */
const FAILED_STATUSES = new Set(["undelivered", "failed", "canceled", "cancelled"]);

export function parseTwilioWebhook(params: URLSearchParams): TwilioWebhookEvent {
  const messageSid = (params.get("MessageSid") ?? params.get("SmsSid") ?? "").trim();
  if (!messageSid) return { kind: "ignored", reason: "no MessageSid" };

  const status = (params.get("MessageStatus") ?? params.get("SmsStatus") ?? "")
    .trim()
    .toLowerCase();

  // Inbound messages carry SmsStatus=received; anything else is a transition on
  // a message we sent.
  if (status && status !== "received") {
    const rawCode = (params.get("ErrorCode") ?? "").trim();
    const code = rawCode ? Number(rawCode) : null;
    return {
      kind: "status",
      payload: {
        messageSid,
        status,
        errorCode: Number.isFinite(code) ? code : null,
        errorMessage: params.get("ErrorMessage")?.trim() || null,
        to: params.get("To")?.trim() || null,
      },
    };
  }

  const from = (params.get("From") ?? "").trim();
  if (!from) return { kind: "ignored", reason: "no From on inbound" };
  const numMedia = Number((params.get("NumMedia") ?? "0").trim());
  return {
    kind: "inbound",
    payload: {
      messageSid,
      from,
      to: params.get("To")?.trim() || null,
      body: params.get("Body") ?? "",
      numMedia: Number.isFinite(numMedia) ? numMedia : 0,
    },
  };
}

export type TwilioInboundOutcome = {
  handled: "inbound";
  inboundId: string | null;
  duplicate: boolean;
  matched: boolean;
  optOut: boolean;
  suppressed: boolean;
};

/** Mirror a carrier opt-out into our own suppression list. */
async function syncOptOutSuppression(options: {
  phone: string;
  contactId?: string | null;
  reason: string;
}): Promise<boolean> {
  const existing = await isSuppressed({ channel: "imessage", phone: options.phone });
  if (existing.suppressed) return false;
  const row = await addSuppression({
    phone: options.phone,
    channel: "imessage",
    reason: options.reason,
    legalBasis: "recipient opt-out keyword (TCPA)",
    contactId: options.contactId ?? null,
  });
  return Boolean(row);
}

export async function handleTwilioInbound(
  payload: TwilioInboundPayload,
  now = new Date(),
): Promise<TwilioInboundOutcome> {
  const optOut = isOptOutMessage(payload.body);
  const body =
    payload.body.trim() ||
    (payload.numMedia > 0
      ? `[${payload.numMedia} media attachment(s), no text]`
      : "[empty message]");

  const result = await ingestInboundMessage({
    channel: "imessage",
    fromAddress: payload.from,
    body,
    externalId: `twilio:${payload.messageSid}`,
    receivedAt: now,
  });

  // Runs even on a duplicate delivery: the suppression write is idempotent and
  // a missed STOP is the one failure with a regulator attached to it. The rule
  // engine also suppresses on opt_out, but only when the reply matched a live
  // enrollment — a STOP from a retired number would otherwise write nothing.
  let suppressed = false;
  if (optOut) {
    suppressed = await syncOptOutSuppression({
      phone: payload.from,
      reason: "STOP reply via SMS",
    });
  }

  return {
    handled: "inbound",
    inboundId: result.id,
    duplicate: result.duplicate,
    matched: result.matched,
    optOut,
    suppressed,
  };
}

export type TwilioStatusOutcome = {
  handled: "status";
  messageId: string | null;
  status: string;
  applied: "delivered" | "sent" | "failed" | "noop" | "unmatched";
};

export async function handleTwilioStatus(
  payload: TwilioStatusPayload,
  now = new Date(),
): Promise<TwilioStatusOutcome> {
  // The Twilio SID lands in message_id (the channel's provider message id;
  // for email that column holds the RFC 5322 Message-ID). resend_id is checked
  // too so a send path that recorded it there still reconciles.
  const [message] = await db
    .select()
    .from(outreachMessages)
    .where(
      or(
        eq(outreachMessages.messageId, payload.messageSid),
        eq(outreachMessages.resendId, payload.messageSid),
      ),
    )
    .limit(1);

  if (!message) {
    console.log(
      `[outreach] twilio status ignored (no matching message): ${payload.status} ${payload.messageSid}`,
    );
    return {
      handled: "status",
      messageId: null,
      status: payload.status,
      applied: "unmatched",
    };
  }

  const detail = [payload.errorCode ? `code ${payload.errorCode}` : null, payload.errorMessage]
    .filter(Boolean)
    .join(" — ");

  if (FAILED_STATUSES.has(payload.status)) {
    await db
      .update(outreachMessages)
      .set({
        status: "failed",
        error: `twilio ${payload.status}${detail ? `: ${detail}` : ""}`,
        updatedAt: now,
      })
      .where(eq(outreachMessages.id, message.id));
    if (message.sendingProfileId) {
      // A carrier rejection is the SMS analogue of a bounce — it must feed the
      // same health score that throttles a profile.
      await bumpProfileCounters(message.sendingProfileId, { totalBounced: 1 });
    }
    await logEnrollmentEvent({
      enrollmentId: message.enrollmentId,
      eventType: "error",
      actor: "twilio",
      payload: {
        message_id: message.id,
        channel: "imessage",
        twilio_status: payload.status,
        error_code: payload.errorCode,
        error: payload.errorMessage,
      },
    });

    if (payload.errorCode === TWILIO_ERROR_OPTED_OUT) {
      const [enrollment] = await db
        .select({
          contactId: sequenceEnrollments.contactId,
          phoneNumber: sequenceEnrollments.phoneNumber,
        })
        .from(sequenceEnrollments)
        .where(eq(sequenceEnrollments.id, message.enrollmentId))
        .limit(1);
      const phone = payload.to ?? enrollment?.phoneNumber ?? null;
      if (phone) {
        await syncOptOutSuppression({
          phone,
          contactId: enrollment?.contactId ?? null,
          reason: "Twilio 21610 — recipient previously sent STOP",
        });
      }
    }
    return {
      handled: "status",
      messageId: message.id,
      status: payload.status,
      applied: "failed",
    };
  }

  if (payload.status === "delivered") {
    await db
      .update(outreachMessages)
      .set({ status: "sent", sentAt: message.sentAt ?? now, error: null, updatedAt: now })
      .where(eq(outreachMessages.id, message.id));
    if (message.sendingProfileId) {
      await bumpProfileCounters(message.sendingProfileId, { totalDelivered: 1 });
    }
    await logEnrollmentEvent({
      enrollmentId: message.enrollmentId,
      eventType: "delivery_verified",
      actor: "twilio",
      payload: { message_id: message.id, channel: "imessage", twilio_status: payload.status },
    });
    return {
      handled: "status",
      messageId: message.id,
      status: payload.status,
      applied: "delivered",
    };
  }

  // sent/accepted mean the carrier took it. Only promote a row still waiting,
  // so a late callback can't overwrite a failure we already recorded.
  if ((payload.status === "sent" || payload.status === "accepted") && message.status === "queued") {
    await db
      .update(outreachMessages)
      .set({ status: "sent", sentAt: message.sentAt ?? now, updatedAt: now })
      .where(eq(outreachMessages.id, message.id));
    return {
      handled: "status",
      messageId: message.id,
      status: payload.status,
      applied: "sent",
    };
  }

  return {
    handled: "status",
    messageId: message.id,
    status: payload.status,
    applied: "noop",
  };
}
