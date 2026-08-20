/**
 * Job signals for a discovered company — pure summary over listings that are
 * already in the database from the scrape.
 *
 * Job activity is a signal, never a requirement: a company with no posting is
 * still a valid lead, it just doesn't get the bonus.
 */

export type JobSignalListing = {
  title: string;
  postedAt?: Date | string | null;
  firstSeenAt?: Date | string | null;
  archivedAt?: Date | string | null;
};

export type JobSignalSummary = {
  openPositions: number;
  /** Longest-running open role — the "they are struggling" tell. */
  oldestTitle: string | null;
  oldestOpenDays: number | null;
  /** e.g. "4 active jobs, Controller open 32 days"; null when there are none. */
  label: string | null;
};

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function summarizeJobSignals(
  listings: JobSignalListing[],
  now: Date = new Date(),
): JobSignalSummary {
  const open = listings.filter((l) => !toDate(l.archivedAt));
  if (!open.length) {
    return {
      openPositions: 0,
      oldestTitle: null,
      oldestOpenDays: null,
      label: null,
    };
  }

  let oldestTitle: string | null = null;
  let oldestOpenDays: number | null = null;
  for (const listing of open) {
    const start = toDate(listing.postedAt) ?? toDate(listing.firstSeenAt);
    if (!start) continue;
    const days = Math.max(
      0,
      Math.floor((now.getTime() - start.getTime()) / 86_400_000),
    );
    if (oldestOpenDays == null || days > oldestOpenDays) {
      oldestOpenDays = days;
      oldestTitle = listing.title;
    }
  }

  const jobsPart = `${open.length} active job${open.length === 1 ? "" : "s"}`;
  const agePart =
    oldestTitle && oldestOpenDays != null
      ? `, ${oldestTitle} open ${oldestOpenDays} day${oldestOpenDays === 1 ? "" : "s"}`
      : "";

  return {
    openPositions: open.length,
    oldestTitle,
    oldestOpenDays,
    label: `${jobsPart}${agePart}`,
  };
}
