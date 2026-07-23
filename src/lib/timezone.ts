/** Business timezone for daily list boundaries (recruiter is US-based). */
export const BUSINESS_TIMEZONE = "America/New_York";

/** Calendar date in Eastern time (midnight boundary). */
export function businessToday(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
  });
}

function tzOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const wallClockAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return wallClockAsUtc - instant.getTime();
}

/**
 * UTC instant of midnight (Eastern) on the current business day.
 * Daily budget windows must roll with the recruiter's day — a UTC window
 * rolls at 8 PM ET and silently charges evening usage to the next day.
 */
export function businessDayStartUtc(now = new Date()): Date {
  const dateStr = now.toLocaleDateString("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
  });
  const guess = new Date(`${dateStr}T00:00:00Z`);
  const offset = tzOffsetMs(guess, BUSINESS_TIMEZONE);
  const corrected = new Date(guess.getTime() - offset);
  // Offset can differ across a DST boundary — recheck at the corrected instant.
  const offsetAtCorrected = tzOffsetMs(corrected, BUSINESS_TIMEZONE);
  return offsetAtCorrected === offset
    ? corrected
    : new Date(guess.getTime() - offsetAtCorrected);
}

/** Hour (0–23) in Eastern time. */
export function businessHour(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIMEZONE,
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0");
}

/**
 * Recruiting "list day" rolls at 5:00 AM Eastern (not midnight).
 * Between midnight and 5 AM, the list still shows the prior business day.
 */
export function businessListDate(): string {
  const calendarToday = businessToday();
  if (businessHour() < 5) {
    const d = new Date(`${calendarToday}T12:00:00`);
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  return calendarToday;
}

/**
 * first_seen values to include on Today's List.
 * Before 5 AM, also includes calendar-today rows from midnight straddle runs.
 */
export function businessDayFirstSeenDates(): string[] {
  const listDate = businessListDate();
  const calendarToday = businessToday();
  if (listDate !== calendarToday) {
    return [listDate, calendarToday];
  }
  return [listDate];
}

export function businessListWindowLabel(listDate?: string): string {
  const d = new Date(`${resolveListDate(listDate)}T12:00:00`);
  const dayLabel = d.toLocaleDateString("en-US", {
    timeZone: BUSINESS_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  return `${dayLabel} · 5 AM – 5 AM ET`;
}

/** Validate YYYY-MM-DD from URL ?date= param. */
export function parseListDateParam(param: string | undefined): string | undefined {
  if (!param?.match(/^\d{4}-\d{2}-\d{2}$/)) return undefined;
  return param;
}

/** Active list date: explicit calendar pick, else current business day. */
export function resolveListDate(listDateParam?: string): string {
  return parseListDateParam(listDateParam) ?? businessListDate();
}

/** am = morning scrape (~5 AM ET), pm = evening (~6 PM ET). */
export type RunSlot = "am" | "pm" | "manual";

export function normalizeRunSlot(slot?: string | null): RunSlot {
  if (slot === "pm" || slot === "manual") return slot;
  return "am";
}

/** Display label for a scheduled run slot. */
export function formatRunSlot(slot?: string | null): string {
  const s = normalizeRunSlot(slot);
  if (s === "pm") return "6 PM ET";
  if (s === "manual") return "manual";
  return "5 AM ET";
}

/** Infer slot from Eastern hour (matches worker schedule). */
export function businessRunSlot(hour = businessHour()): RunSlot {
  if (hour < 12) return "am";
  return "pm";
}

/**
 * first_seen dates for the daily list query.
 * Explicit date → that day only; default → current business day (+ straddle before 5 AM).
 */
export function firstSeenDatesForListQuery(listDateParam?: string): string[] {
  const parsed = parseListDateParam(listDateParam);
  if (parsed) return [parsed];
  return businessDayFirstSeenDates();
}
