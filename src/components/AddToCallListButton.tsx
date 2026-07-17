"use client";

import { useState } from "react";
import Link from "next/link";
import type { CallListEntry } from "@/lib/db/schema";

type OnListState = "unknown" | "on" | "off";

export function OnCallListBadge() {
  return (
    <Link
      href="/crm?tab=call-list"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 hover:underline whitespace-nowrap"
      title="This company is on the call list — open it"
    >
      ✓ On Call List
    </Link>
  );
}

/**
 * Persistent "Add to Call List" action for enriched companies
 * (retroactive add — the post-enrich Yes/No prompt is separate).
 */
export function AddToCallListButton({
  companyId,
  initialOnList,
  compact = false,
  onAdded,
}: {
  companyId: string;
  /** Pass when membership is known server-side; omit to resolve on click. */
  initialOnList?: boolean;
  compact?: boolean;
  onAdded?: (entry: CallListEntry) => void;
}) {
  const [state, setState] = useState<OnListState>(
    initialOnList === undefined ? "unknown" : initialOnList ? "on" : "off",
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state === "on") return <OnCallListBadge />;

  async function handleAdd(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/call-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: companyId }),
      });
      const data = (await res.json()) as {
        entry?: CallListEntry;
        error?: string;
      };
      if (!res.ok || !data.entry) {
        setError(data.error ?? "Could not add to call list");
        return;
      }
      setState("on");
      onAdded?.(data.entry);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <span
      className="inline-flex flex-col items-end gap-0.5"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={handleAdd}
        disabled={loading}
        title="Approve this company + contact into the active call list"
        className={`rounded-md font-medium transition-colors disabled:opacity-50 whitespace-nowrap border border-emerald-700 text-emerald-800 dark:text-emerald-300 dark:border-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 ${
          compact ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm"
        }`}
      >
        {loading ? "Adding…" : "Add to Call List"}
      </button>
      {error && (
        <span className="text-[10px] text-red-700 dark:text-red-400">{error}</span>
      )}
    </span>
  );
}

/** Post-enrich inline prompt: "Add to Call List: Yes / No". */
export function AddToCallListPrompt({
  companyId,
  onAnswer,
}: {
  companyId: string;
  /** Called after Yes (added=true) or No (added=false). */
  onAnswer: (added: boolean) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleYes() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/call-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: companyId }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not add to call list");
        return;
      }
      onAnswer(true);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-md border border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40 px-3 py-2 text-sm text-emerald-900 dark:text-emerald-200"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="font-medium">Add to Call List?</span>
      <span className="flex gap-2">
        <button
          type="button"
          disabled={loading}
          onClick={handleYes}
          className="px-3 py-1 rounded-md text-xs font-medium bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {loading ? "Adding…" : "Yes"}
        </button>
        <button
          type="button"
          disabled={loading}
          onClick={() => onAnswer(false)}
          className="px-3 py-1 rounded-md text-xs font-medium border border-emerald-700 text-emerald-800 dark:text-emerald-300 dark:border-emerald-600 hover:bg-emerald-100 dark:hover:bg-emerald-950/60 disabled:opacity-50"
        >
          No
        </button>
      </span>
      {error && (
        <span className="text-xs text-red-700 dark:text-red-400">{error}</span>
      )}
    </div>
  );
}
