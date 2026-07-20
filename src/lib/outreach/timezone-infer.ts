/**
 * Contact-local send scheduling: timezone inferred from job/contact location
 * (fallback company HQ market, then ET); a contact's timezone_override always
 * wins. Sends land on weekdays inside the local business window with
 * per-message random jitter.
 */

import { parseJobLocation } from "@/lib/location-match";

export const DEFAULT_TIMEZONE = "America/New_York";

/** US state/territory → primary IANA timezone (majority-population zone). */
const STATE_TIMEZONES: Record<string, string> = {
  AL: "America/Chicago",
  AK: "America/Anchorage",
  AZ: "America/Phoenix",
  AR: "America/Chicago",
  CA: "America/Los_Angeles",
  CO: "America/Denver",
  CT: "America/New_York",
  DC: "America/New_York",
  DE: "America/New_York",
  FL: "America/New_York",
  GA: "America/New_York",
  HI: "Pacific/Honolulu",
  IA: "America/Chicago",
  ID: "America/Boise",
  IL: "America/Chicago",
  IN: "America/Indiana/Indianapolis",
  KS: "America/Chicago",
  KY: "America/New_York",
  LA: "America/Chicago",
  MA: "America/New_York",
  MD: "America/New_York",
  ME: "America/New_York",
  MI: "America/Detroit",
  MN: "America/Chicago",
  MO: "America/Chicago",
  MS: "America/Chicago",
  MT: "America/Denver",
  NC: "America/New_York",
  ND: "America/Chicago",
  NE: "America/Chicago",
  NH: "America/New_York",
  NJ: "America/New_York",
  NM: "America/Denver",
  NV: "America/Los_Angeles",
  NY: "America/New_York",
  OH: "America/New_York",
  OK: "America/Chicago",
  OR: "America/Los_Angeles",
  PA: "America/New_York",
  RI: "America/New_York",
  SC: "America/New_York",
  SD: "America/Chicago",
  TN: "America/Chicago",
  TX: "America/Chicago",
  UT: "America/Denver",
  VA: "America/New_York",
  VT: "America/New_York",
  WA: "America/Los_Angeles",
  WI: "America/Chicago",
  WV: "America/New_York",
  WY: "America/Denver",
};

const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR",
  california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY",
};

/** Timezone from a "City, ST"-style location string, or null. */
export function timezoneFromLocation(
  location: string | null | undefined,
): string | null {
  if (!location?.trim()) return null;
  const parsed = parseJobLocation(location);
  if (parsed?.stateAbbr && STATE_TIMEZONES[parsed.stateAbbr.toUpperCase()]) {
    return STATE_TIMEZONES[parsed.stateAbbr.toUpperCase()];
  }
  const lower = location.toLowerCase();
  for (const [name, abbr] of Object.entries(STATE_NAMES)) {
    if (lower.includes(name)) return STATE_TIMEZONES[abbr];
  }
  return null;
}

/**
 * Resolve the enrollment timezone.
 * Priority: contact timezone_override > contact location > job location >
 * company HQ location > ET.
 */
export function resolveContactTimezone(options: {
  timezoneOverride?: string | null;
  contactLocation?: string | null;
  jobLocation?: string | null;
  companyLocation?: string | null;
}): string {
  const override = options.timezoneOverride?.trim();
  if (override && isValidTimezone(override)) return override;
  return (
    timezoneFromLocation(options.contactLocation) ??
    timezoneFromLocation(options.jobLocation) ??
    timezoneFromLocation(options.companyLocation) ??
    DEFAULT_TIMEZONE
  );
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(date).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/** UTC instant for wall-clock (y, m, d, h, min) in a timezone. */
export function dateInTimezone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  let ts = utcGuess - tzOffsetMs(new Date(utcGuess), timeZone);
  ts = utcGuess - tzOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/** Calendar date + weekday of a UTC instant as seen in a timezone. */
export function wallClock(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0=Sun … 6=Sat
} {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(date).map((p) => [p.type, p.value]),
  );
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: weekdays.indexOf(String(parts.weekday)),
  };
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/**
 * Schedule a send N days after a base instant, landing on a WEEKDAY inside
 * the contact's local business window with random jitter. If the target day
 * is a weekend, roll forward to Monday.
 */
export function scheduleSendAt(options: {
  base: Date;
  offsetDays: number;
  timeZone: string;
  windowStartHour?: number;
  windowEndHour?: number;
  /** Injectable for tests. */
  random?: () => number;
}): Date {
  const {
    base,
    offsetDays,
    timeZone,
    windowStartHour = 9,
    windowEndHour = 17,
    random = Math.random,
  } = options;

  let target = addDays(base, offsetDays);
  // Roll weekends forward to Monday (in the contact's timezone).
  for (let i = 0; i < 3; i += 1) {
    const wc = wallClock(target, timeZone);
    if (wc.weekday !== 0 && wc.weekday !== 6) break;
    target = addDays(target, 1);
  }

  const wc = wallClock(target, timeZone);
  const windowMinutes = Math.max(1, (windowEndHour - windowStartHour) * 60 - 1);
  const jitter = Math.floor(random() * windowMinutes);
  const hour = windowStartHour + Math.floor(jitter / 60);
  const minute = jitter % 60;
  let scheduled = dateInTimezone(wc.year, wc.month, wc.day, hour, minute, timeZone);

  // Same-day sends whose window already passed move to the next weekday.
  if (offsetDays === 0 && scheduled <= base) {
    const nowWc = wallClock(base, timeZone);
    if (nowWc.hour < windowEndHour - 1 && nowWc.weekday !== 0 && nowWc.weekday !== 6) {
      // Still inside today's window — send shortly after now with jitter.
      const minutesAhead = 2 + Math.floor(random() * 20);
      scheduled = new Date(base.getTime() + minutesAhead * 60_000);
    } else {
      return scheduleSendAt({ ...options, offsetDays: 1 });
    }
  }
  return scheduled;
}

/** Push a deadline N business days forward (OOO reschedules use this). */
export function addBusinessDays(
  base: Date,
  businessDays: number,
  timeZone: string,
): Date {
  let result = base;
  let remaining = businessDays;
  while (remaining > 0) {
    result = addDays(result, 1);
    const wc = wallClock(result, timeZone);
    if (wc.weekday !== 0 && wc.weekday !== 6) remaining -= 1;
  }
  return result;
}
