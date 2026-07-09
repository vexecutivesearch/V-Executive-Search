import { CompanyCard } from "@/components/CompanyCard";
import { getTodayCompanies, getTodayGeoLabel } from "@/lib/queries";
import { businessListWindowLabel } from "@/lib/timezone";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const listLabel = businessListWindowLabel();

  let companies;
  let geoLabel = "your focus area";
  try {
    [companies, geoLabel] = await Promise.all([
      getTodayCompanies(),
      getTodayGeoLabel(),
    ]);
  } catch {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-2">Today&apos;s List</h1>
        <p className="text-gray-500">
          Database not connected. Set DATABASE_URL and run{" "}
          <code className="text-sm bg-gray-100 dark:bg-gray-800 px-1 rounded">
            npm run db:push
          </code>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Today&apos;s List</h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1">{listLabel}</p>
        <p className="text-sm text-gray-400 mt-1">
          {companies.length} callable{" "}
          {companies.length === 1 ? "lead" : "leads"} in {geoLabel}
        </p>
      </div>

      {companies.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">No callable leads for this business day</p>
          <p className="text-sm mt-2">
            The list includes companies from the 6 AM and 6 PM pipeline runs and
            refreshes at 6 AM Eastern. Browse unenriched jobs on the Jobs page.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {companies.map((company) => (
            <CompanyCard key={company.id} company={company} />
          ))}
        </div>
      )}
    </div>
  );
}
