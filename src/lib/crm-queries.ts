/**
 * Consolidated CRM queries — every market, every date, no coupling to the
 * Admin scrape focus or a date picker.
 *
 * Filters are applied server-side BEFORE the pagination cap so smaller
 * markets are never buried by a global top-500: filtering to "Fort Wayne"
 * queries Fort Wayne rows, not a pre-capped global slice.
 */

import { and, desc, eq, ilike, inArray, not, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  callListEntries,
  companies,
  companyIcp,
  jobListings,
  outreachMessages,
  sequenceEnrollments,
  type CallListEntry,
  type CompanyStatus,
} from "@/lib/db/schema";
import type { CompanyCardData } from "@/components/CompanyCard";
import { enrichCompanies } from "@/lib/queries";
import { getGeoFocusSettings } from "@/lib/geo-focus";
import { getMarketIndex } from "@/lib/market-index";
import {
  deriveMarketFromListings,
  marketForJobLocation,
  UNKNOWN_MARKET_VALUE,
  type MarketIndex,
} from "@/lib/market-attribution";
import { parseJobLocation } from "@/lib/location-match";
import {
  OTHER_SECTOR,
  allSectorFilterOptions,
  sectorFromIndustry,
} from "@/lib/industry-sectors";

export const CRM_PAGE_SIZE = 500;
/** Hydration batch size when exact market/state/city filtering is required. */
const HYDRATE_CHUNK = 1000;

export type CrmSort = "icp" | "score" | "recent" | "name";

/**
 * View-layer hide categories (sink-don't-hide by default: all OFF).
 * Each maps to annotation flags; toggling only changes view state —
 * flipping a toggle back restores the leads instantly, no data mutated.
 */
export const HIDE_CATEGORY_FLAGS: Record<string, string[]> = {
  fortune: ["fortune_500", "fortune_1000"],
  gov: ["gov_domain", "public_sector"],
  schools: ["school"],
  hospitals: ["hospital_system", "large_hospital_system"],
  staffing: ["staffing_agency"],
  third_party: ["third_party_posting"],
};

export type CrmLeadFilters = {
  /** Market label ("Charlotte, NC") or UNKNOWN_MARKET_VALUE bucket. */
  market?: string;
  /** Two-letter state abbreviation from listing locations. */
  state?: string;
  /** City name (any state unless combined with state filter). */
  city?: string;
  /** Broad industry sector (rollup of raw Apollo industries). */
  sector?: string;
  status?: CompanyStatus;
  search?: string;
  callableOnly?: boolean;
  enrichedOnly?: boolean;
  /** Companies with reveal-off discovered candidates awaiting reveal. */
  discoveredOnly?: boolean;
  hotOnly?: boolean;
  /* --- ICP annotation filters (Phase 2, view layer only) --- */
  roleType?: string;
  sizeBand?: string;
  /** Comp floor in annual USD (reads comp_annual_max). */
  compMin?: number;
  /** Include comp estimates when applying compMin (default true). */
  includeEstimatedComp?: boolean;
  /** Minimum icp_adjusted_score. */
  icpMin?: number;
  /** Hide categories from HIDE_CATEGORY_FLAGS — every toggle defaults OFF. */
  hideCategories?: string[];
  sort?: CrmSort;
  /** 1-based page over the filtered, ranked set. */
  page?: number;
  /** CSV export: return the whole filtered set instead of one page. */
  noCap?: boolean;
};

export type CrmLeadIcp = {
  adjustedScore: number | null;
  baseScore: number | null;
  roleType: string | null;
  roleTypeConfidence: number | null;
  compAnnualMin: number | null;
  compAnnualMax: number | null;
  compEstimated: boolean;
  compConfidence: string | null;
  sizeBand: string | null;
  flags: string[];
  likelyToUseRecruiter: number | null;
};

export type CrmLeadRow = CompanyCardData & {
  /** source_market provenance, falling back to location-derived market. */
  marketLabel: string | null;
  onCallList: boolean;
  /** ICP annotations (null until the annotate script has run). */
  icp: CrmLeadIcp | null;
};

export type CrmLeadsResult = {
  rows: CrmLeadRow[];
  totalMatched: number;
  page: number;
  pageCount: number;
  /** Leads removed by active hide toggles (null when none are active). */
  hiddenCount: number | null;
};

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const CALLABLE_CONTACT_EXISTS = sql`EXISTS (
  SELECT 1 FROM contacts AS ct
  WHERE ct.company_id = ${companies.id}
    AND (
      ct.personal_phone IS NOT NULL
      OR ct.phone IS NOT NULL
      OR ct.personal_email IS NOT NULL
      OR ct.email IS NOT NULL
      OR ct.work_email IS NOT NULL
    )
)`;

/** Resolve a company's market: ingest provenance first, else derived. */
export function resolveMarketLabel(
  company: Pick<CompanyCardData, "sourceMarket" | "jobListings">,
  index: MarketIndex,
): string | null {
  return (
    company.sourceMarket ??
    deriveMarketFromListings(company.jobListings, index)
  );
}

