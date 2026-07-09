import { CompanyCard } from "@/components/CompanyCard";
import { JobsTable } from "@/components/JobsTable";
import { getInFocusJobListings, getTodayGeoLabel } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  let jobs;
  let geoLabel = "your focus area";
  try {
    [jobs, geoLabel] = await Promise.all([
      getInFocusJobListings(),
      getTodayGeoLabel(),
    ]);
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
        <p className="text-gray-500 dark:text-gray-400 mt-1">{geoLabel}</p>
        <p className="text-sm text-gray-400 mt-1">
          {jobs.length} in-focus {jobs.length === 1 ? "listing" : "listings"}{" "}
          · Click <strong>Enrich</strong> to find HR/executive contacts via
          Apollo (uses credits)
        </p>
      </div>

      {jobs.length === 0 ? (
        <p className="text-gray-400">
          No listings in {geoLabel} yet. Run the pipeline from Admin after
          saving your geographic focus.
        </p>
      ) : (
        <JobsTable jobs={jobs} />
      )}
    </div>
  );
}
