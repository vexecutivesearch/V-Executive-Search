import { getBacklogCompanies, getRecentRuns } from "@/lib/queries";
import { categorizeRunErrors } from "@/lib/run-errors";
import {
  formatDbFunnelLine,
  formatGooglePerQueryLine,
  formatRunFunnelLine,
  formatSerpapiMeterLine,
  type PipelineFunnel,
} from "@/lib/pipeline-funnel";
import { businessListDate, formatRunSlot } from "@/lib/timezone";
import { formatDate } from "@/lib/utils";
import type { DailyRun } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

type RunHealth = {
  state: "healthy" | "warn" | "none";
  label: string;
};

function runHealth(run: DailyRun): RunHealth {
  const funnel = run.funnelJson as { board_failures?: string[] } | null;
  const errors: string[] = run.errors ? JSON.parse(run.errors) : [];
  const { other } = categorizeRunErrors(errors);

  if ((run.listingsScraped ?? 0) === 0 && (run.companiesFound ?? 0) === 0) {
    return { state: "none", label: "no run" };
  }
  // board_skips (schedule gate) are intentional and never affect health.
  const boardFailure = funnel?.board_failures?.[0];
  if (boardFailure) {
    if (boardFailure.includes("serpapi_budget")) {
      return { state: "warn", label: "serpapi budget" };
    }
    if (boardFailure.includes("serpapi_run_cap")) {
      return { state: "warn", label: "serpapi cap" };
    }
    // e.g. "zip_recruiter: 0 listings this run (often blocked …)"
    const short = boardFailure.split("(")[0].split(":")[0].trim();
    return { state: "warn", label: short.replace("zip_recruiter", "zip 403") };
  }
  if (other.length > 0) {
    return { state: "warn", label: `${other.length} error${other.length > 1 ? "s" : ""}` };
  }
  return { state: "healthy", label: "healthy" };
}

