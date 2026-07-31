import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import {
  callListEntries,
  companies,
  contacts,
  inboundMessages,
  outreachMessages,
  sequenceEnrollments,
  type Contact,
  type SequenceEnrollment,
} from "@/lib/db/schema";
import { TERMINAL_STATUSES } from "@/lib/call-status";
import {
  cancelPendingBookingConfirmation,
  queueBookingConfirmationText,
} from "@/lib/outreach/booking-confirmation";
import { recordCallListOutreachEvent } from "@/lib/outreach/call-list-sync";
import { cancelSiblingEnrollments } from "@/lib/outreach/enroll";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { stopPendingSteps } from "@/lib/outreach/pending-messages";
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
  /** webhook = Calendly API; email = IMAP free-tier notification parse. */
  source?: "webhook" | "email";
  /** When the notification arrived — anchors name-mismatch attribution. */
  notifiedAt?: Date | null;
};

export type ApplyCalendlyBookingResult = {
  ok: boolean;
  matched: boolean;
  companyId?: string;
  contactId?: string | null;
  enrollmentId?: string | null;
  action?: string;
  reason?: string;
  matchVia?: CalendlyNameMatchVia | null;
  contactName?: string | null;
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

/** Normalize person names for fuzzy first+last matching. */
export function normalizePersonName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Drop middle initials (single-letter tokens) for comparison. */
export function significantNameTokens(name: string): string[] {
  return normalizePersonName(name)
    .split(" ")
    .filter((t) => t.length > 1);
}

export type NameMatchStrength = "exact" | "strong" | "partial" | "none";

/**
 * Invitee vs contact.name:
 * - exact: same significant tokens (order-insensitive)
 * - strong: first+last both present (middle initials / reorder OK)
 * - partial: first-only or last-only overlap
 */
export function nameMatchStrength(
  inviteeName: string,
  contactName: string,
): NameMatchStrength {
  const at = significantNameTokens(inviteeName);
  const bt = significantNameTokens(contactName);
  if (!at.length || !bt.length) return "none";

  const sameMultiset =
    at.length === bt.length && at.every((t) => bt.includes(t));
  if (sameMultiset || at.join(" ") === bt.join(" ")) return "exact";

  if (at.length >= 2) {
    const first = at[0]!;
    const last = at[at.length - 1]!;
    if (bt.includes(first) && bt.includes(last)) return "strong";
    if (at.every((t) => bt.includes(t))) return "strong";
  }

  if (at.length === 1) {
    return bt.includes(at[0]!) ? "partial" : "none";
  }
  if (bt.includes(at[0]!) || bt.includes(at[at.length - 1]!)) return "partial";
  return "none";
}

/** True for exact/strong name overlap (not partial-only). */
export function namesMatchInvitee(
  inviteeName: string,
  contactName: string,
): boolean {
  const s = nameMatchStrength(inviteeName, contactName);
  return s === "exact" || s === "strong";
}

const LIVE_ENROLLMENT_STATUSES = [
  "active",
  "paused",
  "waiting_on_reply",
  "waiting_on_manual",
  "replied_positive",
] as const;

/** Lookback for positive / Calendly-link signals when name match is weak. */
export const CALENDLY_POSITIVE_LOOKBACK_DAYS = 21;

/**
 * How much fresher the winning positive signal must be than the runner-up
 * before we attribute a name-mismatched booking to it. Two leads who went
 * positive within half an hour of each other stay unmatched for review.
 */
export const CALENDLY_PROXIMITY_MARGIN_MS = 30 * 60 * 1000;

/** Tolerance for clock skew between the mail hop and our own timestamps. */
const CALENDLY_CLOCK_SLACK_MS = 10 * 60 * 1000;

export type CalendlyNameMatchVia =
  | "name_exact"
  | "name_strong"
  | "name_partial_positive"
  | "sole_recent_positive"
  | "latest_recent_positive";

export type CalendlyNameMatchResult = {
  contact: Contact | null;
  enrollment: SequenceEnrollment | null;
  matchVia?: CalendlyNameMatchVia | null;
  reason?: string;
};

type ScoredCandidate = {
  contact: Contact;
  enrollment: SequenceEnrollment | null;
  strength: NameMatchStrength;
  score: number;
  enrolledAt: number;
};

function scoreNameCandidate(options: {
  contact: Contact;
  enrollment: SequenceEnrollment | null;
  strength: NameMatchStrength;
  onCallList: boolean;
  callStatus?: string | null;
  companyStatus?: string | null;
  recentPositive: boolean;
  calendlyLinkSent: boolean;
}): ScoredCandidate {
  const { contact, enrollment, strength } = options;
  let score = 0;
  if (strength === "exact") score += 200;
  else if (strength === "strong") score += 150;
  else if (strength === "partial") score += 40;
  if (
    enrollment &&
    LIVE_ENROLLMENT_STATUSES.includes(
      enrollment.status as (typeof LIVE_ENROLLMENT_STATUSES)[number],
    )
  ) {
    score += 80;
  }
  if (enrollment?.status === "replied_positive") score += 60;
  if (options.onCallList) score += 40;
  if (options.callStatus === "meeting_scheduled") score += 50;
  if (options.callStatus === "replied_interested") score += 45;
  if (options.companyStatus === "meeting") score += 30;
  if (options.recentPositive) score += 70;
  if (options.calendlyLinkSent) score += 50;
  return {
    contact,
    enrollment,
    strength,
    score,
    enrolledAt: enrollment?.enrolledAt?.getTime() ?? 0,
  };
}

/**
 * Matching cascade for Calendly IMAP "New Event: {Name} - …" emails
 * (From is Calendly — never match by that address):
 *
 * 1. Strong/exact name among Call List + live enrollments → take unique best
 * 2. If zero/ambiguous → cross-ref recent positive signals (≤21d):
 *    replied_positive, meeting_scheduled, company meeting, Calendly link sent,
 *    positive inbound — prefer partial name hit within that set
 * 3. If name still weak AND exactly one recent "waiting for booking" positive
 *    enrollment with name overlap → use it. Never pick at random among many.
 * 4. Name matches nobody (personal Calendly account, alias, assistant booking):
 *    attribute to the lead whose positive/Calendly-link signal is the most
 *    recent one before the notification, if decisively ahead of the runner-up.
 * 5. Else unmatched — caller logs for manual review.
 */
export async function matchByInviteeName(
  name: string,
  options?: {
    /** When the Calendly notification landed — anchors step 4. */
    notifiedAt?: Date | null;
  },
): Promise<CalendlyNameMatchResult> {
  const tokens = significantNameTokens(name);
  if (tokens.length === 0) {
    return { contact: null, enrollment: null, reason: "empty invitee name" };
  }
  const notifiedAt = options?.notifiedAt ?? new Date();

  const since = new Date(
    Date.now() - CALENDLY_POSITIVE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );

  const liveEnrollments = await db
    .select()
    .from(sequenceEnrollments)
    .where(inArray(sequenceEnrollments.status, [...LIVE_ENROLLMENT_STATUSES]))
    .orderBy(desc(sequenceEnrollments.updatedAt))
    .limit(400);

  const callListRows = await db.select().from(callListEntries).limit(500);
  const callListByCompany = new Map(
    callListRows.map((e) => [e.companyId, e] as const),
  );

  const contactIdSet = new Set<string>([
    ...liveEnrollments.map((e) => e.contactId),
  ]);

  if (callListRows.length) {
    const onList = await db
      .select()
      .from(contacts)
      .where(
        inArray(
          contacts.companyId,
          callListRows.map((e) => e.companyId),
        ),
      )
      .limit(800);
    for (const c of onList) contactIdSet.add(c.id);
  }

  if (contactIdSet.size === 0) {
    return {
      contact: null,
      enrollment: null,
      reason: "no call-list or live-enrollment contacts",
    };
  }

  const poolContacts = await db
    .select()
    .from(contacts)
    .where(inArray(contacts.id, [...contactIdSet]))
    .limit(800);

  const enrollmentByContact = new Map<string, SequenceEnrollment>();
  for (const e of liveEnrollments) {
    if (!enrollmentByContact.has(e.contactId)) {
      enrollmentByContact.set(e.contactId, e);
    }
  }
  const extraEnrollments = await db
    .select()
    .from(sequenceEnrollments)
    .where(inArray(sequenceEnrollments.contactId, [...contactIdSet]))
    .orderBy(desc(sequenceEnrollments.enrolledAt))
    .limit(800);
  for (const e of extraEnrollments) {
    if (!enrollmentByContact.has(e.contactId)) {
      enrollmentByContact.set(e.contactId, e);
    }
  }

  const companyIds = [...new Set(poolContacts.map((c) => c.companyId))];
  const companyRows =
    companyIds.length > 0
      ? await db
          .select({ id: companies.id, status: companies.status })
          .from(companies)
          .where(inArray(companies.id, companyIds))
      : [];
  const companyStatusById = new Map(companyRows.map((c) => [c.id, c.status]));

  const positiveInbound = await db
    .select({
      contactId: inboundMessages.contactId,
      enrollmentId: inboundMessages.enrollmentId,
      receivedAt: inboundMessages.receivedAt,
    })
    .from(inboundMessages)
    .where(
      and(
        inArray(inboundMessages.classifiedIntent, [
          "positive",
          "positive_link_request",
        ]),
        sql`${inboundMessages.receivedAt} >= ${since}`,
      ),
    )
    .limit(200);

  const calendlySends = await db
    .select({
      enrollmentId: outreachMessages.enrollmentId,
      sentAt: outreachMessages.sentAt,
      updatedAt: outreachMessages.updatedAt,
    })
    .from(outreachMessages)
    .where(
      and(
        eq(outreachMessages.status, "sent"),
        inArray(outreachMessages.stepKind, [
          "reply_positive",
          "reply_info_request",
        ]),
        sql`${outreachMessages.body} ilike ${"%calendly.com%"}`,
        sql`coalesce(${outreachMessages.sentAt}, ${outreachMessages.updatedAt}) >= ${since}`,
      ),
    )
    .limit(200);

  const positiveContactIds = new Set<string>();
  const calendlyEnrollmentIds = new Set(
    calendlySends.map((r) => r.enrollmentId),
  );

  /**
   * Latest moment each contact showed booking intent, capped at the
   * notification so a later touch cannot backdate its way to the front.
   */
  const signalAtByContact = new Map<string, number>();
  const cutoff = notifiedAt.getTime() + CALENDLY_CLOCK_SLACK_MS;
  const noteSignal = (contactId: string, at: Date | null | undefined) => {
    if (!at) return;
    const ms = at.getTime();
    if (Number.isNaN(ms) || ms > cutoff || ms < since.getTime()) return;
    const prev = signalAtByContact.get(contactId);
    if (prev === undefined || ms > prev) signalAtByContact.set(contactId, ms);
  };

  const contactIdByEnrollment = new Map<string, string>();
  for (const e of [...liveEnrollments, ...extraEnrollments]) {
    contactIdByEnrollment.set(e.id, e.contactId);
  }
  const calendlySentAtByEnrollment = new Map<string, Date>();
  for (const row of calendlySends) {
    const at = row.sentAt ?? row.updatedAt;
    if (!at) continue;
    const prev = calendlySentAtByEnrollment.get(row.enrollmentId);
    if (!prev || at > prev) calendlySentAtByEnrollment.set(row.enrollmentId, at);
  }

  for (const row of positiveInbound) {
    if (row.contactId) {
      positiveContactIds.add(row.contactId);
      noteSignal(row.contactId, row.receivedAt);
    }
  }
  for (const e of liveEnrollments) {
    if (e.status === "replied_positive" && e.updatedAt >= since) {
      positiveContactIds.add(e.contactId);
      noteSignal(e.contactId, e.updatedAt);
    }
    if (calendlyEnrollmentIds.has(e.id)) positiveContactIds.add(e.contactId);
  }
  if (calendlyEnrollmentIds.size) {
    for (const e of extraEnrollments) {
      if (calendlyEnrollmentIds.has(e.id)) positiveContactIds.add(e.contactId);
    }
  }
  for (const [enrollmentId, at] of calendlySentAtByEnrollment) {
    const contactId = contactIdByEnrollment.get(enrollmentId);
    if (contactId) noteSignal(contactId, at);
  }
  for (const entry of callListRows) {
    if (
      (entry.callStatus === "meeting_scheduled" ||
        entry.callStatus === "replied_interested") &&
      (entry.callStatusUpdatedAt ?? entry.updatedAt) >= since
    ) {
      for (const c of poolContacts) {
        if (c.companyId === entry.companyId) {
          positiveContactIds.add(c.id);
          noteSignal(c.id, entry.callStatusUpdatedAt ?? entry.updatedAt);
        }
      }
    }
  }

  const scored: ScoredCandidate[] = [];
  for (const contact of poolContacts) {
    const strength = nameMatchStrength(name, contact.name);
    if (strength === "none") continue;
    const enrollment = enrollmentByContact.get(contact.id) ?? null;
    const callEntry = callListByCompany.get(contact.companyId);
    scored.push(
      scoreNameCandidate({
        contact,
        enrollment,
        strength,
        onCallList: Boolean(callEntry),
        callStatus: callEntry?.callStatus,
        companyStatus: companyStatusById.get(contact.companyId),
        recentPositive: positiveContactIds.has(contact.id),
        calendlyLinkSent: enrollment
          ? calendlyEnrollmentIds.has(enrollment.id)
          : false,
      }),
    );
  }

  scored.sort((a, b) => b.score - a.score || b.enrolledAt - a.enrolledAt);

  const strongHits = scored.filter(
    (s) => s.strength === "exact" || s.strength === "strong",
  );

  if (strongHits.length === 1) {
    const best = strongHits[0]!;
    return {
      contact: best.contact,
      enrollment: best.enrollment,
      matchVia: best.strength === "exact" ? "name_exact" : "name_strong",
    };
  }
  if (strongHits.length > 1) {
    const positiveStrong = strongHits.filter((s) =>
      positiveContactIds.has(s.contact.id),
    );
    if (positiveStrong.length === 1) {
      const best = positiveStrong[0]!;
      return {
        contact: best.contact,
        enrollment: best.enrollment,
        matchVia: best.strength === "exact" ? "name_exact" : "name_strong",
        reason: "disambiguated via recent positive signal",
      };
    }
    if (positiveStrong.length > 1) {
      const [a, b] = positiveStrong;
      if (a && b && a.score >= b.score + 40) {
        return {
          contact: a.contact,
          enrollment: a.enrollment,
          matchVia: a.strength === "exact" ? "name_exact" : "name_strong",
          reason: "top-scored among ambiguous name matches",
        };
      }
      return {
        contact: null,
        enrollment: null,
        reason: `ambiguous name match (${positiveStrong.length} positives)`,
      };
    }
    return {
      contact: null,
      enrollment: null,
      reason: `ambiguous name match (${strongHits.length} contacts)`,
    };
  }

  const partialPositive = scored.filter(
    (s) => s.strength === "partial" && positiveContactIds.has(s.contact.id),
  );
  if (partialPositive.length === 1) {
    const best = partialPositive[0]!;
    return {
      contact: best.contact,
      enrollment: best.enrollment,
      matchVia: "name_partial_positive",
      reason: "partial name among recent positives",
    };
  }
  if (partialPositive.length > 1) {
    const [a, b] = partialPositive;
    if (a && b && a.score >= b.score + 40) {
      return {
        contact: a.contact,
        enrollment: a.enrollment,
        matchVia: "name_partial_positive",
        reason: "top-scored partial among positives",
      };
    }
  }

  const waitingForBooking = liveEnrollments.filter((e) => {
    if (e.updatedAt < since) return false;
    if (e.status === "replied_positive") return true;
    if (calendlyEnrollmentIds.has(e.id)) return true;
    return false;
  });
  const waitingContacts = new Map<string, SequenceEnrollment>();
  for (const e of waitingForBooking) {
    if (!waitingContacts.has(e.contactId)) waitingContacts.set(e.contactId, e);
  }

  if (waitingContacts.size === 1) {
    const [contactId, enrollment] = [...waitingContacts.entries()][0]!;
    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    if (contact) {
      const strength = nameMatchStrength(name, contact.name);
      if (strength === "partial" || strength === "exact" || strength === "strong") {
        return {
          contact,
          enrollment,
          matchVia:
            strength === "partial"
              ? "name_partial_positive"
              : strength === "exact"
                ? "name_exact"
                : "name_strong",
          reason: "sole recent positive with name overlap",
        };
      }
      return {
        contact,
        enrollment,
        matchVia: "sole_recent_positive",
        reason: `invitee "${name}" does not match "${contact.name}"; sole lead awaiting a booking`,
      };
    }
  }

  // Step 4: booked under a name we have never seen. Whoever we just handed the
  // Calendly link to is the booker, so long as one lead is clearly the freshest.
  if (waitingContacts.size > 1) {
    const ranked = [...waitingContacts.entries()]
      .map(([contactId, enrollment]) => ({
        contactId,
        enrollment,
        signalAt: signalAtByContact.get(contactId) ?? 0,
      }))
      .filter((c) => c.signalAt > 0)
      .sort((a, b) => b.signalAt - a.signalAt);

    const [top, runnerUp] = ranked;
    if (top && (!runnerUp || top.signalAt - runnerUp.signalAt >= CALENDLY_PROXIMITY_MARGIN_MS)) {
      const [contact] = await db
        .select()
        .from(contacts)
        .where(eq(contacts.id, top.contactId))
        .limit(1);
      if (contact) {
        return {
          contact,
          enrollment: top.enrollment,
          matchVia: "latest_recent_positive",
          reason: `invitee "${name}" does not match any contact; most recent of ${waitingContacts.size} leads awaiting a booking`,
        };
      }
    }
    return {
      contact: null,
      enrollment: null,
      reason: `invitee "${name}" does not match any contact and ${waitingContacts.size} leads await a booking within minutes of each other`,
    };
  }

  return {
    contact: null,
    enrollment: null,
    reason:
      partialPositive.length > 1
        ? `ambiguous partial positives (${partialPositive.length})`
        : scored.length === 0
          ? "no name overlap on call list / live enrollments"
          : "no confident match after positive cross-reference",
  };
}

export async function matchContactForCalendlyBooking(options: {
  email: string | null;
  phone: string | null;
  /** Invitee display name — used when email/phone unavailable (IMAP path). */
  name?: string | null;
  /** When the booking notification landed — anchors the recency cascade. */
  notifiedAt?: Date | null;
}): Promise<CalendlyNameMatchResult> {
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

  // IMAP Calendly notifications: From is Calendly — match invitee name instead.
  if (options.name?.trim()) {
    return matchByInviteeName(options.name.trim(), {
      notifiedAt: options.notifiedAt ?? null,
    });
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

/**
 * Apply invitee.created / invitee.canceled to Call List + company + enrollment.
 */
export async function applyCalendlyBooking(
  booking: ParsedCalendlyBooking,
): Promise<ApplyCalendlyBookingResult> {
  const actor =
    booking.source === "email" ? "calendly_email" : "calendly_webhook";
  const matched = await matchContactForCalendlyBooking({
    email: booking.email,
    phone: booking.phone,
    name: booking.name,
    notifiedAt: booking.notifiedAt ?? null,
  });
  const { contact, enrollment } = matched;

  if (!contact) {
    return {
      ok: true,
      matched: false,
      reason: matched.reason ?? "no matching contact",
      matchVia: matched.matchVia ?? null,
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

  // Booked under an alias / personal account: name the invitee in the note so a
  // human can spot a wrong attribution without digging through the inbox.
  const inviteeAside =
    booking.name && nameMatchStrength(booking.name, contact.name) === "none"
      ? ` (booked as ${booking.name.trim()})`
      : "";

  const note = isCanceled
    ? `Call canceled${booking.startTime ? `: ${formatCallBookedNote(booking.startTime, booking.endTime).replace(/^Call Booked:\s*/, "")}` : ""}${inviteeAside}`.trim()
    : `${formatCallBookedNote(booking.startTime, booking.endTime)}${inviteeAside}`;

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
      // Someone who just booked should stop getting follow ups, so the
      // remaining sequence steps go. A booking is a reply though, not a stop
      // request: it must not take the auto-reply the contact's own text earned
      // minutes earlier, nor the confirmation an earlier notification for this
      // same booking already queued.
      const cancelledSteps = await stopPendingSteps(enrollment.id, actor, {
        keepAutoReplies: true,
      });
      const liveStatuses = [
        "active",
        "paused",
        "waiting_on_reply",
        "waiting_on_manual",
      ] as const;
      const nowReplied =
        liveStatuses.includes(
          enrollment.status as (typeof liveStatuses)[number],
        ) || enrollment.status === "replied_positive";
      if (nowReplied) {
        await db
          .update(sequenceEnrollments)
          .set({
            status: "replied_positive",
            stopReason:
              booking.source === "email"
                ? "calendly email notification"
                : "calendly invitee.created",
            stoppedBy: actor,
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
        actor,
        payload: {
          action: "created",
          email: booking.email,
          name: booking.name,
          start_time: booking.startTime?.toISOString() ?? null,
          end_time: booking.endTime?.toISOString() ?? null,
          note,
          invitee_uri: booking.inviteeUri,
          source: booking.source ?? "webhook",
          match_via: matched.matchVia ?? null,
          steps_cancelled: cancelledSteps,
        },
      });
      // Calendly emails its own confirmation, so only a texting thread needs
      // one from us. Queued after the cancel sweep above so it survives.
      await queueBookingConfirmationText({
        // The row was just flipped; the local copy still holds the old status.
        enrollment: nowReplied
          ? { ...enrollment, status: "replied_positive" }
          : enrollment,
        startTime: booking.startTime,
        actor,
        bookingKey: booking.inviteeUri ?? booking.scheduledEventUri ?? null,
      });
    }

    return {
      ok: true,
      matched: true,
      companyId,
      contactId: contact.id,
      enrollmentId: enrollment?.id ?? null,
      action: "created",
      matchVia: matched.matchVia ?? null,
      contactName: contact.name,
      reason: matched.reason,
    };
  }

  if (isCanceled) {
    // Append cancel note; only revert meeting_scheduled. The contact had
    // replied positively before booking, so a cancellation lands them back at
    // Replied — Interested (needs a rebook), not merely follow-up.
    const [entry] = await db
      .select()
      .from(callListEntries)
      .where(eq(callListEntries.companyId, companyId))
      .limit(1);

    let nextStatus: "replied_interested" | undefined;
    if (
      entry &&
      entry.callStatus === "meeting_scheduled" &&
      !TERMINAL_STATUSES.has(entry.callStatus)
    ) {
      nextStatus = "replied_interested";
    }

    await recordCallListOutreachEvent({
      companyId,
      contactId: contact.id,
      summary: note,
      activityType: "note",
      callStatus: nextStatus,
      allowRegression: true,
    });

    if (enrollment) {
      await cancelPendingBookingConfirmation(enrollment.id, actor);
      await logEnrollmentEvent({
        enrollmentId: enrollment.id,
        eventType: "calendly_booking",
        actor,
        payload: {
          action: "canceled",
          email: booking.email,
          name: booking.name,
          start_time: booking.startTime?.toISOString() ?? null,
          end_time: booking.endTime?.toISOString() ?? null,
          note,
          invitee_uri: booking.inviteeUri,
          source: booking.source ?? "webhook",
          match_via: matched.matchVia ?? null,
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
      matchVia: matched.matchVia ?? null,
      contactName: contact.name,
      reason: matched.reason,
    };
  }

  return {
    ok: true,
    matched: true,
    companyId,
    contactId: contact.id,
    reason: `unhandled event ${booking.event}`,
    matchVia: matched.matchVia ?? null,
    contactName: contact.name,
  };
}
