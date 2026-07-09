import { CompanyCard } from "@/components/CompanyCard";
import { CompanySearch } from "@/components/CompanySearch";
import { getCompaniesByStatus, getTodayGeoLabel } from "@/lib/queries";
import { CompanyStatus } from "@/lib/db/schema";
import { STATUS_LABELS } from "@/lib/utils";
import Link from "next/link";
import { Suspense } from "react";

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
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const { status, q } = await searchParams;
  const filterStatus = FILTERS.find((f) => f.value === status)?.value;

  let companies;
  let geoLabel = "your focus area";
  try {
    [companies, geoLabel] = await Promise.all([
      getCompaniesByStatus(filterStatus, q),
      getTodayGeoLabel(),
    ]);
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
      <h1 className="text-2xl font-bold mb-1">Companies</h1>
      <p className="text-sm text-gray-400 mb-4">Showing {geoLabel} only</p>

      <div className="flex flex-wrap gap-2 mb-6">
        {FILTERS.map((f) => {
          const params = new URLSearchParams();
          if (f.value) params.set("status", f.value);
          if (q?.trim()) params.set("q", q.trim());
          const href = params.size
            ? `/companies?${params.toString()}`
            : "/companies";
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

      <Suspense fallback={null}>
        <CompanySearch initialQuery={q} />
      </Suspense>

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
