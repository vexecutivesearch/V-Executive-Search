import { and, count, desc, eq, ilike, inArray, isNull, ne, not, or } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  contacts,
  dailyRuns,
  jobListings,
  companyActivities,
  CompanyStatus,
} from "@/lib/db/schema";
import { CompanyCardData } from "@/components/CompanyCard";
import { firstSeenDatesForListQuery, businessListDate } from "@/lib/timezone";
import { applySharedLineFilter } from "@/lib/contact-phones";
import { focusGeoLabel, getGeoFocusSettings, jobLocationInFocus } from "@/lib/geo-focus";
import type { Contact } from "@/lib/db/schema";

function hasCallableContact(contact: Contact): boolean {
  return Boolean(
    contact.personalPhone ||
      contact.phone ||
      contact.personalEmail ||
      contact.email ||
      contact.workEmail,
  );
}

/** Today's enriched call sheet — top-N JIT leads with callable contacts. */
export async function getCallSheetCompanies(
  listDateParam?: string,
): Promise<CompanyCardData[]> {
  const listDate = listDateParam ?? businessListDate();
  const geoSettings = await getGeoFocusSettings();

  const companiesRows = await db
    .select()
    .from(companies)
    .where(
      and(
        eq(companies.status, "new"),
        eq(companies.enrichRunDate, listDate),
        not(ilike(companies.name, "(Listing)%")),
      ),
    )
    .orderBy(desc(companies.leadScore), desc(companies.updatedAt));

  const enriched = await enrichCompanies(companiesRows, geoSettings);
  return enriched
    .filter(
      (c) =>
        c.jobListings.length > 0 && c.contacts.some(hasCallableContact),
    )
    .sort((a, b) => (b.leadScore ?? 0) - (a.leadScore ?? 0));
}

/** Ranked backlog — scraped in-focus companies awaiting enrichment. */
export async function getBacklogCompanies(): Promise<CompanyCardData[]> {
  const geoSettings = await getGeoFocusSettings();

  const companiesRows = await db
    .select()
    .from(companies)
    .where(
      and(
        eq(companies.status, "new"),
        ne(companies.icpStatus, "fail"),
        not(ilike(companies.name, "(Listing)%")),
      ),
    )
    .orderBy(desc(companies.leadScore), desc(companies.updatedAt))
    .limit(200);

  const enriched = await enrichCompanies(companiesRows, geoSettings);
  return enriched
    .filter(
      (c) =>
        c.jobListings.length > 0 && !c.contacts.some(hasCallableContact),
    )
    .sort((a, b) => (b.leadScore ?? 0) - (a.leadScore ?? 0));
}

/** @deprecated Use getCallSheetCompanies — kept for compatibility. */
export async function getDailyListCompanies(
  listDateParam?: string,
): Promise<CompanyCardData[]> {
  const callSheet = await getCallSheetCompanies(listDateParam);
  if (callSheet.length > 0) return callSheet;
  return getBacklogCompanies();
}

/** @deprecated Use getDailyListCompanies — kept for callers expecting callable-only. */
export async function getTodayCompanies(): Promise<CompanyCardData[]> {
  const all = await getDailyListCompanies();
  return all.filter((c) => c.contacts.some(hasCallableContact));
}

export function countCallableCompanies(companies: CompanyCardData[]): number {
  return companies.filter((c) => c.contacts.some(hasCallableContact)).length;
}

export async function getTodayGeoLabel(): Promise<string> {
  const settings = await getGeoFocusSettings();
  return focusGeoLabel(settings);
}

export async function getInFocusJobListings() {
  const settings = await getGeoFocusSettings();

  const rows = await db
    .select({
      listing: jobListings,
      company: companies,
    })
    .from(jobListings)
    .innerJoin(companies, eq(jobListings.companyId, companies.id))
    .orderBy(desc(jobListings.postedAt), desc(jobListings.createdAt));

  const contactCounts = await db
    .select({ companyId: contacts.companyId, count: count() })
    .from(contacts)
    .groupBy(contacts.companyId);

  const contactCountMap = new Map(
    contactCounts.map((row) => [row.companyId, Number(row.count)]),
  );

  return rows
    .filter(({ listing }) => jobLocationInFocus(listing.location, settings))
    .map(({ listing, company }) => ({
      id: listing.id,
      title: listing.title,
      board: listing.board,
      url: listing.url,
      location: listing.location,
      searchName: listing.searchName,
      postedAt: listing.postedAt,
      companyId: company.id,
      companyName: company.name,
      companyDomain: company.domain,
      contactCount: contactCountMap.get(company.id) ?? 0,
    }));
}

