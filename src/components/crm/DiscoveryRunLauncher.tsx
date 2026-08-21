"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  defaultDiscoveryMarket,
  stateLabel,
  type LocationScope,
} from "@/lib/crm-location-scope";
import { gateReasonLabel, type GateReason } from "@/lib/discovery/exclusion-gate";
import {
  findMoreLabel,
  marketProgress,
  nextRunHint,
  sizedPoolHeadline,
  unknownPoolHeadline,
} from "@/lib/discovery/run-progress";
import type { PoolStatus } from "@/lib/discovery/pagination";
import type { DiscoverySourceStatus } from "@/lib/discovery/source-status";

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
  status: PoolStatus;
};

type LauncherConfig = {
  verticals: VerticalOption[];
  markets: string[];
  defaults: { companiesPerRun: number; includeUnknownSize: boolean };
  pools: PoolEntry[];
  sourcesByVertical?: Record<string, DiscoverySourceStatus[]>;
};

type RunSummary = {
  verticalLabel?: string;
  market?: string;
  companiesReviewed?: number;
  created?: number;
  updated?: number;
  returnedSized?: number;
  returnedUnknownSize?: number;
  sizeUnknownCount?: number;
  autoExcluded?: number;
  gateRejected?: number;
  gateRejectionsByReason?: Record<string, number>;
  withJobSignals?: number;
  duplicatesSkipped?: number;
  creditsSpent?: number;
  apolloQuantifyCredits?: number;
  poolExhausted?: boolean;
  canFindMore?: boolean;
  pools?: Record<string, PoolStatus>;
  sources?: Array<{
    name: string;
    billingUnit: string;
    unitsSpent: number;
    returned: number;
  }>;
  sourcesSkipped?: Array<{ name: string; reason: string }>;
  notes?: string[];
  cost_note?: string;
  error?: string;
  reset?: number;
  message?: string;
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

function poolBar(status: PoolStatus): { pct: number; label: string } {
  if (status.poolSize == null || status.poolSize <= 0) {
    return { pct: 0, label: "Not searched yet" };
  }
  const pct = Math.min(100, Math.round((status.consumed / status.poolSize) * 100));
  return {
    pct,
    label: `${status.consumed.toLocaleString()} of ${status.poolSize.toLocaleString()} paged`,
  };
}

/**
 * Launch a discovery run: market + vertical + count. Markets are picked per run
 * and never touch the Admin geo config that drives the job scrape.
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
  const [allowLargeCompanies, setAllowLargeCompanies] = useState(false);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadConfig(): Promise<LauncherConfig | null> {
    const data = (await fetch("/api/discovery/run").then((res) =>
      res.json(),
    )) as LauncherConfig;
    setConfig(data);
    return data;
  }

  useEffect(() => {
    let active = true;
    loadConfig()
      .then((data) => {
        if (!active || !data) return;
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
  const sizedPool = pools.find((p) => p.pool === "sized") ?? null;
  const unknownPool = pools.find((p) => p.pool === "unknown_size") ?? null;
  const progress = marketProgress({
    sized: sizedPool?.status ?? null,
    unknown: unknownPool?.status ?? null,
    includeUnknown: includeUnknownSize,
  });
  const sources = config?.sourcesByVertical?.[vertical] ?? [];
  const maps = sources.find((s) => s.id === "google_maps");
  const mapsWillRun = Boolean(maps?.enabled && maps.appliesToThisVertical);

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
      await loadConfig();
      router.refresh();
    } catch {
      setError("Network error — could not reach the discovery API");
    } finally {
      setBusy(false);
    }
  }

  async function resetPool() {
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
          reset: true,
        }),
      });
      const data = (await res.json()) as RunSummary;
      if (!res.ok) {
        setError(data.error ?? "Could not reset this market's pool");
        return;
      }
      setSummary(data);
      await loadConfig();
    } catch {
      setError("Network error — could not reset the pool");
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
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-2">
        <h2 id="discovery-run-heading" className="text-sm font-semibold">
          Find companies
        </h2>
        <span className="text-xs text-gray-500">
          Adds to the review queue below — does not filter it
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-3">
        <span className="inline-flex items-center rounded-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-2 py-0.5 text-[11px] text-gray-700 dark:text-gray-300">
          Apollo always
        </span>
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${
            mapsWillRun
              ? "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300"
              : "border-dashed border-gray-300 dark:border-gray-700 text-gray-500"
          }`}
          title={maps?.reason ?? undefined}
        >
          {mapsWillRun
            ? "Google Maps on for this vertical"
            : maps?.enabled
              ? "Google Maps off for this vertical"
              : "Google Maps off"}
        </span>
      </div>
      {!mapsWillRun && maps?.reason && (
        <p className="text-[11px] text-amber-800 dark:text-amber-200 mb-3">
          {maps.reason}
        </p>
      )}

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
          Market
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
            Location
            <input
              value={customMarket}
              onChange={(e) => setCustomMarket(e.target.value)}
              placeholder="Tampa, Florida"
              className={selectClass}
            />
          </label>
        )}

        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Per run
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
          Include size-unknown (+1 credit)
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
          disabled={busy || !vertical || !effectiveMarket || progress.marketExhausted}
          className="px-3 py-1.5 rounded-md text-sm font-medium bg-gray-900 text-white dark:bg-white dark:text-gray-900 disabled:opacity-50"
        >
          {busy ? "Finding companies…" : findMoreLabel(limit, progress)}
        </button>

        {!progress.firstRun && (
          <button
            type="button"
            onClick={resetPool}
            disabled={busy || !vertical || !effectiveMarket}
            className="px-3 py-1.5 rounded-md text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 disabled:opacity-50"
          >
            Start this market over
          </button>
        )}
      </div>

      {!marketChoice && suggestedMarket && browseScope?.state && (
        <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">
          {`Prefilled from your last browse scope (${stateLabel(browseScope.state)}). `}
          Any market can be searched, whatever the queue below is scoped to.
        </p>
      )}

      <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">
        {nextRunHint(progress, limit)}
      </p>
      {maps && !mapsWillRun && maps.reason && (
        <p className="text-xs text-gray-500 mt-1">{maps.reason}</p>
      )}

      {(sizedPool || unknownPool) && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {sizedPool && (
            <PoolCard
              title="Known headcount"
              headline={sizedPoolHeadline(sizedPool.status)}
              status={sizedPool.status}
            />
          )}
          {includeUnknownSize && unknownPool && (
            <PoolCard
              title="No headcount / unfiltered pass"
              headline={unknownPoolHeadline(unknownPool.status)}
              status={unknownPool.status}
            />
          )}
        </div>
      )}

      {activeVertical && (
        <p className="text-xs text-gray-500 mt-2">
          Keywords: {activeVertical.keywords.join(", ")}. Outside{" "}
          {activeVertical.employeeMin}–{activeVertical.employeeMax} employees,
          staffing firms, government, public companies, and known enterprises
          never reach the queue. One Apollo credit buys a page of up to 100 —
          you keep {limit} for review, the rest is how the next Find knows what
          it already paid for.
        </p>
      )}
      {allowLargeCompanies && (
        <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
          Larger companies are allowed for this run. Oversized firms will be
          shown for review rather than rejected — staffing, government, and
          known enterprises are still blocked.
        </p>
      )}

      {error && (
        <p className="text-sm text-red-700 dark:text-red-400 mt-2">{error}</p>
      )}

      {summary && (
        <div className="mt-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white/70 dark:bg-gray-950/40 p-3 text-sm space-y-1.5">
          <p className="font-medium">
            {summary.verticalLabel} · {summary.market}:{" "}
            {summary.companiesReviewed ?? 0} in the queue this run (
            {summary.created ?? 0} new, {summary.updated ?? 0} already known)
          </p>
          {summary.message && (
            <p className="text-xs text-gray-600 dark:text-gray-400">
              {summary.message}
            </p>
          )}
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {summary.creditsSpent ?? 0} Apollo credit
            {(summary.creditsSpent ?? 0) === 1 ? "" : "s"}
            {summary.apolloQuantifyCredits
              ? ` (${summary.apolloQuantifyCredits} to size Maps companies)`
              : ""}
            {(summary.sources ?? [])
              .filter((s) => s.unitsSpent > 0)
              .map((s) => ` · ${s.unitsSpent} ${s.name} ${s.billingUnit}(s)`)
              .join("")}
            . {(summary.returnedSized ?? 0) + (summary.returnedUnknownSize ?? 0)}{" "}
            rows paged, {summary.sizeUnknownCount ?? 0} size-unknown kept,{" "}
            {summary.withJobSignals ?? 0} with job postings (a bonus, not a
            requirement).
          </p>
          {(summary.gateRejected ?? 0) > 0 && (
            <p className="text-xs text-gray-600 dark:text-gray-400">
              <span className="font-medium">
                {summary.gateRejected} blocked before review
              </span>
              {": "}
              {gateReasonBreakdown(summary.gateRejectionsByReason)}
            </p>
          )}
          {(summary.sourcesSkipped ?? []).length > 0 && (
            <p className="text-xs text-gray-500">
              Not this run:{" "}
              {(summary.sourcesSkipped ?? [])
                .map((s) => `${s.name} (${s.reason})`)
                .join(" · ")}
            </p>
          )}
          {summary.canFindMore && (
            <p className="text-xs text-gray-700 dark:text-gray-300">
              You can Find again in this market. Clicking Find does not start
              over — it continues from the last page you paid for.
            </p>
          )}
          {summary.poolExhausted && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Nothing left to page in this market. Start over, or pick another
              market.
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

function PoolCard({
  title,
  headline,
  status,
}: {
  title: string;
  headline: string;
  status: PoolStatus;
}) {
  const bar = poolBar(status);
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white/70 dark:bg-gray-950/40 p-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
        {title}
      </p>
      <p className="text-xs text-gray-700 dark:text-gray-300 mt-0.5">{headline}</p>
      <div
        className="mt-2 h-1.5 rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden"
        aria-hidden
      >
        <div
          className={`h-full ${status.exhausted ? "bg-gray-400" : "bg-blue-500"}`}
          style={{ width: `${bar.pct}%` }}
        />
      </div>
      <p className="text-[11px] text-gray-500 mt-1">{bar.label}</p>
    </div>
  );
}
