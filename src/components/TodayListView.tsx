"use client";

import { useEffect, useMemo, useState } from "react";
import type { CompanyCardData } from "./CompanyCard";
import { TodayListRow } from "./TodayListRow";
import { contactIsCallable } from "@/lib/lead-score";
import {
  companyMatchesLeadFilters,
  DEFAULT_LEAD_FILTER,
  type LeadFilterState,
} from "@/lib/lead-filters";
import type { TodayFilterOptions } from "@/lib/filter-options";
import type { ListDateRange } from "@/lib/list-date-range";
import { backlogSummaryLabel } from "@/lib/list-date-range";
import { isNewToday } from "@/lib/new-today";
import type { dailyRuns } from "@/lib/db/schema";

const DISCLAIMER_KEY = "today-list-location-disclaimer-dismissed";

type SortKey = "score" | "name" | "contacts";
type ListMode = "call-sheet" | "backlog";

export function TodayListView({
  companies,
  geoLabel,
  listMode = "call-sheet",
  runStats,
  backlogCount,
  listRange,
  showFunnel = true,
  filterOptions,
}: {
  companies: CompanyCardData[];
  geoLabel: string;
  listMode?: ListMode;
  runStats?: typeof dailyRuns.$inferSelect | null;
  backlogCount?: number;
  listRange?: ListDateRange;
  showFunnel?: boolean;
  filterOptions?: TodayFilterOptions;
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("score");
  const [geoOnly, setGeoOnly] = useState(false);
  const [callableOnly, setCallableOnly] = useState(listMode === "call-sheet");
  const [hotSignalsOnly, setHotSignalsOnly] = useState(false);
  const [newTodayOnly, setNewTodayOnly] = useState(false);
  const [linkedinOnly, setLinkedinOnly] = useState(false);
  const [leadFilters, setLeadFilters] = useState<LeadFilterState>({
    ...DEFAULT_LEAD_FILTER,
  });
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

  function clearFilters() {
    setSearch("");
    setGeoOnly(false);
    setCallableOnly(listMode === "call-sheet");
    setHotSignalsOnly(false);
    setNewTodayOnly(false);
    setLinkedinOnly(false);
    setLeadFilters({ ...DEFAULT_LEAD_FILTER });
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
      if (newTodayOnly) {
        if (
          !isNewToday({
            companyFirstSeen: company.firstSeen,
            listings: company.jobListings,
            listDate: listRange?.snapshotDate,
          })
        ) {
          return false;
        }
      }
      if (linkedinOnly) {
        const hasLinkedIn = company.jobListings.some(
          (j) => j.board?.toLowerCase() === "linkedin",
        );
        if (!hasLinkedIn) return false;
      }

      if (!companyMatchesLeadFilters(company, leadFilters)) return false;

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
  }, [companies, search, sort, geoOnly, callableOnly, hotSignalsOnly, newTodayOnly, linkedinOnly, leadFilters, listRange?.snapshotDate]);

  const funnelJson = runStats?.funnelJson as
    | {
        scrape_by_board?: Record<string, number>;
        board_failures?: string[];
        db_backlog_by_board?: Record<string, number>;
      }
    | null
    | undefined;

  const boardMixLabel = (() => {
    const scrape = funnelJson?.scrape_by_board;
    if (!scrape || !Object.keys(scrape).length) return null;
    const parts = ["indeed", "linkedin", "google", "zip_recruiter"]
      .filter((b) => scrape[b] != null)
      .map((b) => `${b} ${scrape[b]}`);
    const extras = Object.entries(scrape)
      .filter(
        ([b]) =>
          !["indeed", "linkedin", "google", "zip_recruiter"].includes(b),
      )
      .map(([b, n]) => `${b} ${n}`);
    return `Boards: ${[...parts, ...extras].join(" · ")}`;
  })();

  const boardFailureLabel =
    funnelJson?.board_failures?.length
      ? `⚠ Board gaps: ${funnelJson.board_failures.join("; ")}`
      : null;

  const otherIndustryCount = filterOptions?.otherIndustryLabels?.length ?? 0;
  const otherIndustryLabel =
    otherIndustryCount > 0
      ? `⚠ Industry map: Other (${otherIndustryCount}) — add to industry-sectors.ts`
      : null;

  const posterCoverageLabel = (() => {
    const f = runStats?.funnelJson as
      | {
          poster_pages_fetched?: number;
          poster_parsed?: number;
        }
      | null
      | undefined;
    const fetched = f?.poster_pages_fetched ?? 0;
    const parsed = f?.poster_parsed ?? 0;
    if (!fetched) return null;
    return `Hiring team on ${parsed}/${fetched} LinkedIn pages (guest HTML — most jobs hide the poster)`;
  })();

  const funnelLabel = runStats
    ? [
        listRange?.isToday
          ? `Today scraped ${runStats.listingsScraped ?? 0} listings · ${runStats.companiesFound ?? 0} new companies`
          : `Pipeline run ${listRange?.snapshotDate ?? ""}: ${runStats.listingsScraped ?? 0} listings · ${runStats.companiesFound ?? 0} new companies`,
        boardMixLabel,
        boardFailureLabel,
        otherIndustryLabel,
        posterCoverageLabel,
        `Enriched ${runStats.companiesEnriched ?? 0} · ${runStats.contactsEnriched ?? 0} contacts · ${runStats.creditsUsed ?? 0} credits`,
        backlogCount != null && listRange
          ? backlogSummaryLabel(listRange, backlogCount)
          : backlogCount != null
            ? `${backlogCount} in ranked backlog`
            : null,
        (runStats.icpMatchCount ?? 0) > 0
          ? `${runStats.icpMatchCount} ICP-pass companies scored`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  const activeFilterLabels: string[] = [];
  if (search.trim()) activeFilterLabels.push(`search “${search.trim()}”`);
  if (geoOnly) activeFilterLabels.push("geo match");
  if (listMode !== "backlog" && callableOnly) {
    activeFilterLabels.push("callable");
  }
  if (hotSignalsOnly) activeFilterLabels.push("hot signals");
  if (newTodayOnly) activeFilterLabels.push("new today");
  if (linkedinOnly) activeFilterLabels.push("LinkedIn jobs");
  if (leadFilters.jobTitle) activeFilterLabels.push(leadFilters.jobTitle);
  if (leadFilters.industry) activeFilterLabels.push(leadFilters.industry);
  if (leadFilters.salaryFilter === "has_salary") {
    activeFilterLabels.push("has salary");
  } else if (leadFilters.salaryFilter === "min_salary") {
    activeFilterLabels.push(
      `salary ≥ $${leadFilters.salaryMinUsd.toLocaleString()}`,
    );
  }
  const filtersActive = activeFilterLabels.length > 0;

  const industryUnknownHidden = useMemo(() => {
    if (!leadFilters.industry.trim()) return 0;
    return companies.filter((company) => {
      if (!company.jobListings.length) return false;
      if (company.industry?.trim()) return false;
      // Would match all other active filters if industry were known
      return companyMatchesLeadFilters(company, {
        ...leadFilters,
        industry: "",
        includeUnknownIndustry: true,
      });
    }).length;
  }, [companies, leadFilters]);

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

          <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={newTodayOnly}
              onChange={(e) => setNewTodayOnly(e.target.checked)}
              className="rounded border-gray-300"
            />
            New today
          </label>

          <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={linkedinOnly}
              onChange={(e) => setLinkedinOnly(e.target.checked)}
              className="rounded border-gray-300"
            />
            LinkedIn jobs
          </label>

          <select
            value={leadFilters.jobTitle}
            onChange={(e) =>
              setLeadFilters((f) => ({ ...f, jobTitle: e.target.value }))
            }
            className="text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900"
            aria-label="Filter by market scan bucket"
          >
            <option value="">All scan buckets</option>
            {(filterOptions?.jobTitles ?? []).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          {listMode === "backlog" &&
            filterOptions?.dataAvailability.industryFilterReady && (
              <select
                value={leadFilters.industry}
                onChange={(e) =>
                  setLeadFilters((f) => ({
                    ...f,
                    industry: e.target.value,
                    // Sector pick is exact — blank industries must not leak in
                    includeUnknownIndustry: false,
                  }))
                }
                className="text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900 max-w-[10rem]"
                aria-label="Filter by sector"
              >
                <option value="">All sectors</option>
                {(filterOptions?.industries ?? []).map((ind) => {
                  const otherN = filterOptions?.otherIndustryLabels?.length ?? 0;
                  const label =
                    ind === "Other" && otherN > 0 ? `Other (${otherN})` : ind;
                  return (
                    <option key={ind} value={ind}>
                      {label}
                    </option>
                  );
                })}
              </select>
            )}

          {listMode === "backlog" &&
            filterOptions?.dataAvailability.salaryFilterReady && (
              <>
                <select
                  value={leadFilters.salaryFilter}
                  onChange={(e) =>
                    setLeadFilters((f) => ({
                      ...f,
                      salaryFilter: e.target.value as LeadFilterState["salaryFilter"],
                    }))
                  }
                  className="text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900"
                  aria-label="Filter by salary"
                >
                  <option value="any">Any salary</option>
                  <option value="has_salary">Has salary posted</option>
                  <option value="min_salary">Min salary ≥</option>
                </select>

                {leadFilters.salaryFilter === "min_salary" && (
                  <input
                    type="number"
                    min={0}
                    step={5000}
                    value={leadFilters.salaryMinUsd}
                    onChange={(e) =>
                      setLeadFilters((f) => ({
                        ...f,
                        salaryMinUsd: parseInt(e.target.value, 10) || 0,
                      }))
                    }
                    className="w-24 text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900"
                    aria-label="Minimum salary USD"
                  />
                )}
              </>
            )}
        </div>

        <p className="text-xs text-gray-500 mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            Showing {filtered.length} of {companies.length}{" "}
            {listMode === "backlog" ? "backlog leads" : "call sheet leads"}
            {filtersActive
              ? ` · filtered by ${activeFilterLabels.join(", ")}`
              : " · filters apply instantly"}
            {listMode === "backlog" && listRange && !listRange.isToday && (
              <> · snapshot as of {listRange.snapshotDate}</>
            )}
            {sort === "score" && " · ranked by lead score"}
          </span>
          {industryUnknownHidden > 0 && (
            <span className="text-amber-700 dark:text-amber-400">
              {industryUnknownHidden} hidden — industry unknown
            </span>
          )}
          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              Clear filters
            </button>
          )}
        </p>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p>No leads match your filters</p>
          <button
            type="button"
            onClick={clearFilters}
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
