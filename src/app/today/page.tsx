import { Suspense } from "react";
import Link from "next/link";
import { TodayListView } from "@/components/TodayListView";
import { TodayDatePicker } from "@/components/TodayDatePicker";
import {
  countCallableCompanies,
  getBacklogCompanies,
  getCallSheetCompanies,
  getLatestRunStats,
  getTodayGeoLabel,
} from "@/lib/queries";
import {
  businessListDate,
  businessListWindowLabel,
  resolveListDate,
} from "@/lib/timezone";

export const dynamic = "force-dynamic";

type ListTab = "call-sheet" | "backlog";

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; tab?: string }>;
}) {
  const { date: dateParam, tab: tabParam } = await searchParams;
  const tab: ListTab = tabParam === "backlog" ? "backlog" : "call-sheet";
  const listDate = resolveListDate(dateParam);
  const listLabel = businessListWindowLabel(dateParam);
  const currentBusinessDate = businessListDate();

  let callSheetCompanies;
  let backlogCompanies;
  let runStats;
  let geoLabel = "your focus area";
  try {
    [callSheetCompanies, backlogCompanies, runStats, geoLabel] = await Promise.all([
      getCallSheetCompanies(dateParam),
      getBacklogCompanies(),
      getLatestRunStats(dateParam),
      getTodayGeoLabel(),
    ]);
  } catch {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-2">Today&apos;s Call Sheet</h1>
        <p className="text-gray-500">
          Database not connected. Set DATABASE_URL and run{" "}
          <code className="text-sm bg-gray-100 dark:bg-gray-800 px-1 rounded">
            npm run db:push
          </code>
          .
        </p>
      </div>
    );
  }

  const companies = tab === "backlog" ? backlogCompanies : callSheetCompanies;
  const callableCount = countCallableCompanies(callSheetCompanies);

  function tabHref(nextTab: ListTab) {
    const params = new URLSearchParams();
    if (dateParam) params.set("date", dateParam);
    if (nextTab === "backlog") params.set("tab", "backlog");
    const qs = params.toString();
    return qs ? `/today?${qs}` : "/today";
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Today&apos;s Call Sheet</h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1">{listLabel}</p>
        <p className="text-sm text-gray-400 mt-1">
          {callSheetCompanies.length}{" "}
          {callSheetCompanies.length === 1 ? "lead" : "leads"} enriched today
          {callableCount > 0 && (
            <>
              {" "}
              · {callableCount} callable
            </>
          )}
          {" "}
          · {backlogCompanies.length} ranked backlog (all days) · {geoLabel}
        </p>
        <Suspense fallback={null}>
          <TodayDatePicker
            selectedDate={listDate}
            currentBusinessDate={currentBusinessDate}
          />
        </Suspense>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <Link
          href={tabHref("call-sheet")}
          className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
            tab === "call-sheet"
              ? "bg-gray-900 text-white border-gray-900 dark:bg-white dark:text-gray-900"
              : "border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
          }`}
        >
          Call sheet ({callSheetCompanies.length})
        </Link>
        <Link
          href={tabHref("backlog")}
          className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
            tab === "backlog"
              ? "bg-gray-900 text-white border-gray-900 dark:bg-white dark:text-gray-900"
              : "border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
          }`}
        >
          Backlog ({backlogCompanies.length})
        </Link>
      </div>

      {companies.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">
            {tab === "backlog"
              ? "Backlog is empty"
              : "No call sheet leads for this business day"}
          </p>
          <p className="text-sm mt-2">
            {tab === "backlog"
              ? "New scraped companies appear here until they are enriched."
              : "The nightly enrich stage populates today's ranked call sheet. Pick another date or check the backlog."}
          </p>
        </div>
      ) : (
        <TodayListView
          companies={companies}
          geoLabel={geoLabel}
          listMode={tab}
          runStats={runStats}
          backlogCount={backlogCompanies.length}
        />
      )}
    </div>
  );
}
