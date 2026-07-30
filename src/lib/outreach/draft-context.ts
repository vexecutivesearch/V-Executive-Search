import type { Company, Contact, JobListing } from "@/lib/db/schema";
import type { DraftContext } from "@/lib/outreach-draft";

const SENDER_NAME = process.env.OUTREACH_SENDER_NAME ?? "Alejandro O Delgado";
const SENDER_FIRM = process.env.OUTREACH_SENDER_FIRM ?? "Villatoro Executive Search";

function listingLine(l: JobListing): string {
  const parts = [l.title];
  if (l.location) parts.push(`location: ${l.location}`);
  if (l.salaryText) parts.push(`comp: ${l.salaryText}`);
  if (l.board && l.board !== "manual_seed") parts.push(`board: ${l.board}`);
  return parts.join(", ");
}

/**
 * Build LLM draft context. When `focusListing` is set (user picked a Job
 * Listings row / lead's primary posting), that role is the primary personalization
 * anchor; other company openings stay as supporting context.
 */
export function buildDraftContext(options: {
  contact: Contact;
  company: Company;
  listings: JobListing[];
  focusListing?: JobListing | null;
}): DraftContext {
  const { contact, company, listings, focusListing } = options;
  const primary = focusListing ?? listings[0] ?? null;
  const supporting = listings.filter((l) => !primary || l.id !== primary.id);

  const jobTitles = [
    ...(primary?.title ? [primary.title] : []),
    ...supporting.map((l) => l.title).filter(Boolean),
  ];
  const uniqueTitles = [...new Set(jobTitles)];

  const jobDetails = [
    ...(primary ? [`PRIMARY ROLE TO INQUIRE ABOUT: ${listingLine(primary)}`] : []),
    ...supporting.map((l) => listingLine(l)),
  ];

  return {
    contactName: contact.name || null,
    contactTitle: contact.title,
    companyName: company.name,
    industry: company.industry,
    estimatedEmployees: company.estimatedEmployees,
    jobTitles: uniqueTitles,
    jobDetails,
    jobLocation: primary?.location ?? listings[0]?.location ?? null,
    primaryJobTitle: primary?.title ?? null,
    primaryJobLocation: primary?.location ?? null,
    primaryJobSalary: primary?.salaryText ?? null,
    primaryJobBoard: primary?.board ?? null,
    focusListingId: primary?.id ?? null,
    relatedJobTitles: supporting.map((l) => l.title).filter(Boolean).slice(0, 6),
    hiringSignals: Object.entries(company.hiringSignals ?? {})
      .filter(([, v]) => v)
      .map(([k]) => k.replace(/_/g, " ")),
    reasonToCall: company.reasonToCall,
    market: company.sourceMarket,
    senderName: SENDER_NAME,
    senderFirm: SENDER_FIRM,
  };
}