function companyMatchesState(row: CrmLeadRow, stateAbbr: string): boolean {
  const target = stateAbbr.toUpperCase();
  for (const listing of row.jobListings) {
    const parsed = listing.location ? parseJobLocation(listing.location) : null;
    if (parsed?.stateAbbr === target) return true;
  }
  return Boolean(row.marketLabel?.toUpperCase().endsWith(`, ${target}`));
}

function companyMatchesCity(row: CrmLeadRow, city: string): boolean {
  const target = city.trim().toLowerCase();
  if (!target) return true;
  return row.jobListings.some((listing) => {
    const parsed = listing.location ? parseJobLocation(listing.location) : null;
    return parsed?.city?.trim().toLowerCase() === target;
  });
}

/**
 * Surface the listing that matches the active location filter first, so a
 * multi-location company filtered by (say) Virginia shows its Virginia job —
 * not its top-scored out-of-state one. Keeps national companies from looking
 * like the filter is broken.
 */
function reorderListingsForFilter(
  row: CrmLeadRow,
  filters: CrmLeadFilters,
  index: MarketIndex,
): void {
  const state = filters.state?.toUpperCase();
  const city = filters.city?.trim().toLowerCase();
  const market =
    filters.market && filters.market !== UNKNOWN_MARKET_VALUE
      ? filters.market
      : null;
  if (!state && !city && !market) return;

  const matches = (listing: (typeof row.jobListings)[number]): boolean => {
    const parsed = listing.location ? parseJobLocation(listing.location) : null;
    if (city && parsed?.city?.trim().toLowerCase() !== city) return false;
    if (state && parsed?.stateAbbr !== state) return false;
    if (market && marketForJobLocation(listing.location, index) !== market) {
      return false;
    }
    return true;
  };

  const matching = row.jobListings.filter(matches);
  if (!matching.length) return;
  const rest = row.jobListings.filter((l) => !matching.includes(l));
  row.jobListings = [...matching, ...rest];
}

/** Distinct raw industry strings that roll up to the requested sector. */
async function rawIndustriesForSector(sector: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ industry: companies.industry })
    .from(companies)
    .where(sql`${companies.industry} IS NOT NULL AND ${companies.industry} <> ''`);
  return rows
    .map((r) => r.industry?.trim())
    .filter((raw): raw is string => Boolean(raw))
    .filter((raw) => sectorFromIndustry(raw) === sector);
}

/** SQL prefilter for a market: provenance tag OR listing in a member city. */
function marketPrefilterSql(marketLabel: string, index: MarketIndex): SQL {
  const cities = index.citiesByLabel.get(marketLabel) ?? [];
  const aliases = index.aliasesByLabel.get(marketLabel) ?? [];
  const patterns = [
    ...cities.map(({ city }) => `%${escapeLike(city)}%`),
    ...aliases.map((alias) => `%${escapeLike(alias)}%`),
  ];
  if (!patterns.length) {
    return sql`${companies.sourceMarket} = ${marketLabel}`;
  }
  const locationMatch = sql.join(
    patterns.map((p) => sql`jl.location ILIKE ${p}`),
    sql` OR `,
  );
  return sql`(
    ${companies.sourceMarket} = ${marketLabel}
    OR EXISTS (
      SELECT 1 FROM job_listings AS jl
      WHERE jl.company_id = ${companies.id} AND (${locationMatch})
    )
  )`;
}

function statePrefilterSql(stateAbbr: string, stateName: string | null): SQL {
  const abbrPattern = `%, ${stateAbbr}%`;
  const namePattern = stateName ? `%${escapeLike(stateName)}%` : null;
  const inner = namePattern
    ? sql`jl.location ILIKE ${abbrPattern} OR jl.location ILIKE ${namePattern}`
    : sql`jl.location ILIKE ${abbrPattern}`;
  return sql`(
    ${companies.sourceMarket} ILIKE ${`%, ${stateAbbr}`}
    OR EXISTS (
      SELECT 1 FROM job_listings AS jl
      WHERE jl.company_id = ${companies.id} AND (${inner})
    )
  )`;
}

function cityPrefilterSql(city: string): SQL {
  const pattern = `%${escapeLike(city.trim())}%`;
  return sql`EXISTS (
    SELECT 1 FROM job_listings AS jl
    WHERE jl.company_id = ${companies.id} AND jl.location ILIKE ${pattern}
  )`;
}

function stateNameForAbbr(abbr: string): string | null {
  const parsed = parseJobLocation(abbr);
  return parsed?.stateName ?? null;
}

