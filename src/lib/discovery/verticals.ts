/**
 * Vertical config for company-first discovery — pure config access, no DB and
 * no network. One vertical drives the Apollo organization-search filters, the
 * ICP employee band, and the decision-maker title priority.
 *
 * The mechanism is vertical-agnostic: a fifth vertical is config only.
 */

import rawConfig from "../../../config/contact-targets.json";

export type VerticalConfig = {
  label: string;
  /** Existing contact_targets sector to reuse for candidate ranking. */
  contact_sector?: string;
  employee_min: number;
  employee_max: number;
  apollo_keyword_tags: string[];
  decision_maker_titles: string[];
};

type DiscoveryConfigShape = {
  verticals: Record<string, VerticalConfig>;
  discovery_markets: string[];
  discovery_run_defaults: {
    companies_per_run: number;
    include_unknown_size: boolean;
  };
};

const config = rawConfig as unknown as DiscoveryConfigShape;

export type EmployeeBand = { min: number; max: number };

/** Band applied to companies with no vertical — the job-scrape default. */
export const DEFAULT_EMPLOYEE_BAND: EmployeeBand = { min: 20, max: 500 };

export function verticalIds(): string[] {
  return Object.keys(config.verticals);
}

export function isVerticalId(value: unknown): value is string {
  return typeof value === "string" && value in config.verticals;
}

export function getVerticalConfig(
  vertical: string | null | undefined,
): VerticalConfig | null {
  if (!vertical) return null;
  return config.verticals[vertical] ?? null;
}

export function listVerticals(): Array<{ id: string; config: VerticalConfig }> {
  return verticalIds().map((id) => ({ id, config: config.verticals[id] }));
}

/**
 * Employee band for a vertical, falling back to the legacy 20–500 band so
 * companies that arrived through the job scrape keep their existing ICP result.
 */
export function employeeBandForVertical(
  vertical: string | null | undefined,
): EmployeeBand {
  const target = getVerticalConfig(vertical);
  if (!target) return DEFAULT_EMPLOYEE_BAND;
  return { min: target.employee_min, max: target.employee_max };
}

/** Apollo `organization_num_employees_ranges` entry, e.g. "10,500". */
export function apolloEmployeeRange(vertical: string | null | undefined): string {
  const band = employeeBandForVertical(vertical);
  return `${band.min},${band.max}`;
}

export function keywordTagsForVertical(
  vertical: string | null | undefined,
): string[] {
  return getVerticalConfig(vertical)?.apollo_keyword_tags ?? [];
}

/** Decision-maker titles in priority order (index 0 = most wanted). */
export function decisionMakerTitles(
  vertical: string | null | undefined,
): string[] {
  return getVerticalConfig(vertical)?.decision_maker_titles ?? [];
}

/** Lower is better; titles outside the list rank last. */
export function verticalTitleRank(
  title: string | null | undefined,
  vertical: string | null | undefined,
): number {
  const titles = decisionMakerTitles(vertical);
  const normalized = (title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized || !titles.length) return 900;
  for (let i = 0; i < titles.length; i += 1) {
    if (normalized.includes(titles[i].toLowerCase())) return i;
  }
  return 900;
}

export function discoveryMarkets(): string[] {
  return [...config.discovery_markets];
}

export function discoveryRunDefaults(): {
  companiesPerRun: number;
  includeUnknownSize: boolean;
} {
  return {
    companiesPerRun: config.discovery_run_defaults.companies_per_run,
    includeUnknownSize: config.discovery_run_defaults.include_unknown_size,
  };
}
