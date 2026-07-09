"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function EnrichButton({
  companyId,
  contactCount,
  compact = false,
}: {
  companyId: string;
  contactCount: number;
  compact?: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleEnrich() {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/enrich`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error || "Enrichment failed");
        return;
      }

      const parts: string[] = [];
      if (data.contacts_added > 0) {
        parts.push(
          `+${data.contacts_added} contact${data.contacts_added === 1 ? "" : "s"}`,
        );
      }
      if (data.personal_updated > 0) {
        parts.push(`${data.personal_updated} personal updated`);
      }
      setMessage(parts.length ? parts.join(", ") : data.message || "Up to date");
      router.refresh();
    } catch {
      setMessage("Network error");
    } finally {
      setLoading(false);
    }
  }

  const label =
    contactCount > 0
      ? compact
        ? "Enrich"
        : "Enrich contacts"
      : compact
        ? "Enrich"
        : "Enrich contacts";

  return (
    <div className="inline-flex flex-col items-start gap-0.5">
      <button
        type="button"
        onClick={handleEnrich}
        disabled={loading}
        title="Apollo + ContactOut: find contacts and personal email/mobile"
        className={`rounded-md font-medium transition-colors disabled:opacity-50 ${
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
          className={`text-[10px] max-w-[140px] leading-tight ${
            message.includes("+") || message.includes("updated")
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
