import { Contact, JobListing } from "@/lib/db/schema";
import { CompanyStatus } from "@/lib/db/schema";
import Link from "next/link";
import { StatusBadge, StatusSelect } from "./StatusBadge";
import { EnrichButton } from "./EnrichButton";

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

function ContactLocationNote({
  jobLocation,
  contact,
}: {
  jobLocation: string | null | undefined;
  contact: Contact;
}) {
  if (contact.locationMatched) {
    return (
      <span className="text-xs text-green-700 dark:text-green-400">
        Matched to job location
        {contact.contactLocation ? ` (${contact.contactLocation})` : ""}
      </span>
    );
  }

  if (jobLocation) {
    return (
      <span className="text-xs text-amber-700 dark:text-amber-400">
        Not verified for {jobLocation}
        {contact.contactLocation ? ` — contact in ${contact.contactLocation}` : ""}
      </span>
    );
  }

  return (
    <span className="text-xs text-amber-700 dark:text-amber-400">
      Location not verified for this posting
    </span>
  );
}

export function CompanyCard({ company }: { company: CompanyCardData }) {
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
          />
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

      {hasContacts && anyUnverified && jobLocation && (
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
            <div key={c.id} className="space-y-1 text-sm">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
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
              <ContactLocationNote jobLocation={jobLocation} contact={c} />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-400 italic">No contacts enriched yet</p>
      )}
    </article>
  );
}
