"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CompanyCardData } from "./CompanyCard";

type EnrichResponse = {
  error?: string;
  contacts_added?: number;
  personal_updated?: number;
  contactout_checked?: number;
  phones_backfilled?: number;
  message?: string;
  company?: CompanyCardData;
};

function buildSummary(data: EnrichResponse): string {
  const parts: string[] = [];
  if ((data.contacts_added ?? 0) > 0) {
    parts.push(
      `+${data.contacts_added} contact${data.contacts_added === 1 ? "" : "s"}`,
    );
  }
  if ((data.personal_updated ?? 0) > 0) {
    parts.push(`${data.personal_updated} personal updated`);
  }
  if ((data.phones_backfilled ?? 0) > 0) {
    parts.push(`${data.phones_backfilled} phone fields synced`);
  }
  if (parts.length) return parts.join(" · ");
  if (data.message) return data.message;
  if ((data.contactout_checked ?? 0) > 0) {
    return `ContactOut checked ${data.contactout_checked} — no new personal data`;
  }
  return "Up to date — no new contacts or personal data";
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

      const summary = buildSummary(data);
      setMessage(summary);
      setIsError(
        !summary.includes("+") &&
          !summary.includes("updated") &&
          !summary.includes("synced"),
      );

      if (onEnrichComplete) {
        await onEnrichComplete(
          data.company ? (data.company as CompanyCardData) : undefined,
          summary,
        );
      }
      router.refresh();
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
          className={`text-[10px] max-w-[180px] leading-tight text-right ${
            isError
              ? "text-red-700 dark:text-red-400"
              : message.includes("+") ||
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
