/**
 * ICP scorer — a PURE annotation module. No side effects, no DB, no network.
 *
 * Prime directive: this module never deletes, hides, or reorders a lead.
 * It returns annotations (scores, flags with per-flag confidence, estimates);
 * all hiding happens later in the CRM view layer, reversibly, behind toggles.
 *
 * Hard-exclude eligibility is restricted to deterministic matches only
 * (exact known-list name, .gov domain). Everything pattern-based is a soft
 * flag: confidence < 1.0, kept and visible. Classifiers below the keep
 * threshold flag-and-keep — ambiguity always defaults to inclusion.
 */

import {
  getIcpConfig,
  type CompConfidence,
  type CompanySizeBand,
  type IcpConfig,
  type IcpFlagName,
  type RoleType,
} from "./icp-config";

export type IcpLeadInput = {
  companyId: string;
  companyName: string;
  domain: string | null;
  /** Current hiring-signal lead score — unchanged by this module. */
  baseLeadScore: number;
  estimatedEmployees?: number | null;
  hiringSignals?: Record<string, boolean | number> | null;
  listings: Array<{
    title: string;
    salaryMin?: number | null;
    salaryMax?: number | null;
    salaryText?: string | null;
  }>;
};

export type IcpDecision = {
  company: string;
  action: "flag" | "deprioritize" | "none";
  reason: string;
  confidence: number;
  detail?: string;
};

export type IcpAnnotation = {
  companyId: string;
  companyName: string;
  baseLeadScore: number;
  icpAdjustedScore: number;
  exclusionFlags: string[];
  /** INTEGRITY: every entry in exclusionFlags has a numeric 0–1 entry here. */
  exclusionConfidence: Record<string, number>;
  roleType: RoleType;
  roleTypeConfidence: number;
  compAnnualMin: number | null;
  compAnnualMax: number | null;
  compEstimatedFlag: boolean;
  compConfidence: CompConfidence | null;
  companySizeBand: CompanySizeBand;
  likelyToUseRecruiter: number;
  enrichmentTier: "free" | "paid_needed";
  decisions: IcpDecision[];
};

/** Flags that are deterministic (confidence 1.0) and thus hide-eligible. */
export const HARD_EXCLUDE_FLAGS_BY_TOGGLE: Partial<
  Record<IcpFlagName, string[]>
> = {
  exclude_fortune_lists: ["fortune_500", "fortune_1000"],
  exclude_gov_domains: ["gov_domain"],
  exclude_known_staffing_agencies: ["staffing_agency"],
  exclude_known_large_private: ["known_large_private"],
};

