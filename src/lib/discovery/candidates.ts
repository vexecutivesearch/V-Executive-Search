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
 * Every key a company can collide on. Apollo happily returns the same firm
 * twice with a domain on one row and nothing on the other, so a domain match
 * alone is not enough to dedupe a batch.
 */
function candidateKeys(org: { domain: string | null; name: string }): string[] {
  const keys: string[] = [];
  const domain = org.domain?.trim().toLowerCase();
  if (domain) keys.push(`domain:${domain}`);
  const nameKey = normalizeCompanyKey(org.name);
  if (nameKey) keys.push(`name:${nameKey}`);
  return keys;
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

  const dedupe = (orgs: DiscoveredOrganization[], unknownOnly: boolean) => {
    const out: DiscoveryCandidate[] = [];
    for (const org of orgs) {
      if (unknownOnly && org.estimatedEmployees != null) continue;
      const keys = candidateKeys(org);
      if (!keys.length) continue;
      if (keys.some((key) => seen.has(key) || excluded.has(key))) {
        duplicatesSkipped += 1;
        continue;
      }
      for (const key of keys) seen.add(key);
      out.push(toCandidate(org, input.vertical));
    }
    return out;
  };

  const sizedPool = dedupe(input.sized, false);
  const unknownPool = dedupe(input.unknownSize, true);

  // Reserve a fifth of the batch for unknown-headcount firms so they are never
  // crowded out, then hand any unused reserve back to the sized pool.
  const unknownReserve = limit > 0 ? Math.max(1, Math.ceil(limit / 5)) : 0;
  const sized = sizedPool.slice(0, Math.max(0, limit - unknownReserve));
  const unknown = unknownPool.slice(0, Math.max(0, limit - sized.length));
  const backfill = sizedPool.slice(
    sized.length,
    sized.length + Math.max(0, limit - sized.length - unknown.length),
  );

  const candidates = [...sized, ...backfill, ...unknown];
  return {
    candidates,
    duplicatesSkipped,
    sizeUnknownCount: candidates.filter((c) => c.sizeUnknown).length,
  };
}
