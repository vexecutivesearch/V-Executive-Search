import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  contacts,
  dailyRuns,
  jobListings,
  CompanyStatus,
} from "@/lib/db/schema";
import { CompanyCardData } from "@/components/CompanyCard";
import { businessToday } from "@/lib/timezone";

export async function getTodayCompanies(): Promise<CompanyCardData[]> {
  const today = businessToday();

  const rows = await db
    .select()
    .from(companies)
    .where(and(eq(companies.firstSeen, today), eq(companies.status, "new")))
    .orderBy(desc(companies.createdAt));

  return enrichCompanies(rows);
}

export async function getCompaniesByStatus(
  status?: CompanyStatus,
): Promise<CompanyCardData[]> {
  const rows = status
    ? await db
        .select()
        .from(companies)
        .where(eq(companies.status, status))
        .orderBy(desc(companies.updatedAt))
    : await db
        .select()
        .from(companies)
        .orderBy(desc(companies.updatedAt));

  return enrichCompanies(rows);
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
  const enriched = await enrichCompanies(rows);
  return enriched[0];
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
  }));
}

async function enrichCompanies(
  rows: (typeof companies.$inferSelect)[],
): Promise<CompanyCardData[]> {
  const result: CompanyCardData[] = [];

  for (const company of rows) {
    const companyContacts = await db
      .select()
      .from(contacts)
      .where(eq(contacts.companyId, company.id));

    const listings = await db
      .select()
      .from(jobListings)
      .where(eq(jobListings.companyId, company.id))
      .orderBy(desc(jobListings.createdAt));

    result.push({
      id: company.id,
      name: company.name,
      domain: company.domain,
      domainConfidence: company.domainConfidence,
      status: company.status,
      firstSeen: company.firstSeen,
      contacts: companyContacts,
      jobListings: listings,
    });
  }

  return result;
}
