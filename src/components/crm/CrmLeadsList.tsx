import Link from "next/link";
import type { CrmLeadsResult } from "@/lib/crm-queries";
import { CRM_PAGE_SIZE } from "@/lib/crm-queries";
import { CrmLeadRow } from "./CrmLeadRow";

/** Ranked, filtered leads with server-side pagination (500/page). */
export function CrmLeadsList({
  result,
  tab,
  params,
}: {
  result: CrmLeadsResult;
  tab: "all" | "hot";
  params: Record<string, string | undefined>;
}) {
  function pageHref(page: number): string {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value && key !== "page") qs.set(key, value);
    }
    if (page > 1) qs.set("page", String(page));
    const s = qs.toString();
    return s ? `/crm?${s}` : "/crm";
  }

  const from = (result.page - 1) * CRM_PAGE_SIZE + 1;
  const to = Math.min(result.totalMatched, result.page * CRM_PAGE_SIZE);

  return (
    <div>
      <p className="text-xs text-gray-500 mb-3">
        {result.totalMatched === 0
          ? "0 leads match"
          : `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${result.totalMatched.toLocaleString()} leads`}
        {" · filtered server-side, then ranked"}
        {tab === "hot" && " · hot hiring signals only"}
      </p>

      {result.rows.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">No leads match these filters</p>
          <p className="text-sm mt-2">
            Everything scraped is here — try clearing the market, state, or
            sector filter.
          </p>
        </div>
      ) : (
        <div className="border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden bg-white dark:bg-gray-950 shadow-sm">
          <div className="hidden sm:grid grid-cols-[3.5rem_minmax(0,1.3fr)_minmax(0,1.3fr)_7rem_5rem_auto] gap-x-3 px-4 py-2 text-[10px] font-medium uppercase tracking-wide text-gray-500 bg-gray-50 dark:bg-gray-900/80 border-b border-gray-200 dark:border-gray-800">
            <span>Score</span>
            <span>Company</span>
            <span>Job</span>
            <span>Market</span>
            <span>Contacts</span>
            <span className="text-right pr-6">Action</span>
          </div>

          {result.rows.map((row) => (
            <CrmLeadRow key={row.id} row={row} />
          ))}
        </div>
      )}

      {result.pageCount > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm">
          {result.page > 1 ? (
            <Link
              href={pageHref(result.page - 1)}
              className="px-3 py-1.5 rounded-md border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-gray-500">
            Page {result.page} of {result.pageCount}
          </span>
          {result.page < result.pageCount ? (
            <Link
              href={pageHref(result.page + 1)}
              className="px-3 py-1.5 rounded-md border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              Next →
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </div>
  );
}
