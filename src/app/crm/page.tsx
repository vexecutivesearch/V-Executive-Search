import Link from "next/link";
import { CrmFilterBar } from "@/components/crm/CrmFilterBar";
import { CrmLeadsList } from "@/components/crm/CrmLeadsList";
import { CallListView } from "@/components/crm/CallListView";
import {
  getCallListItems,
  getCrmFilterOptions,
  getCrmLeads,
  getCrmTabCounts,
  type CrmLeadFilters,
  type CrmLeadsResult,
  type CallListItem,
  type CrmSort,
} from "@/lib/crm-queries";
import type { CompanyStatus } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

type CrmTab = "all" | "call-list" | "hot";

const COMPANY_STATUSES = new Set(["new", "contacted", "meeting", "client", "skipped"]);
const SORTS = new Set(["score", "recent", "name"]);

type CrmSearchParams = {
  tab?: string;
  market?: string;
  state?: string;
  city?: string;
  sector?: string;
  status?: string;
  q?: string;
  callable?: string;
  enriched?: string;
  sort?: string;
  page?: string;
};

function parseFilters(params: CrmSearchParams): CrmLeadFilters {
  return {
    market: params.market?.trim() || undefined,
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
  const tab: CrmTab =
    params.tab === "call-list" ? "call-list" : params.tab === "hot" ? "hot" : "all";
  const filters = parseFilters(params);

  let filterOptions;
  let counts;
  let leads: CrmLeadsResult | null = null;
  let callListItems: CallListItem[] | null = null;
  try {
    [filterOptions, counts] = await Promise.all([
      getCrmFilterOptions(),
      getCrmTabCounts(),
    ]);
    if (tab === "call-list") {
      callListItems = await getCallListItems();
    } else {
      leads = await getCrmLeads({
        ...filters,
        hotOnly: tab === "hot" ? true : filters.hotOnly,
      });
    }
  } catch {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-2">CRM</h1>
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

  function tabHref(nextTab: CrmTab): string {
    const qs = new URLSearchParams();
    // Filters carry across All Leads ↔ Hot; the Call List is a curated queue.
    if (nextTab !== "call-list") {
      for (const [key, value] of Object.entries({
        market: params.market,
        state: params.state,
        city: params.city,
        sector: params.sector,
        status: params.status,
        q: params.q,
        callable: params.callable,
        enriched: params.enriched,
        sort: params.sort,
      })) {
        if (value) qs.set(key, value);
      }
    }
    if (nextTab !== "all") qs.set("tab", nextTab);
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
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">CRM</h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1">
          Your whole book of business — every market, every date. Independent of
          the Admin scrape focus and today&apos;s date; slice it with filters.
        </p>
        <p className="text-sm text-gray-400 mt-1">
          {counts!.allLeads.toLocaleString()} companies scraped ·{" "}
          {counts!.hot.toLocaleString()} hot · {counts!.callList.toLocaleString()}{" "}
          on call list
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex flex-wrap gap-2">
          <Link href={tabHref("all")} className={tabClass(tab === "all")}>
            All leads ({counts!.allLeads.toLocaleString()})
          </Link>
          <Link
            href={tabHref("call-list")}
            className={tabClass(tab === "call-list")}
          >
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
        ) : (
          <CrmExportLink params={params} hot={tab === "hot"} />
        )}
      </div>

      {tab === "call-list" ? (
        <CallListView items={callListItems!} />
      ) : (
        <>
          <CrmFilterBar
            options={filterOptions!}
            tab={tab}
            active={{
              market: params.market ?? "",
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
