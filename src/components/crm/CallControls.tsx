"use client";

import { useEffect, useState } from "react";
import type { CallListEntry, CallStatus } from "@/lib/db/schema";
import {
  CALL_STATUS_COLORS,
  CALL_STATUS_LABELS,
  CALL_STATUSES,
} from "@/lib/call-status";

/**
 * Dossier call controls — status · attempts · follow-up · assignee,
 * writing straight to the company's call_list_entries row. Log a call
 * without leaving the panel.
 */
export function CallControls({ companyId }: { companyId: string }) {
  const [entry, setEntry] = useState<CallListEntry | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [assignedTo, setAssignedTo] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/call-list?company_id=${companyId}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { entry?: CallListEntry | null } | null) => {
        if (cancelled) return;
        setEntry(data?.entry ?? null);
        setAssignedTo(data?.entry?.assignedTo ?? "");
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  async function patch(body: Record<string, unknown>) {
    if (!entry) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/call-list/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { entry?: CallListEntry };
      if (res.ok && data.entry) setEntry(data.entry);
    } finally {
      setBusy(false);
    }
  }

  if (!loaded || !entry) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-3 py-2.5 text-sm">
      <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
        Call list
      </span>

      <select
        value={entry.callStatus}
        disabled={busy}
        onChange={(e) => patch({ call_status: e.target.value as CallStatus })}
        className={`text-xs font-medium rounded-md px-2 py-1.5 border border-transparent cursor-pointer disabled:opacity-50 ${CALL_STATUS_COLORS[entry.callStatus]}`}
        aria-label="Call status"
      >
        {CALL_STATUSES.map((s) => (
          <option key={s} value={s}>
            {CALL_STATUS_LABELS[s]}
          </option>
        ))}
      </select>

      <span className="text-xs text-gray-600 dark:text-gray-400 tabular-nums">
        {entry.attempts} attempt{entry.attempts === 1 ? "" : "s"}
      </span>

      <label className="flex items-center gap-1.5 text-xs text-gray-500">
        Follow-up
        <input
          type="date"
          value={entry.nextFollowUpDate ?? ""}
          disabled={busy}
          onChange={(e) => patch({ next_follow_up_date: e.target.value || null })}
          className="text-xs border border-gray-200 dark:border-gray-700 rounded-md px-1.5 py-1 bg-white dark:bg-gray-900 disabled:opacity-50"
        />
      </label>

      <label className="flex items-center gap-1.5 text-xs text-gray-500">
        Assigned
        <input
          type="text"
          value={assignedTo}
          disabled={busy}
          onChange={(e) => setAssignedTo(e.target.value)}
          onBlur={() => {
            if (assignedTo.trim() !== (entry.assignedTo ?? "").trim()) {
              patch({ assigned_to: assignedTo.trim() || null });
            }
          }}
          placeholder="Name"
          className="w-24 text-xs border border-gray-200 dark:border-gray-700 rounded-md px-1.5 py-1 bg-white dark:bg-gray-900"
        />
      </label>
    </div>
  );
}
