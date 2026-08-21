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

/** Both Apollo discovery passes page at this size. A page costs one credit either way. */
export const DISCOVERY_APOLLO_PER_PAGE = 100;

export const EMPTY_CURSOR: DiscoveryCursor = {
  perPage: DISCOVERY_APOLLO_PER_PAGE,
  consumed: 0,
  totalEntries: null,
  poolExhausted: false,
};

/**
 * A cursor written under a different page size, or one that consumed past the
 * pool it claims, is leftover from a previous search definition (the 25-row
 * page, a tighter keyword list). Trusting it skips the unknown-size pass —
 * the small local firms the operator actually wants — and spends a credit on
 * an empty page of the sized pool.
 *
 * In-progress cursors (not exhausted) keep their offset so a mid-run page-size
 * change still moves forward.
 */
export function reconcileCursor(
  cursor: DiscoveryCursor,
  currentPerPage: number = DISCOVERY_APOLLO_PER_PAGE,
): { cursor: DiscoveryCursor; resetReason: "page_size_changed" | "consumed_past_pool" | null } {
  const size = Math.max(1, currentPerPage);
  const pageSizeChanged = cursor.perPage !== size;
  const consumedPastPool =
    cursor.totalEntries != null && cursor.consumed > cursor.totalEntries;

  if ((pageSizeChanged && cursor.poolExhausted) || consumedPastPool) {
    return {
      cursor: { ...EMPTY_CURSOR, perPage: size },
      resetReason: consumedPastPool ? "consumed_past_pool" : "page_size_changed",
    };
  }
  return { cursor, resetReason: null };
}

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