function HealthPill({ health }: { health: RunHealth }) {
  const style =
    health.state === "healthy"
      ? "bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300"
      : health.state === "warn"
        ? "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
        : "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300";
  const dot =
    health.state === "healthy" ? "●" : health.state === "warn" ? "⚠" : "×";
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${style}`}
    >
      <span aria-hidden>{dot}</span> {health.label}
    </span>
  );
}

export default async function RunsPage() {
  let runs;
  let backlogCount = 0;

  try {
    [runs, backlogCount] = await Promise.all([
      getRecentRuns(),
      getBacklogCompanies().then((rows) => rows.length),
    ]);
  } catch {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold">Pipeline Runs</h1>
        <p className="text-gray-500 mt-2">Database not connected.</p>
      </div>
    );
  }

  const today = businessListDate();

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-1">Pipeline Runs</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6 max-w-3xl">
        One row per scheduled batch — which market it scraped, what it found,
        and what it cost in credits. Click a row to expand the funnel detail.
        Current backlog: {backlogCount} companies (cumulative across days).
      </p>

      {runs.length === 0 ? (
        <p className="text-gray-400">No runs recorded yet.</p>
      ) : (
        <div className="border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden bg-white dark:bg-gray-950 shadow-sm overflow-x-auto">
          <table className="w-full text-sm min-w-[48rem]">
            <thead>
              <tr className="text-left text-[10px] font-medium uppercase tracking-wide text-gray-500 bg-gray-50 dark:bg-gray-900/80 border-b border-gray-200 dark:border-gray-800">
                <th className="px-4 py-2">Run</th>
                <th className="px-3 py-2">Market</th>
                <th className="px-3 py-2 text-right" title="Job listings scraped this batch">
                  Listings
                </th>
                <th className="px-3 py-2 text-right" title="New companies from this scrape">
                  New cos
                </th>
                <th className="px-3 py-2 text-right">Enriched</th>
                <th className="px-3 py-2 text-right" title="Paid enrichment credits spent — a silent drain shows here">
                  Credits
                </th>
                <th className="px-3 py-2">Health</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const errors: string[] = run.errors ? JSON.parse(run.errors) : [];
                const { domainSkipped, other } = categorizeRunErrors(errors);
                const health = runHealth(run);
                const isToday = run.runDate === today;
                const credits = run.creditsUsed ?? 0;
                const funnel = (run.funnelJson ?? null) as PipelineFunnel | null;
                const serpapiLine = funnel ? formatSerpapiMeterLine(funnel) : null;
                const hasDetail =
                  Boolean(run.funnelJson) ||
                  domainSkipped.length > 0 ||
                  other.length > 0;

                return (
                  <tr
                    key={run.id}
                    className="border-b border-gray-100 dark:border-gray-900 last:border-b-0 align-top"
                  >
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="font-medium">{formatDate(run.runDate)}</span>
                      <span className="ml-2 text-xs text-gray-500">
                        {formatRunSlot(run.runSlot)}
                      </span>
                      {isToday && (
                        <span className="ml-2 text-[10px] uppercase tracking-wide text-gray-400">
                          today
                        </span>
                      )}
                      {serpapiLine && (
                        <p
                          className="mt-1 text-[10px] text-gray-500 font-mono whitespace-normal"
                          title="SerpApi meter — per-run + month-to-date searches vs plan"
                        >
                          {serpapiLine}
                        </p>
                      )}
                      {hasDetail && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-xs text-blue-600 dark:text-blue-400 hover:underline select-none">
                            Funnel detail
                          </summary>
                          <div className="mt-1 max-w-xl space-y-1">
                            {funnel ? (
                              <>
                                <p className="text-[10px] text-gray-500 font-mono whitespace-normal">
                                  {formatRunFunnelLine(funnel)}
                                </p>
                                {funnel.board_skips?.length ? (
                                  <p className="text-[10px] text-sky-700 dark:text-sky-400 font-mono whitespace-normal">
                                    Skipped (intentional):{" "}
                                    {funnel.board_skips.join("; ")}
                                  </p>
                                ) : null}
                                {funnel.google_per_query?.length ? (
                                  <p className="text-[10px] text-gray-500 font-mono whitespace-normal">
                                    Google pages:{" "}
                                    {funnel.google_per_query
                                      .map(formatGooglePerQueryLine)
                                      .join("; ")}
                                  </p>
                                ) : null}
                                {funnel.google_adaptive_skips?.length ? (
                                  <p className="text-[10px] text-gray-400 font-mono whitespace-normal">
                                    Adaptive title skips:{" "}
                                    {funnel.google_adaptive_skips.join("; ")}
                                  </p>
                                ) : null}
                                <p className="text-[10px] text-gray-400 font-mono whitespace-normal">
                                  DB: {formatDbFunnelLine(funnel)}
                                </p>
                              </>
                            ) : null}
                            {domainSkipped.length > 0 && (
                              <p className="text-[10px] text-gray-500 whitespace-normal">
                                No domain (enrich deferred): {domainSkipped.join("; ")}
                              </p>
                            )}
                            {other.length > 0 && (
                              <p className="text-[10px] text-amber-700 dark:text-amber-400 whitespace-normal">
                                Errors: {other.join("; ")}
                              </p>
                            )}
                          </div>
                        </details>
                      )}
                    </td>
                    <td className="px-3 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                      {run.market ?? <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {(run.listingsScraped ?? 0).toLocaleString()}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {(run.companiesFound ?? 0).toLocaleString()}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {run.companiesEnriched ?? 0}
                    </td>
                    <td
                      className={`px-3 py-3 text-right tabular-nums ${
                        credits > 0
                          ? "font-semibold text-amber-700 dark:text-amber-400"
                          : ""
                      }`}
                    >
                      {credits}
                    </td>
                    <td className="px-3 py-3">
                      <HealthPill health={health} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
