/**
 * Is the vertical on a discovered company a FACT about that company, or just
 * the search that found it?
 *
 * Discovery stamps `companies.vertical` from the run parameter, and it has to:
 * the vertical drives the ICP employee band, the company-first score and the
 * decision-maker title priority. But the run parameter is not evidence. Apollo
 * `q_organization_keyword_tags` matches the company's own keyword list, which
 * includes who it SELLS TO — a marketing agency that serves law firms carries
 * legal keywords, and a hair-restoration brand carries "restoration".
 *
 * So the vertical is recorded as the SEARCH vertical and this module decides
 * what the UI is allowed to assert about it. Pure: config + the company's own
 * name and Apollo industry, no DB and no network.
 */

import { isCoarseSectorRollup } from "@/lib/industry-sectors";
import {
  getVerticalConfig,
  listVerticals,
  type VerticalVerify,
} from "./verticals";

export type VerticalEvidenceStatus = "confirmed" | "unverified" | "contradicted";

export type VerticalEvidence = {
  status: VerticalEvidenceStatus;
  /** The industry value or name token that decided it. */
  matchedOn: string | null;
  /** Operator-facing explanation — never overstates what Apollo returned. */
  reason: string;
  /** When contradicted, the vertical the company actually looks like. */
  looksLike: string | null;
};

function normalizeIndustry(value: string | null | undefined): string | null {
  const v = value?.trim().toLowerCase().replace(/\s+/g, " ");
  return v || null;
}

/** Whole-word match, so "law" never fires on "Lawson" and "spa" never on "space". */
function nameHasWord(name: string, word: string): boolean {
  const tokens = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const target = word.toLowerCase().trim();
  if (!target) return false;
  if (target.includes(" ")) {
    return ` ${tokens.join(" ")} `.includes(` ${target} `);
  }
  return tokens.includes(target);
}

function firstNameMatch(name: string, words: string[]): string | null {
  for (const word of words) {
    if (nameHasWord(name, word)) return word;
  }
  return null;
}

function verifyConfig(vertical: string | null | undefined): VerticalVerify {
  return getVerticalConfig(vertical)?.verify ?? {};
}

/** The vertical whose `industry_any` claims this Apollo industry, if any. */
function verticalClaimingIndustry(industry: string): string | null {
  for (const { id } of listVerticals()) {
    const list = verifyConfig(id).industry_any ?? [];
    if (list.some((entry) => normalizeIndustry(entry) === industry)) return id;
  }
  return null;
}

/**
 * What the review queue may say about a discovered company's vertical.
 *
 * `confirmed`   — Apollo's own industry or the company name names the vertical.
 * `contradicted`— the industry or name points somewhere else entirely.
 * `unverified`  — nothing either way; say "found via <vertical> search".
 *
 * A coarse rollup label in `industry` ("Professional & Business Services") is
 * the job-scrape worker's keyword guess, not Apollo data, so it is deliberately
 * given no verifying power in either direction.
 */
export function verticalEvidence(input: {
  vertical: string | null | undefined;
  name: string;
  industry: string | null | undefined;
}): VerticalEvidence {
  const label = getVerticalConfig(input.vertical)?.label ?? null;
  if (!input.vertical || !label) {
    return {
      status: "unverified",
      matchedOn: null,
      reason: "No discovery vertical on this company.",
      looksLike: null,
    };
  }

  const config = verifyConfig(input.vertical);
  const rollup = isCoarseSectorRollup(input.industry);
  const industry = rollup ? null : normalizeIndustry(input.industry);
  const name = input.name ?? "";

  if (industry) {
    const confirmed = (config.industry_any ?? []).find(
      (entry) => normalizeIndustry(entry) === industry,
    );
    if (confirmed) {
      return {
        status: "confirmed",
        matchedOn: confirmed,
        reason: `Apollo industry "${confirmed}" matches ${label}.`,
        looksLike: null,
      };
    }
  }

  const nameHit = firstNameMatch(name, config.name_any ?? []);
  if (nameHit) {
    return {
      status: "confirmed",
      matchedOn: nameHit,
      reason: `Company name contains "${nameHit}", which names the ${label} vertical.`,
      looksLike: null,
    };
  }

  if (industry) {
    const blocked = (config.industry_not ?? []).find(
      (entry) => normalizeIndustry(entry) === industry,
    );
    const claimedBy = verticalClaimingIndustry(industry);
    if (blocked || (claimedBy && claimedBy !== input.vertical)) {
      const otherLabel = claimedBy
        ? getVerticalConfig(claimedBy)?.label ?? null
        : null;
      return {
        status: "contradicted",
        matchedOn: industry,
        reason:
          `Found via the ${label} search, but Apollo's industry is ` +
          `"${industry}"${otherLabel ? ` (${otherLabel})` : ""}.`,
        looksLike: otherLabel,
      };
    }
  }

  const nameMiss = firstNameMatch(name, config.name_not ?? []);
  if (nameMiss) {
    return {
      status: "contradicted",
      matchedOn: nameMiss,
      reason:
        `Found via the ${label} search, but the name contains "${nameMiss}", ` +
        `which does not belong to ${label}.`,
      looksLike: null,
    };
  }

  return {
    status: "unverified",
    matchedOn: null,
    reason:
      `Found via the ${label} search. Apollo returned nothing that confirms ` +
      `the company actually is ${label}` +
      (rollup
        ? " — its industry is a pipeline rollup label, not an Apollo industry."
        : "."),
    looksLike: null,
  };
}

/** Short badge text — asserts the vertical only when the data supports it. */
export function verticalBadgeLabel(
  verticalLabel: string | null,
  status: VerticalEvidenceStatus,
): string | null {
  if (!verticalLabel) return null;
  if (status === "confirmed") return verticalLabel;
  if (status === "contradicted") return `${verticalLabel} search — mismatch`;
  return `via ${verticalLabel} search`;
}
