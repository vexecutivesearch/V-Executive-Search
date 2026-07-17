/**
 * ICP config loader — flat, version-controlled JSON (same pattern as
 * industry-sectors.ts): lists and thresholds change without a deploy.
 * All feature flags default FALSE; the scorer skips disabled inputs.
 */

import rawConfig from "../../../config/icp-config.json";

export type IcpFlagName =
  | "exclude_fortune_lists"
  | "exclude_gov_domains"
  | "exclude_known_staffing_agencies"
  | "exclude_known_large_private"
  | "deprioritize_gov_school_patterns"
  | "deprioritize_hospital_retail_patterns"
  | "deprioritize_large_company_estimate"
  | "role_type_scoring_enabled"
  | "comp_scoring_enabled"
  | "comp_estimate_enabled"
  | "icp_multiplier_enabled";

export const ICP_FLAG_NAMES: IcpFlagName[] = [
  "exclude_fortune_lists",
  "exclude_gov_domains",
  "exclude_known_staffing_agencies",
  "exclude_known_large_private",
  "deprioritize_gov_school_patterns",
  "deprioritize_hospital_retail_patterns",
  "deprioritize_large_company_estimate",
  "role_type_scoring_enabled",
  "comp_scoring_enabled",
  "comp_estimate_enabled",
  "icp_multiplier_enabled",
];

export type IcpFlags = Record<IcpFlagName, boolean>;

export type RoleType =
  | "leadership"
  | "management"
  | "professional"
  | "specialized"
  | "support"
  | "hourly"
  | "unknown";

export type CompConfidence = "low" | "medium" | "high";
export type CompanySizeBand = "micro" | "small" | "mid" | "large" | "unknown";

export type CompEstimateRow = {
  title_pattern: string;
  min: number;
  max: number;
  confidence: CompConfidence;
};

export type IcpConfig = {
  flags: IcpFlags;
  score_weights: {
    role_type_bonus: Record<RoleType, number>;
    private_bonus: number;
    size_penalty_large: number;
    comp_penalty_below_min: number;
    comp_estimate_adjustment_max: number;
    pattern_deprioritize_penalty: number;
    multiplier_base: number;
    multiplier_span: number;
  };
  thresholds: {
    comp_min_annual: number;
    comp_min_hourly: number;
    hourly_annualize_factor: number;
    keep_confidence: number;
    role_ambiguity_confidence: number;
    size_band_micro_max: number;
    size_band_small_max: number;
    size_band_mid_max: number;
    size_band_exclude_above: number;
  };
  role_types: Record<
    Exclude<RoleType, "unknown">,
    { patterns: string[]; exclude_overrides: string[] }
  >;
  comp_estimate_table: CompEstimateRow[];
  known_lists: {
    fortune_500: string[];
    fortune_1000: string[];
    known_large_private: string[];
    national_retailers: string[];
    known_staffing_agencies: string[];
    known_large_hospitals: string[];
  };
  patterns: {
    gov_patterns: string[];
    school_patterns: string[];
    hospital_system_patterns: string[];
    staffing_patterns: string[];
    large_company_name_hints: string[];
    internal_ta_title_patterns: string[];
  };
};

const config = rawConfig as unknown as IcpConfig;

export function getIcpConfig(): IcpConfig {
  return config;
}

/** A copy with one flag flipped on — powers the shadow report's per-filter simulation. */
export function withFlag(
  base: IcpConfig,
  flag: IcpFlagName,
  value: boolean,
): IcpConfig {
  return { ...base, flags: { ...base.flags, [flag]: value } };
}
