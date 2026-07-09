import { Suspense } from "react";
import { TodayListView } from "@/components/TodayListView";
import { TodayDatePicker } from "@/components/TodayDatePicker";
import {
  countCallableCompanies,
  getDailyListCompanies,
  getTodayGeoLabel,
} from "@/lib/queries";
import {
  businessListDate,
  businessListWindowLabel,
  resolveListDate,
} from "@/lib/timezone";

export const dynamic = "force-dynamic";

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { date: dateParam } = await searchParams;
  const listDate = resolveListDate(dateParam);
  const listLabel = businessListWindowLabel(dateParam);
  const currentBusinessDate = businessListDate();

  let companies;
  let geoLabel = "your focus area";
  try {
    [companies, geoLabel] = await Promise.all([
      getDailyListCompanies(dateParam),
      getTodayGeoLabel(),
    ]);
  } catch {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-2">Today&apos;s List</h1>
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

  const callableCount = countCallableCompanies(companies);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Today&apos;s List</h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1">{listLabel}</p>
        <p className="text-sm text-gray-400 mt-1">
          {companies.length} {companies.length === 1 ? "company" : "companies"}{" "}
          in {geoLabel}
          {callableCount > 0 && (
            <>
              {" "}
              · {callableCount} with contacts
            </>
          )}
        </p>
        <Suspense fallback={null}>
          <TodayDatePicker
            selectedDate={listDate}
            currentBusinessDate={currentBusinessDate}
          />
        </Suspense>
      </div>

      {companies.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">No companies for this business day</p>
          <p className="text-sm mt-2">
            Lists populate from the 6 AM and 6 PM pipeline runs. Pick another
            date or wait for the next scheduled run.
          </p>
        </div>
      ) : (
        <TodayListView companies={companies} geoLabel={geoLabel} />
      )}
    </div>
  );
}
