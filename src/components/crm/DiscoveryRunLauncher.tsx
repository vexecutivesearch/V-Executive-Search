"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  defaultDiscoveryMarket,
  stateLabel,
  type LocationScope,
} from "@/lib/crm-location-scope";
import { gateReasonLabel, type GateReason } from "@/lib/discovery/exclusion-gate";

type VerticalOption = {
  id: string;
  label: string;
  employeeMin: number;
  employeeMax: number;
  keywords: string[];
};

type PoolEntry = {
  vertical: string;
  market: string;
  pool: "sized" | "unknown_size";
  lastRunAt: string | null;
  status: {
    poolSize: number | null;
    consumed: number;
    remaining: number | null;
    exhausted: boolean;
    note: string | null;
  };
};

type LauncherConfig = {
  verticals: VerticalOption[];
  markets: string[];
  defaults: { companiesPerRun: number; includeUnknownSize: boolean };
  pools: PoolEntry[];
};

type RunSummary = {
  verticalLabel?: string;
  market?: string;
  companiesReviewed?: number;
  created?: number;
  updated?: number;
  sizeUnknownCount?: number;
  autoExcluded?: number;
  gateRejected?: number;
  gateRejectionsByReason?: Record<string, number>;
  withJobSignals?: number;
  duplicatesSkipped?: number;
  creditsSpent?: number;
  poolExhausted?: boolean;
  pools?: Record<string, PoolEntry["status"]>;
  notes?: string[];
  cost_note?: string;
  error?: string;
};

