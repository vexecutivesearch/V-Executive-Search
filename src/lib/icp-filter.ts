import type { IcpStatus } from "@/lib/db/schema";
import type { JobListing } from "@/lib/db/schema";
import { employeeBandForVertical } from "@/lib/discovery/verticals";

const STAFFING_PATTERNS = [
  "staffing",
  "recruiting",
  "recruitment",
  "talent solutions",
  "talent acquisition",
  "headhunter",
  "executive search",
  "placement agency",
  "employment agency",
  "manpower",
  "randstad",
  "adecco",
  "kelly services",
  "robert half",
  "hays ",
  " hays",
  "kforce",
  "teksystems",
  "aerotek",
  "express employment",
  "spherion",
];

/** Known staffing brands — exact match only (avoid substring false positives). */
const STAFFING_BRAND_NAMES = new Set([
  "hays",
  "randstad",
  "adecco",
  "robert half",
  "kelly services",
  "manpower",
  "kforce",
  "aerotek",
  "teksystems",
]);

const HR_ONLY_TITLE_PATTERNS = [
  "hr director",
  "human resources",
  "talent acquisition",
  "recruiter",
  "people operations",
  "chief people",
  "vp people",
  "head of talent",
];

const EXEC_TITLE_PATTERNS = [
  "ceo",
  "president",
  "founder",
  "chief",
  "coo",
  "cfo",
  "cto",
  "owner",
  "managing partner",
];

/** Job-title placeholder companies from CSV import — not real employers. */
export function isListingPseudoCompany(companyName: string): boolean {
  return companyName.trim().startsWith("(Listing)");
}

export function isStaffingAgency(companyName: string): boolean {
  const lower = companyName.trim().toLowerCase();
  if (STAFFING_BRAND_NAMES.has(lower)) return true;
  return STAFFING_PATTERNS.some((p) => lower.includes(p));
}

export function hasHrOnlyListings(listings: Pick<JobListing, "title">[]): boolean {
  if (!listings.length) return false;
  const execCount = listings.filter((l) => {
    const t = (l.title ?? "").toLowerCase();
    return EXEC_TITLE_PATTERNS.some((p) => t.includes(p));
  }).length;
  if (execCount > 0) return false;
  return listings.every((l) => {
    const t = (l.title ?? "").toLowerCase();
    return HR_ONLY_TITLE_PATTERNS.some((p) => t.includes(p));
  });
}

/**
 * ICP fit — geo is handled separately via jobLocationInFocus / backlog filters.
 * Missing employee size must not auto-fail (domain backfill + rescore first).
 *
 * The employee band is vertical-aware: a 12-person law firm is on target for
 * Legal (10–500) but would fail the legacy 20–500 band, and `icp_status = fail`
 * is not cosmetic — it removes a company from the enrichment queue, outreach,
 * and the backlog. Companies with no vertical keep the 20–500 band so the
 * job-scrape path is unchanged.
 */
export function evaluateIcp(input: {
  companyName: string;
  estimatedEmployees?: number | null;
  listings?: Pick<JobListing, "title">[];
  vertical?: string | null;
}): IcpStatus {
  if (isStaffingAgency(input.companyName)) return "fail";

  const employees = input.estimatedEmployees;
  if (employees != null) {
    const band = employeeBandForVertical(input.vertical);
    if (employees < band.min || employees > band.max) return "fail";
    return "pass";
  }

  return "unknown";
}

export function icpDeprioritizeScore(
  icpStatus: IcpStatus,
  hasHrOnly: boolean,
): number {
  if (icpStatus === "fail") return -100;
  if (icpStatus === "unknown") return -8;
  if (hasHrOnly) return -12;
  return 0;
}
