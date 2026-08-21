import type { CompanyCardData } from "@/components/CompanyCard";
import type {
  Contact,
  HiringSignals,
  IcpStatus,
  JobListing,
} from "@/lib/db/schema";
import type { pipelineSettings } from "@/lib/db/schema";
import { employeeBandForVertical } from "@/lib/discovery/verticals";
import { jobLocationInFocus } from "@/lib/geo-focus";
import { signalScoreBonus } from "@/lib/hiring-signals";
import { icpDeprioritizeScore } from "@/lib/icp-filter";
import { isPersonalEmail } from "@/lib/phone-utils";
import { compareContactsForOutreach } from "@/lib/contact-title-priority";

export function contactIsCallable(contact: Contact): boolean {
  return Boolean(
    contact.personalPhone ||
      contact.phone ||
      (contact.phones ?? []).some((p) => p.number) ||
      contact.personalEmail ||
      contact.email ||
      contact.workEmail,
  );
}

export type LeadScoreBreakdown = {
  score: number;
  geoMismatch: boolean;
  geoVerifiedCount: number;
  callableCount: number;
  bestContactLabel: string | null;
};

/** Score from scraped data only — no contact enrichment required. */
export function scoreCompanyPreEnrich(input: {
  icpStatus: IcpStatus;
  hiringSignals: HiringSignals;
  domainConfidence: string;
  listings: Pick<JobListing, "location">[];
  geoSettings: typeof pipelineSettings.$inferSelect;
  hrOnlyDeprioritize: boolean;
  hasLinkedInPoster?: boolean;
}): number {
  const inFocusCount = input.listings.filter((l) =>
    jobLocationInFocus(l.location, input.geoSettings),
  ).length;

  let score = 20;
  if (inFocusCount > 0) score += 25;
  if (inFocusCount >= 2) score += 10;
  if (input.domainConfidence === "high") score += 8;
  score += signalScoreBonus(input.hiringSignals);
  score += icpDeprioritizeScore(input.icpStatus, input.hrOnlyDeprioritize);

  if (input.hasLinkedInPoster) score += 6;

  return Math.min(100, Math.max(0, score));
}

/**
 * Flags from the ICP scorer that mean "this is not a company the operator
 * wants" — the same deterministic and near-deterministic set the CRM hide
 * toggles use. Discovery deprioritises rather than deletes.
 */
const HARD_EXCLUSION_FLAGS = new Set([
  "fortune_500",
  "fortune_1000",
  "known_large_private",
  "national_retailer",
  "staffing_agency",
  "large_hospital_system",
  "gov_domain",
  "third_party_posting",
  "public_sector",
  "size_above_max",
]);

export type CompanyFirstScoreInput = {
  vertical: string | null;
  icpStatus: IcpStatus;
  estimatedEmployees: number | null;
  domainConfidence: string;
  hasPhone: boolean;
  hasLinkedIn: boolean;
  hiringSignals: HiringSignals;
  /** Active job listings matched to the company — a bonus, never a gate. */
  openPositions: number;
  exclusionFlags?: string[];
  /**
   * Whether the company's own data backs the search vertical. Only
   * "contradicted" changes the score: an off-target company must not outrank a
   * genuine one just because the search that found it said otherwise.
   */
  verticalEvidence?: "confirmed" | "unverified" | "contradicted";
};

/**
 * Ceiling on everything job activity can add to a company-first score.
 *
 * The operator's rule is that a company with no open roles is a full-value
 * prospect. The review queue orders by lead score, so a large hiring bonus is
 * an ordering penalty for every company that is not advertising — the +24 this
 * used to grant put hiring companies on page 1 and everyone else behind them.
 * Job activity stays a visible tiebreaker instead.
 */
const MAX_JOB_ACTIVITY_BONUS = 6;

/**
 * Company-first score — for companies that entered via discovery rather than a
 * job posting. Credits what discovery actually knows (size-band fit for the
 * vertical, vertical match, reachable phone, company LinkedIn, domain
 * confidence) and treats job activity as an ADDITIVE bonus.
 *
 * `scoreCompanyPreEnrich` is job-posting-shaped: with no listings it bottoms
 * out near 20, which would rank a qualified 12-person law firm below the
 * Fortune 500 postings the operator is trying to escape.
 */
