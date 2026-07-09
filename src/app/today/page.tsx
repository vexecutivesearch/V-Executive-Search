import { Suspense } from "react";
import Link from "next/link";
import { TodayListView } from "@/components/TodayListView";
import { TodayDatePicker } from "@/components/TodayDatePicker";
import {
  countCallableCompanies,
  getBacklogForDateRange,
  getCallSheetCompanies,
  getLatestRunStats,
  getTodayGeoLabel,
} from "@/lib/queries";
import {
  backlogSummaryLabel,
  listDateRangeLabel,
  resolveListDateRange,
} from "@/lib/list-date-range";
import { businessListDate } from "@/lib/timezone";

export const dynamic = "force-dynamic";

type ListTab = "call-sheet" | "backlog";

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; from?: string; to?: string; tab?: string }>;
}) {
  const params = await searchParams;
  const { date: dateParam, from: fromParam, to: toParam, tab: tabParam } = params;
  const tab: ListTab = tabParam === "backlog" ? "backlog" : "call-sheet";
  const listRange = resolveListDateRange({
    date: dateParam,
    from: fromParam,
    to: toParam,
  });
  const listLabel = listDateRangeLabel(listRange);
  const currentBusinessDate = businessListDate();

  let callSheetCompanies;
  let backlogCompanies;
  let runStats;
  let geoLabel = "your focus area";
  try {
    [callSheetCompanies, backlogCompanies, runStats, geoLabel] = await Promise.all([
      getCallSheetCompanies(listRange),
      getBacklogForDateRange(listRange),
      getLatestRunStats(listRange.snapshotDate),
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
  const backlogLabel = backlogSummaryLabel(listRange, backlogCompanies.length);

  function tabHref(nextTab: ListTab) {
    const qs = new URLSearchParams();
    if (listRange.mode === "range") {
      qs.set("from", listRange.from);
      qs.set("to", listRange.to);
    } else if (!listRange.isToday) {
      qs.set("date", listRange.from);
    }
    if (nextTab === "backlog") qs.set("tab", "backlog");
    const s = qs.toString();
    return s ? `/today?${s}` : "/today";
  }

  const callSheetTabLabel = `Call sheet (${callSheetCompanies.length})`;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Today&apos;s Call Sheet</h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1">{listLabel}</p>
        <p className="text-sm text-gray-400 mt-1">
          {callSheetCompanies.length}{" "}
          {callSheetCompanies.length === 1 ? "lead" : "leads"} enriched
          {listRange.mode === "range"
            ? ` ${listRange.from === listRange.to ? "on this day" : "in range"}`
            : listRange.isToday
              ? " today"
              : " on this day"}
          {callableCount > 0 && (
            <>
              {" "}
              · {callableCount} callable
            </>
          )}
          {" "}
          · {backlogLabel} · {geoLabel}
        </p>
        <Suspense fallback={null}>
          <TodayDatePicker
            selectedRange={listRange}
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
          {callSheetTabLabel}
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
              ? "No backlog for this date"
              : "No call sheet leads for this period"}
          </p>
          <p className="text-sm mt-2">
            {tab === "backlog"
              ? listRange.isToday
                ? "New scraped companies appear here until they are enriched."
                : "Backlog is reconstructed from scrape dates, enrich history, and contacts as of the selected day."
              : "The nightly enrich stage populates the ranked call sheet. Pick another date or check the backlog."}
          </p>
        </div>
      ) : (
        <TodayListView
          companies={companies}
          geoLabel={geoLabel}
          listMode={tab}
          runStats={runStats}
          backlogCount={backlogCompanies.length}
          listRange={listRange}
        />
      )}
    </div>
  );
}
