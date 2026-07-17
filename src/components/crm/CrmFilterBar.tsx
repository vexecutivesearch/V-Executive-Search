"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { CrmFilterOptions } from "@/lib/crm-queries";

export type CrmActiveFilters = {
  state: string;
  city: string;
  sector: string;
  status: string;
  q: string;
  callable: boolean;
  enriched: boolean;
  sort: string;
};

const STATUS_OPTIONS = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "meeting", label: "Meeting" },
  { value: "client", label: "Client" },
  { value: "skipped", label: "Skipped" },
];

/**
 * URL-driven filter bar: every change updates the query string so filtering
 * happens server-side, before the pagination cap — not over a loaded slice.
 */
export function CrmFilterBar({
  options,
  tab,
  active,
}: {
  options: CrmFilterOptions;
  tab: "all" | "hot";
  active: CrmActiveFilters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(active.q);
  const [prevQ, setPrevQ] = useState(active.q);
  if (prevQ !== active.q) {
    setPrevQ(active.q);
    setSearch(active.q);
  }

  function apply(changes: Partial<Record<string, string | null>>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    params.delete("page"); // filter change restarts pagination
    router.push(`${pathname}?${params.toString()}`);
  }

  // Debounced search — server round-trip per keystroke would be wasteful.
  useEffect(() => {
    if (search === active.q) return;
    const t = setTimeout(() => apply({ q: search || null }), 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const cityOptions = useMemo(() => {
    const list = active.state
      ? options.cities.filter((c) => c.stateAbbr === active.state)
      : options.cities;
    return list.slice(0, 400);
  }, [options.cities, active.state]);

  const hasActiveFilters =
    active.state ||
    active.city ||
    active.sector ||
    active.status ||
    active.q ||
    active.callable ||
    active.enriched;

  const selectClass =
    "text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900 max-w-[13rem]";

  return (
    <div className="sticky top-[3.25rem] z-10 -mx-4 px-4 py-3 mb-3 bg-gray-50/95 dark:bg-gray-950/95 backdrop-blur border-y border-gray-200 dark:border-gray-800">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search company, job, contact…"
          className="flex-1 min-w-[12rem] text-sm border border-gray-200 dark:border-gray-700 rounded-md px-3 py-1.5 bg-white dark:bg-gray-900"
        />

        <select
          value={active.state}
          onChange={(e) =>
            apply({ state: e.target.value || null, city: null })
          }
          className={selectClass}
          aria-label="Filter by state"
        >
          <option value="">All states</option>
          {options.states.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select
          value={active.city}
          onChange={(e) => apply({ city: e.target.value || null })}
          className={selectClass}
          aria-label="Filter by city"
        >
          <option value="">All cities</option>
          {cityOptions.map((c) => (
            <option key={`${c.city}|${c.stateAbbr}`} value={c.city}>
              {c.city}, {c.stateAbbr}
            </option>
          ))}
        </select>

        <select
          value={active.sector}
          onChange={(e) => apply({ sector: e.target.value || null })}
          className={selectClass}
          aria-label="Filter by sector"
        >
          <option value="">All sectors</option>
          {options.sectors.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select
          value={active.status}
          onChange={(e) => apply({ status: e.target.value || null })}
          className={selectClass}
          aria-label="Filter by pipeline status"
        >
          <option value="">Any status</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={active.callable}
            onChange={(e) => apply({ callable: e.target.checked ? "1" : null })}
            className="rounded border-gray-300"
          />
          Callable only
        </label>

        <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={active.enriched}
            onChange={(e) => apply({ enriched: e.target.checked ? "1" : null })}
            className="rounded border-gray-300"
          />
          Enriched only
        </label>

        <select
          value={active.sort}
          onChange={(e) =>
            apply({ sort: e.target.value === "score" ? null : e.target.value })
          }
          className={selectClass}
          aria-label="Sort leads"
        >
          <option value="score">Sort: Score</option>
          <option value="recent">Sort: Recently updated</option>
          <option value="name">Sort: Name</option>
        </select>

        {hasActiveFilters && (
          <button
            type="button"
            onClick={() =>
              router.push(tab === "hot" ? "/crm?tab=hot" : "/crm")
            }
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
