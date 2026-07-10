"use client";

import { Contact } from "@/lib/db/schema";
import {
  contactPhonesForDisplay,
  phoneKindLabel,
  sortPhonesForDisplay,
  sourceLabel,
} from "@/lib/contact-phones";
import { isPersonalEmail, parsePhoneValue } from "@/lib/phone-utils";
import { ImessageIndicator } from "./ImessageIndicator";

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

function linkedInHref(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith("http")) return trimmed;
  return `https://www.linkedin.com/in/${trimmed.replace(/^\/+/, "")}`;
}

function sourceBadgeClass(source: "apollo" | "contactout"): string {
  return source === "contactout"
    ? "text-green-800 dark:text-green-300 bg-green-50 dark:bg-green-950/50"
    : "text-blue-800 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/50";
}

export function ContactRow({
  contact,
  jobLocation,
}: {
  contact: Contact;
  jobLocation: string | null;
}) {
  const personalEmail = contact.personalEmail ?? (
    contact.email && isPersonalEmail(contact.email) ? contact.email : null
  );
  const workEmail =
    contact.workEmail ??
    (contact.email && !isPersonalEmail(contact.email) ? contact.email : null);

  const phones = sortPhonesForDisplay(contactPhonesForDisplay(contact));

  return (
    <div className="space-y-1.5 text-sm border-t border-gray-100 dark:border-gray-800 pt-3 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{contact.name}</span>
        {contact.title && (
          <span className="text-gray-500">{contact.title}</span>
        )}
        {contact.sourceProvider === "linkedin_poster" && (
          <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-200">
            {contact.title?.toLowerCase().includes("job poster") ||
            contact.title === "Job poster"
              ? "Job poster"
              : "Hiring team"}
          </span>
        )}
        {contact.linkedinUrl && (
          <a
            href={linkedInHref(contact.linkedinUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 dark:text-blue-400 hover:underline text-xs font-medium"
          >
            LinkedIn →
          </a>
        )}
      </div>

      <div className="flex flex-col gap-1 pl-0.5">
        {personalEmail && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-green-700 dark:text-green-400 font-medium">
              Personal
            </span>
            <a
              href={`mailto:${personalEmail}`}
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              {personalEmail}
            </a>
            <ImessageIndicator
              contactId={contact.id}
              capable={contact.imessageCapable}
              personalEmail={personalEmail}
            />
            {contact.emailDeliverable === true && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 text-green-800 dark:bg-green-950/50 dark:text-green-300">
                MX ✓
              </span>
            )}
            {contact.emailDeliverable === false && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300">
                Email risky
              </span>
            )}
          </div>
        )}

        {workEmail && workEmail !== personalEmail && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-gray-500 font-medium">
              Work
            </span>
            <a
              href={`mailto:${workEmail}`}
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              {workEmail}
            </a>
          </div>
        )}

        {!personalEmail && !workEmail && contact.email && (
          <a
            href={`mailto:${contact.email}`}
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            {contact.email}
          </a>
        )}

        {phones.length > 0 ? (
          phones.map((p) => (
            <div key={`${p.source}-${p.number}`} className="flex flex-wrap items-center gap-2">
              <span
                className={`text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded ${sourceBadgeClass(p.source)}`}
              >
                {sourceLabel(p.source)} · {phoneKindLabel(p.kind)}
              </span>
              <a
                href={`tel:${parsePhoneValue(p.number) ?? p.number}`}
                className="text-gray-800 dark:text-gray-200 hover:underline"
              >
                {parsePhoneValue(p.number) ?? p.number}
              </a>
            </div>
          ))
        ) : null}
      </div>

      <ContactLocationNote jobLocation={jobLocation} contact={contact} />
    </div>
  );
}