export function scoreCompanyFirst(input: CompanyFirstScoreInput): number {
  let score = 30;

  const band = employeeBandForVertical(input.vertical);
  const employees = input.estimatedEmployees;
  if (employees == null) {
    // Apollo has no headcount for many small firms; unknown is not a demerit.
    score += 6;
  } else if (employees >= band.min && employees <= band.max) {
    score += 18;
  } else {
    score -= 10;
  }

  if (input.vertical) score += 10;
  if (input.hasPhone) score += 8;
  if (input.hasLinkedIn) score += 6;
  if (input.domainConfidence === "high") score += 8;

  let jobBonus = 0;
  if (input.openPositions > 0) jobBonus += 4;
  if (input.openPositions >= 3) jobBonus += 2;
  jobBonus += signalScoreBonus(input.hiringSignals);
  score += Math.min(jobBonus, MAX_JOB_ACTIVITY_BONUS);

  // The company's own name/industry says it is not in this vertical, so the
  // vertical credit above is not earned and the row needs to sink.
  if (input.verticalEvidence === "contradicted") score -= 22;

  const flags = input.exclusionFlags ?? [];
  if (flags.some((f) => HARD_EXCLUSION_FLAGS.has(f))) score -= 45;
  else if (flags.length) score -= 8;

  if (input.icpStatus === "fail") score -= 100;

  return Math.min(100, Math.max(0, score));
}

/** Add contact channel bonuses after enrichment. */
export function scoreCompanyPostEnrich(
  baseScore: number,
  contacts: Contact[],
): number {
  const callableContacts = contacts.filter(contactIsCallable);
  let score = baseScore;

  const geoVerifiedCount = contacts.filter((c) => c.locationMatched).length;
  if (geoVerifiedCount > 0) score += Math.min(geoVerifiedCount * 3, 9);

  const hasPhone = callableContacts.some((c) => c.personalPhone || c.phone);
  const hasPersonalEmail = callableContacts.some(
    (c) =>
      c.personalEmail || (c.email ? isPersonalEmail(c.email) : false),
  );
  const hasImessage = callableContacts.some((c) => c.imessageCapable === true);

  if (hasPhone) score += 15;
  if (hasPersonalEmail) score += 10;
  if (hasImessage) score += 5;
  score += Math.min(callableContacts.length * 2, 8);

  return Math.min(100, Math.max(0, score));
}

export function scoreLead(company: CompanyCardData): LeadScoreBreakdown {
  const contacts = company.contacts;
  const geoVerifiedCount = contacts.filter((c) => c.locationMatched).length;
  const geoMismatch = contacts.length > 0 && geoVerifiedCount === 0;
  const callableContacts = contacts.filter(contactIsCallable);

  const baseScore =
    company.leadScore ??
    scoreCompanyPostEnrich(
      scoreCompanyPreEnrich({
        icpStatus: company.icpStatus ?? "unknown",
        hiringSignals: (company.hiringSignals ?? {}) as HiringSignals,
        domainConfidence: company.domainConfidence,
        listings: company.jobListings,
        geoSettings: { geographicScope: "city" } as typeof pipelineSettings.$inferSelect,
        hrOnlyDeprioritize: false,
      }),
      contacts,
    );

  const score =
    contacts.length > 0
      ? scoreCompanyPostEnrich(baseScore, contacts)
      : baseScore;

  const ranked = [...contacts].sort((a, b) => {
    const titleCmp = compareContactsForOutreach(a, b);
    if (titleCmp !== 0) return titleCmp;
    const aCallable = contactIsCallable(a);
    const bCallable = contactIsCallable(b);
    if (aCallable !== bCallable) return aCallable ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const best = ranked[0];
  const bestContactLabel = best
    ? best.title
      ? `${best.name} · ${best.title}`
      : best.name
    : null;

  return {
    score,
    geoMismatch,
    geoVerifiedCount,
    callableCount: callableContacts.length,
    bestContactLabel,
  };
}

export function scoreTextClass(score: number): string {
  if (score >= 80) return "text-green-700 dark:text-green-400";
  if (score >= 60) return "text-amber-700 dark:text-amber-400";
  return "text-gray-600 dark:text-gray-400";
}

export function scoreBgClass(score: number): string {
  if (score >= 80) return "bg-green-50 dark:bg-green-950/50";
  if (score >= 60) return "bg-amber-50 dark:bg-amber-950/40";
  return "bg-gray-50 dark:bg-gray-900/50";
}

export function scoreRankColor(score: number): "green" | "amber" | "gray" {
  if (score >= 80) return "green";
  if (score >= 60) return "amber";
  return "gray";
}
