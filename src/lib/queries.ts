import { and, count, desc, eq, gte, ilike, inArray, isNull, lte, ne, not, or, sql } from "drizzle-orm";
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
import { businessListDate, BUSINESS_TIMEZONE } from "@/lib/timezone";
import type { ListDateRange } from "@/lib/list-date-range";
import { applySharedLineFilter } from "@/lib/contact-phones";
import { focusGeoLabel, getGeoFocusSettings, jobLocationInFocus } from "@/lib/geo-focus";
import type { Contact, JobListing } from "@/lib/db/schema";

function etDateFromTimestamp(value: Date): string {
  return value.toLocaleDateString("en-CA", { timeZone: BUSINESS_TIMEZONE });
}

function jobActiveOnDate(listing: JobListing, asOfDate: string): boolean {
  if (etDateFromTimestamp(listing.firstSeenAt) > asOfDate) return false;
  if (listing.archivedAt && etDateFromTimestamp(listing.archivedAt) <= asOfDate) {
    return false;
  }
  const lastSeen =
    listing.lastSeenRunDate ?? etDateFromTimestamp(listing.lastSeenAt);
  return lastSeen >= asOfDate;
}

function hasCallableContact(contact: Contact): boolean {
  return Boolean(
    contact.personalPhone ||
      contact.phone ||
      contact.personalEmail ||
      contact.email ||
      contact.workEmail,
  );
}

/** Call sheet — JIT-enriched leads with callable contacts for a day or range. */
export async function getCallSheetCompanies(
  listRange?: Pick<ListDateRange, "from" | "to" | "isToday">,
): Promise<CompanyCardData[]> {
  const from = listRange?.from ?? businessListDate();
  const to = listRange?.to ?? from;
  const isToday =
    listRange?.isToday ??
    (from === businessListDate() && to === businessListDate());
  const geoSettings = await getGeoFocusSettings();

  // Promote manual CRM enriches on the current business day only.
  if (isToday) {
    await db.execute(sql`
      UPDATE companies AS c
      SET
        enrich_run_date = ${from}::date,
        enriched_at = COALESCE(c.enriched_at, NOW()),
        updated_at = NOW()
      WHERE c.status = 'new'
        AND c.enrich_run_date IS NULL
        AND EXISTS (
          SELECT 1 FROM contacts AS ct
          WHERE ct.company_id = c.id
            AND (
              ct.personal_phone IS NOT NULL
              OR ct.phone IS NOT NULL
              OR ct.personal_email IS NOT NULL
              OR ct.email IS NOT NULL
              OR ct.work_email IS NOT NULL
            )
            AND (ct.created_at AT TIME ZONE 'America/New_York')::date = ${from}::date
        )
    `);
  }

  const dateFilter =
    from === to
      ? eq(companies.enrichRunDate, from)
      : and(
          gte(companies.enrichRunDate, from),
          lte(companies.enrichRunDate, to),
        );

  const companiesRows = await db
    .select()
    .from(companies)
    .where(
      and(
        eq(companies.status, "new"),
        dateFilter,
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

export type BacklogQueryOptions = {
  asOfDate?: string;
  firstSeenFrom?: string;
  firstSeenTo?: string;
};

/** Ranked backlog snapshot — companies awaiting enrichment as of a business day. */
export async function getBacklogCompanies(
  options?: BacklogQueryOptions,
): Promise<CompanyCardData[]> {
  const asOfDate = options?.asOfDate ?? businessListDate();
  const isCurrentDay = asOfDate === businessListDate();
  const geoSettings = await getGeoFocusSettings();

  const conditions = [
    ne(companies.icpStatus, "fail"),
    not(ilike(companies.name, "(Listing)%")),
    lte(companies.firstSeen, asOfDate),
    or(
      isNull(companies.enrichRunDate),
      sql`${companies.enrichRunDate} > ${asOfDate}::date`,
    ),
    sql`NOT EXISTS (
      SELECT 1 FROM contacts AS ct
      WHERE ct.company_id = ${companies.id}
        AND (
          ct.personal_phone IS NOT NULL
          OR ct.phone IS NOT NULL
          OR ct.personal_email IS NOT NULL
          OR ct.email IS NOT NULL
          OR ct.work_email IS NOT NULL
        )
        AND (ct.created_at AT TIME ZONE 'America/New_York')::date <= ${asOfDate}::date
    )`,
  ];

  if (isCurrentDay) {
    conditions.push(eq(companies.status, "new"));
  }

  if (options?.firstSeenFrom) {
    conditions.push(gte(companies.firstSeen, options.firstSeenFrom));
  }
  if (options?.firstSeenTo) {
    conditions.push(lte(companies.firstSeen, options.firstSeenTo));
  }

  const companiesRows = await db
    .select()
    .from(companies)
    .where(and(...conditions))
    .orderBy(desc(companies.leadScore), desc(companies.updatedAt))
    .limit(500);

  const enriched = await enrichCompanies(companiesRows, geoSettings, {
    asOfDate,
  });

  return enriched
    .filter(
      (c) =>
        c.jobListings.length > 0 &&
        !c.contacts.some(hasCallableContact),
    )
    .sort((a, b) => (b.leadScore ?? 0) - (a.leadScore ?? 0));
}

export async function getBacklogForDateRange(
  range: ListDateRange,
): Promise<CompanyCardData[]> {
  if (range.mode === "range") {
    return getBacklogCompanies({
      asOfDate: range.snapshotDate,
      firstSeenFrom: range.from,
      firstSeenTo: range.to,
    });
  }
  return getBacklogCompanies({ asOfDate: range.snapshotDate });
}

/** @deprecated Use getCallSheetCompanies — kept for compatibility. */
export async function getDailyListCompanies(
  listRange?: Pick<ListDateRange, "from" | "to" | "isToday">,
): Promise<CompanyCardData[]> {
  const callSheet = await getCallSheetCompanies(listRange);
  if (callSheet.length > 0) return callSheet;
  const asOf = listRange?.to ?? listRange?.from;
  return getBacklogCompanies(asOf ? { asOfDate: asOf } : undefined);
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
  options?: { asOfDate?: string },
): Promise<CompanyCardData[]> {
  if (rows.length === 0) return [];

  const settings = geoSettings ?? (await getGeoFocusSettings());
  const companyIds = rows.map((c) => c.id);
  const asOfDate = options?.asOfDate;

  const [allContacts, allListings] = await Promise.all([
    db.select().from(contacts).where(inArray(contacts.companyId, companyIds)),
    db
      .select()
      .from(jobListings)
      .where(
        asOfDate
          ? inArray(jobListings.companyId, companyIds)
          : and(
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
    const companyContacts = (contactsByCompany.get(company.id) ?? []).filter(
      (contact) =>
        !asOfDate || etDateFromTimestamp(contact.createdAt) <= asOfDate,
    );
    const listings = (listingsByCompany.get(company.id) ?? []).filter(
      (listing) => !asOfDate || jobActiveOnDate(listing, asOfDate),
    );
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
