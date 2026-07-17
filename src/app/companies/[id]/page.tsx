import { RefreshableCompanyCard } from "@/components/RefreshableCompanyCard";
import { ActivityTimeline } from "@/components/ActivityTimeline";
import { getCompanyActivities, getCompanyById } from "@/lib/queries";
import { notFound } from "next/navigation";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function CompanyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const company = await getCompanyById(id);
  if (!company) notFound();
  const activities = await getCompanyActivities(id);

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <Link
        href="/crm"
        className="text-sm text-gray-500 hover:underline mb-4 inline-block"
      >
        ← Back to Pipeline
      </Link>
      <RefreshableCompanyCard company={company} showLocationDisclaimer />

      <ActivityTimeline companyId={id} initialActivities={activities} />

      {company.jobListings.length > 1 && (
        <section className="mt-6">
          <h2 className="text-sm font-medium uppercase tracking-wide text-gray-500 mb-3">
            All job listings ({company.jobListings.length})
          </h2>
          <ul className="space-y-2">
            {company.jobListings.map((jl) => (
              <li
                key={jl.id}
                className="text-sm border border-gray-200 dark:border-gray-800 rounded-lg p-3"
              >
                <p className="font-medium">{jl.title}</p>
                <p className="text-gray-500">
                  {jl.board}
                  {jl.location ? ` · ${jl.location}` : ""}
                </p>
                {jl.url && (
                  <a
                    href={jl.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    View posting
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
