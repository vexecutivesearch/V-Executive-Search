import { BUSINESS_TIMEZONE, businessListDate } from "@/lib/timezone";

/** Calendar date (YYYY-MM-DD) in business TZ for a timestamp. */
export function businessDateFromTimestamp(
  value: Date | string | null | undefined,
): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    // date-only columns already store business calendar days
    if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toLocaleDateString("en-CA", { timeZone: BUSINESS_TIMEZONE });
  }
  return value.toLocaleDateString("en-CA", { timeZone: BUSINESS_TIMEZONE });
}

/**
 * Freshness highlight — scrape stays wide (168h); "new today" is computed
 * from first-seen, not from narrowing the JobSpy window.
 */
export function isNewToday(opts: {
  companyFirstSeen: string | null | undefined;
  listings?: Array<{ firstSeenAt?: Date | string | null }>;
  listDate?: string;
}): boolean {
  const asOf = opts.listDate ?? businessListDate();
  if (opts.companyFirstSeen === asOf) return true;
  return (opts.listings ?? []).some(
    (l) => businessDateFromTimestamp(l.firstSeenAt) === asOf,
  );
}
