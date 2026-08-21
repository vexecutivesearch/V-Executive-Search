import Link from "next/link";
import { CrmFilterBar } from "@/components/crm/CrmFilterBar";
import { CrmLeadsList } from "@/components/crm/CrmLeadsList";
import { DiscoveryReviewList } from "@/components/crm/DiscoveryReviewList";
import { DiscoveryRunLauncher } from "@/components/crm/DiscoveryRunLauncher";
import { CrmListingsList } from "@/components/crm/CrmListingsList";
import { CallListView } from "@/components/crm/CallListView";
import { KpiCards } from "@/components/crm/KpiCards";
import { LocationRail } from "@/components/crm/LocationRail";
import {
  getCallListItems,
  getConsolidatedListings,
  getCrmFilterOptions,
  getCrmKpis,
  getCrmLeads,
  getCrmTabCounts,
  getLocationRailCounts,
  type CallListItem,
  type CrmLeadFilters,
  type CrmLeadsResult,
  type CrmListingsResult,
  type CrmListingSort,
  type CrmSort,
} from "@/lib/crm-queries";
import {
  companyReviewStatusEnum,
  type CompanyReviewStatus,
  type CompanyStatus,
} from "@/lib/db/schema";
import {
  EMPTY_LOCATION_SCOPE,
  normalizeLocationScope,
  type LocationScope,
} from "@/lib/crm-location-scope";
import {
  getReviewQueue,
  getReviewQueueCounts,
  getReviewQueueFacets,
  type ReviewQueueCounts,
  type ReviewQueueResult,
} from "@/lib/discovery/review-queue";
import { businessListDate } from "@/lib/timezone";

export const dynamic = "force-dynamic";

type CrmTab = "all" | "listings" | "call-list" | "hot" | "discovery";

const COMPANY_STATUSES = new Set(["new", "contacted", "meeting", "client", "skipped"]);
const SORTS = new Set(["icp", "score", "recent", "name"]);
const LISTING_SORTS = new Set(["newest", "reposts"]);
const HIDE_CATEGORIES = new Set([
  "fortune",
  "gov",
  "schools",
  "hospitals",
  "staffing",
  "third_party",
]);
const ROLE_TYPES = new Set([
  "leadership",
  "management",
  "professional",
  "specialized",
  "support",
  "hourly",
  "unknown",
]);
const SIZE_BANDS = new Set(["micro", "small", "mid", "large", "unknown"]);
const REVIEW_STATUSES = new Set<string>(companyReviewStatusEnum.enumValues);

type CrmSearchParams = {
  tab?: string;
  /** Discovery review bucket (pending by default). */
  review?: string;
  /** Discovery vertical filter. */
  vertical?: string;
  /** Discovery market filter — separate from the legacy `market` param. */
  dmarket?: string;
  market?: string;
  state?: string;
  city?: string;
  sector?: string;
  status?: string;
  board?: string;
  q?: string;
  callable?: string;
  enriched?: string;
  discovered?: string;
  role?: string;
  size?: string;
  comp?: string;
  est?: string;
  icpmin?: string;
  hide?: string;
  sort?: string;
  page?: string;
};

function parseTab(raw: string | undefined): CrmTab {
  if (raw === "call-list") return "call-list";
  if (raw === "hot") return "hot";
  if (raw === "listings") return "listings";
  if (raw === "discovery") return "discovery";
  return "all";
}

function parseReviewStatus(raw: string | undefined): CompanyReviewStatus | "all" {
  if (raw === "all") return "all";
  return REVIEW_STATUSES.has(raw ?? "")
    ? (raw as CompanyReviewStatus)
    : "pending";
}

