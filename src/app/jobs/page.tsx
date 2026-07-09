import { getMarketJobListings } from "@/lib/queries";
import { formatDate } from "@/lib/utils";
import Link from "next/link";

export const dynamic = "force-dynamic";

const DEFAULT_SCAN = "West Palm Beach — 15 day market scan";

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ scan?: string }>;
}) {
  const { scan } = await searchParams;
  const searchName = scan || DEFAULT_SCAN;

  let jobs;
  try {
    jobs = await getMarketJobListings(searchName);
  } catch {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold">Job Listings</h1>
        <p className="text-gray-500 mt-2">Database not connected.</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Job Listings</h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1">{searchName}</p>
        <p className="text-sm text-gray-400 mt-1">
          {jobs.length} {jobs.length === 1 ? "listing" : "listings"}
        </p>
      </div>

      {jobs.length === 0 ? (
        <p className="text-gray-400">No listings found for this scan.</p>
      ) : (
        <div className="overflow-x-auto border border-gray-200 dark:border-gray-800 rounded-xl">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3">Posted</th>
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Company</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">Board</th>
                <th className="px-4 py-3">Link</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {jobs.map((job) => (
                <tr key={job.id} className="hover:bg-gray-50 dark:hover:bg-gray-900/50">
                  <td className="px-4 py-3 whitespace-nowrap text-gray-500">
                    {formatDate(job.postedAt?.toISOString())}
                  </td>
                  <td className="px-4 py-3 font-medium">{job.title}</td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/companies/${job.companyId}`}
                      className="text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      {job.companyName}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{job.location || "—"}</td>
                  <td className="px-4 py-3 text-gray-500">{job.board || "—"}</td>
                  <td className="px-4 py-3">
                    {job.url ? (
                      <a
                        href={job.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        View
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
