import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import {
  callListEntries,
  companies,
  contacts,
  outreachMessages,
  sequenceEnrollments,
  type Contact,
  type SequenceEnrollment,
} from "@/lib/db/schema";
import { TERMINAL_STATUSES } from "@/lib/call-status";
import { recordCallListOutreachEvent } from "@/lib/outreach/call-list-sync";
import { cancelSiblingEnrollments } from "@/lib/outreach/enroll";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { normalizeEmail, normalizePhone } from "@/lib/outreach/suppression";

/** Calendly webhook event names we act on. */
export type CalendlyWebhookEvent =
  | "invitee.created"
  | "invitee.canceled"
  | string;

export type ParsedCalendlyBooking = {
  event: CalendlyWebhookEvent;
  email: string | null;
  name: string | null;
  phone: string | null;
  timezone: string | null;
  startTime: Date | null;
  endTime: Date | null;
  scheduledEventUri: string | null;
  inviteeUri: string | null;
  cancelUrl: string | null;
  rawPayload: Record<string, unknown>;
};

export type ApplyCalendlyBookingResult = {
  ok: boolean;
  matched: boolean;
  companyId?: string;
  contactId?: string | null;
  enrollmentId?: string | null;
  action?: string;
  reason?: string;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function parseIsoDate(value: unknown): Date | null {
  const raw = asString(value);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Pull phone from Calendly text_reminder_number or custom questions. */
function extractPhone(payload: UnknownRecord): string | null {
  const direct =
    asString(payload.text_reminder_number) ??
    asString(payload.phone_number) ??
    asString(payload.phone);
  if (direct) return normalizePhone(direct);

  const questions = payload.questions_and_answers;
  if (Array.isArray(questions)) {
    for (const q of questions) {
      const row = asRecord(q);
      if (!row) continue;
      const question = (asString(row.question) ?? "").toLowerCase();
      const answer = asString(row.answer);
      if (!answer) continue;
      if (
        question.includes("phone") ||
        question.includes("mobile") ||
        question.includes("cell")
      ) {
        const normalized = normalizePhone(answer);
        if (normalized) return normalized;
      }
    }
  }
  return null;
}

/**
 * Normalize Calendly invitee.created / invitee.canceled payloads.
 * Handles nested `scheduled_event` objects and URI-only scheduled_event strings.
 */
export function parseCalendlyWebhookBody(
  body: unknown,
): ParsedCalendlyBooking | null {
  const root = asRecord(body);
  if (!root) return null;

  const event = asString(root.event) ?? asString(root.event_type) ?? "";
  const payload =
    asRecord(root.payload) ??
    asRecord(root.invitee) ??
    root;

  const email = normalizeEmail(
    asString(payload.email) ?? asString(payload.invitee_email),
  );
  const name =
    asString(payload.name) ??
    asString(payload.invitee_name) ??
    null;
  const timezone =
    asString(payload.timezone) ??
    asString(payload.invitee_timezone) ??
    null;
  const inviteeUri = asString(payload.uri);
  const cancelUrl = asString(payload.cancel_url);

  let startTime: Date | null = null;
  let endTime: Date | null = null;
  let scheduledEventUri: string | null = null;

  const scheduled = payload.scheduled_event;
  if (typeof scheduled === "string") {
    scheduledEventUri = asString(scheduled);
  } else {
    const scheduledObj = asRecord(scheduled);
    if (scheduledObj) {
      scheduledEventUri = asString(scheduledObj.uri);
      startTime = parseIsoDate(scheduledObj.start_time);
      endTime = parseIsoDate(scheduledObj.end_time);
    }
  }

  // Older / flattened shapes
  if (!startTime) {
    startTime =
      parseIsoDate(payload.start_time) ??
      parseIsoDate(payload.event_start_time);
  }
  if (!endTime) {
    endTime =
      parseIsoDate(payload.end_time) ?? parseIsoDate(payload.event_end_time);
  }

  if (!event && !email && !startTime) return null;

  return {
    event,
    email,
    name,
    phone: extractPhone(payload),
    timezone,
    startTime,
    endTime,
    scheduledEventUri,
    inviteeUri,
    cancelUrl,
    rawPayload: payload,
  };
}

/** Format a booking window in Eastern for Call List notes. */
export function formatCallBookedNote(
  start: Date | null,
  end: Date | null,
): string {
  if (!start) return "Call Booked (time TBD)";

  const tz = "America/New_York";
  const weekday = start.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" });
  const month = start.toLocaleDateString("en-US", { timeZone: tz, month: "short" });
  const day = start.toLocaleDateString("en-US", { timeZone: tz, day: "numeric" });
  const year = start.toLocaleDateString("en-US", { timeZone: tz, year: "numeric" });
  const datePart = `${weekday} ${month} ${day}, ${year}`;

  const startTime = start.toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  if (!end) return `Call Booked: ${datePart} ${startTime} ET`;

  const endTime = end.toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  // "9:00 AM–9:30 AM" → drop duplicate AM/PM on start when same meridiem
  const startMeridiem = startTime.slice(-2);
  const endMeridiem = endTime.slice(-2);
  const startClock =
    startMeridiem === endMeridiem
      ? startTime.replace(/\s?(AM|PM)$/i, "")
      : startTime;

  return `Call Booked: ${datePart} ${startClock}–${endTime} ET`;
}

/**
 * Verify Calendly-Webhook-Signature (Stripe-style t=,v1= HMAC-SHA256 of
 * `${timestamp}.${rawBody}`).
 */
export function verifyCalendlySignature(options: {
  rawBody: string;
  signatureHeader: string | null;
  signingKey: string;
  /** Reject stamps older than this many seconds (default 5 min). */
  maxAgeSec?: number;
}): boolean {
  const header = options.signatureHeader?.trim();
  if (!header) return false;

  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const [k, ...rest] = p.trim().split("=");
      return [k, rest.join("=")];
    }),
  );
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return false;
  const maxAge = options.maxAgeSec ?? 300;
  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (ageSec > maxAge) return false;

  const expected = createHmac("sha256", options.signingKey)
    .update(`${timestamp}.${options.rawBody}`, "utf8")
    .digest("hex");

  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(v1, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Fetch start/end when the webhook only includes a scheduled_event URI. */
export async function fetchScheduledEventTimes(
  uri: string,
  apiToken: string,
): Promise<{ startTime: Date | null; endTime: Date | null }> {
  try {
    const res = await fetch(uri, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      console.error(
        "[calendly] scheduled_event fetch failed",
        res.status,
        uri,
      );
      return { startTime: null, endTime: null };
    }
    const json = (await res.json()) as UnknownRecord;
    const resource = asRecord(json.resource) ?? json;
    return {
      startTime: parseIsoDate(resource.start_time),
      endTime: parseIsoDate(resource.end_time),
    };
  } catch (error) {
    console.error("[calendly] scheduled_event fetch error", error);
    return { startTime: null, endTime: null };
  }
}

function contactEmailMatches(contact: Contact, email: string): boolean {
  const candidates = [
    contact.email,
    contact.workEmail,
    contact.personalEmail,
    ...(contact.personalEmails ?? []),
  ];
  return candidates.some((c) => normalizeEmail(c) === email);
}

function contactPhoneMatches(contact: Contact, phone: string): boolean {
  const candidates = [
    contact.phone,
    contact.personalPhone,
    contact.companyPhone,
    ...(contact.phones ?? []).map((p) => p.number),
  ];
  return candidates.some((c) => normalizePhone(c) === phone);
}

export async function matchContactForCalendlyBooking(options: {
  email: string | null;
  phone: string | null;
}): Promise<{
  contact: Contact | null;
  enrollment: SequenceEnrollment | null;
}> {
  const email = options.email;
  const phone = options.phone;

  // Prefer enrollment address match (most recent active-ish first).
  if (email) {
    const enrollments = await db
      .select()
      .from(sequenceEnrollments)
      .where(sql`lower(${sequenceEnrollments.emailAddress}) = ${email}`)
      .orderBy(desc(sequenceEnrollments.enrolledAt))
      .limit(10);
    if (enrollments[0]) {
      const [contact] = await db
        .select()
        .from(contacts)
        .where(eq(contacts.id, enrollments[0].contactId))
        .limit(1);
      return { contact: contact ?? null, enrollment: enrollments[0] };
    }
  }

  if (phone) {
    const enrollments = await db
      .select()
      .from(sequenceEnrollments)
      .where(isNotNull(sequenceEnrollments.phoneNumber))
      .orderBy(desc(sequenceEnrollments.enrolledAt))
      .limit(100);
    const match = enrollments.find(
      (e) => normalizePhone(e.phoneNumber) === phone,
    );
    if (match) {
      const [contact] = await db
        .select()
        .from(contacts)
        .where(eq(contacts.id, match.contactId))
        .limit(1);
      return { contact: contact ?? null, enrollment: match };
    }
  }

  // Fall back to contacts table by email / phone.
  if (email) {
    const rows = await db
      .select()
      .from(contacts)
      .where(
        or(
          sql`lower(${contacts.email}) = ${email}`,
          sql`lower(${contacts.workEmail}) = ${email}`,
          sql`lower(${contacts.personalEmail}) = ${email}`,
        ),
      )
      .limit(20);
    let contact = rows.find((c) => contactEmailMatches(c, email)) ?? null;
    if (!contact) {
      // personalEmails is jsonb — small recent scan for extras.
      const recent = await db
        .select()
        .from(contacts)
        .orderBy(desc(contacts.createdAt))
        .limit(200);
      contact = recent.find((c) => contactEmailMatches(c, email)) ?? null;
    }
    if (contact) {
      const enrollment = await latestEnrollmentForContact(contact.id);
      return { contact, enrollment };
    }
  }

  if (phone) {
    const recent = await db
      .select()
      .from(contacts)
      .orderBy(desc(contacts.createdAt))
      .limit(300);
    const contact =
      recent.find((c) => contactPhoneMatches(c, phone)) ?? null;
    if (contact) {
      const enrollment = await latestEnrollmentForContact(contact.id);
      return { contact, enrollment };
    }
  }

  return { contact: null, enrollment: null };
}

async function latestEnrollmentForContact(
  contactId: string,
): Promise<SequenceEnrollment | null> {
  const [enrollment] = await db
    .select()
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.contactId, contactId))
    .orderBy(desc(sequenceEnrollments.enrolledAt))
    .limit(1);
  return enrollment ?? null;
}