function parseFilters(
  params: CrmSearchParams,
  scope: LocationScope,
): CrmLeadFilters {
  return {
    // The Pipeline UI is location-led (State → City). source_market remains
    // available to the JSON API for provenance queries, but is not a view gate.
    market: undefined,
    state: scope.state || undefined,
    city: scope.city || undefined,
    sector: params.sector?.trim() || undefined,
    status:
      params.status && COMPANY_STATUSES.has(params.status)
        ? (params.status as CompanyStatus)
        : undefined,
    search: params.q?.trim() || undefined,
    callableOnly: params.callable === "1",
    enrichedOnly: params.enriched === "1",
    discoveredOnly: params.discovered === "1",
    roleType:
      params.role && ROLE_TYPES.has(params.role) ? params.role : undefined,
    sizeBand:
      params.size && SIZE_BANDS.has(params.size) ? params.size : undefined,
    compMin: Number.parseInt(params.comp ?? "", 10) || undefined,
    includeEstimatedComp: params.est !== "0",
    icpMin: Number.parseInt(params.icpmin ?? "", 10) || undefined,
    hideCategories: (params.hide ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter((c) => HIDE_CATEGORIES.has(c)),
    sort: params.sort && SORTS.has(params.sort) ? (params.sort as CrmSort) : "icp",
    page: Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1),
  };
}

