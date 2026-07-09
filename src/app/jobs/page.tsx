import { getMarketJobListings } from "@/lib/queries";
import { JobsTable } from "@/components/JobsTable";

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
          {jobs.length} {jobs.length === 1 ? "listing" : "listings"} · Click{" "}
          <strong>Enrich</strong> to find HR/executive contacts via Apollo (uses
          credits)
        </p>
      </div>

      {jobs.length === 0 ? (
        <p className="text-gray-400">No listings found for this scan.</p>
      ) : (
        <JobsTable jobs={jobs} />
      )}
    </div>
  );
}
