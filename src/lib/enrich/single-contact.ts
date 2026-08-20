/**
 * Single decision-maker enrichment — the paid step of company-first discovery.
 *
 * Discovery is free (Apollo People Search is 0 credits) and is what finds the
 * candidates. This module spends the reveal credit on exactly ONE contact: the
 * top-ranked decision-maker for the company's vertical. It then stops. A second
 * contact only happens when the operator explicitly asks for one, which is what
 * `allowAdditional` is for.
 *
 * Phone is an explicit opt-in here, NOT the picker's default-on behaviour: an
 * Apollo fallback mobile is 9 credits against 1 for an email, and the whole
 * point of this flow is one cheap, verified way to reach one person.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, contacts } from "@/lib/db/schema";
import { verifyContactEmail } from "@/lib/email-verify";
import { titlePriorityRank } from "@/lib/enrich/contact-targets";
import {
  discoverCompanyContacts,
  getCachedCandidates,
  revealSelectedContacts,
  type DiscoveryCandidate,
} from "@/lib/enrich/discovery";
import { verticalTitleRank } from "@/lib/discovery/verticals";
import type { PaidEgressContext } from "@/lib/paid-egress";

export type RankableCandidate = Pick<
  DiscoveryCandidate,
  | "contactId"
  | "name"
  | "title"
  | "revealStatus"
  | "locationMatched"
  | "priorityRank"
  | "hasEmail"
  | "hasPhone"
>;

function alreadyRevealed(candidate: RankableCandidate): boolean {
  return candidate.revealStatus === "revealed" || candidate.hasEmail;
}

/**
 * The ONE contact worth paying for: highest-priority title for the vertical
 * (falling back to the sector ranking discovery already computed), in-market
 * first, and never a contact whose email was already paid for.
 */
export function pickSingleDecisionMaker(
  candidates: RankableCandidate[],
  vertical: string | null,
): RankableCandidate | null {
  const unrevealed = candidates.filter((c) => !alreadyRevealed(c));
  if (!unrevealed.length) return null;

  const rank = (candidate: RankableCandidate): number => {
    const byVertical = vertical
      ? verticalTitleRank(candidate.title, vertical)
      : 900;
    // The vertical list is the operator's own priority order; the sector
    // ranking is the fallback for titles it does not name.
    return byVertical < 900 ? byVertical : 100 + candidate.priorityRank;
  };

  return [...unrevealed].sort((a, b) => {
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    if (a.locationMatched !== b.locationMatched) return a.locationMatched ? -1 : 1;
    return a.name.localeCompare(b.name);
  })[0];
}

export type SingleContactResult = {
  companyId: string;
  contact: {
    id: string;
    name: string;
    title: string | null;
    email: string | null;
    phone: string | null;
    linkedinUrl: string | null;
  } | null;
  revealed: number;
  candidatesFound: number;
  alreadyRevealedCount: number;
  phoneRequested: boolean;
  emailDeliverable: boolean | null;
  emailVerifyReason: string | null;
  searchesSpent: number;
  contactOutError: string | null;
  message: string;
};