async function buildSqlConditions(
  filters: CrmLeadFilters,
  index: MarketIndex,
): Promise<SQL[]> {
  const conditions: SQL[] = [
    sql`${not(ilike(companies.name, "(Listing)%"))}`,
  ];

  if (filters.status) {
    conditions.push(sql`${eq(companies.status, filters.status)}`);
  }

  const term = filters.search?.trim();
  if (term) {
    const pattern = `%${escapeLike(term)}%`;
    conditions.push(sql`(
      ${companies.name} ILIKE ${pattern}
      OR ${companies.domain} ILIKE ${pattern}
      OR EXISTS (
        SELECT 1 FROM job_listings AS jl
        WHERE jl.company_id = ${companies.id}
          AND (jl.title ILIKE ${pattern} OR jl.location ILIKE ${pattern})
      )
      OR EXISTS (
        SELECT 1 FROM contacts AS ct
        WHERE ct.company_id = ${companies.id}
          AND (ct.name ILIKE ${pattern} OR ct.title ILIKE ${pattern})
      )
    )`);
  }

  if (filters.callableOnly) {
    conditions.push(CALLABLE_CONTACT_EXISTS);
  }

  if (filters.enrichedOnly) {
    conditions.push(
      sql`(${companies.enrichedAt} IS NOT NULL OR ${CALLABLE_CONTACT_EXISTS})`,
    );
  }

  if (filters.discoveredOnly) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM contacts AS ct
      WHERE ct.company_id = ${companies.id}
        AND ct.reveal_status = 'discovered'
    )`);
  }

  if (filters.hotOnly) {
    conditions.push(
      sql`${companies.hiringSignals} IS NOT NULL AND ${companies.hiringSignals}::text <> '{}'`,
    );
  }

  if (filters.sector) {
    const raws = await rawIndustriesForSector(filters.sector);
    if (raws.length) {
      conditions.push(sql`${inArray(companies.industry, raws)}`);
    } else {
      // Sector chosen but no raw industry maps to it — match nothing.
      conditions.push(sql`FALSE`);
    }
  }

  if (filters.market && filters.market !== UNKNOWN_MARKET_VALUE) {
    conditions.push(marketPrefilterSql(filters.market, index));
  }

  if (filters.state) {
    conditions.push(
      statePrefilterSql(filters.state.toUpperCase(), stateNameForAbbr(filters.state)),
    );
  }

  if (filters.city) {
    conditions.push(cityPrefilterSql(filters.city));
  }

  return conditions;
}

function orderBySql(sort: CrmSort) {
  if (sort === "icp") {
    // ICP fit sort — bad fits SINK, nothing is removed. Falls back to the
    // raw lead score for rows not yet annotated.
    return [
      desc(sql`COALESCE(${companyIcp.icpAdjustedScore}, ${companies.leadScore})`),
      desc(companies.leadScore),
      desc(companies.updatedAt),
    ];
  }
  if (sort === "recent") {
    return [desc(companies.updatedAt), desc(companies.leadScore)];
  }
  if (sort === "name") {
    return [companies.name, desc(companies.leadScore)];
  }
  return [desc(companies.leadScore), desc(companies.updatedAt)];
}

/** SQL for a hide category: no annotation row = never hidden. */
function hideCategorySql(category: string): SQL | null {
  const flags = HIDE_CATEGORY_FLAGS[category];
  if (!flags?.length) return null;
  const flagList = sql.join(
    flags.map((f) => sql`${f}`),
    sql`, `,
  );
  return sql`NOT COALESCE(${companyIcp.exclusionFlags} ?| ARRAY[${flagList}]::text[], FALSE)`;
}

/** ICP annotation filters — server-side, before the pagination cap. */
function icpConditions(filters: CrmLeadFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.roleType) {
    conditions.push(sql`${companyIcp.roleType} = ${filters.roleType}`);
  }
  if (filters.sizeBand) {
    conditions.push(sql`${companyIcp.companySizeBand} = ${filters.sizeBand}`);
  }
  if (filters.compMin != null && filters.compMin > 0) {
    const compValue = sql`COALESCE(${companyIcp.compAnnualMax}, ${companyIcp.compAnnualMin})`;
    const floor = filters.compMin;
    if (filters.includeEstimatedComp === false) {
      conditions.push(
        sql`(${compValue} >= ${floor} AND ${companyIcp.compEstimatedFlag} = FALSE)`,
      );
    } else {
      conditions.push(sql`${compValue} >= ${floor}`);
    }
  }
  if (filters.icpMin != null && filters.icpMin > 0) {
    conditions.push(sql`${companyIcp.icpAdjustedScore} >= ${filters.icpMin}`);
  }
  for (const category of filters.hideCategories ?? []) {
    const condition = hideCategorySql(category);
    if (condition) conditions.push(condition);
  }

  return conditions;
}

function rowIcp(icp: typeof companyIcp.$inferSelect | null): CrmLeadIcp | null {
  if (!icp) return null;
  return {
    adjustedScore: icp.icpAdjustedScore,
    baseScore: icp.baseLeadScore,
    roleType: icp.roleType,
    roleTypeConfidence: icp.roleTypeConfidence,
    compAnnualMin: icp.compAnnualMin,
    compAnnualMax: icp.compAnnualMax,
    compEstimated: icp.compEstimatedFlag ?? false,
    compConfidence: icp.compConfidence,
    sizeBand: icp.companySizeBand,
    flags: icp.exclusionFlags ?? [],
    likelyToUseRecruiter: icp.likelyToUseRecruiter,
  };
}

async function callListCompanyIdSet(): Promise<Set<string>> {
  const rows = await db
    .select({ companyId: callListEntries.companyId })
    .from(callListEntries);
  return new Set(rows.map((r) => r.companyId));
}

/**
 * All Leads / Hot query — everything scraped, all markets, all dates.
 * Server-side filters first, then the page cap over the filtered set.
 */
export async function getCrmLeads(
  filters: CrmLeadFilters = {},
): Promise<CrmLeadsResult> {
  const sort = filters.sort ?? "icp";
  const page = Math.max(1, filters.page ?? 1);
  const [geoSettings, index, onListIds] = await Promise.all([
    getGeoFocusSettings(),
    getMarketIndex(),
    callListCompanyIdSet(),
  ]);
  const conditions = await buildSqlConditions(filters, index);
  const icpConds = icpConditions(filters);
  const whereClause = and(
    ...[...conditions, ...icpConds].map((c) => sql`(${c})`),
  );
  // Same filters WITHOUT the hide toggles — for the reversible hidden count.
  const hideActive = (filters.hideCategories ?? []).length > 0;
  const whereWithoutHides = hideActive
    ? and(
        ...[
          ...conditions,
          ...icpConditions({ ...filters, hideCategories: [] }),
        ].map((c) => sql`(${c})`),
      )
    : null;

  // Exact market/state/city matching needs hydrated listings, so those
  // filters finish in TS over SQL-prefiltered candidates — still before
  // the pagination cap.
  const needsExactPass = Boolean(filters.market || filters.state || filters.city);

  const icpById = new Map<string, typeof companyIcp.$inferSelect>();
  const toRow = (company: CompanyCardData): CrmLeadRow => ({
    ...company,
    marketLabel: resolveMarketLabel(company, index),
    onCallList: onListIds.has(company.id),
    icp: rowIcp(icpById.get(company.id) ?? null),
  });

  if (!needsExactPass) {
    const [{ count: totalMatched }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(companies)
      .leftJoin(companyIcp, eq(companyIcp.companyId, companies.id))
      .where(whereClause);

    let hiddenCount: number | null = null;
    if (whereWithoutHides) {
      const [{ count: unfiltered }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(companies)
        .leftJoin(companyIcp, eq(companyIcp.companyId, companies.id))
        .where(whereWithoutHides);
      hiddenCount = Math.max(0, unfiltered - totalMatched);
    }

    const baseQuery = db
      .select({ company: companies, icp: companyIcp })
      .from(companies)
      .leftJoin(companyIcp, eq(companyIcp.companyId, companies.id))
      .where(whereClause)
      .orderBy(...orderBySql(sort));
    const pageRows = filters.noCap
      ? await baseQuery
      : await baseQuery
          .limit(CRM_PAGE_SIZE)
          .offset((page - 1) * CRM_PAGE_SIZE);

    for (const r of pageRows) {
      if (r.icp) icpById.set(r.company.id, r.icp);
    }
    const hydrated = await enrichCompanies(
      pageRows.map((r) => r.company),
      geoSettings,
      { skipGeoFilter: true },
    );

    // Preserve the SQL ordering (enrichCompanies maps in input order already).
    return {
      rows: hydrated.map(toRow),
      totalMatched,
      page,
      pageCount: Math.max(1, Math.ceil(totalMatched / CRM_PAGE_SIZE)),
      hiddenCount,
    };
  }

  const candidates = await db
    .select({ company: companies, icp: companyIcp })
    .from(companies)
    .leftJoin(companyIcp, eq(companyIcp.companyId, companies.id))
    .where(whereClause)
    .orderBy(...orderBySql(sort));
  for (const r of candidates) {
    if (r.icp) icpById.set(r.company.id, r.icp);
  }

  const matched: CrmLeadRow[] = [];
  for (let i = 0; i < candidates.length; i += HYDRATE_CHUNK) {
    const chunk = candidates.slice(i, i + HYDRATE_CHUNK);
    const hydrated = await enrichCompanies(
      chunk.map((r) => r.company),
      geoSettings,
      { skipGeoFilter: true },
    );
    for (const company of hydrated) {
      const row = toRow(company);
      if (filters.market === UNKNOWN_MARKET_VALUE) {
        if (row.marketLabel !== null) continue;
      } else if (filters.market && row.marketLabel !== filters.market) {
        continue;
      }
      if (filters.state && !companyMatchesState(row, filters.state)) continue;
      if (filters.city && !companyMatchesCity(row, filters.city)) continue;
      reorderListingsForFilter(row, filters, index);
      matched.push(row);
    }
  }

  const totalMatched = matched.length;
  const start = (page - 1) * CRM_PAGE_SIZE;
  return {
    rows: filters.noCap ? matched : matched.slice(start, start + CRM_PAGE_SIZE),
    totalMatched,
    page,
    pageCount: Math.max(1, Math.ceil(totalMatched / CRM_PAGE_SIZE)),
    hiddenCount: null,
  };
}

/** Cheap tab badge counts — unfiltered totals across all markets/dates. */
export async function getCrmTabCounts(): Promise<{
  allLeads: number;
  hot: number;
  callList: number;
}> {
  const notListing = not(ilike(companies.name, "(Listing)%"));
  const [[all], [hot], [list]] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(companies)
      .where(notListing),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(companies)
      .where(
        and(
          notListing,
          sql`${companies.hiringSignals} IS NOT NULL AND ${companies.hiringSignals}::text <> '{}'`,
        ),
      ),
    db.select({ count: sql<number>`count(*)::int` }).from(callListEntries),
  ]);
  return { allLeads: all.count, hot: hot.count, callList: list.count };
}

export type CrmFilterOptions = {
  markets: string[];
  states: string[];
  cities: Array<{ city: string; stateAbbr: string }>;
  sectors: string[];
};

/** Distinct filter values across ALL scraped data (not date/geo-gated). */
export async function getCrmFilterOptions(): Promise<CrmFilterOptions> {
  const [index, marketRows, locationRows, industryRows] = await Promise.all([
    getMarketIndex(),
    db
      .selectDistinct({ sourceMarket: companies.sourceMarket })
      .from(companies)
      .where(sql`${companies.sourceMarket} IS NOT NULL`),
    db
      .selectDistinct({ location: jobListings.location })
      .from(jobListings)
      .where(sql`${jobListings.location} IS NOT NULL AND ${jobListings.location} <> ''`),
    db
      .selectDistinct({ industry: companies.industry })
      .from(companies)
      .where(sql`${companies.industry} IS NOT NULL AND ${companies.industry} <> ''`),
  ]);

  const markets = new Set<string>();
  for (const row of marketRows) {
    if (row.sourceMarket) markets.add(row.sourceMarket);
  }

  const states = new Set<string>();
  const cities = new Map<string, { city: string; stateAbbr: string }>();
  for (const row of locationRows) {
    const parsed = row.location ? parseJobLocation(row.location) : null;
    if (!parsed) continue;
    if (parsed.stateAbbr) states.add(parsed.stateAbbr);
    if (parsed.city && parsed.stateAbbr) {
      const key = `${parsed.city.toLowerCase()}|${parsed.stateAbbr}`;
      if (!cities.has(key)) {
        cities.set(key, { city: parsed.city, stateAbbr: parsed.stateAbbr });
      }
    }
    const derived = deriveMarketFromListings([{ location: row.location }], index);
    if (derived) markets.add(derived);
  }

  const sectorsPresent = new Set<string>();
  for (const row of industryRows) {
    const sector = sectorFromIndustry(row.industry);
    if (sector) sectorsPresent.add(sector);
  }
  const sectors = allSectorFilterOptions().filter((s) => sectorsPresent.has(s));
  if (!sectors.length && industryRows.length) sectors.push(OTHER_SECTOR);

  return {
    markets: [...markets].sort((a, b) => a.localeCompare(b)),
    states: [...states].sort(),
    cities: [...cities.values()].sort(
      (a, b) => a.city.localeCompare(b.city) || a.stateAbbr.localeCompare(b.stateAbbr),
    ),
    sectors,
  };
}

/* ------------------------------------------------------------------ */
/* Job Listings tab — listing-centric, one row per posting, reposts    */
/* shown individually (they feed the hot signal). The old Companies →  */
/* "Job listings" tab freed from the Admin geo scope.                  */
/* ------------------------------------------------------------------ */

export const CRM_LISTINGS_PAGE_SIZE = 200;

export type CrmListingSort = "newest" | "reposts";

export type CrmListingFilters = {
  market?: string;
  board?: string;
  state?: string;
  city?: string;
  search?: string;
  sort?: CrmListingSort;
  page?: number;
};

export type CrmListingRow = {
  id: string;
  title: string;
  board: string | null;
  url: string | null;
  location: string | null;
  postedAt: Date | null;
  firstSeenAt: Date;
  lastSeenRunDate: string | null;
  sightingsCount: number;
  companyId: string;
  companyName: string;
  companyDomain: string | null;
  contactCount: number;
  marketLabel: string | null;
};

export type CrmListingsResult = {
  rows: CrmListingRow[];
  totalMatched: number;
  page: number;
  pageCount: number;
  boards: string[];
};

function listingOrderBy(sort: CrmListingSort) {
  if (sort === "reposts") {
    return [desc(jobListings.sightingsCount), desc(jobListings.lastSeenAt)];
  }
  return [
    sql`${jobListings.postedAt} DESC NULLS LAST`,
    desc(jobListings.firstSeenAt),
  ];
}

function listingMarketPrefilterSql(marketLabel: string, index: MarketIndex): SQL {
  const cities = index.citiesByLabel.get(marketLabel) ?? [];
  const aliases = index.aliasesByLabel.get(marketLabel) ?? [];
  const patterns = [
    ...cities.map(({ city }) => `%${escapeLike(city)}%`),
    ...aliases.map((alias) => `%${escapeLike(alias)}%`),
  ];
  const locationMatch = patterns.length
    ? sql.join(
        patterns.map((p) => sql`${jobListings.location} ILIKE ${p}`),
        sql` OR `,
      )
    : sql`FALSE`;
  return sql`(${companies.sourceMarket} = ${marketLabel} OR (${locationMatch}))`;
}

/** Every scraped posting, all markets/dates — server-side filters first. */
export async function getConsolidatedListings(
  filters: CrmListingFilters = {},
): Promise<CrmListingsResult> {
  const sort = filters.sort ?? "newest";
  const page = Math.max(1, filters.page ?? 1);
  const index = await getMarketIndex();

  const conditions: SQL[] = [];

  if (filters.board) {
    conditions.push(sql`${eq(jobListings.board, filters.board)}`);
  }

  const term = filters.search?.trim();
  if (term) {
    const pattern = `%${escapeLike(term)}%`;
    conditions.push(sql`(
      ${jobListings.title} ILIKE ${pattern}
      OR ${jobListings.location} ILIKE ${pattern}
      OR ${companies.name} ILIKE ${pattern}
    )`);
  }

  if (filters.state) {
    const abbr = filters.state.toUpperCase();
    const name = stateNameForAbbr(filters.state);
    conditions.push(
      name
        ? sql`(${jobListings.location} ILIKE ${`%, ${abbr}%`} OR ${jobListings.location} ILIKE ${`%${escapeLike(name)}%`})`
        : sql`${jobListings.location} ILIKE ${`%, ${abbr}%`}`,
    );
  }

  if (filters.city) {
    conditions.push(
      sql`${jobListings.location} ILIKE ${`%${escapeLike(filters.city.trim())}%`}`,
    );
  }

  const marketFilter = filters.market;
  if (marketFilter && marketFilter !== UNKNOWN_MARKET_VALUE) {
    conditions.push(listingMarketPrefilterSql(marketFilter, index));
  }

  const whereClause = conditions.length
    ? and(...conditions.map((c) => sql`(${c})`))
    : undefined;

  const selection = {
    id: jobListings.id,
    title: jobListings.title,
    board: jobListings.board,
    url: jobListings.url,
    location: jobListings.location,
    postedAt: jobListings.postedAt,
    firstSeenAt: jobListings.firstSeenAt,
    lastSeenRunDate: jobListings.lastSeenRunDate,
    sightingsCount: jobListings.sightingsCount,
    companyId: companies.id,
    companyName: companies.name,
    companyDomain: companies.domain,
    companySourceMarket: companies.sourceMarket,
    contactCount: sql<number>`(
      SELECT count(*)::int FROM contacts ct WHERE ct.company_id = ${companies.id}
    )`,
  };

  const toRow = (r: {
    id: string;
    title: string;
    board: string | null;
    url: string | null;
    location: string | null;
    postedAt: Date | null;
    firstSeenAt: Date;
    lastSeenRunDate: string | null;
    sightingsCount: number | null;
    companyId: string;
    companyName: string;
    companyDomain: string | null;
    companySourceMarket: string | null;
    contactCount: number;
  }): CrmListingRow => ({
    id: r.id,
    title: r.title,
    board: r.board,
    url: r.url,
    location: r.location,
    postedAt: r.postedAt,
    firstSeenAt: r.firstSeenAt,
    lastSeenRunDate: r.lastSeenRunDate,
    sightingsCount: r.sightingsCount ?? 1,
    companyId: r.companyId,
    companyName: r.companyName,
    companyDomain: r.companyDomain,
    contactCount: r.contactCount,
    marketLabel:
      marketForJobLocation(r.location, index) ?? r.companySourceMarket,
  });

  const boardsRows = await db
    .selectDistinct({ board: jobListings.board })
    .from(jobListings)
    .where(sql`${jobListings.board} IS NOT NULL`);
  const boards = boardsRows
    .map((b) => b.board)
    .filter((b): b is string => Boolean(b))
    .sort();

  // Market filter needs an exact per-row pass (cross-state metros), so pull
  // the SQL-prefiltered candidate set and finish in TS before the cap.
  if (marketFilter) {
    const candidates = await db
      .select(selection)
      .from(jobListings)
      .innerJoin(companies, eq(jobListings.companyId, companies.id))
      .where(whereClause)
      .orderBy(...listingOrderBy(sort));

    const matched = candidates.map(toRow).filter((row) => {
      if (marketFilter === UNKNOWN_MARKET_VALUE) return row.marketLabel === null;
      return row.marketLabel === marketFilter;
    });

    const totalMatched = matched.length;
    const start = (page - 1) * CRM_LISTINGS_PAGE_SIZE;
    return {
      rows: matched.slice(start, start + CRM_LISTINGS_PAGE_SIZE),
      totalMatched,
      page,
      pageCount: Math.max(1, Math.ceil(totalMatched / CRM_LISTINGS_PAGE_SIZE)),
      boards,
    };
  }

  const [{ count: totalMatched }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobListings)
    .innerJoin(companies, eq(jobListings.companyId, companies.id))
    .where(whereClause);

  const pageRows = await db
    .select(selection)
    .from(jobListings)
    .innerJoin(companies, eq(jobListings.companyId, companies.id))
    .where(whereClause)
    .orderBy(...listingOrderBy(sort))
    .limit(CRM_LISTINGS_PAGE_SIZE)
    .offset((page - 1) * CRM_LISTINGS_PAGE_SIZE);

  return {
    rows: pageRows.map(toRow),
    totalMatched,
    page,
    pageCount: Math.max(1, Math.ceil(totalMatched / CRM_LISTINGS_PAGE_SIZE)),
    boards,
  };
}

/* ------------------------------------------------------------------ */
/* Market rail + KPI cards                                             */
/* ------------------------------------------------------------------ */

export type MarketRailEntry = {
  label: string;
  /** UNKNOWN_MARKET_VALUE for the null bucket. */
  value: string;
  count: number;
};

/** Per-market company counts from source_market (backfilled provenance). */
export async function getMarketRailCounts(): Promise<{
  total: number;
  markets: MarketRailEntry[];
}> {
  const notListing = not(ilike(companies.name, "(Listing)%"));
  const rows = await db
    .select({
      sourceMarket: companies.sourceMarket,
      count: sql<number>`count(*)::int`,
    })
    .from(companies)
    .where(notListing)
    .groupBy(companies.sourceMarket)
    .orderBy(sql`count(*) DESC`);

  let total = 0;
  let unknown = 0;
  const markets: MarketRailEntry[] = [];
  for (const row of rows) {
    total += row.count;
    if (row.sourceMarket) {
      markets.push({ label: row.sourceMarket, value: row.sourceMarket, count: row.count });
    } else {
      unknown += row.count;
    }
  }
  if (unknown > 0) {
    markets.push({
      label: "No market match",
      value: UNKNOWN_MARKET_VALUE,
      count: unknown,
    });
  }
  return { total, markets };
}

export type LocationRailCity = {
  city: string;
  count: number;
};

export type LocationRailState = {
  stateName: string;
  stateAbbr: string;
  count: number;
  cities: LocationRailCity[];
};

/**
 * State → city hierarchy for the Pipeline rail.
 *
 * Counts are based on actual job-listing locations, not source_market. A
 * company is counted once per state/city in which it has a listing, matching
 * the server-side State/City filter semantics. This means a valid location
 * such as Weston, FL is never mislabeled as "No market match" merely because
 * Weston was not a configured metro scrape hub.
 */
export async function getLocationRailCounts(): Promise<{
  total: number;
  states: LocationRailState[];
}> {
  const [companyRows, locationRows] = await Promise.all([
    db
      .select({ id: companies.id })
      .from(companies)
      .where(not(ilike(companies.name, "(Listing)%"))),
    db
      .select({
        companyId: jobListings.companyId,
        location: jobListings.location,
      })
      .from(jobListings)
      .innerJoin(companies, eq(jobListings.companyId, companies.id))
      .where(
        and(
          not(ilike(companies.name, "(Listing)%")),
          sql`${jobListings.location} IS NOT NULL AND ${jobListings.location} <> ''`,
        ),
      ),
  ]);

  const stateCompanies = new Map<
    string,
    { stateName: string; companies: Set<string> }
  >();
  const cityCompanies = new Map<string, Map<string, Set<string>>>();

  for (const row of locationRows) {
    const parsed = row.location ? parseJobLocation(row.location) : null;
    if (!parsed?.stateAbbr || !parsed.stateName) continue;

    const state = stateCompanies.get(parsed.stateAbbr) ?? {
      stateName: parsed.stateName,
      companies: new Set<string>(),
    };
    state.companies.add(row.companyId);
    stateCompanies.set(parsed.stateAbbr, state);

    if (parsed.city?.trim()) {
      const byCity = cityCompanies.get(parsed.stateAbbr) ?? new Map();
      const companyIds = byCity.get(parsed.city) ?? new Set<string>();
      companyIds.add(row.companyId);
      byCity.set(parsed.city, companyIds);
      cityCompanies.set(parsed.stateAbbr, byCity);
    }
  }

  const states = [...stateCompanies.entries()]
    .map(([stateAbbr, state]) => ({
      stateName: state.stateName,
      stateAbbr,
      count: state.companies.size,
      cities: [...(cityCompanies.get(stateAbbr) ?? new Map()).entries()]
        .map(([city, ids]) => ({ city, count: ids.size }))
        .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city)),
    }))
    .sort(
      (a, b) =>
        a.stateName.localeCompare(b.stateName) ||
        a.stateAbbr.localeCompare(b.stateAbbr),
    );

  return { total: companyRows.length, states };
}

export type CrmKpis = {
  totalCompanies: number;
  newToday: number;
  enriched: number;
  hot: number;
  dueToday: number;
  totalListings: number;
};

/** Header KPI cards — cheap unfiltered counts. */
export async function getCrmKpis(todayDate: string): Promise<CrmKpis> {
  const notListing = not(ilike(companies.name, "(Listing)%"));
  const [[totalRow], [newRow], [enrichedRow], [hotRow], [dueRow], [listingsRow]] =
    await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(companies).where(notListing),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(companies)
        .where(and(notListing, sql`${companies.firstSeen} = ${todayDate}::date`)),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(companies)
        .where(
          and(
            notListing,
            sql`(${companies.enrichedAt} IS NOT NULL OR ${CALLABLE_CONTACT_EXISTS})`,
          ),
        ),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(companies)
        .where(
          and(
            notListing,
            sql`${companies.hiringSignals} IS NOT NULL AND ${companies.hiringSignals}::text <> '{}'`,
          ),
        ),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(callListEntries)
        .where(sql`${callListEntries.nextFollowUpDate} <= ${todayDate}::date`),
      db.select({ n: sql<number>`count(*)::int` }).from(jobListings),
    ]);
  return {
    totalCompanies: totalRow.n,
    newToday: newRow.n,
    enriched: enrichedRow.n,
    hot: hotRow.n,
    dueToday: dueRow.n,
    totalListings: listingsRow.n,
  };
}

export type CallListOutreachProgress = {
  enrollmentId: string;
  status: string;
  channelPlan: "email_and_text" | "email_only";
  stepsTotal: number;
  stepsSent: number;
  stepsQueued: number;
  stepsDrafted: number;
  lastSentKind: string | null;
  label: string;
};

export type CallListItem = {
  entry: CallListEntry;
  company: CompanyCardData;
  marketLabel: string | null;
  outreach: CallListOutreachProgress | null;
};

function outreachProgressLabel(p: Omit<CallListOutreachProgress, "label">): string {
  if (p.status === "replied_positive") return "Seq: positive reply";
  if (p.status === "stopped") return "Seq: stopped";
  if (p.status === "paused") return "Seq: paused";
  if (p.stepsSent > 0) {
    return `Seq: ${p.lastSentKind ?? "step"} sent · ${p.stepsSent}/${p.stepsTotal}`;
  }
  if (p.stepsQueued > 0) return `Seq: queued · 0/${p.stepsTotal} sent`;
  if (p.stepsDrafted > 0) return `Seq: drafted · awaiting send`;
  return `Seq: ${p.status}`;
}

/** Full call list — curated queue, loads completely (no pagination). */
export async function getCallListItems(): Promise<CallListItem[]> {
  const [geoSettings, index] = await Promise.all([
    getGeoFocusSettings(),
    getMarketIndex(),
  ]);

  const entries = await db
    .select()
    .from(callListEntries)
    .orderBy(desc(callListEntries.addedAt));
  if (!entries.length) return [];

  const companyIds = entries.map((e) => e.companyId);
  const companyRows = await db
    .select()
    .from(companies)
    .where(inArray(companies.id, companyIds));

  const hydrated = await enrichCompanies(companyRows, geoSettings, {
    skipGeoFilter: true,
  });
  const byId = new Map(hydrated.map((c) => [c.id, c]));

  // Latest enrollment per company (Call List progress badge).
  const enrollments = await db
    .select()
    .from(sequenceEnrollments)
    .where(inArray(sequenceEnrollments.companyId, companyIds))
    .orderBy(desc(sequenceEnrollments.enrolledAt));
  const enrollmentByCompany = new Map<string, (typeof enrollments)[number]>();
  for (const enr of enrollments) {
    if (!enrollmentByCompany.has(enr.companyId)) {
      enrollmentByCompany.set(enr.companyId, enr);
    }
  }
  const enrollmentIds = [...enrollmentByCompany.values()].map((e) => e.id);
  const messageRows = enrollmentIds.length
    ? await db
        .select({
          enrollmentId: outreachMessages.enrollmentId,
          status: outreachMessages.status,
          stepKind: outreachMessages.stepKind,
          sentAt: outreachMessages.sentAt,
        })
        .from(outreachMessages)
        .where(inArray(outreachMessages.enrollmentId, enrollmentIds))
    : [];
  const messagesByEnrollment = new Map<string, typeof messageRows>();
  for (const m of messageRows) {
    const list = messagesByEnrollment.get(m.enrollmentId) ?? [];
    list.push(m);
    messagesByEnrollment.set(m.enrollmentId, list);
  }

  return entries
    .map((entry) => {
      const company = byId.get(entry.companyId);
      if (!company) return null;
      const enr = enrollmentByCompany.get(entry.companyId) ?? null;
      let outreach: CallListOutreachProgress | null = null;
      if (enr) {
        const msgs = messagesByEnrollment.get(enr.id) ?? [];
        const sent = msgs.filter((m) => m.status === "sent");
        const lastSent = [...sent].sort(
          (a, b) =>
            (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0),
        )[0];
        const base = {
          enrollmentId: enr.id,
          status: enr.status,
          channelPlan: (enr.phoneNumber
            ? "email_and_text"
            : "email_only") as "email_and_text" | "email_only",
          stepsTotal: msgs.length,
          stepsSent: sent.length,
          stepsQueued: msgs.filter((m) => m.status === "queued").length,
          stepsDrafted: msgs.filter((m) => m.status === "drafted").length,
          lastSentKind: lastSent?.stepKind ?? null,
        };
        outreach = { ...base, label: outreachProgressLabel(base) };
      }
      return {
        entry,
        company,
        marketLabel: resolveMarketLabel(company, index),
        outreach,
      };
    })
    .filter((item): item is CallListItem => item !== null);
}

/** Membership lookup for a single company (post-enrich Yes/No prompt). */
export async function getCallListEntryForCompany(
  companyId: string,
): Promise<CallListEntry | null> {
  const [entry] = await db
    .select()
    .from(callListEntries)
    .where(eq(callListEntries.companyId, companyId))
    .limit(1);
  return entry ?? null;
}

export { UNKNOWN_MARKET_VALUE };
