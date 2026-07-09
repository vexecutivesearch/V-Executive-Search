"use client";

import { useState } from "react";
import type { CompanyActivity, ActivityType } from "@/lib/db/schema";
import { STATUS_LABELS } from "@/lib/utils";

const TYPE_LABELS: Record<ActivityType, string> = {
  call: "Call",
  email: "Email",
  note: "Note",
  meeting: "Meeting",
};

export function ActivityTimeline({
  companyId,
  initialActivities,
  onActivitySaved,
}: {
  companyId: string;
  initialActivities: CompanyActivity[];
  onActivitySaved?: () => void;
}) {
  const [activities, setActivities] = useState(initialActivities);
  const [open, setOpen] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [summary, setSummary] = useState("");
  const [classification, setClassification] = useState<string | null>(null);
  const [suggestedStatus, setSuggestedStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSummarize() {
    if (!transcript.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/activities/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_id: companyId,
          transcript: transcript.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Summarize failed");
        return;
      }
      setSummary(data.summary ?? "");
      setClassification(data.classification ?? null);
      setSuggestedStatus(data.suggestedStatus ?? null);
    } finally {
      setBusy(false);
    }
  }

  async function handleSave(markContacted: boolean) {
    const text = summary.trim() || transcript.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/activities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "call",
          summary: text,
          raw_transcript: transcript.trim() || undefined,
          classification: classification ?? undefined,
          source: summary ? "haiku" : "manual",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Save failed");
        return;
      }

      if (markContacted && suggestedStatus) {
        await fetch(`/api/companies/${companyId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: suggestedStatus }),
        });
      } else if (markContacted) {
        await fetch(`/api/companies/${companyId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "contacted" }),
        });
      }

      setActivities((prev) => [data.activity, ...prev]);
      setOpen(false);
      setTranscript("");
      setSummary("");
      setClassification(null);
      setSuggestedStatus(null);
      onActivitySaved?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-gray-500">
          Activity ({activities.length})
        </h2>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline"
        >
          {open ? "Cancel" : "Log call"}
        </button>
      </div>

      {open && (
        <div className="mb-4 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3 bg-gray-50/50 dark:bg-gray-900/30">
          <textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder="Paste call notes or transcript…"
            rows={5}
            className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-950"
          />
          {summary && (
            <div className="rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30 p-3 text-sm">
              <p className="font-medium text-green-900 dark:text-green-200 mb-1">
                Suggested summary
              </p>
              <p className="text-green-800 dark:text-green-100">{summary}</p>
              {classification && (
                <p className="text-xs text-green-700 dark:text-green-300 mt-2">
                  {classification}
                  {suggestedStatus &&
                    ` · suggest status: ${STATUS_LABELS[suggestedStatus as keyof typeof STATUS_LABELS] ?? suggestedStatus}`}
                </p>
              )}
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !transcript.trim()}
              onClick={handleSummarize}
              className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 disabled:opacity-50"
            >
              {busy ? "Working…" : "Summarize with AI"}
            </button>
            <button
              type="button"
              disabled={busy || (!summary && !transcript.trim())}
              onClick={() => handleSave(false)}
              className="px-3 py-1.5 text-sm rounded-lg bg-gray-900 text-white dark:bg-white dark:text-gray-900 disabled:opacity-50"
            >
              Save note
            </button>
            <button
              type="button"
              disabled={busy || (!summary && !transcript.trim())}
              onClick={() => handleSave(true)}
              className="px-3 py-1.5 text-sm rounded-lg bg-green-700 text-white disabled:opacity-50"
            >
              Save & mark contacted
            </button>
          </div>
        </div>
      )}

      {activities.length === 0 ? (
        <p className="text-sm text-gray-400">No activity logged yet.</p>
      ) : (
        <ul className="space-y-3">
          {activities.map((activity) => (
            <li
              key={activity.id}
              className="border border-gray-200 dark:border-gray-800 rounded-lg p-3 text-sm"
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-medium">
                  {TYPE_LABELS[activity.type]}
                </span>
                <time className="text-xs text-gray-500">
                  {new Date(activity.createdAt).toLocaleString()}
                </time>
              </div>
              <p className="text-gray-700 dark:text-gray-300">{activity.summary}</p>
              {activity.classification && (
                <p className="text-xs text-gray-500 mt-1">
                  {activity.classification}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
