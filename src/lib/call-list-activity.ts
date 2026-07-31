/**
 * Call List "latest activity" — one definition shared by the sort and the
 * Last Activity column so they can never disagree.
 *
 * Mirrors the SQL ordering in crm-queries / the call-list API route:
 * GREATEST(last_contact_at, call_status_updated_at, updated_at).
 *
 * Client + server safe (no DB imports). Stamps render in Eastern to match
 * businessToday() and the `[Jul 31, 12:23 AM]` note stamps, and to keep
 * server-rendered markup identical to the client pass.
 */

const ET = "America/New_York";

type ActivityTimestamps = {
  lastContactAt: Date | string | null;
  callStatusUpdatedAt: Date | string | null;
  updatedAt: Date | string;
};

function toMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** Most recent touch: outreach notes bump updatedAt; attempts bump lastContactAt. */
export function latestActivityAt(entry: ActivityTimestamps): Date | null {
  const times: number[] = [];
  for (const value of [
    entry.lastContactAt,
    entry.callStatusUpdatedAt,
    entry.updatedAt,
  ]) {
    const ms = toMs(value);
    if (ms != null) times.push(ms);
  }
  return times.length ? new Date(Math.max(...times)) : null;
}

/** Sort key form of {@link latestActivityAt} — 0 when there is no activity. */
export function latestActivityMs(entry: ActivityTimestamps): number {
  return latestActivityAt(entry)?.getTime() ?? 0;
}

/** `Jul 31` */
export function formatActivityDay(value: Date): string {
  return value.toLocaleDateString("en-US", {
    timeZone: ET,
    month: "short",
    day: "numeric",
  });
}

/** `12:23 AM` */
export function formatActivityClock(value: Date): string {
  return value.toLocaleTimeString("en-US", {
    timeZone: ET,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** `Jul 31, 12:23 AM` — same shape as the Call List note stamps. */
export function formatActivityStamp(value: Date): string {
  return `${formatActivityDay(value)}, ${formatActivityClock(value)}`;
}

/** `Jul 31, 2026, 12:23 AM ET` — hover/expanded detail, year included. */
export function formatActivityStampLong(value: Date): string {
  const year = value.toLocaleDateString("en-US", { timeZone: ET, year: "numeric" });
  return `${formatActivityDay(value)}, ${year}, ${formatActivityClock(value)} ET`;
}
