import { and, isNotNull, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, jobListings } from "@/lib/db/schema";
import { getActiveSearchProfiles } from "@/lib/pipeline-config";

export type TodayFilterOptions = {
  jobTitles: string[];
  industries: string[];
};

/** Distinct filter values from active backlog + search profiles. */
export async function getTodayFilterOptions(): Promise<TodayFilterOptions> {
  const [profiles, industryRows, searchRows] = await Promise.all([
    getActiveSearchProfiles(),
    db
      .selectDistinct({ industry: companies.industry })
      .from(companies)
      .where(and(isNotNull(companies.industry), ne(companies.industry, "")))
      .orderBy(companies.industry),
    db
      .selectDistinct({ searchName: jobListings.searchName })
      .from(jobListings)
      .where(and(isNotNull(jobListings.searchName), ne(jobListings.searchName, "")))
      .orderBy(jobListings.searchName),
  ]);

  const profileNames = profiles.map((p) => p.name);
  const fromListings = searchRows
    .map((r) => r.searchName?.split(" — ")[0]?.trim())
    .filter(Boolean) as string[];

  const jobTitles = [
    ...new Set([...profileNames, ...fromListings].map((s) => s.trim())),
  ].sort();

  const industries = industryRows
    .map((r) => r.industry?.trim())
    .filter(Boolean) as string[];

  return { jobTitles, industries };
}