function norm(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Exact-name match against a known list (normalized, suffix-tolerant). */
function matchesKnownList(companyName: string, list: string[]): boolean {
  const name = norm(companyName).replace(
    /\b(inc|incorporated|llc|llp|lp|corp|corporation|co|company|ltd|limited|plc|holdings|group)\b\s*$/,
    "",
  ).trim();
  return list.some((entry) => {
    const target = norm(entry);
    return name === target || norm(companyName) === target;
  });
}

function anyPatternMatches(value: string, patterns: string[]): boolean {
  const v = value.toLowerCase();
  return patterns.some((p) => new RegExp(p, "i").test(v));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/* ------------------------------------------------------------------ */
/* Role classification                                                  */
/* ------------------------------------------------------------------ */

const ROLE_VALUE_ORDER: RoleType[] = [
  "leadership",
  "management",
  "specialized",
  "professional",
  "support",
  "hourly",
];

export function classifyRoleType(
  title: string,
  config: IcpConfig = getIcpConfig(),
): { roleType: RoleType; confidence: number } {
  const t = title.toLowerCase();
  const matched: RoleType[] = [];

  for (const roleType of ROLE_VALUE_ORDER) {
    const bucket = config.role_types[roleType as Exclude<RoleType, "unknown">];
    if (!bucket) continue;
    if (bucket.exclude_overrides.some((o) => t.includes(o.toLowerCase()))) {
      continue;
    }
    if (anyPatternMatches(t, bucket.patterns)) {
      matched.push(roleType);
    }
  }

  if (!matched.length) return { roleType: "unknown", confidence: 0.5 };
  if (matched.length === 1) return { roleType: matched[0], confidence: 0.95 };

  // Ambiguous — WHEN-IN-DOUBT-KEEP: resolve toward the higher-value bucket,
  // never toward hourly, with reduced confidence (kept + flagged upstream).
  const best = ROLE_VALUE_ORDER.find((r) => matched.includes(r))!;
  const resolved =
    best === "hourly" || best === "support" ? "professional" : best;
  return { roleType: resolved, confidence: 0.6 };
}

/** Company-level role: the highest-value classification across listings. */
function classifyCompanyRole(
  listings: IcpLeadInput["listings"],
  config: IcpConfig,
): { roleType: RoleType; confidence: number } {
  let best: { roleType: RoleType; confidence: number } = {
    roleType: "unknown",
    confidence: 0.5,
  };
  let bestRank = ROLE_VALUE_ORDER.length + 1;
  for (const listing of listings) {
    const result = classifyRoleType(listing.title, config);
    const rank =
      result.roleType === "unknown"
        ? ROLE_VALUE_ORDER.length
        : ROLE_VALUE_ORDER.indexOf(result.roleType);
    if (rank < bestRank) {
      bestRank = rank;
      best = result;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Compensation                                                         */
/* ------------------------------------------------------------------ */

type CompResult = {
  annualMin: number | null;
  annualMax: number | null;
  estimated: boolean;
  confidence: CompConfidence | null;
  belowMin: boolean;
};

function parseSalaryText(
  text: string,
): { min: number | null; max: number | null; hourly: boolean } {
  const hourly = /\b(hour|hourly|\/\s*hr|an hour)\b/i.test(text);
  const numbers = [...text.replace(/,/g, "").matchAll(/\$?\s*(\d+(?:\.\d+)?)(k)?/gi)]
    .map((m) => {
      const n = Number.parseFloat(m[1]);
      return m[2] ? n * 1000 : n;
    })
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!numbers.length) return { min: null, max: null, hourly };
  return {
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    hourly,
  };
}

export function normalizeListingComp(
  listing: IcpLeadInput["listings"][number],
  config: IcpConfig = getIcpConfig(),
): { annualMin: number | null; annualMax: number | null } {
  const factor = config.thresholds.hourly_annualize_factor;
  let min = listing.salaryMin ?? null;
  let max = listing.salaryMax ?? null;
  let hourlyHint = false;

  if (min == null && max == null && listing.salaryText) {
    const parsed = parseSalaryText(listing.salaryText);
    min = parsed.min;
    max = parsed.max;
    hourlyHint = parsed.hourly;
  } else if (listing.salaryText) {
    hourlyHint = /\b(hour|hourly|\/\s*hr|an hour)\b/i.test(listing.salaryText);
  }

  // Values below a plausible annual floor are hourly rates.
  const looksHourly = (v: number | null) => v != null && v > 0 && v < 1000;
  if (hourlyHint || (looksHourly(min) && looksHourly(max ?? min))) {
    min = min != null ? Math.round(min * factor) : null;
    max = max != null ? Math.round(max * factor) : null;
  }
  return { annualMin: min, annualMax: max };
}

function resolveComp(
  listings: IcpLeadInput["listings"],
  config: IcpConfig,
): CompResult {
  // Prefer the best (highest-max) listing-provided comp.
  let best: { annualMin: number | null; annualMax: number | null } | null = null;
  for (const listing of listings) {
    const normalized = normalizeListingComp(listing, config);
    if (normalized.annualMin == null && normalized.annualMax == null) continue;
    const bestMax = best?.annualMax ?? best?.annualMin ?? -1;
    const thisMax = normalized.annualMax ?? normalized.annualMin ?? -1;
    if (thisMax > bestMax) best = normalized;
  }

  if (best) {
    const top = best.annualMax ?? best.annualMin ?? 0;
    return {
      annualMin: best.annualMin,
      annualMax: best.annualMax,
      estimated: false,
      confidence: "high",
      belowMin: top > 0 && top < config.thresholds.comp_min_annual,
    };
  }

  // Missing — estimate from the config lookup table (never a gate).
  for (const listing of listings) {
    for (const row of config.comp_estimate_table) {
      if (new RegExp(row.title_pattern, "i").test(listing.title)) {
        return {
          annualMin: row.min,
          annualMax: row.max,
          estimated: true,
          confidence: row.confidence,
          belowMin: false, // estimates never trip the floor
        };
      }
    }
  }

  return {
    annualMin: null,
    annualMax: null,
    estimated: false,
    confidence: null,
    belowMin: false,
  };
}

/* ------------------------------------------------------------------ */
/* Scorer                                                               */
/* ------------------------------------------------------------------ */

export function scoreLeadIcp(
  lead: IcpLeadInput,
  config: IcpConfig = getIcpConfig(),
): IcpAnnotation {
  const { flags, score_weights: weights, thresholds } = config;
  const decisions: IcpDecision[] = [];
  const exclusionFlags: string[] = [];
  const exclusionConfidence: Record<string, number> = {};

  const addFlag = (flag: string, confidence: number, detail?: string) => {
    // Integrity by construction: a flag and its confidence are always written
    // together, so a missing confidence can never be misread as 0.
    if (!exclusionFlags.includes(flag)) exclusionFlags.push(flag);
    exclusionConfidence[flag] = clamp(confidence, 0, 1);
    decisions.push({
      company: lead.companyName,
      action: confidence >= 1 ? "flag" : "deprioritize",
      reason: flag,
      confidence: clamp(confidence, 0, 1),
      detail,
    });
  };

  const name = lead.companyName;
  const lists = config.known_lists;
  const patterns = config.patterns;

  /* 1 — name/keyword exclusions (deterministic = 1.0, patterns = 0.9). */
  if (matchesKnownList(name, lists.fortune_500)) {
    addFlag("fortune_500", 1.0, "exact known-list name");
  } else if (matchesKnownList(name, lists.fortune_1000)) {
    addFlag("fortune_1000", 1.0, "exact known-list name");
  }
  if (matchesKnownList(name, lists.known_large_private)) {
    addFlag("known_large_private", 1.0, "exact known-list name");
  }
  if (matchesKnownList(name, lists.national_retailers)) {
    addFlag("national_retailer", 1.0, "exact known-list name");
  }
  if (matchesKnownList(name, lists.known_staffing_agencies)) {
    addFlag("staffing_agency", 1.0, "exact known-agency name");
  }
  if (matchesKnownList(name, lists.known_large_hospitals)) {
    addFlag("large_hospital_system", 1.0, "exact known-list name");
  }
  if (lead.domain && /\.gov$/i.test(lead.domain.trim())) {
    addFlag("gov_domain", 1.0, lead.domain);
  }

  if (anyPatternMatches(name, patterns.gov_patterns)) {
    addFlag("public_sector", 0.9, "gov name pattern");
  }
  if (anyPatternMatches(name, patterns.school_patterns)) {
    addFlag("school", 0.9, "school name pattern");
  }
  if (anyPatternMatches(name, patterns.hospital_system_patterns)) {
    addFlag("hospital_system", 0.9, "hospital-system name pattern");
  }
  if (
    !exclusionFlags.includes("staffing_agency") &&
    anyPatternMatches(name, patterns.staffing_patterns)
  ) {
    // Pattern-based → soft; the posting company appears to BE an agency.
    addFlag("third_party_posting", 0.9, "staffing name pattern");
  }
  if (anyPatternMatches(name, patterns.large_company_name_hints)) {
    addFlag("large_company_hint", 0.6, "name hints large org");
  }

  /* 2 — role type (when-in-doubt-keep). */
  const role = classifyCompanyRole(lead.listings, config);
  if (
    role.confidence < thresholds.role_ambiguity_confidence &&
    role.roleType !== "unknown"
  ) {
    addFlag("role_ambiguous", role.confidence, `resolved to ${role.roleType}`);
  }

  /* 3 — compensation (soft floor; estimates never gate). */
  const comp = resolveComp(lead.listings, config);
  if (comp.belowMin && !comp.estimated) {
    addFlag("salary_below_min", 0.9, `top of range < $${thresholds.comp_min_annual}`);
  }

  /* 4 — company size (free proxy; enrich confirms later). */
  let sizeBand: CompanySizeBand = "unknown";
  const employees = lead.estimatedEmployees ?? null;
  if (employees != null && employees > 0) {
    if (employees <= thresholds.size_band_micro_max) sizeBand = "micro";
    else if (employees <= thresholds.size_band_small_max) sizeBand = "small";
    else if (employees <= thresholds.size_band_mid_max) sizeBand = "mid";
    else sizeBand = "large";
  } else if (
    exclusionFlags.some((f) =>
      ["fortune_500", "fortune_1000", "known_large_private", "large_hospital_system", "national_retailer"].includes(f),
    )
  ) {
    sizeBand = "large";
  }
  if (
    sizeBand === "large" &&
    employees != null &&
    employees > thresholds.size_band_exclude_above
  ) {
    addFlag("size_above_max", 0.95, `${employees} employees`);
  }

  const internalTa = lead.listings.some((l) =>
    anyPatternMatches(l.title, patterns.internal_ta_title_patterns),
  );
  if (internalTa) {
    addFlag("internal_ta_presence", 0.6, "TA/recruiting postings at company");
  }

  /* 5 — recruiter-fit composite (0–1, always annotated). */
  const inferredPrivate =
    !exclusionFlags.some((f) => ["fortune_500", "fortune_1000"].includes(f)) &&
    /\b(inc|llc|llp|lp|group|co|company|partners)\b/i.test(name);
  const sizeFit = sizeBand === "large" ? 0 : sizeBand === "unknown" ? 0.8 : 1;
  const roleFit =
    role.roleType === "unknown"
      ? 0.5
      : ["support", "hourly"].includes(role.roleType)
        ? 0
        : 1;
  const signals = lead.hiringSignals ?? {};
  const urgency = clamp(Object.keys(signals).length / 2, 0, 1);
  const taFit = internalTa ? 0.3 : 1;
  const privateFit = inferredPrivate ? 1 : 0.5;
  const fitWeights = weights.fit_weights;
  const likelyToUseRecruiter =
    Math.round(
      (privateFit * fitWeights.private +
        sizeFit * fitWeights.size +
        roleFit * fitWeights.role +
        urgency * fitWeights.urgency +
        taFit * fitWeights.ta) *
        100,
    ) / 100;

  /* 6 — the EXACT score structure (multiplier first, then additive terms). */
  const multiplier = flags.icp_multiplier_enabled
    ? weights.multiplier_base + weights.multiplier_span * likelyToUseRecruiter
    : 1;

  const roleTypeBonus =
    flags.role_type_scoring_enabled &&
    role.confidence >= thresholds.role_ambiguity_confidence
      ? weights.role_type_bonus[role.roleType]
      : 0;

  const privateBonus =
    flags.icp_multiplier_enabled && inferredPrivate ? weights.private_bonus : 0;

  const sizePenalty =
    flags.deprioritize_large_company_estimate && sizeBand === "large"
      ? weights.size_penalty_large
      : 0;

  let compAdjustment = 0;
  if (flags.comp_scoring_enabled && comp.belowMin && !comp.estimated) {
    compAdjustment += weights.comp_penalty_below_min;
  }
  if (flags.comp_estimate_enabled && comp.estimated && comp.annualMax != null) {
    // Estimates add color only — bounded ± comp_estimate_adjustment_max.
    const mid = ((comp.annualMin ?? comp.annualMax) + comp.annualMax) / 2;
    compAdjustment +=
      mid >= 100000
        ? weights.comp_estimate_adjustment_max
        : mid < thresholds.comp_min_annual
          ? -weights.comp_estimate_adjustment_max
          : 0;
  }

  let patternPenalty = 0;
  if (flags.deprioritize_gov_school_patterns) {
    if (
      exclusionFlags.includes("public_sector") ||
      exclusionFlags.includes("school")
    ) {
      patternPenalty += weights.pattern_deprioritize_penalty;
    }
  }
  if (flags.deprioritize_hospital_retail_patterns) {
    if (
      exclusionFlags.includes("hospital_system") ||
      exclusionFlags.includes("large_hospital_system") ||
      exclusionFlags.includes("national_retailer")
    ) {
      patternPenalty += weights.pattern_deprioritize_penalty;
    }
  }

  const icpAdjustedScore = Math.round(
    clamp(
      lead.baseLeadScore * multiplier +
        roleTypeBonus +
        privateBonus +
        sizePenalty +
        compAdjustment +
        patternPenalty,
      0,
      100,
    ),
  );

  if (!exclusionFlags.length) {
    decisions.push({
      company: lead.companyName,
      action: "none",
      reason: "no_flags",
      confidence: 1,
    });
  }

  return {
    companyId: lead.companyId,
    companyName: lead.companyName,
    baseLeadScore: lead.baseLeadScore,
    icpAdjustedScore,
    exclusionFlags,
    exclusionConfidence,
    roleType: role.roleType,
    roleTypeConfidence: role.confidence,
    compAnnualMin: comp.annualMin,
    compAnnualMax: comp.annualMax,
    compEstimatedFlag: comp.estimated,
    compConfidence: comp.confidence,
    companySizeBand: sizeBand,
    likelyToUseRecruiter,
    enrichmentTier: sizeBand === "unknown" ? "paid_needed" : "free",
    decisions,
  };
}

/** Pure batch API per the spec: icpScorer(leads) -> annotations. */
export function icpScorer(
  leads: IcpLeadInput[],
  config: IcpConfig = getIcpConfig(),
): IcpAnnotation[] {
  return leads.map((lead) => scoreLeadIcp(lead, config));
}

/**
 * Would the view hide this lead under the given toggles? Deterministic
 * (confidence >= 1.0) flags only — pattern flags can never hide a lead.
 * This is a view-layer helper; annotations themselves never hide anything.
 */
export function isHiddenByToggles(
  annotation: Pick<IcpAnnotation, "exclusionFlags" | "exclusionConfidence">,
  enabledToggles: Partial<Record<IcpFlagName, boolean>>,
): boolean {
  for (const [toggle, flagNames] of Object.entries(
    HARD_EXCLUDE_FLAGS_BY_TOGGLE,
  )) {
    if (!enabledToggles[toggle as IcpFlagName]) continue;
    for (const flag of flagNames ?? []) {
      if (
        annotation.exclusionFlags.includes(flag) &&
        (annotation.exclusionConfidence[flag] ?? 0) >= 1
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Integrity check (§7.7): every flag must carry a numeric 0–1 confidence.
 * A flag with a missing confidence is a bug — callers must reject it rather
 * than treat it as 0.
 */
export function validateAnnotationIntegrity(
  annotation: Pick<IcpAnnotation, "exclusionFlags" | "exclusionConfidence">,
): string[] {
  const problems: string[] = [];
  for (const flag of annotation.exclusionFlags) {
    const confidence = annotation.exclusionConfidence[flag];
    if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
      problems.push(`flag "${flag}" has no valid confidence`);
    }
  }
  for (const key of Object.keys(annotation.exclusionConfidence)) {
    if (!annotation.exclusionFlags.includes(key)) {
      problems.push(`confidence "${key}" has no matching flag`);
    }
  }
  return problems;
}
