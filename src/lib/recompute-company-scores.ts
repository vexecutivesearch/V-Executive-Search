import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, contacts, jobListings } from "@/lib/db/schema";
import { getGeoFocusSettings } from "@/lib/geo-focus";
import {
  evaluateIcp,
  hasHrOnlyListings,
} from "@/lib/icp-filter";
import {
  detectHiringSignals,
  reasonToCallFromSignals,
} from "@/lib/hiring-signals";
import { scoreCompanyPostEnrich, scoreCompanyPreEnrich } from "@/lib/lead-score";

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
      geoSettings,
    });

    const hrOnly = hasHrOnlyListings(listings);
    const signals = detectHiringSignals(listings, geoSettings);
    const reasonToCall = reasonToCallFromSignals(signals);

    const companyContacts = await db
      .select()
      .from(contacts)
      .where(eq(contacts.companyId, company.id));

    const preScore = scoreCompanyPreEnrich({
      icpStatus,
      hiringSignals: signals,
      domainConfidence: company.domainConfidence,
      listings,
      geoSettings,
      hrOnlyDeprioritize: hrOnly,
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