async function cancelPendingMessages(enrollmentId: string): Promise<void> {
  await db
    .update(outreachMessages)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(outreachMessages.enrollmentId, enrollmentId),
        inArray(outreachMessages.status, ["drafted", "queued"]),
      ),
    );
}

/**
 * Apply invitee.created / invitee.canceled to Call List + company + enrollment.
 */
export async function applyCalendlyBooking(
  booking: ParsedCalendlyBooking,
): Promise<ApplyCalendlyBookingResult> {
  const { contact, enrollment } = await matchContactForCalendlyBooking({
    email: booking.email,
    phone: booking.phone,
  });

  if (!contact) {
    return {
      ok: true,
      matched: false,
      reason: "no matching contact",
    };
  }

  const companyId = contact.companyId;
  const isCreated =
    booking.event === "invitee.created" ||
    booking.event.endsWith(".created");
  const isCanceled =
    booking.event === "invitee.canceled" ||
    booking.event === "invitee.cancelled" ||
    booking.event.endsWith(".canceled") ||
    booking.event.endsWith(".cancelled");

  const note = isCanceled
    ? `Call canceled${booking.startTime ? `: ${formatCallBookedNote(booking.startTime, booking.endTime).replace(/^Call Booked:\s*/, "")}` : ""}`.trim()
    : formatCallBookedNote(booking.startTime, booking.endTime);

  if (isCreated) {
    await recordCallListOutreachEvent({
      companyId,
      contactId: contact.id,
      summary: note,
      activityType: "meeting",
      callStatus: "meeting_scheduled",
    });

    // Company → meeting track (skip if already client).
    const [company] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    if (company && company.status !== "client" && company.status !== "skipped") {
      await db
        .update(companies)
        .set({ status: "meeting", updatedAt: new Date() })
        .where(eq(companies.id, companyId));
    }

    if (enrollment) {
      await cancelPendingMessages(enrollment.id);
      const liveStatuses = [
        "active",
        "paused",
        "waiting_on_reply",
        "waiting_on_manual",
      ] as const;
      if (
        liveStatuses.includes(
          enrollment.status as (typeof liveStatuses)[number],
        ) ||
        enrollment.status === "replied_positive"
      ) {
        await db
          .update(sequenceEnrollments)
          .set({
            status: "replied_positive",
            stopReason: "calendly invitee.created",
            stoppedBy: "calendly_webhook",
            nextStepAt: null,
            updatedAt: new Date(),
          })
          .where(eq(sequenceEnrollments.id, enrollment.id));
      }
      await cancelSiblingEnrollments(
        companyId,
        enrollment.id,
        "sibling booked Calendly — one conversation per company",
      );
      await logEnrollmentEvent({
        enrollmentId: enrollment.id,
        eventType: "calendly_booking",
        actor: "calendly_webhook",
        payload: {
          action: "created",
          email: booking.email,
          start_time: booking.startTime?.toISOString() ?? null,
          end_time: booking.endTime?.toISOString() ?? null,
          note,
          invitee_uri: booking.inviteeUri,
        },
      });
    }

    return {
      ok: true,
      matched: true,
      companyId,
      contactId: contact.id,
      enrollmentId: enrollment?.id ?? null,
      action: "created",
    };
  }

  if (isCanceled) {
    // Append cancel note; only revert meeting_scheduled → spoke_follow_up.
    const [entry] = await db
      .select()
      .from(callListEntries)
      .where(eq(callListEntries.companyId, companyId))
      .limit(1);

    let nextStatus: "spoke_follow_up" | undefined;
    if (
      entry &&
      entry.callStatus === "meeting_scheduled" &&
      !TERMINAL_STATUSES.has(entry.callStatus)
    ) {
      nextStatus = "spoke_follow_up";
    }

    await recordCallListOutreachEvent({
      companyId,
      contactId: contact.id,
      summary: note,
      activityType: "note",
      callStatus: nextStatus,
    });

    if (enrollment) {
      await logEnrollmentEvent({
        enrollmentId: enrollment.id,
        eventType: "calendly_booking",
        actor: "calendly_webhook",
        payload: {
          action: "canceled",
          email: booking.email,
          start_time: booking.startTime?.toISOString() ?? null,
          end_time: booking.endTime?.toISOString() ?? null,
          note,
          invitee_uri: booking.inviteeUri,
        },
      });
    }

    return {
      ok: true,
      matched: true,
      companyId,
      contactId: contact.id,
      enrollmentId: enrollment?.id ?? null,
      action: "canceled",
    };
  }

  return {
    ok: true,
    matched: true,
    companyId,
    contactId: contact.id,
    reason: `unhandled event ${booking.event}`,
  };
}
