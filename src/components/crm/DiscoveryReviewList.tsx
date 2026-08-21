import Link from "next/link";
import type { CompanyReviewStatus } from "@/lib/db/schema";
import type { ReviewBucketCounts } from "@/lib/crm-queries";
import type { ReviewQueueResult } from "@/lib/discovery/review-queue";
import { activeReviewFilters, type ReviewScope } from "@/lib/crm-location-scope";
import { getVerticalConfig } from "@/lib/discovery/verticals";
import { DiscoveryReviewRow } from "./DiscoveryReviewRow";

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

/** Clears every queue filter at once, leaving the bucket alone. */
const CLEARED_SCOPE = { vertical: null, dmarket: null, q: null, page: null };

export function DiscoveryReviewList({
  result,
  counts,
  queueTotal,
  facets,
  active,
  buildHref,
}: {
  result: ReviewQueueResult;
  /** Per-bucket counts under the same scope the list was read with. */
  counts: ReviewBucketCounts;
  /** Companies in the queue ignoring every filter — "is this a first run?". */
  queueTotal: number;
  facets: { verticals: string[]; markets: string[] };
  active: { reviewStatus: CompanyReviewStatus | "all" } & ReviewScope;
  buildHref: (changes: Record<string, string | null>) => string;
}) {
  const chipClass = (on: boolean) =>
    `px-2.5 py-1 rounded-full text-xs border transition-colors ${
      on
        ? "bg-gray-900 text-white border-gray-900 dark:bg-white dark:text-gray-900"
        : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
    }`;

  const groupLabelClass =
    "text-[10px] font-medium uppercase tracking-wide text-gray-500 self-center mr-0.5";

  /**
   * The bucket on screen is counted by the list itself, so the number on the
   * chip is the number of rows the query matched — never a wider count that
   * promises rows a filter then removes.
   */
  const countFor = (bucket: CompanyReviewStatus | "all"): number => {
    if (bucket === active.reviewStatus) return result.totalMatched;
    return bucket === "all" ? counts.total : counts[bucket] ?? 0;
  };

  const bucketLabel =
    STATUS_TABS.find((t) => t.value === active.reviewStatus)?.label ?? "Pending";

  const filterLabels = activeReviewFilters(active).map((filter) => {
    if (filter.key === "vertical") {
      return `vertical ${getVerticalConfig(filter.value)?.label ?? filter.value}`;
    }
    if (filter.key === "dmarket") return `found in ${filter.value}`;
    return `search “${filter.value}”`;
  });
  const clearHref = buildHref(CLEARED_SCOPE);

  return (
    <div>
      <h2 className="text-sm font-semibold">
        Review queue — companies already found
      </h2>
      <p className="text-xs text-gray-500 mt-0.5 mb-3">
        Narrowed by the market each company was <em>found in</em>, not by
        job-listing geography — a company Apollo just found may have no listings
        yet.
      </p>

      <div className="flex flex-wrap gap-1.5 mb-3">
        <span className={groupLabelClass}>Bucket</span>
        {STATUS_TABS.map((tab) => (
          <Link
            key={tab.value}
            href={buildHref({
              review: tab.value === "pending" ? null : tab.value,
              page: null,
            })}
            className={chipClass(active.reviewStatus === tab.value)}
          >
            {tab.label} ({countFor(tab.value).toLocaleString()})
          </Link>
        ))}
      </div>

      {facets.verticals.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          <span className={groupLabelClass}>Vertical</span>
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
        </div>
      )}

      {facets.markets.length > 0 && (
        /* The market a row was *found in* — the queue's only geography. */
        <div className="flex flex-wrap gap-1.5 mb-4">
          <span className={groupLabelClass}>Found in</span>
          <Link
            href={buildHref({ dmarket: null, page: null })}
            className={chipClass(!active.market)}
          >
            All markets
          </Link>
          {facets.markets.map((market) => (
            <Link
              key={market}
              href={buildHref({ dmarket: market, page: null })}
              className={chipClass(active.market === market)}
            >
              {market}
            </Link>
          ))}
        </div>
      )}

      {filterLabels.length > 0 && (
        <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
          Filtered to {filterLabels.join(" · ")} —{" "}
          {result.totalMatched.toLocaleString()} of{" "}
          {queueTotal.toLocaleString()} in the queue.{" "}
          <Link href={clearHref} className="text-blue-600 dark:text-blue-400 underline">
            Clear queue filters
          </Link>
        </p>
      )}

      {result.rows.length === 0 ? (
        queueTotal === 0 ? (
          <p className="text-sm text-gray-500">
            Nothing discovered yet. Pick a vertical and an Apollo market above
            and run discovery — it costs one Apollo organization-search credit
            and reveals no contacts.
          </p>
        ) : filterLabels.length > 0 ? (
          <div className="text-sm text-gray-600 dark:text-gray-400 space-y-2">
            <p>
              No {bucketLabel.toLowerCase()} company matches{" "}
              {filterLabels.join(" · ")}. The queue holds{" "}
              {queueTotal.toLocaleString()}{" "}
              {queueTotal === 1 ? "company" : "companies"} — the filters are
              hiding them, not the discovery run.
            </p>
            <p>
              <Link
                href={clearHref}
                className="text-blue-600 dark:text-blue-400 underline"
              >
                Clear queue filters
              </Link>
            </p>
          </div>
        ) : (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Nothing in the {bucketLabel.toLowerCase()} bucket. Every other
            bucket&apos;s count is on the chips above.
          </p>
        )
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
