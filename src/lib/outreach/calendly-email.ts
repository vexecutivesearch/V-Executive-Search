import { normalizeEmail } from "@/lib/outreach/suppression";

/**
 * Free-tier Calendly workaround: IMAP notification emails are From Calendly
 * (not the invitee), so enrollment cannot be matched by From. Parse invitee
 * name + start time from the subject (and light body fallbacks) instead.
 *
 * Example subject:
 *   New Event: Miguel Lozano - 09:00am Fri, Jul 31, 2026 - 30 Minute Meeting
 */

export type CalendlyEmailKind = "created" | "canceled" | "marketing" | null;

export type ParsedCalendlyEmail = {
  kind: Exclude<CalendlyEmailKind, null>;
  /** Invitee display name from subject/body (never the Calendly From address). */
  inviteeName: string | null;
  startTime: Date | null;
  endTime: Date | null;
  eventTitle: string | null;
  rawSubject: string;
};

const CALENDLY_FROM_SUFFIXES = ["@calendly.com", "@send.calendly.com"];

/**
 * Undo RFC 5322 header folding. Calendly subjects are long enough that the
 * SMTP hop wraps them, so IMAP hands us "… - 15 Minute\r\n Meeting" and any
 * `^…$` subject regex fails on the embedded newline.
 */
export function unfoldHeader(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MARKETING_SUBJECT =
  /\b(you did it|first booking|getting started|welcome to calendly|tips for|introduce yourself)\b/i;

/** True when IMAP From is a Calendly notification sender (not an invitee). */
export function isCalendlyNotificationAddress(
  from: string | null | undefined,
): boolean {
  const email = normalizeEmail(from);
  if (!email) return false;
  return CALENDLY_FROM_SUFFIXES.some((suffix) => email.endsWith(suffix));
}

/** Strip tags so Invitee: / Event Date lines are searchable. */
export function stripHtmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/**
 * Parse a Calendly wall-clock stamp as America/New_York.
 * Subject times look like: "09:00am Fri, Jul 31, 2026"
 */
export function parseCalendlySubjectDateTime(
  timePart: string,
): Date | null {
  const m = timePart
    .trim()
    .match(
      /^(\d{1,2}):(\d{2})\s*(am|pm)\s+[A-Za-z]{3},?\s+([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i,
    );
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = m[3].toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  const month = MONTHS[m[4].toLowerCase()];
  const day = Number(m[5]);
  const year = Number(m[6]);
  if (!month || !day || !year) return null;

  return easternWallClockToUtc(year, month, day, hour, minute);
}

/** Convert ET wall clock → UTC Date (handles EST/EDT). */
function easternWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date | null {
  for (const offset of ["-04:00", "-05:00"] as const) {
    const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00${offset}`;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) continue;
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
      })
        .formatToParts(date)
        .filter((p) => p.type !== "literal")
        .map((p) => [p.type, p.value]),
    );
    const h = Number(parts.hour === "24" ? "0" : parts.hour);
    if (
      Number(parts.year) === year &&
      Number(parts.month) === month &&
      Number(parts.day) === day &&
      h === hour &&
      Number(parts.minute) === minute
    ) {
      return date;
    }
  }
  return null;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

const EVENT_SUBJECT =
  /^(new|canceled|cancelled)\s+event:\s*(.+)$/i;

/**
 * Duration from a Calendly event type name ("15 Minute Meeting", "1 Hour
 * Intro"). Drives the end time in Call List notes, so it must cover every
 * event type on the account, not just the 30 minute default.
 */
export function eventDurationMinutes(eventTitle: string): number | null {
  const mins = eventTitle.match(/\b(\d{1,3})\s*(?:minute|min)s?\b/i);
  if (mins) {
    const n = Number(mins[1]);
    return n > 0 && n <= 600 ? n : null;
  }
  const hours = eventTitle.match(/\b(\d{1,2})(?:\.5)?\s*(?:hour|hr)s?\b/i);
  if (hours) {
    const half = /\.5\s*(?:hour|hr)/i.test(eventTitle);
    const n = Number(hours[1]) * 60 + (half ? 30 : 0);
    return n > 0 && n <= 600 ? n : null;
  }
  return null;
}

/**
 * Parse Calendly notification subject (+ optional HTML/text body).
 * Does not use the From address for identity.
 */
export function parseCalendlyNotificationEmail(options: {
  subject?: string | null;
  body?: string | null;
}): ParsedCalendlyEmail | null {
  const subject = unfoldHeader(options.subject ?? "");
  if (!subject) return null;

  if (MARKETING_SUBJECT.test(subject)) {
    return {
      kind: "marketing",
      inviteeName: null,
      startTime: null,
      endTime: null,
      eventTitle: null,
      rawSubject: subject,
    };
  }

  const eventMatch = subject.match(EVENT_SUBJECT);
  if (!eventMatch) {
    // teamcalendly fluff without New/Canceled Event → ignore
    return {
      kind: "marketing",
      inviteeName: null,
      startTime: null,
      endTime: null,
      eventTitle: null,
      rawSubject: subject,
    };
  }

  const kind: "created" | "canceled" =
    eventMatch[1].toLowerCase() === "new" ? "created" : "canceled";
  const rest = eventMatch[2].trim();

  // "Miguel Lozano - 09:00am Fri, Jul 31, 2026 - 30 Minute Meeting"
  const parts = rest.split(/\s+-\s+/);
  let inviteeName: string | null = parts[0]?.trim() || null;
  let startTime: Date | null = null;
  let endTime: Date | null = null;
  let eventTitle: string | null = null;

  if (parts.length >= 2) {
    startTime = parseCalendlySubjectDateTime(parts[1].trim());
    if (parts.length >= 3) {
      eventTitle = parts.slice(2).join(" - ").trim() || null;
    }
  }

  // Body fallbacks when subject is thin
  const text = stripHtmlToText(options.body ?? "");
  if (!inviteeName || inviteeName.length < 2) {
    const invitee =
      text.match(/\bInvitee:\s*([^\n<]+)/i) ??
      text.match(/\bName:\s*([^\n<]+)/i);
    if (invitee?.[1]) inviteeName = invitee[1].trim();
  }
  if (!startTime) {
    const when =
      text.match(
        /\b(?:Event Date(?:\s*&\s*Time)?|When):\s*([^\n<]+)/i,
      ) ?? null;
    if (when?.[1]) {
      // Try subject-style parse on a cleaned fragment
      const cleaned = when[1]
        .replace(/\s+/g, " ")
        .replace(/\s+\([^)]*\)\s*$/, "")
        .trim();
      // "Friday, July 31, 2026 9:00am" variants — best-effort
      const loose = cleaned.match(
        /(\d{1,2}:\d{2}\s*(?:am|pm))\s*[A-Za-z]{3},?\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
      );
      if (loose) {
        startTime = parseCalendlySubjectDateTime(
          `${loose[1]} Fri, ${loose[2]}`,
        );
      }
    }
  }

  if (startTime && eventTitle) {
    const minutes = eventDurationMinutes(eventTitle);
    if (minutes) endTime = new Date(startTime.getTime() + minutes * 60 * 1000);
  }

  return {
    kind,
    inviteeName,
    startTime,
    endTime,
    eventTitle,
    rawSubject: subject,
  };
}
