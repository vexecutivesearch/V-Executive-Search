import Link from "next/link";
import type { CrmListingsResult, CrmListingRow } from "@/lib/crm-queries";
import { CRM_LISTINGS_PAGE_SIZE } from "@/lib/crm-queries";
import { ContactPickerButton } from "@/components/enrich/ContactPickerButton";
import { CrmListingsFilterBar } from "./CrmListingsFilterBar";

const BOARD_STYLES: Record<string, string> = {
  linkedin: "bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300",
  indeed: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-300",
  google: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  zip_recruiter: "bg-teal-100 text-teal-800 dark:bg-teal-950/50 dark:text-teal-300",
};

export function BoardBadge({ board }: { board: string | null }) {
  if (!board) return <span className="text-gray-400">—</span>;
  const style =
    BOARD_STYLES[board.toLowerCase()] ??
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium lowercase ${style}`}
    >
      {board}
    </span>
  );
}

function postedLabel(row: CrmListingRow): string {
  const d = row.postedAt ?? row.firstSeenAt;
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

/**
 * Job Listings tab — the raw firehose. One row per posting, reposts shown
 * individually (they feed the hot signal). All markets, all dates.
 */
export function CrmListingsList({
  result,
  params,
  activeFilters,
}: {
  result: CrmListingsResult;
  params: Record<string, string | undefined>;
  activeFilters: { q: string; board: string; sort: string };
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

  const from = (result.page - 1) * CRM_LISTINGS_PAGE_SIZE + 1;
  const to = Math.min(result.totalMatched, result.page * CRM_LISTINGS_PAGE_SIZE);

  return (
    <div>
      <CrmListingsFilterBar boards={result.boards} active={activeFilters} />

      <p className="text-xs text-gray-500 mb-3">
        {result.totalMatched === 0
          ? "0 listings match"
          : `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${result.totalMatched.toLocaleString()} listings`}
        {" · one row per posting — reposts shown individually · server-paginated"}
      </p>

      {result.rows.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">No listings match these filters</p>
        </div>
      ) : (
        <div className="border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden bg-white dark:bg-gray-950 shadow-sm overflow-x-auto">
          <table className="w-full text-sm min-w-[52rem]">
            <thead>
              <tr className="text-left text-[10px] font-medium uppercase tracking-wide text-gray-500 bg-gray-50 dark:bg-gray-900/80 border-b border-gray-200 dark:border-gray-800">
                <th className="px-3 py-2">Posted</th>
                <th className="px-3 py-2">Title</th>
                <th className="px-3 py-2">Company</th>
                <th className="px-3 py-2">Location</th>
                <th className="px-3 py-2">Board</th>
                <th className="px-3 py-2">Link</th>
                <th className="px-3 py-2 text-right">Contacts</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-gray-100 dark:border-gray-900 last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-900/60"
                >
                  <td className="px-3 py-2.5 whitespace-nowrap text-gray-500 text-xs">
                    {postedLabel(row)}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="font-medium">{row.title}</span>
                    {row.sightingsCount > 1 && (
                      <span
                        className="ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300 whitespace-nowrap"
                        title="Times this posting was re-sighted — reposts feed the hot signal"
                      >
                        reposted {row.sightingsCount}×
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <Link
                      href={`/companies/${row.companyId}`}
                      className="hover:underline"
                    >
                      {row.companyName}
                    </Link>
                    {row.marketLabel && (
                      <span className="block text-[10px] text-gray-500">
                        {row.marketLabel}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-gray-600 dark:text-gray-400 text-xs">
                    {row.location ?? "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <BoardBadge board={row.board} />
                  </td>
                  <td className="px-3 py-2.5">
                    {row.url ? (
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 dark:text-blue-400 hover:underline text-xs"
                      >
                        View
                      </a>
                    ) : (
                      <span className="text-gray-400 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <ContactPickerButton companyId={row.companyId} compact />
                    {row.contactCount > 0 && (
                      <span className="block text-[10px] text-gray-400 mt-0.5">
                        {row.contactCount} saved
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