export async function revealSingleDecisionMaker(options: {
  companyId: string;
  apiKey: string;
  contactOutApiKey?: string;
  contactOutAvailable?: boolean;
  /** Explicit opt-in — an Apollo fallback mobile costs 9 credits vs 1. */
  includePhone?: boolean;
  /** "Find Additional Contact": reveal one more on top of what exists. */
  allowAdditional?: boolean;
  context: PaidEgressContext;
}): Promise<SingleContactResult> {
  const {
    companyId,
    apiKey,
    contactOutApiKey,
    contactOutAvailable = false,
    includePhone = false,
    allowAdditional = false,
    context,
  } = options;

  const [company] = await db
    .select({ vertical: companies.vertical })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!company) throw new Error("Company not found");

  const discovery =
    (await getCachedCandidates(companyId)) ??
    (await discoverCompanyContacts({ companyId, apiKey, context }));

  const revealedAlready = discovery.candidates.filter(alreadyRevealed).length;
  if (revealedAlready > 0 && !allowAdditional) {
    return {
      companyId,
      contact: null,
      revealed: 0,
      candidatesFound: discovery.candidates.length,
      alreadyRevealedCount: revealedAlready,
      phoneRequested: false,
      emailDeliverable: null,
      emailVerifyReason: null,
      searchesSpent: discovery.searchesSpent,
      contactOutError: null,
      message:
        "A decision-maker is already revealed for this company — no credits spent. " +
        "Use Find Additional Contact to reveal one more.",
    };
  }

  const target = pickSingleDecisionMaker(discovery.candidates, company.vertical);
  if (!target) {
    return {
      companyId,
      contact: null,
      revealed: 0,
      candidatesFound: discovery.candidates.length,
      alreadyRevealedCount: revealedAlready,
      phoneRequested: false,
      emailDeliverable: null,
      emailVerifyReason: null,
      searchesSpent: discovery.searchesSpent,
      contactOutError: null,
      message: discovery.candidates.length
        ? "Every candidate at this company is already revealed — no credits spent."
        : "No decision-maker candidates found for this company.",
    };
  }

  const reveal = await revealSelectedContacts({
    companyId,
    selections: [
      {
        contactId: target.contactId,
        channels: includePhone ? "email_phone" : "email",
      },
    ],
    apiKey,
    contactOutApiKey,
    contactOutAvailable,
    context,
  });

  const [saved] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, target.contactId))
    .limit(1);

  let emailDeliverable: boolean | null = null;
  let emailVerifyReason: string | null = null;
  if (saved) {
    const verification = await verifyContactEmail(saved);
    if (verification) {
      emailDeliverable = verification.deliverable;
      emailVerifyReason = verification.reason;
      await db
        .update(contacts)
        .set({
          emailDeliverable: verification.deliverable,
          emailVerifiedAt: new Date(),
        })
        .where(eq(contacts.id, target.contactId));
    }
  }

  const parts: string[] = [];
  if (reveal.revealed > 0) {
    parts.push(
      `Revealed 1 decision-maker: ${saved?.name ?? target.name}` +
        (saved?.title ? ` · ${saved.title}` : ""),
    );
    parts.push(
      emailDeliverable === true
        ? "email verified"
        : emailDeliverable === false
          ? `email unverified (${emailVerifyReason})`
          : "no email found",
    );
    parts.push(
      includePhone
        ? reveal.phonesFound > 0
          ? "phone found"
          : reveal.phonesPending > 0
            ? "phone still loading from Apollo"
            : "no phone found"
        : "phone not requested (opt-in)",
    );
    parts.push("Stopped at one contact — use Find Additional Contact for more.");
  } else if (reveal.skippedAlreadyRevealed > 0) {
    parts.push("Already revealed — no credits spent.");
  } else {
    parts.push("No contact data found for the top-ranked decision-maker.");
  }
  if (reveal.contactOutError) parts.push(reveal.contactOutError);

  return {
    companyId,
    contact: saved
      ? {
          id: saved.id,
          name: saved.name,
          title: saved.title,
          email: saved.workEmail ?? saved.email ?? saved.personalEmail,
          phone: saved.personalPhone ?? saved.phone,
          linkedinUrl: saved.linkedinUrl,
        }
      : null,
    revealed: reveal.revealed,
    candidatesFound: discovery.candidates.length,
    alreadyRevealedCount: revealedAlready,
    phoneRequested: includePhone,
    emailDeliverable,
    emailVerifyReason,
    searchesSpent: discovery.searchesSpent,
    contactOutError: reveal.contactOutError,
    message: parts.join(" · "),
  };
}

/** Re-exported so the picker and this flow rank titles the same way. */
export { titlePriorityRank };
