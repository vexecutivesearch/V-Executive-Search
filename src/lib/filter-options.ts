import { and, isNotNull, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { getActiveSearchProfiles } from "@/lib/pipeline-config";
import {
  getFilterDataAvailability,
  type FilterDataAvailability,
} from "@/lib/filter-data-availability";
import {
  OTHER_SECTOR,
  allSectorFilterOptions,
  normalizeIndustryKey,
  sectorFromIndustry,
} from "@/lib/industry-sectors";

export type TodayFilterOptions = {
  /** Active market-scan profile names (scrape buckets — not contact titles). */
  jobTitles: string[];
  /** Broad sector buckets for filtering (raw industry stays on the company). */
  industries: string[];
  dataAvailability: FilterDataAvailability;
  /**
   * Distinct raw Apollo industries currently landing in Other.
   * Visible cue to extend industry-sectors.ts — never silently grow.
   */
  otherIndustryLabels: string[];
};

/** Distinct filter values — scrape buckets + sector rollups present in the DB. */
export async function getTodayFilterOptions(): Promise<TodayFilterOptions> {
  const [profiles, industryRows, dataAvailability] = await Promise.all([
    getActiveSearchProfiles(),
    db
      .selectDistinct({ industry: companies.industry })
      .from(companies)
      .where(and(isNotNull(companies.industry), ne(companies.industry, "")))
      .orderBy(companies.industry),
    getFilterDataAvailability(),
  ]);

  const jobTitles = [
    ...new Set(profiles.map((p) => p.name.trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));

  const sectorsPresent = new Set<string>();
  const otherByKey = new Map<string, string>();
  for (const row of industryRows) {
    const raw = row.industry?.trim();
    if (!raw) continue;
    const sector = sectorFromIndustry(raw);
    if (!sector) continue;
    sectorsPresent.add(sector);
    if (sector === OTHER_SECTOR) {
      const key = normalizeIndustryKey(raw);
      if (!otherByKey.has(key)) otherByKey.set(key, raw);
    }
  }

  const industries = allSectorFilterOptions().filter((s) =>
    sectorsPresent.has(s),
  );
  if (!industries.length && industryRows.length) {
    industries.push(OTHER_SECTOR);
  }

  const otherIndustryLabels = [...otherByKey.values()].sort((a, b) =>
    a.localeCompare(b),
  );

  return {
    jobTitles,
    industries,
    dataAvailability,
    otherIndustryLabels,
  };
}
