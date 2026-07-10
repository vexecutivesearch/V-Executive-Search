import { getBacklogCompanies, getRecentRuns } from "@/lib/queries";
import { categorizeRunErrors } from "@/lib/run-errors";
import { formatFunnelLine, type PipelineFunnel } from "@/lib/pipeline-funnel";
import { businessListDate } from "@/lib/timezone";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

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
      <h1 className="text-2xl font-bold mb-2">Pipeline Runs</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6 max-w-3xl">
        Each row is <strong>today&apos;s nightly batch</strong> — listings scraped,
        new companies ingested, and how many were enriched with paid credits.
        The ranked backlog ({backlogCount} companies) is cumulative across all
        days and is not the same as &quot;Companies&quot; in this table.
      </p>

      {runs.length === 0 ? (
        <p className="text-gray-400">No runs recorded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 text-left text-gray-500">
                <th className="py-2 pr-4">Date</th>
                <th className="py-2 pr-4" title="Job listings scraped this batch">
                  Listings
                </th>
                <th className="py-2 pr-4" title="New companies from this scrape">
                  New cos
                </th>
                <th className="py-2 pr-4">Skipped</th>
                <th className="py-2 pr-4">Enriched</th>
                <th className="py-2 pr-4">Contacts</th>
                <th className="py-2 pr-4">Credits</th>
                <th className="py-2">Issues</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const errors = run.errors ? JSON.parse(run.errors) : [];
                const { domainSkipped, other } = categorizeRunErrors(errors);
                const isToday = run.runDate === today;

                return (
                  <tr
                    key={run.id}
                    className="border-b border-gray-100 dark:border-gray-900"
                  >
                    <td className="py-3 pr-4 font-medium">
                      {formatDate(run.runDate)}
                      {isToday && (
                        <span className="ml-2 text-xs font-normal text-gray-400">
                          backlog {backlogCount}
                        </span>
                      )}
                      {run.funnelJson ? (
                        <p className="text-[10px] text-gray-400 mt-0.5 font-mono max-w-xs truncate">
                          {formatFunnelLine(run.funnelJson as PipelineFunnel)}
                        </p>
                      ) : null}
                    </td>
                    <td className="py-3 pr-4">{run.listingsScraped}</td>
                    <td className="py-3 pr-4">{run.companiesFound}</td>
                    <td className="py-3 pr-4">{run.companiesSkippedExisting}</td>
                    <td className="py-3 pr-4">{run.companiesEnriched}</td>
                    <td className="py-3 pr-4">{run.contactsEnriched}</td>
                    <td className="py-3 pr-4">{run.creditsUsed}</td>
                    <td className="py-3">
                      {domainSkipped.length === 0 && other.length === 0 ? (
                        "—"
                      ) : (
                        <details className="cursor-pointer">
                          <summary className="text-amber-600">
                            {domainSkipped.length > 0 && (
                              <span>
                                {domainSkipped.length} skipped (no domain)
                              </span>
                            )}
                            {domainSkipped.length > 0 && other.length > 0 && (
                              <span> · </span>
                            )}
                            {other.length > 0 && (
                              <span>
                                {other.length} error{other.length > 1 ? "s" : ""}
                              </span>
                            )}
                          </summary>
                          <ul className="mt-1 max-w-md text-xs font-normal text-gray-600 dark:text-gray-400 list-disc pl-4">
                            {domainSkipped.length > 0 && (
                              <li className="list-none -ml-4 font-medium text-gray-500">
                                No domain (enrich deferred):
                              </li>
                            )}
                            {domainSkipped.map((err: string, i: number) => (
                              <li key={`d-${i}`}>{err}</li>
                            ))}
                            {other.length > 0 && domainSkipped.length > 0 && (
                              <li className="list-none -ml-4 mt-2 font-medium text-gray-500">
                                Other errors:
                              </li>
                            )}
                            {other.map((err: string, i: number) => (
                              <li key={`e-${i}`}>{err}</li>
                            ))}
                          </ul>
                        </details>
                      )}
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
