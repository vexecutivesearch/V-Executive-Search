"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { CompanyCardData } from "@/components/CompanyCard";
import { EnrichButton } from "@/components/EnrichButton";
import {
  buildHotListings,
  type HotListing,
  type HotListingFilterState,
  type HotListingSort,
} from "@/lib/hot-listings";
import { hotMaxEmployees, hotMinEmployees } from "@/lib/hot-listings-config";
import { ROLE_FAMILIES, type RoleFamily } from "@/lib/role-families";
import type { ListDateRange } from "@/lib/list-date-range";

export function HotListingsView({
  companies,
  listRange,
}: {
  companies: CompanyCardData[];
  listRange: ListDateRange;
}) {
  const [roleFamilies, setRoleFamilies] = useState<RoleFamily[]>([
    ...ROLE_FAMILIES,
  ]);
  const [salaryFilter, setSalaryFilter] =
    useState<HotListingFilterState["salaryFilter"]>("any");
  const [salaryMinUsd, setSalaryMinUsd] = useState(80000);
  const [includeUnknownSalary, setIncludeUnknownSalary] = useState(true);
  const [newTodayOnly, setNewTodayOnly] = useState(false);
  const [sort, setSort] = useState<HotListingSort>("score");

  const { listings, hidden } = useMemo(
    () =>
      buildHotListings(companies, {
        filter: {
          roleFamilies,
          salaryFilter,
          salaryMinUsd,
          includeUnknownSalary,
          newTodayOnly,
        },
        sort,
        listDate: listRange.snapshotDate,
      }),
    [
      companies,
      roleFamilies,
      salaryFilter,
      salaryMinUsd,
      includeUnknownSalary,
      newTodayOnly,
      sort,
      listRange.snapshotDate,
    ],
  );

  function toggleFamily(family: RoleFamily) {
    setRoleFamilies((prev) => {
      if (prev.includes(family)) {
        const next = prev.filter((f) => f !== family);
        return next.length ? next : [...ROLE_FAMILIES];
      }
      return [...prev, family];
    });
  }

  const allFamiliesSelected = roleFamilies.length === ROLE_FAMILIES.length;

  return (
    <div>
      <div className="sticky top-[3.25rem] z-10 -mx-4 px-4 py-3 mb-3 bg-gray-50/95 dark:bg-gray-950/95 backdrop-blur border-y border-gray-200 dark:border-gray-800">
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
          Curated openings to pitch — mid-size ({hotMinEmployees()}–
          {hotMaxEmployees()} employees), in-focus geo, target role families.
          Scrape stays broad; this is a view.
        </p>

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex flex-wrap gap-1.5">
            {ROLE_FAMILIES.map((family) => {
              const on = roleFamilies.includes(family);
              return (
                <button
                  key={family}
                  type="button"
                  onClick={() => toggleFamily(family)}
                  className={`text-xs px-2 py-1 rounded-md border transition-colors ${
                    on
                      ? "bg-gray-900 text-white border-gray-900 dark:bg-white dark:text-gray-900"
                      : "border-gray-200 dark:border-gray-700 text-gray-500"
                  }`}
                >
                  {family}
                </button>
              );
            })}
            {!allFamiliesSelected && (
              <button
                type="button"
                onClick={() => setRoleFamilies([...ROLE_FAMILIES])}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline px-1"
              >
                All families
              </button>
            )}
          </div>

          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as HotListingSort)}
            className="text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900"
            aria-label="Sort hot listings"
          >
            <option value="score">Sort: Score</option>
            <option value="salary">Sort: Salary</option>
            <option value="recent">Sort: Most recent</option>
          </select>

          <select
            value={salaryFilter}
            onChange={(e) =>
              setSalaryFilter(
                e.target.value as HotListingFilterState["salaryFilter"],
              )
            }
            className="text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900"
            aria-label="Minimum salary filter"
          >
            <option value="any">Any salary (shown when known)</option>
            <option value="min_salary">Min salary ≥</option>
          </select>

          {salaryFilter === "min_salary" && (
            <>
              <input
                type="number"
                min={0}
                step={5000}
                value={salaryMinUsd}
                onChange={(e) =>
                  setSalaryMinUsd(parseInt(e.target.value, 10) || 0)
                }
                className="w-28 text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900"
                aria-label="Minimum salary USD"
              />
              <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeUnknownSalary}
                  onChange={(e) => setIncludeUnknownSalary(e.target.checked)}
                  className="rounded border-gray-300"
                />
                Include unknown salary
              </label>
            </>
          )}

          <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={newTodayOnly}
              onChange={(e) => setNewTodayOnly(e.target.checked)}
              className="rounded border-gray-300"
            />
            New today
          </label>
        </div>

        <p className="text-xs text-gray-500 mt-2 flex flex-wrap gap-x-3 gap-y-1">
          <span>
            Showing {listings.length} hot listing
            {listings.length === 1 ? "" : "s"}
            {sort === "score" && " · ranked by lead score"}
          </span>
          {hidden.sizeUnknown > 0 && (
            <span className="text-amber-700 dark:text-amber-400">
              {hidden.sizeUnknown} hidden — company size unknown
            </span>
          )}
          {hidden.belowSalary > 0 && (
            <span className="text-amber-700 dark:text-amber-400">
              {hidden.belowSalary} hidden — no salary posted / below min
            </span>
          )}
        </p>
      </div>

      {listings.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">No hot listings for this period</p>
          <p className="text-sm mt-2">
            Try another date, broaden role families, or wait for company size
            enrichment on promising roles.
          </p>
        </div>
      ) : (
        <div className="border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden bg-white dark:bg-gray-950 shadow-sm divide-y divide-gray-200 dark:divide-gray-800">
          {listings.map((row) => (
            <HotListingRow key={`${row.companyId}-${row.listing.id}`} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function HotListingRow({ row }: { row: HotListing }) {
  return (
    <div className="px-4 py-3 flex flex-col sm:flex-row sm:items-start gap-3 hover:bg-gray-50 dark:hover:bg-gray-900/60">
      <div className="flex-1 min-w-0">
        <p className="text-sm sm:text-[15px] text-gray-900 dark:text-gray-100 leading-snug">
          {row.headline}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wide">
          <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-200 font-medium">
            {row.roleFamily}
          </span>
          {row.estimatedEmployees != null && (
            <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
              ~{row.estimatedEmployees.toLocaleString()} emp
            </span>
          )}
          {row.board && (
            <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
              {row.board}
            </span>
          )}
          {row.isNewToday && (
            <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 font-medium">
              New today
            </span>
          )}
          <span className="text-gray-400 normal-case tracking-normal">
            score {row.leadScore}
          </span>
        </div>
        <Link
          href={`/companies/${row.companyId}`}
          className="inline-block mt-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
        >
          Open company →
        </Link>
      </div>
      <div className="shrink-0 self-start">
        <EnrichButton
          companyId={row.companyId}
          contactCount={row.contactCount}
        />
      </div>
    </div>
  );
}
