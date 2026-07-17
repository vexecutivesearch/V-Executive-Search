import Link from "next/link";
import { TodayPageContent } from "@/app/today/page";
import { CompaniesPageContent } from "@/app/companies/page";

export const dynamic = "force-dynamic";

type LegacySearchParams = {
  section?: string;
  date?: string;
  from?: string;
  to?: string;
  tab?: string;
  status?: string;
  q?: string;
  view?: string;
  list?: string;
};

/**
 * Legacy consolidates the two pre-Pipeline working views without changing
 * either one's data, filters, enrichment, export, or status behavior.
 */
export default async function LegacyPage({
  searchParams,
}: {
  searchParams: Promise<LegacySearchParams>;
}) {
  const params = await searchParams;
  const section = params.section === "companies" ? "companies" : "today";
  const tabClass = (active: boolean) =>
    `px-4 py-2 rounded-full text-sm border transition-colors ${
      active
        ? "bg-gray-900 text-white border-gray-900 dark:bg-white dark:text-gray-900"
        : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 hover:bg-gray-100 dark:hover:bg-gray-800"
    }`;

  return (
    <>
      <div className="max-w-6xl mx-auto px-4 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 dark:border-gray-800 pb-4">
          <div>
            <h1 className="text-xl font-bold">Legacy</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              Original Today&apos;s List and Companies views, unchanged.
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/legacy?section=today"
              className={tabClass(section === "today")}
            >
              Today&apos;s List
            </Link>
            <Link
              href="/legacy?section=companies"
              className={tabClass(section === "companies")}
            >
              Companies
            </Link>
          </div>
        </div>
      </div>

      {section === "companies" ? (
        <CompaniesPageContent
          searchParams={Promise.resolve(params)}
          basePath="/legacy"
        />
      ) : (
        <TodayPageContent
          searchParams={Promise.resolve(params)}
          basePath="/legacy"
        />
      )}
    </>
  );
}
