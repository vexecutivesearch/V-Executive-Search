/**
 * The discovery exclusion gate — the hard size/enterprise filter.
 *
 * The operator's requirement is absolute: no Fortune 500, no Fortune 1000, no
 * huge corporations, no staffing or recruiting firms, no government employers.
 * Small to mid-sized businesses only. Everything before this module treated
 * that as a score penalty (`scoreCompanyFirst` subtracts 45 for an exclusion
 * flag) or as an `icp_status` the review queue never reads, so an oversized
 * company still arrived in the queue, just further down. This module decides
 * instead of ranking.
 *
 * Pure and provider-agnostic: no DB, no network, no Apollo types at the
 * boundary. The Apollo source and the SerpAPI source both map their payload
 * into `DiscoveryGateInput` and get the same verdict.
 *
 * Every decision carries a reason enum, following `explainChannelPlan` in
 * `src/lib/outreach/channel-plan.ts` — a run that returns 4 companies instead
 * of 25 has to be diagnosable, and a boolean cannot explain itself.
 */

import { employeeBandForVertical } from "./verticals";
import { matchEnterpriseDomain } from "./enterprise-domains";

export type GateVerdict = "accept" | "review" | "reject";

export type GateReason =
  | "within_band"
  | "size_unknown"
  | "employees_below_min"
  | "employees_above_max"
  | "government"
  | "public_education"
  | "staffing_agency"
  | "publicly_traded"
  | "enterprise_domain"
  | "revenue_above_max";

export type GateDecision = {
  verdict: GateVerdict;
  reason: GateReason;
  /** Human-readable evidence for the reason (domain matched, headcount, …). */
  detail: string;
};

/**
 * What the gate needs from any discovery source. Everything but `name` is
 * optional-by-null so a source that cannot supply a signal degrades to the
 * rules it can support rather than throwing.
 */
export type DiscoveryGateInput = {
  name: string;
  domain?: string | null;
  /** Provider industry label, e.g. Apollo's "staffing & recruiting". */
  industry?: string | null;
  employeeCount?: number | null;
  /** Annual revenue in USD, when the provider supplies it. */
  annualRevenue?: number | null;
  /** Stock ticker — presence alone means the company is publicly traded. */
  publiclyTradedSymbol?: string | null;
  /** Discovery vertical, which selects the employee band. */
  vertical?: string | null;
};

export type GateOptions = {
  /**
   * The operator's "allow larger companies selectively" escape hatch. It ONLY
   * downgrades an over-max headcount from reject to review, and it is never a
   * default: the caller has to pass it for a specific run. Government,
   * staffing, publicly traded, enterprise domain, and over-max revenue stay
   * hard rejects regardless — none of those are "a big company we might make
   * an exception for", they are categories the operator ruled out outright.
   */
  allowLargeCompanies?: boolean;
};

/**
 * $1B. Deliberately far above any small-to-mid business so the rule cannot
 * misfire on a successful regional firm, and deliberately below the Fortune
 * 1000 floor (~$3B) so it still catches every ranked company. Its real job is
 * the subsidiary case: providers report the PARENT's revenue on a subsidiary
 * record whose local headcount reads like a small office.
 */
export const ENTERPRISE_REVENUE_MIN = 1_000_000_000;

/* ------------------------------------------------------------------ */
/* Name and industry patterns                                          */
/* ------------------------------------------------------------------ */

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[.,'’]/g, "").replace(/\s+/g, " ").trim();
}

