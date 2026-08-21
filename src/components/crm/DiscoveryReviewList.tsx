import Link from "next/link";
import type { CompanyReviewStatus } from "@/lib/db/schema";
import type {
  ReviewQueueCounts,
  ReviewQueueResult,
} from "@/lib/discovery/review-queue";
import { getVerticalConfig } from "@/lib/discovery/verticals";
import { DiscoveryReviewRow } from "./DiscoveryReviewRow";
import { DiscoveryRunLauncher } from "./DiscoveryRunLauncher";

const STATUS_TABS: Array<{ value: CompanyReviewStatus | "all"; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "review_later", label: "Review later" },
  { value: "rejected", label: "Rejected" },
  { value: "already_contacted", label: "Already contacted" },
  { value: "existing_client", label: "Existing client" },
  { value: "do_not_contact", label: "Do not contact" },
  { value: "all", label: "All" },
];

export function DiscoveryReviewList({
  result,
  counts,
  facets,
  active,
  buildHref,
}: {
  result: ReviewQueueResult;
  counts: ReviewQueueCounts;
  facets: { verticals: string[]; markets: string[] };
  active: {
    reviewStatus: CompanyReviewStatus | "all";
    vertical: string;
    market: string;
  };
  buildHref: (changes: Record<string, string | null>) => string;
}) {
  const chipClass = (on: boolean) =>
    `px-2.5 py-1 rounded-full text-xs border transition-colors ${
      on
        ? "bg-gray-900 text-white border-gray-900 dark:bg-white dark:text-gray-900"
        : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
    }`;

  return (
    <div>
      <DiscoveryRunLauncher />

      <div className="flex flex-wrap gap-1.5 mb-3">
        {STATUS_TABS.map((tab) => {
          const count =
            tab.value === "all" ? counts.total : counts[tab.value] ?? 0;
          return (
            <Link
              key={tab.value}
              href={buildHref({
                review: tab.value === "pending" ? null : tab.value,
                page: null,
              })}
              className={chipClass(active.reviewStatus === tab.value)}
            >
              {tab.label} ({count.toLocaleString()})
            </Link>
          );
        })}
      </div>

      {(facets.verticals.length > 0 || facets.markets.length > 0) && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          <Link
            href={buildHref({ vertical: null, page: null })}
            className={chipClass(!active.vertical)}
          >
            All verticals
          </Link>
          {facets.verticals.map((vertical) => (
            <Link
              key={vertical}
              href={buildHref({ vertical, page: null })}
              className={chipClass(active.vertical === vertical)}
            >
              {getVerticalConfig(vertical)?.label ?? vertical}
            </Link>
          ))}
          {facets.markets.map((market) => (
            <Link
              key={market}
              href={buildHref({
                dmarket: active.market === market ? null : market,
                page: null,
              })}
              className={chipClass(active.market === market)}
            >
              {market}
            </Link>
          ))}
        </div>
      )}

      {result.rows.length === 0 ? (
        <p className="text-sm text-gray-500">
          Nothing in this bucket yet. Pick a market and vertical above and run
          discovery — it costs one Apollo organization-search credit and reveals
          no contacts.
        </p>
      ) : (
        <div className="space-y-3">
          {result.rows.map((row) => (
            <DiscoveryReviewRow key={row.id} row={row} />
          ))}
        </div>
      )}

      {result.pageCount > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm">
          <span className="text-gray-500">
            Page {result.page} of {result.pageCount} ·{" "}
            {result.totalMatched.toLocaleString()} companies
          </span>
          <div className="flex gap-2">
            {result.page > 1 && (
              <Link
                href={buildHref({ page: String(result.page - 1) })}
                className="px-3 py-1.5 rounded-md border border-gray-200 dark:border-gray-700"
              >
                Previous
              </Link>
            )}
            {result.page < result.pageCount && (
              <Link
                href={buildHref({ page: String(result.page + 1) })}
                className="px-3 py-1.5 rounded-md border border-gray-200 dark:border-gray-700"
              >
                Next
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
