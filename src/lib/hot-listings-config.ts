/**
 * Tunable knobs for Hot Listings (display view only — does not affect scrape scope).
 * Env overrides: HOT_MIN_EMPLOYEES, HOT_MAX_EMPLOYEES, HOT_EMAIL_LIMIT.
 */

import type { IndustrySector } from "@/lib/industry-sectors";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Mid-size company band — hard criterion for Hot Listings. */
export function hotMinEmployees(): number {
  return envInt("HOT_MIN_EMPLOYEES", 50);
}

export function hotMaxEmployees(): number {
  return envInt("HOT_MAX_EMPLOYEES", 500);
}

/** Top-N hot listings in the daily email. */
export function hotEmailLimit(): number {
  return envInt("HOT_EMAIL_LIMIT", 15);
}

/**
 * Low-value sectors to exclude ("no Crumbl Cookie").
 * Tunable — keep in sync with INDUSTRY_SECTORS labels.
 */
export const HOT_EXCLUDED_SECTORS: readonly IndustrySector[] = [
  "Retail & Consumer Goods",
  "Hospitality, Travel & Media",
];

/** Also drop staffing agencies / recruiting competitors. */
export const HOT_EXCLUDE_STAFFING = true;
