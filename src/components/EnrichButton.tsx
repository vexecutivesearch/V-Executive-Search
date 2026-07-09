"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CompanyCardData } from "./CompanyCard";
import { contactPhonesForDisplay } from "@/lib/contact-phones";

type EnrichResponse = {
  error?: string;
  contacts_added?: number;
  apollo_refreshed?: number;
  apollo_phones_requested?: number;
  apollo_phones_added?: number;
  apollo_webhook_configured?: boolean;
  existing_contacts?: number;
  personal_updated?: number;
  contactout_checked?: number;
  contactout_phone_locked?: boolean;
  phones_backfilled?: number;
  message?: string;
  company?: CompanyCardData;
};

function countPhones(company?: CompanyCardData): number {
  if (!company) return 0;
  return company.contacts.reduce(
    (n, c) => n + contactPhonesForDisplay(c).length,
    0,
  );
}

function buildSummary(data: EnrichResponse): string {
  const parts: string[] = [];
  if ((data.contacts_added ?? 0) > 0) {
    parts.push(
      `+${data.contacts_added} contact${data.contacts_added === 1 ? "" : "s"}`,
    );
  }
  if ((data.apollo_phones_added ?? 0) > 0) {
    parts.push(
      `${data.apollo_phones_added} phone${data.apollo_phones_added === 1 ? "" : "s"} from Apollo`,
    );
  } else if ((data.apollo_refreshed ?? 0) > 0) {
    parts.push(`${data.apollo_refreshed} Apollo updated`);
  }
  if ((data.personal_updated ?? 0) > 0) {
    parts.push(`${data.personal_updated} personal updated`);
  }
  if ((data.phones_backfilled ?? 0) > 0) {
    parts.push(`${data.phones_backfilled} phone fields synced`);
  }
  if (parts.length) return parts.join(" · ");
  if (data.message) return data.message;
  if ((data.existing_contacts ?? 0) > 0) {
    return `${data.existing_contacts} Apollo contact${data.existing_contacts === 1 ? "" : "s"} on file`;
  }
  return "Up to date — no new contacts or personal data";
}

async function pollCompanyPhones(
  companyId: string,
  phonesBefore: number,
): Promise<CompanyCardData | undefined> {
  let latest: CompanyCardData | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`/api/companies/${companyId}`, { cache: "no-store" });
    if (!res.ok) continue;
    const data = (await res.json()) as { company: CompanyCardData };
    latest = data.company;
    if (countPhones(latest) > phonesBefore) return latest;
  }
  return latest;
}

export function EnrichButton({
  companyId,
  contactCount,
  compact = false,
  onEnrichComplete,
}: {
  companyId: string;
  contactCount: number;
  compact?: boolean;
  onEnrichComplete?: (
    company?: CompanyCardData,
    summary?: string,
  ) => void | Promise<void>;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function handleEnrich(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setLoading(true);
    setMessage(null);
    setIsError(false);
    try {
      const phonesBeforeRes = await fetch(`/api/companies/${companyId}`, {
        cache: "no-store",
      });
      let phonesBefore = 0;
      if (phonesBeforeRes.ok) {
        const beforeData = (await phonesBeforeRes.json()) as {
          company: CompanyCardData;
        };
        phonesBefore = countPhones(beforeData.company);
      }

      const res = await fetch(`/api/companies/${companyId}/enrich`, {
        method: "POST",
      });
      const data = (await res.json()) as EnrichResponse;
      if (!res.ok) {
        const err = data.error || "Enrichment failed";
        setMessage(err);
        setIsError(true);
        if (onEnrichComplete) await onEnrichComplete(undefined, err);
        return;
      }

      let company = data.company;
      let summary = buildSummary(data);

      const shouldPoll =
        (data.apollo_phones_requested ?? 0) > 0 &&
        (data.apollo_phones_added ?? 0) === 0 &&
        data.apollo_webhook_configured !== false;

      if (shouldPoll) {
        setMessage("Waiting for Apollo phones…");
        const polled = await pollCompanyPhones(companyId, phonesBefore);
        if (polled && countPhones(polled) > phonesBefore) {
          company = polled;
          const added = countPhones(polled) - phonesBefore;
          summary = `${added} phone${added === 1 ? "" : "s"} arrived from Apollo`;
        }
      }

      setMessage(summary);
      setIsError(
        !summary.includes("+") &&
          !summary.includes("phone") &&
          !summary.includes("updated") &&
          !summary.includes("synced") &&
          (summary.includes("locked") ||
            summary.includes("not configured") ||
            summary.includes("no new")),
      );

      if (onEnrichComplete) {
        await onEnrichComplete(company, summary);
      } else {
        router.refresh();
      }
    } catch {
      const err = "Network error — could not reach enrich API";
      setMessage(err);
      setIsError(true);
      if (onEnrichComplete) await onEnrichComplete(undefined, err);
    } finally {
      setLoading(false);
    }
  }

  const label = compact ? "Enrich" : "Enrich contacts";

  return (
    <div
      className="inline-flex flex-col items-end gap-0.5"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={handleEnrich}
        disabled={loading}
        title="Apollo + ContactOut: find contacts and personal email/mobile"
        className={`rounded-md font-medium transition-colors disabled:opacity-50 whitespace-nowrap ${
          compact
            ? "px-2 py-1 text-xs bg-green-700 text-white hover:bg-green-800"
            : "px-3 py-1.5 text-sm bg-green-700 text-white hover:bg-green-800"
        }`}
      >
        {loading ? "Enriching…" : label}
      </button>
      {contactCount > 0 && !message && (
        <span className="text-[10px] text-gray-400">{contactCount} saved</span>
      )}
      {message && (
        <span
          className={`text-[10px] max-w-[200px] leading-tight text-right ${
            isError
              ? "text-red-700 dark:text-red-400"
              : message.includes("+") ||
                  message.includes("phone") ||
                  message.includes("updated") ||
                  message.includes("synced")
                ? "text-green-700 dark:text-green-400"
                : "text-amber-700 dark:text-amber-400"
          }`}
        >
          {message}
        </span>
      )}
    </div>
  );
}
