import { CompanyCard } from "@/components/CompanyCard";
import { getTodayCompanies } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  let companies;
  try {
    companies = await getTodayCompanies();
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
        <p className="text-gray-500 dark:text-gray-400 mt-1">{today}</p>
        <p className="text-sm text-gray-400 mt-1">
          {companies.length} new {companies.length === 1 ? "company" : "companies"} ready for outreach
        </p>
      </div>

      {companies.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">No new companies today</p>
          <p className="text-sm mt-2">
            The scheduled pipeline (6 AM & 6 PM) will populate this list automatically.
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
