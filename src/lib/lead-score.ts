import type { CompanyCardData } from "@/components/CompanyCard";
import type { Contact } from "@/lib/db/schema";
import { isPersonalEmail } from "@/lib/phone-utils";

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

export function scoreLead(company: CompanyCardData): LeadScoreBreakdown {
  const contacts = company.contacts;
  const geoVerifiedCount = contacts.filter((c) => c.locationMatched).length;
  const geoMismatch = contacts.length > 0 && geoVerifiedCount === 0;
  const callableContacts = contacts.filter(contactIsCallable);

  let score = 0;

  if (geoVerifiedCount > 0) {
    score += 35 + Math.min(geoVerifiedCount * 5, 15);
  } else if (contacts.length === 0) {
    score += 12;
  } else {
    score += 5;
  }

  const hasPhone = callableContacts.some((c) => c.personalPhone || c.phone);
  const hasPersonalEmail = callableContacts.some(
    (c) =>
      c.personalEmail || (c.email ? isPersonalEmail(c.email) : false),
  );
  if (hasPhone) score += 25;
  if (hasPersonalEmail) score += 15;
  else if (callableContacts.some((c) => c.email || c.workEmail)) score += 8;

  score += Math.min(callableContacts.length * 4, 12);

  if (company.domain && company.domainConfidence !== "low") score += 8;

  score = Math.min(100, Math.max(0, score));

  const ranked = [...contacts].sort((a, b) => {
    if (a.locationMatched !== b.locationMatched) {
      return a.locationMatched ? -1 : 1;
    }
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
  if (score >= 60) return "text-green-700 dark:text-green-400";
  if (score >= 40) return "text-amber-700 dark:text-amber-400";
  return "text-red-700 dark:text-red-400";
}

export function scoreBgClass(score: number): string {
  if (score >= 60) return "bg-green-50 dark:bg-green-950/50";
  if (score >= 40) return "bg-amber-50 dark:bg-amber-950/40";
  return "bg-red-50 dark:bg-red-950/40";
}
