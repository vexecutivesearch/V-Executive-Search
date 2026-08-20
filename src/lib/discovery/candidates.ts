/**
 * Candidate selection + dedupe planning for company-first discovery.
 * Pure functions — the DB write path calls these, tests exercise them directly.
 */

import { normalizeCompanyKey } from "@/lib/company-name";
import type { DiscoveredOrganization } from "@/lib/domain-resolver";
import { employeeBandForVertical } from "@/lib/discovery/verticals";

export type DiscoveryCandidate = DiscoveredOrganization & {
  /** Apollo has no headcount for this company — surfaced, not hidden. */
  sizeUnknown: boolean;
  /** Headcount is outside the vertical's band (kept, but deprioritised). */
  sizeOutOfBand: boolean;
};

function toCandidate(
  org: DiscoveredOrganization,
  vertical: string,
): DiscoveryCandidate {
  const band = employeeBandForVertical(vertical);
  const employees = org.estimatedEmployees;
  return {
    ...org,
    sizeUnknown: employees == null,
    sizeOutOfBand:
      employees != null && (employees < band.min || employees > band.max),
  };
}

/** Dedupe key: domain when known, else the normalised name. */
export function candidateKey(org: {
  domain: string | null;
  name: string;
}): string {
  const domain = org.domain?.trim().toLowerCase();
  if (domain) return `domain:${domain}`;
  return `name:${normalizeCompanyKey(org.name)}`;
}

/**
 * Merge the two Apollo passes into one review batch.
 *
 * The size-filtered pass is authoritative; the second pass exists only because
 * `organization_num_employees_ranges` drops companies Apollo has no headcount
 * for, and the operator's own target list is full of small firms in exactly
 * that state. Unknown-headcount companies get a reserved share of the batch so
 * they are never crowded out, then fill whatever the sized pass left over.
 */
export function selectDiscoveryCandidates(input: {
  vertical: string;
  sized: DiscoveredOrganization[];
  unknownSize: DiscoveredOrganization[];
  limit: number;
  /** Keys already surfaced in an earlier run (never re-review the same company). */
  excludeKeys?: Set<string>;
}): {
  candidates: DiscoveryCandidate[];
  duplicatesSkipped: number;
  sizeUnknownCount: number;
} {
  const limit = Math.max(0, input.limit);
  const seen = new Set<string>();
  const excluded = input.excludeKeys ?? new Set<string>();
  let duplicatesSkipped = 0;

  const take = (orgs: DiscoveredOrganization[], max: number, unknownOnly: boolean) => {
    const out: DiscoveryCandidate[] = [];
    for (const org of orgs) {
      if (out.length >= max) break;
      if (unknownOnly && org.estimatedEmployees != null) continue;
      const key = candidateKey(org);
      if (seen.has(key) || excluded.has(key)) {
        duplicatesSkipped += 1;
        continue;
      }
      seen.add(key);
      out.push(toCandidate(org, input.vertical));
    }
    return out;
  };

  // Reserve a fifth of the batch for unknown-headcount firms.
  const unknownReserve = limit > 0 ? Math.max(1, Math.ceil(limit / 5)) : 0;
  const sized = take(input.sized, Math.max(0, limit - unknownReserve), false);
  const unknown = take(input.unknownSize, Math.max(0, limit - sized.length), true);
  // Backfill with sized results when the unknown pass came back thin.
  const backfill = take(
    input.sized,
    Math.max(0, limit - sized.length - unknown.length),
    false,
  );

  const candidates = [...sized, ...backfill, ...unknown];
  return {
    candidates,
    duplicatesSkipped,
    sizeUnknownCount: candidates.filter((c) => c.sizeUnknown).length,
  };
}
