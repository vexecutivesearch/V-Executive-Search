import { and, isNotNull, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { getActiveSearchProfiles } from "@/lib/pipeline-config";
import {
  getFilterDataAvailability,
  type FilterDataAvailability,
} from "@/lib/filter-data-availability";

export type TodayFilterOptions = {
  /** Active search profile names only (never polluted location fragments). */
  jobTitles: string[];
  industries: string[];
  dataAvailability: FilterDataAvailability;
};

/** Distinct filter values — titles from search profiles; industries from DB. */
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

  const industries = industryRows
    .map((r) => r.industry?.trim())
    .filter(Boolean) as string[];

  return { jobTitles, industries, dataAvailability };
}
