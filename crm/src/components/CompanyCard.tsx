import { Contact, JobListing } from "@/lib/db/schema";
import { CompanyStatus } from "@/lib/db/schema";
import Link from "next/link";
import { StatusBadge, StatusSelect } from "./StatusBadge";

export interface CompanyCardData {
  id: string;
  name: string;
  domain: string | null;
  domainConfidence: string;
  status: CompanyStatus;
  firstSeen: string;
  contacts: Contact[];
  jobListings: JobListing[];
}

export function CompanyCard({ company }: { company: CompanyCardData }) {
  const primaryJob = company.jobListings[0];

  return (
    <article className="border border-gray-200 dark:border-gray-800 rounded-xl p-5 bg-white dark:bg-gray-950 shadow-sm">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <Link
            href={`/companies/${company.id}`}
            className="text-lg font-semibold hover:underline"
          >
            {company.name}
          </Link>
          {company.domain && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              {company.domain}
              {company.domainConfidence === "low" && (
                <span className="ml-2 text-amber-600 dark:text-amber-400 text-xs">
                  (unverified domain)
                </span>
              )}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge status={company.status} />
          <StatusSelect companyId={company.id} currentStatus={company.status} />
        </div>
      </div>

      {primaryJob && (
        <div className="mb-4 p-3 rounded-lg bg-gray-50 dark:bg-gray-900 text-sm">
          <p className="font-medium">{primaryJob.title}</p>
          <p className="text-gray-500 dark:text-gray-400 mt-0.5">
            {primaryJob.board}
            {primaryJob.location ? ` · ${primaryJob.location}` : ""}
          </p>
          {primaryJob.url && (
            <a
              href={primaryJob.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:underline mt-1 inline-block"
            >
              View posting →
            </a>
          )}
        </div>
      )}

      {company.contacts.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Contacts
          </p>
          {company.contacts.map((c) => (
            <div
              key={c.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
            >
              <span className="font-medium">{c.name}</span>
              <span className="text-gray-500">{c.title}</span>
              {c.email && (
                <a
                  href={`mailto:${c.email}`}
                  className="text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {c.email}
                </a>
              )}
              {c.phone && (
                <a
                  href={`tel:${c.phone}`}
                  className="text-gray-600 dark:text-gray-300"
                >
                  {c.phone}
                </a>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-400 italic">No contacts enriched yet</p>
      )}
    </article>
  );
}
