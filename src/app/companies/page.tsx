import { CompanyCard } from "@/components/CompanyCard";
import { getCompaniesByStatus } from "@/lib/queries";
import { CompanyStatus } from "@/lib/db/schema";
import { STATUS_LABELS } from "@/lib/utils";
import Link from "next/link";

export const dynamic = "force-dynamic";

const FILTERS: { label: string; value?: CompanyStatus }[] = [
  { label: "All" },
  { label: STATUS_LABELS.new, value: "new" },
  { label: STATUS_LABELS.contacted, value: "contacted" },
  { label: STATUS_LABELS.meeting, value: "meeting" },
  { label: STATUS_LABELS.client, value: "client" },
  { label: STATUS_LABELS.skipped, value: "skipped" },
];

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const filterStatus = FILTERS.find((f) => f.value === status)?.value;

  let companies;
  try {
    companies = await getCompaniesByStatus(filterStatus);
  } catch {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold">Companies</h1>
        <p className="text-gray-500 mt-2">Database not connected.</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-4">Companies</h1>

      <div className="flex flex-wrap gap-2 mb-6">
        {FILTERS.map((f) => {
          const href = f.value ? `/companies?status=${f.value}` : "/companies";
          const active = (filterStatus ?? undefined) === f.value;
          return (
            <Link
              key={f.label}
              href={href}
              className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                active
                  ? "bg-gray-900 text-white border-gray-900 dark:bg-white dark:text-gray-900"
                  : "border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
              }`}
            >
              {f.label}
            </Link>
          );
        })}
      </div>

      <p className="text-sm text-gray-400 mb-4">
        {companies.length} {companies.length === 1 ? "company" : "companies"}
      </p>

      <div className="space-y-4">
        {companies.map((company) => (
          <CompanyCard key={company.id} company={company} />
        ))}
      </div>
    </div>
  );
}
