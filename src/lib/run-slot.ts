const BUSINESS_TZ = "America/New_York";

export type RunSlot = {
  id: string;
  label: string;
  slotStart: Date;
};

function etParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

/** Build a Date for a given ET calendar date + hour (DST-aware via noon anchor). */
function etSlotStart(year: number, month: number, day: number, hour: number): Date {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const hh = String(hour).padStart(2, "0");
  // Iterate UTC offsets — ET is UTC-4 (EDT) or UTC-5 (EST)
  for (const offset of [4, 5]) {
    const utc = new Date(
      Date.UTC(year, month - 1, day, hour + offset, 0, 0),
    );
    const p = etParts(utc);
    if (p.year === year && p.month === month && p.day === day && p.hour === hour) {
      return utc;
    }
  }
  return new Date(`${year}-${mm}-${dd}T${hh}:00:00-04:00`);
}

/**
 * Returns the pipeline run slot we should monitor, if we're in the post-run
 * alert window (6:20–8:00 AM or PM ET).
 */
export function getActiveRunSlot(now = new Date()): RunSlot | null {
  const { year, month, day, hour, minute } = etParts(now);
  const dateKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  const inMorningWindow =
    (hour === 6 && minute >= 20) || hour === 7 || (hour === 8 && minute === 0);
  const inEveningWindow =
    (hour === 18 && minute >= 20) || hour === 19 || (hour === 20 && minute === 0);

  if (inMorningWindow) {
    return {
      id: `${dateKey}-morning`,
      label: "6 AM Eastern",
      slotStart: etSlotStart(year, month, day, 6),
    };
  }

  if (inEveningWindow) {
    return {
      id: `${dateKey}-evening`,
      label: "6 PM Eastern",
      slotStart: etSlotStart(year, month, day, 18),
    };
  }

  return null;
}

export function formatEtTimestamp(date: Date | null | undefined): string {
  if (!date) return "never";
  return date.toLocaleString("en-US", {
    timeZone: BUSINESS_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function minutesAgo(date: Date | null | undefined, now = new Date()): number | null {
  if (!date) return null;
  return Math.round((now.getTime() - date.getTime()) / 60_000);
}
