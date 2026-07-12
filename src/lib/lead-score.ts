import type { CompanyCardData } from "@/components/CompanyCard";
import type {
  Contact,
  HiringSignals,
  IcpStatus,
  JobListing,
} from "@/lib/db/schema";
import type { pipelineSettings } from "@/lib/db/schema";
import { jobLocationInFocus } from "@/lib/geo-focus";
import { signalScoreBonus } from "@/lib/hiring-signals";
import { icpDeprioritizeScore } from "@/lib/icp-filter";
import { isPersonalEmail } from "@/lib/phone-utils";
import { compareContactsForOutreach } from "@/lib/contact-title-priority";

export function contactIsCallable(contact: Contact): boolean {
  return Boolean(
    contact.personalPhone ||
      contact.phone ||
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