export async function getCompaniesByStatus(
  status?: CompanyStatus,
  search?: string,
): Promise<CompanyCardData[]> {
  const term = search?.trim();
  const rows = term
    ? await db
        .select()
        .from(companies)
        .where(
          and(
            status ? eq(companies.status, status) : undefined,
            or(
              ilike(companies.name, `%${term}%`),
              ilike(companies.domain, `%${term}%`),
            ),
          ),
        )
        .orderBy(desc(companies.updatedAt))
    : status
      ? await db
          .select()
          .from(companies)
          .where(eq(companies.status, status))
          .orderBy(desc(companies.updatedAt))
      : await db
          .select()
          .from(companies)
          .orderBy(desc(companies.updatedAt));

  return enrichCompanies(rows, await getGeoFocusSettings()).then((companies) =>
    companies.filter((c) => c.jobListings.length > 0),
  );
}

export async function getCompanyById(
  id: string,
): Promise<CompanyCardData | null> {
  const rows = await db
    .select()
    .from(companies)
    .where(eq(companies.id, id))
    .limit(1);

  if (rows.length === 0) return null;
  const enriched = await enrichCompanies(rows, await getGeoFocusSettings());
  return enriched[0];
}

export async function getLatestRunStats(listDate?: string) {
  const date = listDate ?? businessListDate();
  const [run] = await db
    .select()
    .from(dailyRuns)
    .where(eq(dailyRuns.runDate, date))
    .limit(1);
  return run ?? null;
}

export async function getRecentRuns() {
  return db
    .select()
    .from(dailyRuns)
    .orderBy(desc(dailyRuns.runDate))
    .limit(30);
}

export async function getMarketJobListings(searchName?: string) {
  const rows = searchName
    ? await db
        .select({
          listing: jobListings,
          company: companies,
        })
        .from(jobListings)
        .innerJoin(companies, eq(jobListings.companyId, companies.id))
        .where(eq(jobListings.searchName, searchName))
        .orderBy(desc(jobListings.postedAt), desc(jobListings.createdAt))
    : await db
        .select({
          listing: jobListings,
          company: companies,
        })
        .from(jobListings)
        .innerJoin(companies, eq(jobListings.companyId, companies.id))
        .orderBy(desc(jobListings.postedAt), desc(jobListings.createdAt));

  const contactCounts = await db
    .select({ companyId: contacts.companyId, count: count() })
    .from(contacts)
    .groupBy(contacts.companyId);

  const contactCountMap = new Map(
    contactCounts.map((row) => [row.companyId, Number(row.count)]),
  );

  return rows.map(({ listing, company }) => ({
    id: listing.id,
    title: listing.title,
    board: listing.board,
    url: listing.url,
    location: listing.location,
    searchName: listing.searchName,
    postedAt: listing.postedAt,
    companyId: company.id,
    companyName: company.name,
    companyDomain: company.domain,
    contactCount: contactCountMap.get(company.id) ?? 0,
  }));
}

export async function getCompanyActivities(companyId: string) {
  return db
    .select()
    .from(companyActivities)
    .where(eq(companyActivities.companyId, companyId))
    .orderBy(desc(companyActivities.createdAt))
    .limit(100);
}

async function enrichCompanies(
  rows: (typeof companies.$inferSelect)[],
  geoSettings?: Awaited<ReturnType<typeof getGeoFocusSettings>>,
): Promise<CompanyCardData[]> {
  if (rows.length === 0) return [];

  const settings = geoSettings ?? (await getGeoFocusSettings());
  const companyIds = rows.map((c) => c.id);

  const [allContacts, allListings] = await Promise.all([
    db.select().from(contacts).where(inArray(contacts.companyId, companyIds)),
    db
      .select()
      .from(jobListings)
      .where(
        and(
          inArray(jobListings.companyId, companyIds),
          isNull(jobListings.archivedAt),
        ),
      )
      .orderBy(desc(jobListings.createdAt)),
  ]);

  const contactsByCompany = new Map<string, Contact[]>();
  for (const contact of allContacts) {
    const list = contactsByCompany.get(contact.companyId) ?? [];
    list.push(contact);
    contactsByCompany.set(contact.companyId, list);
  }

  const listingsByCompany = new Map<
    string,
    (typeof jobListings.$inferSelect)[]
  >();
  for (const listing of allListings) {
    const list = listingsByCompany.get(listing.companyId) ?? [];
    list.push(listing);
    listingsByCompany.set(listing.companyId, list);
  }

  return rows.map((company) => {
    const companyContacts = contactsByCompany.get(company.id) ?? [];
    const listings = listingsByCompany.get(company.id) ?? [];
    const inFocusListings = listings.filter((listing) =>
      jobLocationInFocus(listing.location, settings),
    );

    return {
      id: company.id,
      name: company.name,
      domain: company.domain,
      domainConfidence: company.domainConfidence,
      status: company.status,
      firstSeen: company.firstSeen,
      leadScore: company.leadScore ?? 0,
      hiringSignals: company.hiringSignals ?? {},
      reasonToCall: company.reasonToCall,
      callOpener: company.callOpener,
      callOpenerGeneratedAt: company.callOpenerGeneratedAt,
      icpStatus: company.icpStatus,
      enrichedAt: company.enrichedAt,
      enrichRunDate: company.enrichRunDate,
      contacts: applySharedLineFilter(companyContacts),
      jobListings: inFocusListings,
    };
  });
}
