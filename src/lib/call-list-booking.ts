/**
 * Booked-meeting time for Call List rows.
 *
 * Structured source: the `calendly_booking` enrollment event written by
 * applyCalendlyBooking(), whose payload carries ISO start_time / end_time.
 * Notes text is only a fallback for rows booked before that record existed.
 *
 * Client + server safe (no DB imports). Rendered in Eastern, matching the
 * `Call Booked: …` note stamps.
 */

const ET = "America/New_York";

export type CallListBooking = {
  startAt: Date;
  endAt: Date | null;
};

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Read a booking out of a `calendly_booking` enrollment event payload.
 * Cancellations and "time TBD" bookings return null — the caller degrades to
 * no label rather than showing an empty window.
 */
export function bookingFromEventPayload(
  payload: Record<string, unknown> | null | undefined,
): CallListBooking | null {
  if (!payload) return null;
  const action =
    typeof payload.action === "string" ? payload.action.toLowerCase() : "";
  if (action.startsWith("cancel")) return null;
  const startAt = toDate(payload.start_time);
  if (!startAt) return null;
  return { startAt, endAt: toDate(payload.end_time) };
}

function clock(value: Date): string {
  return value.toLocaleTimeString("en-US", {
    timeZone: ET,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * `Mon Aug 3, 9:00–9:30 AM ET` (or with the year for the expanded detail).
 * The start meridiem is dropped when it matches the end's, as in the notes.
 */
export function formatBookedWindow(
  startValue: Date | string,
  endValue: Date | string | null,
  options: { includeYear?: boolean } = {},
): string | null {
  // RSC-serialized rows can hand back ISO strings rather than Dates.
  const start = toDate(startValue);
  if (!start) return null;
  const end = toDate(endValue);

  const weekday = start.toLocaleDateString("en-US", { timeZone: ET, weekday: "short" });
  const month = start.toLocaleDateString("en-US", { timeZone: ET, month: "short" });
  const day = start.toLocaleDateString("en-US", { timeZone: ET, day: "numeric" });
  let datePart = `${weekday} ${month} ${day}`;
  if (options.includeYear) {
    const year = start.toLocaleDateString("en-US", { timeZone: ET, year: "numeric" });
    datePart = `${datePart}, ${year}`;
  }

  const startClock = clock(start);
  if (!end) return `${datePart}, ${startClock} ET`;

  const endClock = clock(end);
  const sameMeridiem = startClock.slice(-2) === endClock.slice(-2);
  const head = sameMeridiem
    ? startClock.replace(/\s?(AM|PM)$/i, "")
    : startClock;
  return `${datePart}, ${head}–${endClock} ET`;
}

const STAMP_PREFIX = /^\[[^\]]*\]\s*/;

/**
 * Fallback for rows with no structured booking: pull the window text out of the
 * newest `Call Booked: …` note line. Notes are newest-first, so a later
 * cancellation (or a booking with no time) wins and yields null.
 */
export function bookedWindowFromNotes(
  notes: string | null | undefined,
): string | null {
  if (!notes?.trim()) return null;
  for (const raw of notes.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim().replace(STAMP_PREFIX, "");
    if (!line) continue;
    if (/^call cancell?ed\b/i.test(line)) return null;
    if (/^call booked\b/i.test(line)) {
      // "Call Booked (time TBD)" has no window to show.
      return line.match(/^call booked:\s*(.+)$/i)?.[1]?.trim() ?? null;
    }
  }
  return null;
}
