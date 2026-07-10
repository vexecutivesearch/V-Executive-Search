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
  sectorFromIndustry,
} from "@/lib/industry-sectors";

export type TodayFilterOptions = {
  /** Active market-scan profile names (scrape buckets — not contact titles). */
  jobTitles: string[];
  /** Broad sector buckets for filtering (raw industry stays on the company). */
  industries: string[];
  dataAvailability: FilterDataAvailability;
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
  for (const row of industryRows) {
    const sector = sectorFromIndustry(row.industry);
    if (sector) sectorsPresent.add(sector);
  }

  // Stable order from config; only include sectors that appear (plus Other if needed).
  const industries = allSectorFilterOptions().filter((s) =>
    sectorsPresent.has(s),
  );
  if (!industries.length && industryRows.length) {
    industries.push(OTHER_SECTOR);
  }

  return { jobTitles, industries, dataAvailability };
}
