import {
  businessListDate,
  businessListWindowLabel,
  parseListDateParam,
} from "@/lib/timezone";

export type ListDateRange = {
  /** Single-day pick (from === to) or explicit range. */
  mode: "single" | "range";
  from: string;
  to: string;
  /** Backlog snapshot date — end of the selected window. */
  snapshotDate: string;
  isToday: boolean;
};

function clampToBusinessToday(date: string): string {
  const today = businessListDate();
  return date > today ? today : date;
}

/** Parse ?date=, ?from= & ?to= into a normalized list window. */
export function resolveListDateRange(params: {
  date?: string;
  from?: string;
  to?: string;
}): ListDateRange {
  const today = businessListDate();
  const parsedFrom = parseListDateParam(params.from);
  const parsedTo = parseListDateParam(params.to);
  const parsedDate = parseListDateParam(params.date);

  if (parsedFrom && parsedTo) {
    let from = parsedFrom;
    let to = parsedTo;
    if (from > to) [from, to] = [to, from];
    from = clampToBusinessToday(from);
    to = clampToBusinessToday(to);
    return {
      mode: from === to ? "single" : "range",
      from,
      to,
      snapshotDate: to,
      isToday: from === today && to === today,
    };
  }

  if (parsedFrom && !parsedTo) {
    const from = clampToBusinessToday(parsedFrom);
    return {
      mode: "single",
      from,
      to: from,
      snapshotDate: from,
      isToday: from === today,
    };
  }

  const single = clampToBusinessToday(parsedDate ?? today);
  return {
    mode: "single",
    from: single,
    to: single,
    snapshotDate: single,
    isToday: single === today,
  };
}

export function listDateRangeLabel(range: ListDateRange): string {
  if (range.mode === "range") {
    const fromLabel = formatShortDate(range.from);
    const toLabel = formatShortDate(range.to);
    return `${fromLabel} – ${toLabel} · 5 AM – 5 AM ET`;
  }
  return businessListWindowLabel(range.from);
}

function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function backlogSummaryLabel(
  range: ListDateRange,
  count: number,
): string {
  if (range.mode === "range") {
    return `${count} backlog leads scraped ${formatShortDate(range.from)}–${formatShortDate(range.to)} (as of ${formatShortDate(range.snapshotDate)})`;
  }
  if (range.isToday) {
    return `${count} in ranked backlog`;
  }
  return `${count} in backlog as of ${formatShortDate(range.snapshotDate)}`;
}
