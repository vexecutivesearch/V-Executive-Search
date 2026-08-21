/**
 * Discovery pagination — pure cursor maths, no DB.
 *
 * "25 new companies per day" is a sustained rate against a finite pool: a
 * single county's law firms are a few hundred companies, so day 2 must start
 * where day 1 stopped and the operator must be told when the pool runs out
 * instead of silently re-reviewing yesterday's list.
 */

export type DiscoveryPool = "sized" | "unknown_size";

export type DiscoveryCursor = {
  /** Page size the consumed counter was accumulated with. */
  perPage: number;
  /** Apollo organizations already pulled for this (vertical, market, pool). */
  consumed: number;
  /** Apollo pagination.total_entries — null until the first run. */
  totalEntries: number | null;
  poolExhausted: boolean;
};

export type PoolStatus = {
  poolSize: number | null;
  consumed: number;
  /** Null while the pool size is still unknown (before the first run). */
  remaining: number | null;
  exhausted: boolean;
  /** Operator-facing note; set when the market should be rotated. */
  note: string | null;
};

export const EMPTY_CURSOR: DiscoveryCursor = {
  perPage: 25,
  consumed: 0,
  totalEntries: null,
  poolExhausted: false,
};

/**
 * Apollo is offset-paged, so the next page derives from how much of the pool
 * has been consumed. When the run size changes, the page boundary shifts and a
 * few organizations can repeat — dedupe on domain/name is what keeps those from
 * reaching the operator, and the run summary reports them as duplicates.
 */
export function pageForCursor(cursor: DiscoveryCursor, perPage: number): number {
  const size = Math.max(1, perPage);
  return Math.floor(Math.max(0, cursor.consumed) / size) + 1;
}

export function poolStatus(cursor: DiscoveryCursor): PoolStatus {
  const poolSize = cursor.totalEntries;
  const remaining =
    poolSize == null ? null : Math.max(0, poolSize - cursor.consumed);
  const exhausted = cursor.poolExhausted || remaining === 0;
  return {
    poolSize,
    consumed: cursor.consumed,
    remaining,
    exhausted,
    note: exhausted
      ? "Pool exhausted — rotate to another market or vertical."
      : null,
  };
}

/**
 * Advance after a run. A short page (fewer organizations than requested) means
 * Apollo has nothing left for these filters, which is the exhaustion signal
 * even when total_entries suggests otherwise.
 */
export function advanceCursor(
  cursor: DiscoveryCursor,
  result: {
    requested: number;
    returned: number;
    totalEntries: number | null;
    perPage: number;
  },
): DiscoveryCursor {
  const consumed = Math.max(0, cursor.consumed) + Math.max(0, result.returned);
  const totalEntries = result.totalEntries ?? cursor.totalEntries;
  const shortPage = result.returned < result.requested;
  const drained = totalEntries != null && consumed >= totalEntries;
  return {
    perPage: result.perPage,
    consumed,
    totalEntries,
    poolExhausted: cursor.poolExhausted || shortPage || drained,
  };
}
