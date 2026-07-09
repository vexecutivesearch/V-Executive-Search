import { Suspense } from "react";
import Link from "next/link";
import { TodayListView } from "@/components/TodayListView";
import { JobsTable } from "@/components/JobsTable";
import { CompanySearch } from "@/components/CompanySearch";
import {
  getBacklogCompanies,
  getCallSheetCompanies,
  getCompaniesByStatus,
  getInFocusJobListings,
  getLatestRunStats,
  getTodayGeoLabel,
} from "@/lib/queries";
import { CompanyStatus } from "@/lib/db/schema";
import { STATUS_LABELS } from "@/lib/utils";

export const dynamic = "force-dynamic";

const FILTERS: { label: string; value?: CompanyStatus }[] = [
  { label: "All" },
  { label: STATUS_LABELS.new, value: "new" },
  { label: STATUS_LABELS.contacted, value: "contacted" },
  { label: STATUS_LABELS.meeting, value: "meeting" },
  { label: STATUS_LABELS.client, value: "client" },
  { label: STATUS_LABELS.skipped, value: "skipped" },
];

type CompaniesView = "leads" | "jobs";
type LeadList = "call-sheet" | "backlog" | "all";

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    q?: string;
    view?: string;
    list?: string;
  }>;
}) {
  const { status, q, view: viewParam, list: listParam } = await searchParams;
  const view: CompaniesView = viewParam === "jobs" ? "jobs" : "leads";
  const filterStatus = FILTERS.find((f) => f.value === status)?.value;
  const showLeadSplit = view === "leads" && (!filterStatus || filterStatus === "new");
  const leadList: LeadList =
    listParam === "backlog"
      ? "backlog"
      : listParam === "all"
        ? "all"
        : "call-sheet";

  let companies;
  let callSheetCompanies: Awaited<ReturnType<typeof getCallSheetCompanies>> = [];
  let backlogCompanies: Awaited<ReturnType<typeof getBacklogCompanies>> = [];
  let runStats: Awaited<ReturnType<typeof getLatestRunStats>> | null = null;
  let jobs: Awaited<ReturnType<typeof getInFocusJobListings>> = [];
  let geoLabel = "your focus area";
  try {
    if (showLeadSplit && leadList === "call-sheet") {
      [callSheetCompanies, runStats, geoLabel] = await Promise.all([
        getCallSheetCompanies(),
        getLatestRunStats(),
        getTodayGeoLabel(),
      ]);
      companies = callSheetCompanies;
    } else if (showLeadSplit && leadList === "backlog") {
      [backlogCompanies, runStats, geoLabel] = await Promise.all([
        getBacklogCompanies(),
        getLatestRunStats(),
        getTodayGeoLabel(),
      ]);
      companies = backlogCompanies;
    } else {
      const [companiesResult, geoLabelResult, jobsResult, statsResult] =
        await Promise.all([
          getCompaniesByStatus(filterStatus, q),
          getTodayGeoLabel(),
          view === "jobs" ? getInFocusJobListings() : Promise.resolve([]),
          showLeadSplit ? getLatestRunStats() : Promise.resolve(null),
        ]);
      companies = companiesResult;
      geoLabel = geoLabelResult;
      jobs = jobsResult;
      runStats = statsResult;
    }

    if (view === "jobs" && jobs.length === 0) {
      jobs = await getInFocusJobListings();
    }
  } catch {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold">Companies</h1>
        <p className="text-gray-500 mt-2">Database not connected.</p>
      </div>
    );
  }

  function tabHref(nextView: CompaniesView) {
    const params = new URLSearchParams();
    params.set("view", nextView);
    if (filterStatus) params.set("status", filterStatus);
    if (q?.trim()) params.set("q", q.trim());
    if (showLeadSplit && leadList !== "call-sheet") params.set("list", leadList);
    return `/companies?${params.toString()}`;
  }

  function listHref(nextList: LeadList) {
    const params = new URLSearchParams();
    params.set("view", "leads");
    if (filterStatus) params.set("status", filterStatus);
    if (q?.trim()) params.set("q", q.trim());
    if (nextList !== "call-sheet") params.set("list", nextList);
    return `/companies?${params.toString()}`;
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-1">Companies</h1>
      <p className="text-sm text-gray-400 mb-4">
        {geoLabel} · {companies.length}{" "}
        {companies.length === 1 ? "company" : "companies"}
        {view === "jobs" && (
          <>
            {" "}
            · {jobs.length} job{jobs.length === 1 ? "" : "s"}
          </>
        )}
      </p>

      <div className="flex flex-wrap gap-2 mb-6">
        <Link
          href={tabHref("leads")}
          className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
            view === "leads"
              ? "bg-gray-900 text-white border-gray-900 dark:bg-white dark:text-gray-900"
              : "border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
          }`}
        >
          Leads
        </Link>
        <Link
          href={tabHref("jobs")}
          className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
            view === "jobs"
              ? "bg-gray-900 text-white border-gray-900 dark:bg-white dark:text-gray-900"
              : "border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
          }`}
        >
          Job listings
        </Link>
      </div>

      {view === "leads" ? (
        <>
          <div className="flex flex-wrap gap-2 mb-4">
            {FILTERS.map((f) => {
              const params = new URLSearchParams();
              params.set("view", "leads");
              if (f.value) params.set("status", f.value);
              if (q?.trim()) params.set("q", q.trim());
              if (showLeadSplit && leadList !== "call-sheet") {
                params.set("list", leadList);
              }
              const href = `/companies?${params.toString()}`;
              const active = (filterStatus ?? undefined) === f.value;
              return (
                <Link
                  key={f.label}
                  href={href}
                  className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                    active
                      ? "bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600 font-medium"
                      : "border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
                  }`}
                >
                  {f.label}
                </Link>
              );
            })}
          </div>

          {showLeadSplit && (
            <div className="flex flex-wrap gap-2 mb-4">
              <Link
                href={listHref("call-sheet")}
                className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                  leadList === "call-sheet"
                    ? "bg-blue-600 text-white border-blue-600"
                    : "border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
              >
                Call sheet
              </Link>
              <Link
                href={listHref("backlog")}
                className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                  leadList === "backlog"
                    ? "bg-blue-600 text-white border-blue-600"
                    : "border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
              >
                Backlog
              </Link>
              <Link
                href={listHref("all")}
                className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                  leadList === "all"
                    ? "bg-blue-600 text-white border-blue-600"
                    : "border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
              >
                All new
              </Link>
            </div>
          )}

          <Suspense fallback={null}>
            <CompanySearch initialQuery={q} view="leads" status={filterStatus} />
          </Suspense>

          {companies.length === 0 ? (
            <p className="text-gray-400 py-12 text-center">No companies match</p>
          ) : (
            <TodayListView
              companies={companies}
              geoLabel={geoLabel}
              listMode={leadList === "backlog" ? "backlog" : "call-sheet"}
              runStats={runStats}
              showFunnel={showLeadSplit && leadList !== "all"}
            />
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-gray-500 mb-4">
            In-focus job postings · click <strong>Enrich</strong> to find contacts
          </p>
          {jobs.length === 0 ? (
            <p className="text-gray-400">
              No listings in {geoLabel} yet. Run the pipeline from Admin.
            </p>
          ) : (
            <JobsTable jobs={jobs} />
          )}
        </>
      )}
    </div>
  );
}
