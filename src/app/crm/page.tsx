import Link from "next/link";
import { CrmFilterBar } from "@/components/crm/CrmFilterBar";
import { CrmLeadsList } from "@/components/crm/CrmLeadsList";
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
import type { CompanyStatus } from "@/lib/db/schema";
import { businessListDate } from "@/lib/timezone";

export const dynamic = "force-dynamic";

type CrmTab = "all" | "listings" | "call-list" | "hot";

const COMPANY_STATUSES = new Set(["new", "contacted", "meeting", "client", "skipped"]);
const SORTS = new Set(["score", "recent", "name"]);
const LISTING_SORTS = new Set(["newest", "reposts"]);

type CrmSearchParams = {
  tab?: string;
  market?: string;
  state?: string;
  city?: string;
  sector?: string;
  status?: string;
  board?: string;
  q?: string;
  callable?: string;
  enriched?: string;
  sort?: string;
  page?: string;
};

function parseTab(raw: string | undefined): CrmTab {
  if (raw === "call-list") return "call-list";
  if (raw === "hot") return "hot";
  if (raw === "listings") return "listings";
  return "all";
}

function parseFilters(params: CrmSearchParams): CrmLeadFilters {
  return {
    // The Pipeline UI is location-led (State → City). source_market remains
    // available to the JSON API for provenance queries, but is not a view gate.
    market: undefined,
    state: params.state?.trim() || undefined,
    city: params.city?.trim() || undefined,
    sector: params.sector?.trim() || undefined,
    status:
      params.status && COMPANY_STATUSES.has(params.status)
        ? (params.status as CompanyStatus)
        : undefined,
    search: params.q?.trim() || undefined,
    callableOnly: params.callable === "1",
    enrichedOnly: params.enriched === "1",
    sort: params.sort && SORTS.has(params.sort) ? (params.sort as CrmSort) : "score",
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
  const filters = parseFilters(params);

  let filterOptions;
  let counts;
  let kpis;
  let rail;
  let leads: CrmLeadsResult | null = null;
  let listings: CrmListingsResult | null = null;
  let callListItems: CallListItem[] | null = null;
  try {
    [filterOptions, counts, kpis, rail] = await Promise.all([
      getCrmFilterOptions(),
      getCrmTabCounts(),
      getCrmKpis(businessListDate()),
      getLocationRailCounts(),
    ]);
    if (tab === "call-list") {
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
  } catch {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-2">Pipeline</h1>
        <p className="text-gray-500">
          Database not connected or schema out of date. Set DATABASE_URL and run{" "}
          <code className="text-sm bg-gray-100 dark:bg-gray-800 px-1 rounded">
            npm run db:push
          </code>{" "}
          (adds the call_list_entries table and companies.source_market column).
        </p>
      </div>
    );
  }

  const carriedFilterEntries = {
    market: params.market,
    state: params.state,
    city: params.city,
    sector: params.sector,
    status: params.status,
    board: params.board,
    q: params.q,
    callable: params.callable,
    enriched: params.enriched,
    sort: params.sort,
  };

  function tabHref(nextTab: CrmTab): string {
    const qs = new URLSearchParams();
    // Filters carry across the data tabs; the Call List is a curated queue.
    if (nextTab !== "call-list") {
      for (const [key, value] of Object.entries(carriedFilterEntries)) {
        if (value) qs.set(key, value);
      }
    }
    if (nextTab !== "all") qs.set("tab", nextTab);
    const s = qs.toString();
    return s ? `/crm?${s}` : "/crm";
  }

  function locationHref(state: string | null, city?: string | null): string {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(carriedFilterEntries)) {
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
        </div>
        {tab === "call-list" ? (
          <a
            href="/api/export/csv?type=call-list"
            download
            className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors shadow-sm"
          >
            ↓ Export call list CSV
          </a>
        ) : tab !== "listings" ? (
          <CrmExportLink params={params} hot={tab === "hot"} />
        ) : null}
      </div>

      <div className="flex gap-6">
        {tab !== "call-list" && (
          <LocationRail
            total={rail!.total}
            states={rail!.states}
            activeState={params.state ?? ""}
            activeCity={params.city ?? ""}
            buildHref={locationHref}
          />
        )}

        <div className="flex-1 min-w-0">
          {tab === "call-list" ? (
            <CallListView items={callListItems!} />
          ) : tab === "listings" ? (
            <CrmListingsList
              result={listings!}
              params={{ ...params, tab: "listings" }}
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
                  state: params.state ?? "",
                  city: params.city ?? "",
                  sector: params.sector ?? "",
                  status: params.status ?? "",
                  q: params.q ?? "",
                  callable: params.callable === "1",
                  enriched: params.enriched === "1",
                  sort: filters.sort ?? "score",
                }}
              />
              <CrmLeadsList result={leads!} tab={tab} params={params} />
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
