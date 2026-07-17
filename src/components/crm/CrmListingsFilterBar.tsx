"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** URL-driven filters for the Job Listings tab (server-side before the cap). */
export function CrmListingsFilterBar({
  boards,
  active,
}: {
  boards: string[];
  active: { q: string; board: string; sort: string };
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
    params.delete("page");
    router.push(`${pathname}?${params.toString()}`);
  }

  useEffect(() => {
    if (search === active.q) return;
    const t = setTimeout(() => apply({ q: search || null }), 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const selectClass =
    "text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900";

  const activeFilterCount = [active.board].filter(Boolean).length;

  return (
    <div className="sticky top-[3.25rem] z-10 -mx-4 px-4 py-3 mb-3 bg-gray-50/95 dark:bg-gray-950/95 backdrop-blur border-y border-gray-200 dark:border-gray-800">
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title, company, location…"
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

      <div
        className={`${filtersOpen ? "flex" : "hidden"} sm:flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center mt-2`}
      >
        <select
          value={active.board}
          onChange={(e) => apply({ board: e.target.value || null })}
          className={selectClass}
          aria-label="Filter by job board"
        >
          <option value="">All boards</option>
          {boards.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>

        <select
          value={active.sort}
          onChange={(e) =>
            apply({ sort: e.target.value === "newest" ? null : e.target.value })
          }
          className={selectClass}
          aria-label="Sort listings"
        >
          <option value="newest">Newest</option>
          <option value="reposts">Most reposted</option>
        </select>

        {(active.q || active.board) && (
          <button
            type="button"
            onClick={() => apply({ q: null, board: null })}
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
