"use client";

import { useEffect, useMemo, useState } from "react";
import type { CompanyCardData } from "./CompanyCard";
import { TodayListRow } from "./TodayListRow";
import { contactIsCallable } from "@/lib/lead-score";
import type { dailyRuns } from "@/lib/db/schema";

const DISCLAIMER_KEY = "today-list-location-disclaimer-dismissed";

type SortKey = "score" | "name" | "contacts";
type ListMode = "call-sheet" | "backlog";

export function TodayListView({
  companies,
  geoLabel,
  listMode = "call-sheet",
  runStats,
  showFunnel = true,
}: {
  companies: CompanyCardData[];
  geoLabel: string;
  listMode?: ListMode;
  runStats?: typeof dailyRuns.$inferSelect | null;
  showFunnel?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("score");
  const [geoOnly, setGeoOnly] = useState(false);
  const [callableOnly, setCallableOnly] = useState(listMode === "call-sheet");
  const [hotSignalsOnly, setHotSignalsOnly] = useState(false);
  const [dismissedNotice, setDismissedNotice] = useState(false);

  useEffect(() => {
    setDismissedNotice(localStorage.getItem(DISCLAIMER_KEY) === "1");
  }, []);

  useEffect(() => {
    setCallableOnly(listMode === "call-sheet");
  }, [listMode]);

  const showLocationNotice =
    !dismissedNotice &&
    companies.some(
      (c) =>
        c.contacts.length > 0 &&
        c.contacts.some((contact) => !contact.locationMatched),
    );

  function dismissNotice() {
    localStorage.setItem(DISCLAIMER_KEY, "1");
    setDismissedNotice(true);
  }

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();

    let rows = companies.filter((company) => {
      const geoMismatch =
        company.contacts.length > 0 &&
        !company.contacts.some((c) => c.locationMatched);
      if (geoOnly && geoMismatch) return false;
      if (callableOnly && !company.contacts.some(contactIsCallable)) return false;
      if (hotSignalsOnly) {
        const signals = company.hiringSignals ?? {};
        if (!Object.keys(signals).length) return false;
      }

      if (!term) return true;

      const primaryJob = company.jobListings[0];
      const haystack = [
        company.name,
        company.domain ?? "",
        company.reasonToCall ?? "",
        primaryJob?.title ?? "",
        primaryJob?.location ?? "",
        ...company.contacts.map((c) => `${c.name} ${c.title ?? ""}`),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(term);
    });

    rows = [...rows].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "contacts") {
        return b.contacts.length - a.contacts.length || a.name.localeCompare(b.name);
      }
      const sa = a.leadScore ?? 0;
      const sb = b.leadScore ?? 0;
      return sb - sa || a.name.localeCompare(b.name);
    });

    return rows;
  }, [companies, search, sort, geoOnly, callableOnly, hotSignalsOnly]);

  const funnelLabel = runStats
    ? `Scraped ${runStats.listingsScraped ?? 0} → ICP match ${runStats.icpMatchCount ?? 0} → Enriched ${runStats.companiesEnriched ?? 0} · Credits ${runStats.creditsUsed ?? 0}`
    : null;

  return (
    <div>
      {showFunnel && funnelLabel && (
        <div className="mb-4 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
          <span className="font-medium">Pipeline funnel:</span> {funnelLabel}
        </div>
      )}

      {showLocationNotice && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 px-3 py-2.5 text-sm text-amber-900 dark:text-amber-200">
          <span className="text-base leading-none mt-0.5" aria-hidden>
            ⚠️
          </span>
          <div className="flex-1 min-w-0">
            <p>
              Contacts are matched by company and title, not guaranteed to be the
              hiring manager for <strong>{geoLabel}</strong>. Verify before
              outreach — especially at companies with many offices.
            </p>
          </div>
          <button
            type="button"
            onClick={dismissNotice}
            className="shrink-0 text-xs font-medium text-amber-800 dark:text-amber-300 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

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
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900"
            aria-label="Sort leads"
          >
            <option value="score">Sort: Score</option>
            <option value="name">Sort: Name</option>
            <option value="contacts">Sort: Contact count</option>
          </select>

          <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={geoOnly}
              onChange={(e) => setGeoOnly(e.target.checked)}
              className="rounded border-gray-300"
            />
            Geo match only
          </label>

          {listMode !== "backlog" && (
            <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={callableOnly}
                onChange={(e) => setCallableOnly(e.target.checked)}
                className="rounded border-gray-300"
              />
              Callable only
            </label>
          )}

          <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={hotSignalsOnly}
              onChange={(e) => setHotSignalsOnly(e.target.checked)}
              className="rounded border-gray-300"
            />
            Hot signals
          </label>
        </div>

        <p className="text-xs text-gray-500 mt-2">
          Showing {filtered.length} of {companies.length}{" "}
          {listMode === "backlog" ? "backlog leads" : "call sheet leads"}
          {sort === "score" && " · ranked by lead score"}
        </p>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p>No leads match your filters</p>
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setGeoOnly(false);
              setCallableOnly(listMode === "call-sheet");
              setHotSignalsOnly(false);
            }}
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline mt-2"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden bg-white dark:bg-gray-950 shadow-sm">
          <div className="hidden sm:grid grid-cols-[3.5rem_minmax(0,1.2fr)_minmax(0,1.4fr)_5rem_6.5rem_auto] gap-x-3 px-4 py-2 text-[10px] font-medium uppercase tracking-wide text-gray-500 bg-gray-50 dark:bg-gray-900/80 border-b border-gray-200 dark:border-gray-800">
            <span>Score</span>
            <span>Company</span>
            <span>Job</span>
            <span>Contacts</span>
            <span className="text-right">Status</span>
            <span className="text-right pr-6">Action</span>
          </div>

          {filtered.map((company, index) => (
            <TodayListRow
              key={company.id}
              company={company}
              rank={index + 1}
              showReasonToCall
              listMode={listMode}
            />
          ))}
        </div>
      )}
    </div>
  );
}
