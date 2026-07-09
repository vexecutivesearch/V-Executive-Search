import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { TodayListView } from "@/components/TodayListView";
import { JobsTable } from "@/components/JobsTable";
import { CompanySearch } from "@/components/CompanySearch";
import {
  getCompaniesByStatus,
  getInFocusJobListings,
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

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; view?: string }>;
}) {
  const { status, q, view: viewParam } = await searchParams;
  const view: CompaniesView = viewParam === "jobs" ? "jobs" : "leads";
  const filterStatus = FILTERS.find((f) => f.value === status)?.value;

  let companies;
  let jobs;
  let geoLabel = "your focus area";
  try {
    [companies, jobs, geoLabel] = await Promise.all([
      getCompaniesByStatus(filterStatus, q),
      getInFocusJobListings(),
      getTodayGeoLabel(),
    ]);
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
    return `/companies?${params.toString()}`;
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-1">Companies</h1>
      <p className="text-sm text-gray-400 mb-4">
        {geoLabel} · {companies.length}{" "}
        {companies.length === 1 ? "company" : "companies"} · {jobs.length} job
        {jobs.length === 1 ? "" : "s"}
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

          <Suspense fallback={null}>
            <CompanySearch initialQuery={q} view="leads" status={filterStatus} />
          </Suspense>

          {companies.length === 0 ? (
            <p className="text-gray-400 py-12 text-center">No companies match</p>
          ) : (
            <TodayListView companies={companies} geoLabel={geoLabel} />
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
