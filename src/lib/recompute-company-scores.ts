import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, companyIcp, contacts, jobListings } from "@/lib/db/schema";
import { verticalEvidence } from "@/lib/discovery/vertical-evidence";
import { getGeoFocusSettings, jobLocationInFocus } from "@/lib/geo-focus";
import {
  evaluateIcp,
  hasHrOnlyListings,
  isStaffingAgency,
} from "@/lib/icp-filter";
import {
  detectHiringSignals,
  reasonToCallFromSignals,
} from "@/lib/hiring-signals";
import {
  scoreCompanyFirst,
  scoreCompanyPostEnrich,
  scoreCompanyPreEnrich,
} from "@/lib/lead-score";

export async function recomputeCompanyScores(
  companyIds?: string[],
): Promise<{ scored: number; icpMatch: number }> {
  const geoSettings = await getGeoFocusSettings();

  const companyRows = companyIds?.length
    ? await db
        .select()
        .from(companies)
        .where(inArray(companies.id, companyIds))
    : await db.select().from(companies).where(eq(companies.status, "new"));

  // Only the company-first path reads exclusion flags, so this is scoped to
  // companies that carry a vertical.
  const discoveredIds = companyRows.filter((c) => c.vertical).map((c) => c.id);
  const flagRows = discoveredIds.length
    ? await db
        .select({
          companyId: companyIcp.companyId,
          flags: companyIcp.exclusionFlags,
        })
        .from(companyIcp)
        .where(inArray(companyIcp.companyId, discoveredIds))
    : [];
  const flagsByCompany = new Map(
    flagRows.map((row) => [row.companyId, row.flags ?? []]),
  );

  let icpMatch = 0;

  for (const company of companyRows) {
    const listings = await db
      .select()
      .from(jobListings)
      .where(eq(jobListings.companyId, company.id));

    const icpStatus = evaluateIcp({
      companyName: company.name,
      estimatedEmployees: company.estimatedEmployees,
      listings,
      vertical: company.vertical,
    });

    const hrOnly = hasHrOnlyListings(listings);
    const signals = detectHiringSignals(listings, geoSettings, company.firstSeen);
    let reasonToCall = reasonToCallFromSignals(signals);

    const companyContacts = await db
      .select()
      .from(contacts)
      .where(eq(contacts.companyId, company.id));

    const posterContact = companyContacts.find(
      (c) => c.sourceProvider === "linkedin_poster",
    );
    const inFocusListings = listings.filter((l) =>
      jobLocationInFocus(l.location, geoSettings),
    );
    if (
      posterContact &&
      inFocusListings.length > 0 &&
      !isStaffingAgency(company.name)
    ) {
      const posterLabel = posterContact.title
        ? `${posterContact.name} (${posterContact.title})`
        : posterContact.name;
      const posterReason = `LinkedIn job poster — ${posterLabel}`;
      reasonToCall = reasonToCall
        ? `${posterReason} · ${reasonToCall}`
        : posterReason;
    }

    // Discovered companies are scored company-first: with no job posting the
    // job-shaped path bottoms out near 20 and buries them under scraped noise.
    const preScore = company.vertical
      ? scoreCompanyFirst({
          vertical: company.vertical,
          icpStatus,
          estimatedEmployees: company.estimatedEmployees,
          domainConfidence: company.domainConfidence,
          hasPhone: Boolean(company.phone),
          hasLinkedIn: Boolean(company.linkedinUrl),
          hiringSignals: signals,
          openPositions: listings.filter((l) => !l.archivedAt).length,
          exclusionFlags: flagsByCompany.get(company.id) ?? [],
          verticalEvidence: verticalEvidence({
            vertical: company.vertical,
            name: company.name,
            industry: company.industry,
          }).status,
        })
      : scoreCompanyPreEnrich({
          icpStatus,
          hiringSignals: signals,
          domainConfidence: company.domainConfidence,
          listings,
          geoSettings,
          hrOnlyDeprioritize: hrOnly,
          hasLinkedInPoster: companyContacts.some(
            (c) => c.sourceProvider === "linkedin_poster",
          ),
        });

    const leadScore =
      companyContacts.length > 0
        ? scoreCompanyPostEnrich(preScore, companyContacts)
        : preScore;

    if (icpStatus === "pass" || icpStatus === "unknown") icpMatch += 1;

    await db
      .update(companies)
      .set({
        leadScore,
        hiringSignals: signals,
        reasonToCall,
        icpStatus,
        updatedAt: new Date(),
      })
      .where(eq(companies.id, company.id));
  }

  return { scored: companyRows.length, icpMatch };
}
