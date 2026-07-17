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
  discovered: boolean;
  sort: string;
  /* ICP annotation filters (view state only — reversible). */
  role: string;
  size: string;
  comp: string;
  includeEstimated: boolean;
  icpMin: string;
  hide: string[];
};

const STATUS_OPTIONS = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "meeting", label: "Meeting" },
  { value: "client", label: "Client" },
  { value: "skipped", label: "Skipped" },
];

const ROLE_TYPE_OPTIONS = [
  { value: "leadership", label: "Leadership" },
  { value: "management", label: "Management" },
  { value: "specialized", label: "Specialized" },
  { value: "professional", label: "Professional" },
  { value: "support", label: "Support" },
  { value: "hourly", label: "Hourly" },
  { value: "unknown", label: "Unclassified" },
];

const SIZE_BAND_OPTIONS = [
  { value: "micro", label: "Micro (<25)" },
  { value: "small", label: "Small (25–99)" },
  { value: "mid", label: "Mid (100–750)" },
  { value: "large", label: "Large (750+)" },
  { value: "unknown", label: "Size unknown" },
];

/** Sink-don't-hide: every hide toggle defaults OFF; flipping back restores. */
const HIDE_CATEGORY_OPTIONS = [
  { value: "fortune", label: "Fortune 500/1000" },
  { value: "gov", label: "Government" },
  { value: "schools", label: "Schools" },
  { value: "hospitals", label: "Hospital systems" },
  { value: "staffing", label: "Staffing agencies" },
  { value: "third_party", label: "Third-party postings" },
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
  const [filtersOpen, setFiltersOpen] = useState(false);
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

  // Count active filters (search stays visible, so it's excluded from the badge).
  const activeFilterCount = [
    active.state,
    active.city,
    active.sector,
    active.status,
    active.callable,
    active.enriched,
    active.discovered,
    active.role,
    active.size,
    active.comp,
    active.icpMin,
  ].filter(Boolean).length + active.hide.length;

  const hasActiveFilters = activeFilterCount > 0 || Boolean(active.q);

  const selectClass =
    "text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900 max-w-[13rem]";

  // Mobile: filters collapse behind a "View filters" button so the listings
  // aren't pushed off-screen. Desktop always shows them (sm:flex).
  const controlRowClass = (open: boolean) =>
    `${open ? "flex" : "hidden"} sm:flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center`;

  return (
    <div className="sticky top-[3.25rem] z-10 -mx-4 px-4 py-3 mb-3 bg-gray-50/95 dark:bg-gray-950/95 backdrop-blur border-y border-gray-200 dark:border-gray-800">
      {/* Always-visible compact bar: search + mobile filters toggle. */}
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search company, job, contact…"
          className="flex-1 min-w-0 text-sm border border-gray-200 dark:border-gray-700 rounded-md px-3 py-1.5 bg-white dark:bg-gray-900"
        />
        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          aria-expanded={filtersOpen}
          className="sm:hidden shrink-0 inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
        >
          {filtersOpen ? "Hide" : "Filters"}
          {activeFilterCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[1.15rem] h-[1.15rem] px-1 rounded-full text-[10px] font-semibold bg-blue-600 text-white">
              {activeFilterCount}
            </span>
          )}
          <span className={`transition-transform ${filtersOpen ? "rotate-180" : ""}`} aria-hidden>▾</span>
        </button>
      </div>

      <div className={`${controlRowClass(filtersOpen)} mt-2`}>
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

        <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={active.discovered}
            onChange={(e) => apply({ discovered: e.target.checked ? "1" : null })}
            className="rounded border-gray-300"
          />
          Discovered only
        </label>

        <select
          value={active.sort}
          onChange={(e) =>
            apply({ sort: e.target.value === "icp" ? null : e.target.value })
          }
          className={selectClass}
          aria-label="Sort leads"
        >
          <option value="icp">Sort: ICP fit</option>
          <option value="score">Sort: Raw score</option>
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

      {/* ICP annotation filters — reversible view state, never data changes. */}
      <div className={`${controlRowClass(filtersOpen)} mt-2`}>
        <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
          ICP
        </span>

        <select
          value={active.role}
          onChange={(e) => apply({ role: e.target.value || null })}
          className={selectClass}
          aria-label="Filter by role type"
        >
          <option value="">Any role type</option>
          {ROLE_TYPE_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>

        <select
          value={active.size}
          onChange={(e) => apply({ size: e.target.value || null })}
          className={selectClass}
          aria-label="Filter by company size band"
        >
          <option value="">Any company size</option>
          {SIZE_BAND_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <label className="inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400">
          Comp ≥
          <input
            type="number"
            min={0}
            step={10000}
            value={active.comp}
            onChange={(e) => apply({ comp: e.target.value || null })}
            placeholder="$"
            className="w-24 text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900"
            aria-label="Minimum annual compensation"
          />
        </label>

        {active.comp && (
          <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={active.includeEstimated}
              onChange={(e) => apply({ est: e.target.checked ? null : "0" })}
              className="rounded border-gray-300"
            />
            Include estimated
          </label>
        )}

        <label className="inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400">
          ICP ≥
          <input
            type="number"
            min={0}
            max={100}
            step={10}
            value={active.icpMin}
            onChange={(e) => apply({ icpmin: e.target.value || null })}
            className="w-16 text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900"
            aria-label="Minimum ICP score"
          />
        </label>

        <details className="relative">
          <summary
            className={`cursor-pointer list-none text-sm px-2 py-1.5 rounded-md border select-none [&::-webkit-details-marker]:hidden ${
              active.hide.length
                ? "border-red-300 text-red-700 dark:text-red-400 dark:border-red-800"
                : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400"
            }`}
          >
            Hide categories{active.hide.length ? ` (${active.hide.length})` : ""} ▾
          </summary>
          <div className="absolute z-20 mt-1 w-56 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 shadow-lg space-y-1">
            {HIDE_CATEGORY_OPTIONS.map((c) => {
              const on = active.hide.includes(c.value);
              return (
                <label
                  key={c.value}
                  className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer px-1 py-0.5 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...active.hide, c.value]
                        : active.hide.filter((v) => v !== c.value);
                      apply({ hide: next.length ? next.join(",") : null });
                    }}
                    className="rounded border-gray-300"
                  />
                  {c.label}
                </label>
              );
            })}
            {active.hide.length > 0 && (
              <button
                type="button"
                onClick={() => apply({ hide: null })}
                className="w-full text-left text-xs text-blue-600 dark:text-blue-400 hover:underline px-1 pt-1"
              >
                Show deprioritized (clear hides)
              </button>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}
