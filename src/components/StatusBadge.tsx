"use client";

import { CompanyStatus } from "@/lib/db/schema";
import { STATUS_COLORS, STATUS_LABELS } from "@/lib/utils";
import { useRouter } from "next/navigation";
import { useState } from "react";

const STATUSES: CompanyStatus[] = [
  "new",
  "contacted",
  "meeting",
  "client",
  "skipped",
];

export function StatusBadge({ status }: { status: CompanyStatus }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

export function StatusSelect({
  companyId,
  currentStatus,
}: {
  companyId: string;
  currentStatus: CompanyStatus;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(currentStatus);
  const [loading, setLoading] = useState(false);

  async function handleChange(newStatus: CompanyStatus) {
    setLoading(true);
    setStatus(newStatus);
    try {
      await fetch(`/api/companies/${companyId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <select
      value={status}
      disabled={loading}
      onChange={(e) => handleChange(e.target.value as CompanyStatus)}
      className="text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1 bg-white dark:bg-gray-900 disabled:opacity-50"
    >
      {STATUSES.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABELS[s]}
        </option>
      ))}
    </select>
  );
}
