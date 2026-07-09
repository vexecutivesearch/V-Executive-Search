import { and, count, desc, eq, ilike, inArray, isNotNull, or } from "drizzle-orm";
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

  // Callable leads only: new status, added today, with email or phone on file.
  const rows = await db
    .selectDistinct({ id: companies.id })
    .from(companies)
    .innerJoin(contacts, eq(contacts.companyId, companies.id))
    .where(
      and(
        eq(companies.status, "new"),
        eq(companies.firstSeen, today),
        or(isNotNull(contacts.email), isNotNull(contacts.phone)),
      ),
    );

  const ids = rows.map((r) => r.id);
  if (!ids.length) return [];

  const companiesRows = await db
    .select()
    .from(companies)
    .where(inArray(companies.id, ids))
    .orderBy(desc(companies.createdAt));

  return enrichCompanies(companiesRows);
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