export default async function CrmPage({
  searchParams,
}: {
  searchParams: Promise<CrmSearchParams>;
}) {
  const params = await searchParams;
  const tab = parseTab(params.tab);
  let scope = EMPTY_LOCATION_SCOPE;
  let filters = parseFilters(params, scope);

  let filterOptions;
  let counts;
  let kpis;
  let rail;
  let leads: CrmLeadsResult | null = null;
  let listings: CrmListingsResult | null = null;
  let callListItems: CallListItem[] | null = null;
  let review: ReviewQueueResult | null = null;
  let reviewCounts: ReviewQueueCounts | null = null;
  let reviewFacets: { verticals: string[]; markets: string[] } | null = null;
  const reviewStatus = parseReviewStatus(params.review);
  try {
    [filterOptions, counts, kpis, rail] = await Promise.all([
      getCrmFilterOptions(),
      getCrmTabCounts(),
      getCrmKpis(businessListDate()),
      getLocationRailCounts(),
    ]);
    scope = normalizeLocationScope(params, filterOptions);
    filters = parseFilters(params, scope);
    if (tab === "discovery") {
      [review, reviewCounts, reviewFacets] = await Promise.all([
        getReviewQueue({
          reviewStatus,
          vertical: params.vertical?.trim() || undefined,
          market: params.dmarket?.trim() || undefined,
          state: filters.state,
          city: filters.city,
          search: filters.search,
          page: filters.page,
        }),
        getReviewQueueCounts(),
        getReviewQueueFacets(),
      ]);
    } else if (tab === "call-list") {
      callListItems = await getCallListItems();
    } else if (tab === "listings") {
      listings = await getConsolidatedListings({
        state: filters.state,
        city: filters.city,
        board: params.board?.trim() || undefined,
        search: filters.search,
        sort:
          params.sort && LISTING_SORTS.has(params.sort)
            ? (params.sort as CrmListingSort)
            : "newest",
        page: filters.page,
      });
    } else {
      leads = await getCrmLeads({
        ...filters,
        hotOnly: tab === "hot" ? true : filters.hotOnly,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const missingDb =
      /DATABASE_URL/i.test(message) ||
      /connect/i.test(message) ||
      /source_market|call_list_entries/i.test(message);

    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-2">Pipeline</h1>
        {missingDb ? (
          <p className="text-gray-500">
            Database not connected or schema out of date. Set DATABASE_URL and run{" "}
            <code className="text-sm bg-gray-100 dark:bg-gray-800 px-1 rounded">
              npm run db:push
            </code>{" "}
            (adds the call_list_entries table and companies.source_market column).
          </p>
        ) : (
          <p className="text-gray-500">
            Pipeline failed to load:{" "}
            <code className="text-sm bg-gray-100 dark:bg-gray-800 px-1 rounded">
              {message}
            </code>
          </p>
        )}
      </div>
    );
  }

  const carriedFilterEntries = {
    market: params.market,
    state: scope.state || undefined,
    city: scope.city || undefined,
    sector: params.sector,
    status: params.status,
    board: params.board,
    q: params.q,
    callable: params.callable,
    enriched: params.enriched,
    discovered: params.discovered,
    role: params.role,
    size: params.size,
    comp: params.comp,
    est: params.est,
    icpmin: params.icpmin,
    hide: params.hide,
    sort: params.sort,
  };

  function tabHref(nextTab: CrmTab): string {
    const qs = new URLSearchParams();
    // Filters carry across the data tabs; the Call List is a curated queue.
    // Discovery review only filters on location and search, so carrying the
    // job-shaped filters would show an active filter that does nothing.
    if (nextTab === "discovery") {
      for (const key of ["state", "city", "q"] as const) {
        const value = carriedFilterEntries[key];
        if (value) qs.set(key, value);
      }
    } else if (nextTab !== "call-list") {
      for (const [key, value] of Object.entries(carriedFilterEntries)) {
        if (value) qs.set(key, value);
      }
    }
    if (nextTab !== "all") qs.set("tab", nextTab);
    const s = qs.toString();
    return s ? `/crm?${s}` : "/crm";
  }

  /** Discovery keeps its own bucket/vertical/market params alongside the shared ones. */
  function discoveryHref(changes: Record<string, string | null>): string {
    const qs = new URLSearchParams();
    qs.set("tab", "discovery");
    const current: Record<string, string | undefined> = {
      review: params.review,
      vertical: params.vertical,
      dmarket: params.dmarket,
      state: scope.state || undefined,
      city: scope.city || undefined,
      q: params.q,
      page: params.page,
    };
    for (const [key, value] of Object.entries({ ...current, ...changes })) {
      if (value) qs.set(key, value);
      else qs.delete(key);
    }
    return `/crm?${qs.toString()}`;
  }

  function locationHref(state: string | null, city?: string | null): string {
    const qs = new URLSearchParams();
    const carried: Record<string, string | undefined> =
      tab === "discovery"
        ? { q: params.q, review: params.review, vertical: params.vertical, dmarket: params.dmarket }
        : carriedFilterEntries;
    for (const [key, value] of Object.entries(carried)) {
      if (value && key !== "market" && key !== "state" && key !== "city") {
        qs.set(key, value);
      }
    }
    if (state) qs.set("state", state);
    if (state && city) qs.set("city", city);
    if (tab !== "all") qs.set("tab", tab);
    const s = qs.toString();
    return s ? `/crm?${s}` : "/crm";
  }

  /** Pagination/export links rebuild the query string, so hand them the
   * normalized pair rather than letting a dropped city ride along. */
  const scopedParams: CrmSearchParams = {
    ...params,
    state: scope.state || undefined,
    city: scope.city || undefined,
  };

  const tabClass = (active: boolean) =>
    `px-3 py-1.5 rounded-full text-sm border transition-colors ${
      active
        ? "bg-gray-900 text-white border-gray-900 dark:bg-white dark:text-gray-900"
        : "border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
    }`;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="mb-5">
        <h1 className="text-2xl font-bold">Pipeline</h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1">
          All markets · all dates · independent of the Admin scrape and
          today&apos;s date. Filter by market to see any pipeline, instantly.
        </p>
      </div>

      <KpiCards kpis={kpis!} />

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex flex-wrap gap-2">
          <Link href={tabHref("all")} className={tabClass(tab === "all")}>
            All leads ({counts!.allLeads.toLocaleString()})
          </Link>
          <Link href={tabHref("listings")} className={tabClass(tab === "listings")}>
            Job listings ({kpis!.totalListings.toLocaleString()})
          </Link>
          <Link href={tabHref("call-list")} className={tabClass(tab === "call-list")}>
            Call list ({counts!.callList.toLocaleString()})
          </Link>
          <Link href={tabHref("hot")} className={tabClass(tab === "hot")}>
            Hot ({counts!.hot.toLocaleString()})
          </Link>
          <Link
            href={tabHref("discovery")}
            className={tabClass(tab === "discovery")}
          >
            Discovery review
            {reviewCounts ? ` (${reviewCounts.pending.toLocaleString()})` : ""}
          </Link>
        </div>
        {tab === "call-list" || tab === "discovery" ? (
          <a
            href="/api/export/csv?type=call-list"
            download
            className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors shadow-sm"
          >
            ↓ Export call list CSV
          </a>
        ) : tab !== "listings" ? (
          <CrmExportLink params={scopedParams} hot={tab === "hot"} />
        ) : null}
      </div>

      <div className="flex gap-6">
        {tab !== "call-list" && (
          <LocationRail
            total={rail!.total}
            states={rail!.states}
            activeState={scope.state}
            activeCity={scope.city}
            buildHref={locationHref}
          />
        )}

        <div className="flex-1 min-w-0">
          {tab === "discovery" ? (
            <>
            {/* Search first, then the filters that narrow what it produced —
                the two must not read as one row of location controls. */}
            <DiscoveryRunLauncher browseScope={scope} />
            <CrmFilterBar
              options={filterOptions!}
              tab={tab}
              variant="discovery"
              active={{
                state: scope.state,
                city: scope.city,
                sector: "",
                status: "",
                q: params.q ?? "",
                callable: false,
                enriched: false,
                discovered: false,
                role: "",
                size: "",
                comp: "",
                includeEstimated: true,
                icpMin: "",
                hide: [],
                sort: "icp",
              }}
            />
            <DiscoveryReviewList
              result={review!}
              counts={reviewCounts!}
              facets={reviewFacets!}
              active={{
                reviewStatus,
                vertical: params.vertical ?? "",
                market: params.dmarket ?? "",
              }}
              buildHref={discoveryHref}
            />
            </>
          ) : tab === "call-list" ? (
            <CallListView items={callListItems!} />
          ) : tab === "listings" ? (
            <CrmListingsList
              result={listings!}
              params={{ ...scopedParams, tab: "listings" }}
              activeFilters={{
                q: params.q ?? "",
                board: params.board ?? "",
                sort:
                  params.sort && LISTING_SORTS.has(params.sort)
                    ? params.sort
                    : "newest",
              }}
            />
          ) : (
            <>
              <CrmFilterBar
                options={filterOptions!}
                tab={tab}
                active={{
                  state: scope.state,
                  city: scope.city,
                  sector: params.sector ?? "",
                  status: params.status ?? "",
                  q: params.q ?? "",
                  callable: params.callable === "1",
                  enriched: params.enriched === "1",
                  discovered: params.discovered === "1",
                  role: filters.roleType ?? "",
                  size: filters.sizeBand ?? "",
                  comp: params.comp ?? "",
                  includeEstimated: params.est !== "0",
                  icpMin: params.icpmin ?? "",
                  hide: filters.hideCategories ?? [],
                  sort: filters.sort ?? "icp",
                }}
              />
              <CrmLeadsList result={leads!} tab={tab} params={scopedParams} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CrmExportLink({
  params,
  hot,
}: {
  params: CrmSearchParams;
  hot: boolean;
}) {
  const qs = new URLSearchParams({ type: "crm-leads" });
  for (const [key, value] of Object.entries({
    market: params.market,
    state: params.state,
    city: params.city,
    sector: params.sector,
    status: params.status,
    q: params.q,
    callable: params.callable,
    enriched: params.enriched,
    discovered: params.discovered,
  })) {
    if (value) qs.set(key, value);
  }
  if (hot) qs.set("hot", "1");
  return (
    <a
      href={`/api/export/csv?${qs.toString()}`}
      download
      className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors shadow-sm"
    >
      ↓ Export CSV (filtered)
    </a>
  );
}