function normalizeIndustry(industry: string): string {
  return industry.toLowerCase().replace(/[/_-]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Staffing/recruiting name patterns.
 *
 * Bare "talent" and bare "search" are deliberately absent. The operator's
 * targets include firms like "Talent Design Group" and "Search & Rescue
 * Restoration", and a bare-token rule would delete them. Every "talent" and
 * "search" pattern below requires a second staffing-specific word.
 */
const STAFFING_NAME_PATTERNS: RegExp[] = [
  /\bstaffing\b/,
  /\bstaff(ing)? (agency|solutions|services|partners|group)\b/,
  /\brecruit(ing|ment|er|ers)\b/,
  /\bheadhunt(er|ers|ing)?\b/,
  /\bexecutive search\b/,
  /\bretained search\b/,
  /\bsearch (group|partners|associates|consultants|firm)\b/,
  /\btalent (solutions|acquisition|partners|group|advisors|network|search|sourcing)\b/,
  /\bplacement (agency|services)\b/,
  /\bjob placement\b/,
  /\bemployment (agency|agencies|services|solutions)\b/,
  /\bpersonnel\b/,
  /\bworkforce (solutions|services|staffing|partners)\b/,
  /\btemp(orary)? (agency|staffing|services)\b/,
  /\bmanpower\b/,
  /\bhr (solutions|services|outsourcing)\b/,
  /\bprofessional employer organization\b/,
  /\brpo\b/,
];

/** Provider industry labels that are staffing outright. */
const STAFFING_INDUSTRIES = new Set([
  "staffing & recruiting",
  "staffing and recruiting",
  "staffing recruiting",
  "recruiting",
  "staffing",
  "executive search",
  "employment services",
  "employment placement agencies",
]);

const GOV_NAME_PATTERNS: RegExp[] = [
  /^city of\b/,
  /^town of\b/,
  /^village of\b/,
  /^county of\b/,
  /\bcounty of\b/,
  /^state of\b/,
  /\bcounty (government|commission|board|clerk|sheriff)\b/,
  /^(us|u s|united states) department\b/,
  /\bdepartment of (transportation|corrections|health|revenue|justice|defense|labor|education|veterans)\b/,
  /\bmunicipal(ity|ities)?\b/,
  /\b(city|county|state|federal) government\b/,
  /\bpublic works department\b/,
  /\bsheriffs? office\b/,
  /\bpolice department\b/,
  /\bfire (department|district|rescue)\b/,
  /\bhousing authority\b/,
  /\btransit authority\b/,
  /\bport authority\b/,
  /\bwater management district\b/,
];

const GOV_INDUSTRIES = new Set([
  "government administration",
  "government relations",
  "legislative office",
  "judiciary",
  "political organization",
  "public safety",
  "military",
  "defense & space",
  "international affairs",
  "public policy",
]);

const PUBLIC_EDUCATION_NAME_PATTERNS: RegExp[] = [
  /\bschool district\b/,
  /\bpublic schools?\b/,
  /\bunified school\b/,
  /\bisd\b/,
  /\bboard of education\b/,
  /\bstate (university|college)\b/,
  /\buniversity of\b/,
  /\bcommunity college\b/,
  /\bcollege district\b/,
];

const PUBLIC_EDUCATION_INDUSTRIES = new Set([
  "primary/secondary education",
  "primary secondary education",
  "higher education",
]);

/** The matched substring, so a rejection reads as evidence not as a regex. */
function matchedToken(value: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const hit = value.match(pattern);
    if (hit) return hit[0];
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Individual classifiers (exported so each is unit-testable alone)    */
/* ------------------------------------------------------------------ */

export function isGovernmentEmployer(input: {
  name: string;
  domain?: string | null;
  industry?: string | null;
}): string | null {
  const host = (input.domain ?? "").trim().toLowerCase();
  if (/(^|\.)(gov|mil)$/.test(host.split("/")[0].replace(/^www\./, ""))) {
    return `${host} is a government domain`;
  }
  const industry = input.industry ? normalizeIndustry(input.industry) : "";
  if (industry && GOV_INDUSTRIES.has(industry)) {
    return `industry "${input.industry}"`;
  }
  const hit = matchedToken(normalizeName(input.name), GOV_NAME_PATTERNS);
  return hit ? `name contains "${hit}"` : null;
}

export function isPublicEducation(input: {
  name: string;
  industry?: string | null;
}): string | null {
  const industry = input.industry ? normalizeIndustry(input.industry) : "";
  if (industry && PUBLIC_EDUCATION_INDUSTRIES.has(industry)) {
    return `industry "${input.industry}"`;
  }
  const hit = matchedToken(
    normalizeName(input.name),
    PUBLIC_EDUCATION_NAME_PATTERNS,
  );
  return hit ? `name contains "${hit}"` : null;
}

/**
 * Staffing, recruiting, executive search, RPO, and PEO firms.
 *
 * This catches the operator's own business too ("V Executive Search"), which
 * is correct — discovery must not prospect the firm running it.
 */
export function isStaffingOrRecruiting(input: {
  name: string;
  industry?: string | null;
}): string | null {
  const industry = input.industry ? normalizeIndustry(input.industry) : "";
  if (industry && STAFFING_INDUSTRIES.has(industry)) {
    return `industry "${input.industry}"`;
  }
  const hit = matchedToken(normalizeName(input.name), STAFFING_NAME_PATTERNS);
  return hit ? `name contains "${hit}"` : null;
}

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

/**
 * Order matters: the category rules run before the size rules so an oversized
 * staffing agency reports "staffing agency" rather than "too large", and so a
 * Fortune 500 subsidiary with 40 local employees is rejected on its domain
 * rather than accepted on its headcount.
 *
 * Unknown headcount FAILS CLOSED to `review`, never to `accept`. The rule it
 * replaces (`employees > max → fail`) was silently true-for-nobody on null,
 * which is how large companies with no provider headcount reached the queue.
 * Auto-dropping them instead would be just as wrong: missing headcount is the
 * normal state for the small local firms in Construction and Legal that the
 * operator most wants, so they are surfaced with an explicit "size unknown"
 * marker and the operator makes the call.
 */
export function evaluateDiscoveryGate(
  input: DiscoveryGateInput,
  options: GateOptions = {},
): GateDecision {
  const gov = isGovernmentEmployer(input);
  if (gov) return { verdict: "reject", reason: "government", detail: gov };

  const education = isPublicEducation(input);
  if (education) {
    return { verdict: "reject", reason: "public_education", detail: education };
  }

  const staffing = isStaffingOrRecruiting(input);
  if (staffing) {
    return { verdict: "reject", reason: "staffing_agency", detail: staffing };
  }

  const domainHit = matchEnterpriseDomain(input.domain);
  if (domainHit) {
    return {
      verdict: "reject",
      reason:
        domainHit.kind === "staffing" ? "staffing_agency" : "enterprise_domain",
      detail: `${domainHit.domain} is a known ${domainHit.kind} domain`,
    };
  }

  const ticker = input.publiclyTradedSymbol?.trim();
  if (ticker) {
    return {
      verdict: "reject",
      reason: "publicly_traded",
      detail: `publicly traded (${ticker})`,
    };
  }

  const revenue = input.annualRevenue;
  if (revenue != null && revenue >= ENTERPRISE_REVENUE_MIN) {
    return {
      verdict: "reject",
      reason: "revenue_above_max",
      detail: `$${Math.round(revenue / 1_000_000).toLocaleString()}M annual revenue`,
    };
  }

  const band = employeeBandForVertical(input.vertical);
  const employees = input.employeeCount;

  if (employees == null) {
    return {
      verdict: "review",
      reason: "size_unknown",
      detail: "no headcount from the discovery source",
    };
  }
  if (employees > band.max) {
    return {
      verdict: options.allowLargeCompanies ? "review" : "reject",
      reason: "employees_above_max",
      detail: `${employees.toLocaleString()} employees, band max ${band.max.toLocaleString()}`,
    };
  }
  if (employees < band.min) {
    // Under the band is not what the operator asked to eliminate, and a hard
    // reject here would delete real four-person firms, so it surfaces instead.
    return {
      verdict: "review",
      reason: "employees_below_min",
      detail: `${employees.toLocaleString()} employees, band min ${band.min.toLocaleString()}`,
    };
  }

  return {
    verdict: "accept",
    reason: "within_band",
    detail: `${employees.toLocaleString()} employees, band ${band.min}–${band.max}`,
  };
}

export function gateReasonLabel(reason: GateReason): string {
  switch (reason) {
    case "within_band":
      return "within the vertical's employee band";
    case "size_unknown":
      return "size unknown";
    case "employees_below_min":
      return "under the band minimum";
    case "employees_above_max":
      return "too large";
    case "government":
      return "government / public sector";
    case "public_education":
      return "public education";
    case "staffing_agency":
      return "staffing or recruiting firm";
    case "publicly_traded":
      return "publicly traded";
    case "enterprise_domain":
      return "known enterprise";
    case "revenue_above_max":
      return "enterprise revenue";
  }
}

export type GatePartition<T> = {
  accepted: T[];
  /** Kept, but carrying a reason the operator has to look at. */
  flagged: Array<{ item: T; decision: GateDecision }>;
  rejected: Array<{ item: T; decision: GateDecision }>;
};

/** Split a batch from any source into keep / flag / reject. */
export function partitionByGate<T>(
  items: T[],
  toInput: (item: T) => DiscoveryGateInput,
  options: GateOptions = {},
): GatePartition<T> {
  const partition: GatePartition<T> = {
    accepted: [],
    flagged: [],
    rejected: [],
  };
  for (const item of items) {
    const decision = evaluateDiscoveryGate(toInput(item), options);
    if (decision.verdict === "accept") partition.accepted.push(item);
    else if (decision.verdict === "review") {
      partition.flagged.push({ item, decision });
    } else partition.rejected.push({ item, decision });
  }
  return partition;
}

/** Counts per reason, for the run summary. */
export function summarizeGateReasons(
  decisions: GateDecision[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const decision of decisions) {
    counts[decision.reason] = (counts[decision.reason] ?? 0) + 1;
  }
  return counts;
}

/** "12 rejected: 7 too large, 3 staffing or recruiting firm, 2 government". */
export function describeGateRejections(
  counts: Record<string, number>,
): string | null {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${n} ${gateReasonLabel(reason as GateReason)}`);
  if (!parts.length) return null;
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return `${total} rejected before review: ${parts.join(", ")}.`;
}
