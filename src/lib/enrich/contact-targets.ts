/**
 * Sector-aware contact targeting (Feature 2) — decides WHICH titles discovery
 * searches and how the picker ranks candidates. Pure helpers; no network, no DB.
 *
 * Allowlist semantics: discovery searches ONLY the active priority titles.
 * Titles not on the list (litigation chairs, practice-group leaders, extra
 * partners) are never searched, so they're never paid for.
 */

import rawConfig from "../../../config/contact-targets.json";

export type SizeBand = "small" | "large" | "unknown";

export type SectorTargetConfig = {
  detect_sector?: string;
  detect_name_strong?: string[];
  detect_name_weak?: string[];
  detect_industry_keywords?: string[];
  on_uncertain?: string;
  broad_search?: boolean;
  size_small_max: number;
  unknown_size: "union" | "small" | "large";
  priority_small: string[];
  priority_large: string[];
  empty_fallback: string[];
};

export type ContactTargetsConfig = {
  contact_targets: Record<string, SectorTargetConfig> & {
    default: SectorTargetConfig;
  };
  discovery: {
    max_candidates: number;
    search_per_page: number;
  };
};

const config = rawConfig as unknown as ContactTargetsConfig;

export function getContactTargetsConfig(): ContactTargetsConfig {
  return config;
}

function norm(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Legal detection — STRONG signals only:
 * sector/industry says legal, OR a strong name pattern (LLP, PLLC,
 * "Attorneys at Law", "Law Firm"…). Weak patterns ("& Associates", "Group",
 * "Partners") only count when combined with another legal signal.
 * Uncertain → generic ranking, never legal targeting.
 */
export function detectSector(
  companyName: string,
  industry: string | null | undefined,
  cfg: ContactTargetsConfig = config,
): string {
  const name = norm(companyName);
  const rawIndustry = norm(industry ?? "");

  for (const [sector, target] of Object.entries(cfg.contact_targets)) {
    if (sector === "default") continue;

    const industryMatch = (target.detect_industry_keywords ?? []).some(
      (k) => rawIndustry === norm(k) || rawIndustry.includes(norm(k)),
    );
    const strongName = (target.detect_name_strong ?? []).some((p) =>
      name.includes(norm(p)),
    );
    const weakName = (target.detect_name_weak ?? []).some((p) =>
      name.includes(norm(p)),
    );

    // Strong alone qualifies; weak needs a second legal signal.
    if (industryMatch || strongName || (weakName && industryMatch)) {
      return sector;
    }
  }
  return "default";
}

/** Firm size band from ICP band or headcount; unknown stays unknown. */
export function resolveSizeBand(
  estimatedEmployees: number | null | undefined,
  icpSizeBand: string | null | undefined,
  target: SectorTargetConfig,
): SizeBand {
  if (estimatedEmployees != null && estimatedEmployees > 0) {
    return estimatedEmployees <= target.size_small_max ? "small" : "large";
  }
  if (icpSizeBand === "micro" || icpSizeBand === "small") return "small";
  if (icpSizeBand === "mid" || icpSizeBand === "large") return "large";
  return "unknown";
}

/** Split "Founder|Named Partner" config entries into searchable titles. */
function expandTitles(priorities: string[]): string[] {
  return priorities.flatMap((entry) => entry.split("|").map((t) => t.trim()));
}

/**
 * The titles discovery searches — the allowlist.
 * Unknown size → UNION of both lists in ONE pass (deduped), so a wrong band
 * guess never costs a second search credit.
 */
export function titlesForDiscovery(
  sector: string,
  sizeBand: SizeBand,
  cfg: ContactTargetsConfig = config,
): { titles: string[]; usedUnion: boolean } {
  const target = cfg.contact_targets[sector] ?? cfg.contact_targets.default;
  if (sizeBand === "small") {
    return { titles: dedupe(expandTitles(target.priority_small)), usedUnion: false };
  }
  if (sizeBand === "large") {
    return { titles: dedupe(expandTitles(target.priority_large)), usedUnion: false };
  }
  return {
    titles: dedupe([
      ...expandTitles(target.priority_small),
      ...expandTitles(target.priority_large),
    ]),
    usedUnion: true,
  };
}

export function fallbackTitles(
  sector: string,
  cfg: ContactTargetsConfig = config,
): string[] {
  const target = cfg.contact_targets[sector] ?? cfg.contact_targets.default;
  return dedupe(target.empty_fallback);
}

function dedupe(titles: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const title of titles) {
    const key = norm(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(title);
  }
  return out;
}

/**
 * Rank a candidate title against the active priority order — lower is better.
 * Once size is known, rank by that band; unknown ranks against the union in
 * priority order (small list first for sector defaults).
 */
export function titlePriorityRank(
  title: string | null | undefined,
  sector: string,
  sizeBand: SizeBand,
  cfg: ContactTargetsConfig = config,
): number {
  const target = cfg.contact_targets[sector] ?? cfg.contact_targets.default;
  const t = norm(title ?? "");
  if (!t) return 900;

  const lists =
    sizeBand === "small"
      ? [target.priority_small]
      : sizeBand === "large"
        ? [target.priority_large]
        : [target.priority_small, target.priority_large];

  let offset = 0;
  for (const list of lists) {
    for (let i = 0; i < list.length; i += 1) {
      const variants = list[i].split("|").map(norm);
      if (variants.some((v) => t.includes(v))) return offset + i;
    }
    offset += list.length;
  }

  // Fallback titles rank after all priorities.
  const fallback = target.empty_fallback.map(norm);
  const fbIndex = fallback.findIndex((v) => t.includes(v));
  if (fbIndex >= 0) return 100 + fbIndex;
  return 900;
}