function gateReasonBreakdown(
  counts: Record<string, number> | undefined,
): string {
  const parts = Object.entries(counts ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${n} ${gateReasonLabel(reason as GateReason)}`);
  return parts.join(", ");
}

function poolLabel(status: PoolEntry["status"]): string {
  const size = status.poolSize == null ? "unknown" : status.poolSize.toLocaleString();
  const remaining =
    status.remaining == null ? "unknown" : status.remaining.toLocaleString();
  return `pool ${size} · consumed ${status.consumed.toLocaleString()} · remaining ${remaining}`;
}

/**
 * Launch a discovery run: market + vertical + count. Markets are picked per run
 * and never touch the Admin geo config that drives the job scrape.
 *
 * This is a search, not a filter: the market goes to Apollo's
 * organization_locations to find companies the database has never seen. The
 * browse scope can suggest a starting market but must not narrow the list —
 * searching Dallas while browsing Florida is legitimate.
 */
export function DiscoveryRunLauncher({
  browseScope,
}: {
  browseScope?: LocationScope;
}) {
  const router = useRouter();
  const [config, setConfig] = useState<LauncherConfig | null>(null);
  const [vertical, setVertical] = useState("");
  const [marketChoice, setMarketChoice] = useState("");
  const [customMarket, setCustomMarket] = useState("");
  const [limit, setLimit] = useState(25);
  const [includeUnknownSize, setIncludeUnknownSize] = useState(true);
  // Always starts off. The size ceiling only lifts when the operator ticks
  // this for a specific run; nothing in the config can default it on.
  const [allowLargeCompanies, setAllowLargeCompanies] = useState(false);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/discovery/run")
      .then((res) => res.json())
      .then((data: LauncherConfig) => {
        if (!active) return;
        setConfig(data);
        setVertical((v) => v || data.verticals[0]?.id || "");
        setLimit(data.defaults?.companiesPerRun ?? 25);
        setIncludeUnknownSize(data.defaults?.includeUnknownSize !== false);
      })
      .catch(() => setError("Could not load discovery config"));
    return () => {
      active = false;
    };
  }, []);

  const suggestedMarket = config
    ? defaultDiscoveryMarket(config.markets, browseScope ?? {})
    : null;
  const market = marketChoice || suggestedMarket || config?.markets[0] || "";
  const effectiveMarket = market === "__custom" ? customMarket.trim() : market;
  const activeVertical = config?.verticals.find((v) => v.id === vertical);
  const pools = (config?.pools ?? []).filter(
    (p) => p.vertical === vertical && p.market === effectiveMarket,
  );
  const sizedPool = pools.find((p) => p.pool === "sized");

  async function runDiscovery() {
    if (!vertical || !effectiveMarket) return;
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const res = await fetch("/api/discovery/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vertical,
          market: effectiveMarket,
          limit,
          include_unknown_size: includeUnknownSize,
          allow_large_companies: allowLargeCompanies,
        }),
      });
      const data = (await res.json()) as RunSummary;
      if (!res.ok) {
        setError(data.error ?? "Discovery run failed");
        return;
      }
      setSummary(data);
      router.refresh();
    } catch {
      setError("Network error — could not reach the discovery API");
    } finally {
      setBusy(false);
    }
  }

  const selectClass =
    "text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900";

  return (
    <section
      aria-labelledby="discovery-run-heading"
      className="rounded-xl border-2 border-dashed border-blue-300 dark:border-blue-900 bg-blue-50/50 dark:bg-blue-950/20 p-4 mb-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-3">
        <h2 id="discovery-run-heading" className="text-sm font-semibold">
          New Apollo search — find companies not in the pipeline yet
        </h2>
        <span className="text-xs text-gray-500">
          Does not filter the queue below
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Vertical
          <select
            value={vertical}
            onChange={(e) => setVertical(e.target.value)}
            className={selectClass}
          >
            {(config?.verticals ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.label} ({v.employeeMin}–{v.employeeMax})
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Apollo market to search
          <select
            value={market}
            onChange={(e) => setMarketChoice(e.target.value)}
            className={selectClass}
          >
            {(config?.markets ?? []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value="__custom">Other market…</option>
          </select>
        </label>

        {market === "__custom" && (
          <label className="flex flex-col gap-1 text-xs text-gray-500">
            Apollo location
            <input
              value={customMarket}
              onChange={(e) => setCustomMarket(e.target.value)}
              placeholder="Tampa, Florida"
              className={selectClass}
            />
          </label>
        )}

        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Companies
          <input
            type="number"
            min={1}
            max={100}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) || 25)}
            className={`${selectClass} w-20`}
          />
        </label>

        <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer pb-1.5">
          <input
            type="checkbox"
            checked={includeUnknownSize}
            onChange={(e) => setIncludeUnknownSize(e.target.checked)}
            className="rounded border-gray-300"
          />
          Include size-unknown companies (+1 credit)
        </label>

        <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer pb-1.5">
          <input
            type="checkbox"
            checked={allowLargeCompanies}
            onChange={(e) => setAllowLargeCompanies(e.target.checked)}
            className="rounded border-gray-300"
          />
          Allow larger companies this run
        </label>

        <button
          type="button"
          onClick={runDiscovery}
          disabled={busy || !vertical || !effectiveMarket}
          className="px-3 py-1.5 rounded-md text-sm font-medium bg-gray-900 text-white dark:bg-white dark:text-gray-900 disabled:opacity-50"
        >
          {busy ? "Finding companies…" : `Find ${limit} companies`}
        </button>
      </div>

      {!marketChoice && suggestedMarket && browseScope?.state && (
        <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">
          Prefilled from the {stateLabel(browseScope.state)} browse filter. Any
          market can be searched, whatever the queue below is scoped to.
        </p>
      )}

      <p className="text-xs text-gray-500 mt-2">
        Discovery costs one Apollo credit per page of up to 100 organizations and
        reveals nobody. Apollo&apos;s headcount filter hides companies it has no
        headcount for, so those are searched separately and flagged{" "}
        <span className="font-medium">size unknown</span>.
        {activeVertical && (
          <>
            {" "}
            Keywords: {activeVertical.keywords.join(", ")}. Companies outside{" "}
            {activeVertical.employeeMin}–{activeVertical.employeeMax} employees,
            staffing and recruiting firms, government employers, publicly traded
            companies, and known enterprises are rejected before review.
          </>
        )}
      </p>
      {allowLargeCompanies && (
        <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
          Larger companies are allowed for this run. Oversized firms will be
          shown for review rather than rejected — staffing, government, and
          known enterprises are still blocked.
        </p>
      )}

      {sizedPool && (
        <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
          {activeVertical?.label} · {effectiveMarket}: {poolLabel(sizedPool.status)}
          {sizedPool.status.exhausted && (
            <span className="ml-1 text-amber-700 dark:text-amber-400">
              — pool exhausted, rotate market
            </span>
          )}
        </p>
      )}

      {error && (
        <p className="text-sm text-red-700 dark:text-red-400 mt-2">{error}</p>
      )}

      {summary && (
        <div className="mt-3 rounded-lg border border-gray-200 dark:border-gray-800 p-3 text-sm space-y-1">
          <p className="font-medium">
            {summary.verticalLabel} · {summary.market}:{" "}
            {summary.companiesReviewed ?? 0} companies for review (
            {summary.created ?? 0} new, {summary.updated ?? 0} already known)
          </p>
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {summary.sizeUnknownCount ?? 0} size unknown ·{" "}
            {summary.withJobSignals ?? 0} with job signals ·{" "}
            {summary.autoExcluded ?? 0} auto-rejected ·{" "}
            {summary.duplicatesSkipped ?? 0} duplicates skipped ·{" "}
            {summary.creditsSpent ?? 0} credit(s)
          </p>
          {(summary.gateRejected ?? 0) > 0 && (
            /* Why a run can come back short — the operator should never have to
               guess whether Apollo ran dry or the size gate did its job. */
            <p className="text-xs text-gray-600 dark:text-gray-400">
              <span className="font-medium">
                {summary.gateRejected} blocked before review
              </span>
              {": "}
              {gateReasonBreakdown(summary.gateRejectionsByReason)}
            </p>
          )}
          {summary.pools?.sized && (
            <p className="text-xs text-gray-600 dark:text-gray-400">
              Sized pool: {poolLabel(summary.pools.sized)}
              {summary.pools.unknown_size
                ? ` · size-unknown pool: ${poolLabel(summary.pools.unknown_size)}`
                : ""}
            </p>
          )}
          {summary.poolExhausted && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Pool exhausted — rotate to another market or vertical.
            </p>
          )}
          {(summary.notes ?? []).map((note) => (
            <p key={note} className="text-xs text-gray-500">
              {note}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
