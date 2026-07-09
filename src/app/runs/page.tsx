import { getRecentRuns } from "@/lib/queries";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  let runs;
  try {
    runs = await getRecentRuns();
  } catch {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold">Pipeline Runs</h1>
        <p className="text-gray-500 mt-2">Database not connected.</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Pipeline Runs</h1>

      {runs.length === 0 ? (
        <p className="text-gray-400">No runs recorded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 text-left text-gray-500">
                <th className="py-2 pr-4">Date</th>
                <th className="py-2 pr-4">Listings</th>
                <th className="py-2 pr-4">Companies</th>
                <th className="py-2 pr-4">Skipped</th>
                <th className="py-2 pr-4">Enriched</th>
                <th className="py-2 pr-4">Contacts</th>
                <th className="py-2 pr-4">Credits</th>
                <th className="py-2">Errors</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const errors = run.errors ? JSON.parse(run.errors) : [];
                return (
                  <tr
                    key={run.id}
                    className="border-b border-gray-100 dark:border-gray-900"
                  >
                    <td className="py-3 pr-4 font-medium">
                      {formatDate(run.runDate)}
                    </td>
                    <td className="py-3 pr-4">{run.listingsScraped}</td>
                    <td className="py-3 pr-4">{run.companiesFound}</td>
                    <td className="py-3 pr-4">{run.companiesSkippedExisting}</td>
                    <td className="py-3 pr-4">{run.companiesEnriched}</td>
                    <td className="py-3 pr-4">{run.contactsEnriched}</td>
                    <td className="py-3 pr-4">{run.creditsUsed}</td>
                    <td className="py-3 text-amber-600">
                      {errors.length > 0 ? errors.length : "—"}
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
