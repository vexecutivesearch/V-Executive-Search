/**
 * Operator-facing progress for a discovery market.
 *
 * Two Apollo pools exist because Apollo's employee-range filter hides every
 * company it has no headcount for — exactly the small local firms we want.
 * The sized pool is small and drains in one run. The second pass has no
 * "unknown size" filter (Apollo does not offer one), so its pool size is the
 * unfiltered result count and most rows on each page already have a headcount.
 *
 * `poolExhausted` used to mean "the sized pool is empty", which is how a
 * Finance run with 233 companies still to page through told the operator to
 * rotate markets. Market exhaustion is both pools done, not the first one.
 */

import type { PoolStatus } from "./pagination";

export type DiscoveryPoolId = "sized" | "unknown_size";

export type MarketProgress = {
  sized: PoolStatus | null;
  unknown: PoolStatus | null;
  includeUnknown: boolean;
  /** At least one pool still has a page we have not bought. */
  canFindMore: boolean;
  /** Every pool we would search is empty. Reset or rotate. */
  marketExhausted: boolean;
  /** Never searched this pair. */
  firstRun: boolean;
  remainingAcrossPools: number | null;
  nextAction: "first_run" | "find_more" | "rotate_or_reset";
};

export function marketProgress(input: {
  sized?: PoolStatus | null;
  unknown?: PoolStatus | null;
  includeUnknown?: boolean;
}): MarketProgress {
  const includeUnknown = input.includeUnknown !== false;
  const sized = input.sized ?? null;
  const unknown = includeUnknown ? (input.unknown ?? null) : null;
  const firstRun = sized == null && unknown == null;

  const sizedDone = sized?.exhausted === true;
  const unknownDone = !includeUnknown || unknown?.exhausted === true;
  // A pool we have never opened is still searchable.
  const sizedOpen = sized == null || !sizedDone;
  const unknownOpen = includeUnknown && (unknown == null || !unknownDone);
  const canFindMore = sizedOpen || unknownOpen;
  const marketExhausted = !firstRun && !canFindMore;

  const remainingParts = [sized, unknown]
    .filter((p): p is PoolStatus => p != null && p.remaining != null)
    .map((p) => p.remaining as number);
  const remainingAcrossPools =
    remainingParts.length === 0
      ? null
      : remainingParts.reduce((sum, n) => sum + n, 0);

  return {
    sized,
    unknown,
    includeUnknown,
    canFindMore,
    marketExhausted,
    firstRun,
    remainingAcrossPools,
    nextAction: firstRun
      ? "first_run"
      : canFindMore
        ? "find_more"
        : "rotate_or_reset",
  };
}

export function findMoreLabel(limit: number, progress: MarketProgress): string {
  if (progress.nextAction === "rotate_or_reset") {
    return "Nothing left in this market";
  }
  if (progress.nextAction === "find_more") {
    return `Find ${limit} more`;
  }
  return `Find ${limit} companies`;
}

export function sizedPoolHeadline(status: PoolStatus): string {
  if (status.exhausted) {
    return "Companies Apollo already has a headcount for — done for this market.";
  }
  if (status.remaining == null) {
    return "Companies Apollo already has a headcount for.";
  }
  return `Companies Apollo already has a headcount for — ${status.remaining.toLocaleString()} left.`;
}

export function unknownPoolHeadline(status: PoolStatus): string {
  if (status.exhausted) {
    return "Companies with no Apollo headcount — paged through.";
  }
  if (status.remaining == null) {
    return "Companies with no Apollo headcount (the small local firms).";
  }
  return `${status.remaining.toLocaleString()} Apollo rows still unpaged in the unfiltered pass. Most will already have a headcount and be skipped; the ones that do not are size-unknown.`;
}

export function nextRunHint(progress: MarketProgress, limit: number): string {
  if (progress.nextAction === "first_run") {
    return `The first Find pages Apollo and, when it is on for this vertical, Google Maps. You can run it again — each click continues from where the last one stopped, up to ${limit} companies per run.`;
  }
  if (progress.nextAction === "find_more") {
    const left =
      progress.remainingAcrossPools == null
        ? "more companies"
        : `${progress.remainingAcrossPools.toLocaleString()} Apollo rows still unpaged`;
    return `${left}. Find again to continue — it will not re-buy the pages you already paid for.`;
  }
  return "Both Apollo passes for this market are empty. Reset to start over, or pick another market.";
}
