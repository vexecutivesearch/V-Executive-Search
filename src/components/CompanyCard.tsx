import { Contact, JobListing, type IcpStatus } from "@/lib/db/schema";
import { CompanyStatus } from "@/lib/db/schema";
import Link from "next/link";
import { StatusBadge, StatusSelect } from "./StatusBadge";
import { EnrichButton } from "./EnrichButton";
import { ContactRow } from "./ContactRow";

export interface CompanyCardData {
  id: string;
  name: string;
  domain: string | null;
  domainConfidence: string;
  status: CompanyStatus;
  firstSeen: string;
  industry?: string | null;
  /** Apollo estimated headcount — required for Hot Listings mid-size band. */
  estimatedEmployees?: number | null;
  leadScore?: number;
  hiringSignals?: Record<string, boolean | number>;
  reasonToCall?: string | null;
  callOpener?: string | null;
  icpStatus?: IcpStatus;
  enrichedAt?: Date | null;
  enrichRunDate?: string | null;
  contacts: Contact[];
  jobListings: JobListing[];
}

export function CompanyCard({
  company,
  onEnrichComplete,
  onStatusChange,
  showLocationDisclaimer = false,
}: {
  company: CompanyCardData;
  onEnrichComplete?: (company?: CompanyCardData) => void | Promise<void>;
  onStatusChange?: (status: CompanyStatus) => void;
  /** Shown on detail pages only — Today's List uses a one-time top notice instead. */
  showLocationDisclaimer?: boolean;
}) {
  const primaryJob = company.jobListings[0];
  const jobLocation =
    primaryJob?.location ||
    company.contacts.find((c) => c.jobLocation)?.jobLocation ||
    null;
  const hasContacts = company.contacts.length > 0;
  const anyUnverified = company.contacts.some((c) => !c.locationMatched);

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
          <EnrichButton
            companyId={company.id}
            contactCount={company.contacts.length}
            onEnrichComplete={onEnrichComplete}
          />
          <StatusBadge status={company.status} />
          <StatusSelect
            companyId={company.id}
            currentStatus={company.status}
            onStatusChange={onStatusChange}
          />
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

      {showLocationDisclaimer && hasContacts && anyUnverified && jobLocation && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          Contacts are matched by company and title, not guaranteed to be the
          hiring manager for <strong>{jobLocation}</strong>. Verify before
          outreach — especially at companies with many offices.
        </div>
      )}

      {hasContacts ? (
        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Contacts
          </p>
          {company.contacts.map((c) => (
            <ContactRow key={c.id} contact={c} jobLocation={jobLocation} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-400 italic">No contacts enriched yet</p>
      )}
    </article>
  );
}
