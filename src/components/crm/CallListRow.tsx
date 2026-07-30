"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { CallListItem } from "@/lib/crm-queries";
import type { CallListEntry, CallStatus, Contact } from "@/lib/db/schema";
import {
  CALL_STATUS_COLORS,
  CALL_STATUS_LABELS,
  CALL_STATUSES,
  isAttemptStatus,
} from "@/lib/call-status";
import { ContactRow } from "@/components/ContactRow";
import {
  contactIsCallable,
  scoreBgClass,
  scoreTextClass,
} from "@/lib/lead-score";
import { compareContactsForOutreach } from "@/lib/contact-title-priority";
import {
  contactPhonesForDisplay,
  sortPhonesForDisplay,
} from "@/lib/contact-phones";
import { isPersonalEmail, parsePhoneValue } from "@/lib/phone-utils";
import { sectorFromIndustry } from "@/lib/industry-sectors";
import { formatListingSalary, pickDisplayListing } from "@/lib/salary-format";
import { parseJobLocation } from "@/lib/location-match";

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(`${value}T12:00:00`) : new Date(value);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function CallListRow({
  item,
  today,
  onEntryChange,
  onRemove,
}: {
  item: CallListItem;
  today: string;
  onEntryChange: (entry: CallListEntry) => void;
  onRemove: (entryId: string) => void;
}) {
  const { entry, company, marketLabel } = item;
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState(entry.notes ?? "");
  const [assignedTo, setAssignedTo] = useState(entry.assignedTo ?? "");
  const [finalResult, setFinalResult] = useState(entry.finalResult ?? "");
  const [outreachAngle, setOutreachAngle] = useState(
    entry.outreachAngle ?? company.reasonToCall ?? "",
  );
  const [highlightFollowUp, setHighlightFollowUp] = useState(false);
  const followUpRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setNotes(entry.notes ?? "");
  }, [entry.notes]);

  const locked = entry.callStatus === "do_not_contact";

  const primaryContact: Contact | undefined = useMemo(() => {
    const byId = company.contacts.find((c) => c.id === entry.primaryContactId);
    if (byId) return byId;
    return [...company.contacts]
      .filter(contactIsCallable)
      .sort(compareContactsForOutreach)[0] ?? company.contacts[0];
  }, [company.contacts, entry.primaryContactId]);

  const primaryJob = company.jobListings[0];
  const salaryJob = pickDisplayListing(company.jobListings);
  const salary = salaryJob ? formatListingSalary(salaryJob) : null;
  const cityState = useMemo(() => {
    const raw =
      primaryJob?.location ||
      company.contacts.find((c) => c.jobLocation)?.jobLocation ||
      null;
    if (!raw) return null;
    return parseJobLocation(raw)?.label ?? raw;
  }, [primaryJob?.location, company.contacts]);

  const phones = primaryContact
    ? sortPhonesForDisplay(contactPhonesForDisplay(primaryContact))
    : [];
  const directPhone = phones.find((p) => p.kind !== "company")?.number ?? null;
  const companyPhone =
    phones.find((p) => p.kind === "company")?.number ??
    primaryContact?.companyPhone ??
    null;
  const verifiedEmail = primaryContact
    ? (primaryContact.workEmail ??
      (primaryContact.email && !isPersonalEmail(primaryContact.email)
        ? primaryContact.email
        : null) ??
      primaryContact.personalEmail ??
      primaryContact.email)
    : null;

  const followUp = entry.nextFollowUpDate;
  const overdue = Boolean(followUp && followUp < today);
  const dueToday = followUp === today;
  const score = company.leadScore ?? 0;
  const sector = sectorFromIndustry(company.industry);

  async function patch(
    body: Record<string, unknown>,
  ): Promise<CallListEntry | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/call-list/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        entry?: CallListEntry;
        error?: string;
      };
      if (!res.ok || !data.entry) {
        setError(data.error ?? "Update failed");
        return null;
      }
      onEntryChange(data.entry);
      return data.entry;
    } catch {
      setError("Network error");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleStatusChange(status: CallStatus) {
    const updated = await patch({ call_status: status });
    // Attempt statuses want a next touch scheduled — surface the date field.
    if (updated && isAttemptStatus(status) && !updated.nextFollowUpDate) {
      setExpanded(true);
      setHighlightFollowUp(true);
      setTimeout(() => followUpRef.current?.focus(), 60);
    }
  }

  async function handleRemove() {
    if (!window.confirm(`Remove ${company.name} from the call list?`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/call-list/${entry.id}`, {
        method: "DELETE",
      });
      if (res.ok) onRemove(entry.id);
    } finally {
      setBusy(false);
    }
  }

  const statusSelect = (
    <select
      value={entry.callStatus}
      disabled={busy}
      onChange={(e) => handleStatusChange(e.target.value as CallStatus)}
      onClick={(e) => e.stopPropagation()}
      className={`text-xs font-medium rounded-md px-2 py-1.5 border border-transparent cursor-pointer disabled:opacity-50 max-w-[11rem] ${CALL_STATUS_COLORS[entry.callStatus]}`}
      aria-label="Call status"
    >
      {CALL_STATUSES.map((s) => (
        <option key={s} value={s}>
          {CALL_STATUS_LABELS[s]}
        </option>
      ))}
    </select>
  );

  const followUpBadge = followUp ? (
    <span
      className={`text-xs tabular-nums ${
        overdue
          ? "text-red-700 dark:text-red-400 font-semibold"
          : dueToday
            ? "text-amber-700 dark:text-amber-400 font-medium"
            : "text-gray-600 dark:text-gray-400"
      }`}
    >
      {formatDate(followUp)}
      {overdue ? " · overdue" : dueToday ? " · today" : ""}
    </span>
  ) : (
    <span className="text-xs text-gray-400">—</span>
  );

  return (
    <div className="border-b border-gray-200 dark:border-gray-800 last:border-b-0">
      <div
        className="grid grid-cols-[3rem_1fr_auto] lg:grid-cols-[3.25rem_minmax(0,1.4fr)_minmax(0,1.2fr)_11.5rem_4.5rem_7rem_minmax(0,0.7fr)_auto] gap-x-3 gap-y-1 items-center px-3 py-4 lg:py-2.5 sm:px-4 hover:bg-gray-50 dark:hover:bg-gray-900/60 transition-colors cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <div
          className={`flex h-9 w-9 lg:h-10 lg:w-10 items-center justify-center rounded-lg text-sm font-semibold tabular-nums ${scoreBgClass(score)} ${scoreTextClass(score)}`}
          title="Opportunity score"
        >
          {score}
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <Link
              href={`/companies/${company.id}`}
              onClick={(e) => e.stopPropagation()}
              className="font-medium truncate hover:underline"
            >
              {company.name}
            </Link>
            {locked && (
              <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300">
                Do not contact
              </span>
            )}
            {item.outreach && (
              <span
                className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-violet-100 text-violet-900 dark:bg-violet-950/50 dark:text-violet-200"
                title={`Outreach sequencer · ${item.outreach.channelPlan.replace("_", " + ")} · ${item.outreach.status}`}
              >
                {item.outreach.label}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 truncate">
            {[cityState, marketLabel, sector ?? company.industry]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>

        <div className="hidden lg:block min-w-0">
          {primaryContact ? (
            <>
              <p className="text-sm truncate">
                {primaryContact.name}
                {primaryContact.title ? (
                  <span className="text-gray-500"> · {primaryContact.title}</span>
                ) : null}
              </p>
              {!locked && directPhone ? (
                <a
                  href={`tel:${parsePhoneValue(directPhone) ?? directPhone}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {parsePhoneValue(directPhone) ?? directPhone}
                </a>
              ) : (
                <span className="text-xs text-gray-400">
                  {locked ? "outreach locked" : (verifiedEmail ?? "no direct line")}
                </span>
              )}
            </>
          ) : (
            <span className="text-sm text-gray-400 italic">No contact</span>
          )}
        </div>

        <div className="hidden lg:block" onClick={(e) => e.stopPropagation()}>
          {statusSelect}
        </div>

        <div
          className="hidden lg:block text-sm tabular-nums text-gray-600 dark:text-gray-400"
          title="Outreach attempts"
        >
          {entry.attempts}
        </div>

        <div className="hidden lg:block">{followUpBadge}</div>

        <div className="hidden lg:block min-w-0 text-xs text-gray-600 dark:text-gray-400 truncate">
          {entry.assignedTo ?? <span className="text-gray-400">—</span>}
        </div>

        <div className="flex items-center justify-end gap-1">
          {!locked && (
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                patch({ log_attempt: true });
              }}
              title="Log an outreach attempt (increments attempts, stamps last contact)"
              className="px-2 py-1 rounded-md text-xs font-medium border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 whitespace-nowrap"
            >
              +1 attempt
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              handleRemove();
            }}
            title="Remove from call list"
            aria-label="Remove from call list"
            className="p-1 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M10 11v6M14 11v6" />
            </svg>
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="p-2 -mr-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            aria-label={expanded ? "Collapse row" : "Expand row"}
          >
            <span
              className={`inline-block text-base transition-transform ${expanded ? "rotate-180" : ""}`}
              aria-hidden
            >
              ▾
            </span>
          </button>
        </div>
      </div>

      <div className="lg:hidden px-3 pb-2 pl-[3.75rem] flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
        <span onClick={(e) => e.stopPropagation()}>{statusSelect}</span>
        <span>{entry.attempts} attempts</span>
        {followUpBadge}
      </div>

      {error && (
        <div className="mx-4 mb-2 rounded-md border border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200 px-3 py-2 text-sm">
          {error}
        </div>
      )}

      {expanded && (
        <div className="px-4 pb-4 pt-2 bg-gray-50/80 dark:bg-gray-900/40 border-t border-gray-100 dark:border-gray-800 space-y-3">
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
            {primaryJob && (
              <span>
                Open position:{" "}
                <span className="text-gray-800 dark:text-gray-200">
                  {primaryJob.title}
                </span>
              </span>
            )}
            {salary && <span>Salary: {salary}</span>}
            {company.industry && (
              <span title={company.industry}>
                Industry: {sector ?? company.industry}
                {company.enrichedAt ? "" : " (coarse)"}
              </span>
            )}
            <span>Last contact: {formatDate(entry.lastContactAt)}</span>
            <span>Added: {formatDate(entry.addedAt)}</span>
          </div>

          {item.outreach && (
            <div className="rounded-lg border border-violet-200 dark:border-violet-900 bg-violet-50/60 dark:bg-violet-950/30 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-violet-800 dark:text-violet-200">
                  Sequence progress
                </p>
                <Link
                  href={`/admin/outreach?tab=enrollments`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs text-violet-700 dark:text-violet-300 hover:underline"
                >
                  Open sequencer →
                </Link>
              </div>
              <p className="mt-1 text-violet-950 dark:text-violet-100">
                {item.outreach.label}
                <span className="text-violet-700/80 dark:text-violet-300/80">
                  {" "}
                  · {item.outreach.channelPlan === "email_and_text"
                    ? "email + iMessage"
                    : "email only"}{" "}
                  · status {item.outreach.status}
                </span>
              </p>
              <p className="mt-0.5 text-xs text-violet-800/80 dark:text-violet-300/80">
                {item.outreach.stepsSent} sent · {item.outreach.stepsQueued}{" "}
                queued · {item.outreach.stepsDrafted} drafted ·{" "}
                {item.outreach.stepsTotal} total steps
              </p>
            </div>
          )}

          <div className="rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50/60 dark:bg-blue-950/30 p-3">
            <label className="block text-xs font-medium uppercase tracking-wide text-blue-800 dark:text-blue-200 mb-1">
              Outreach angle
            </label>
            <input
              type="text"
              value={outreachAngle}
              disabled={busy}
              onChange={(e) => setOutreachAngle(e.target.value)}
              onBlur={() => {
                const next = outreachAngle.trim();
                const current = entry.outreachAngle ?? company.reasonToCall ?? "";
                if (next !== current.trim()) {
                  patch({ outreach_angle: next || null });
                }
              }}
              placeholder="Why call this company?"
              className="w-full text-sm border border-blue-200 dark:border-blue-900 rounded-md px-2 py-1.5 bg-white dark:bg-gray-950"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <label className="text-xs text-gray-500">
              Next follow-up
              <input
                ref={followUpRef}
                type="date"
                value={entry.nextFollowUpDate ?? ""}
                disabled={busy || locked}
                onChange={(e) => {
                  setHighlightFollowUp(false);
                  patch({ next_follow_up_date: e.target.value || null });
                }}
                className={`mt-1 block w-full text-sm border rounded-md px-2 py-1.5 bg-white dark:bg-gray-900 disabled:opacity-50 ${
                  highlightFollowUp
                    ? "border-amber-500 ring-2 ring-amber-200 dark:ring-amber-900"
                    : "border-gray-200 dark:border-gray-700"
                }`}
              />
              {highlightFollowUp && (
                <span className="text-amber-700 dark:text-amber-400">
                  Schedule the next touch
                </span>
              )}
            </label>

            <label className="text-xs text-gray-500">
              Assigned team member
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
                placeholder="e.g. Miguel"
                className="mt-1 block w-full text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900"
              />
            </label>

            <label className="text-xs text-gray-500">
              Final result
              <input
                type="text"
                value={finalResult}
                disabled={busy}
                onChange={(e) => setFinalResult(e.target.value)}
                onBlur={() => {
                  if (finalResult.trim() !== (entry.finalResult ?? "").trim()) {
                    patch({ final_result: finalResult.trim() || null });
                  }
                }}
                placeholder="Outcome once closed"
                className="mt-1 block w-full text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900"
              />
            </label>

            {company.contacts.length > 1 && (
              <label className="text-xs text-gray-500">
                Primary contact
                <select
                  value={primaryContact?.id ?? ""}
                  disabled={busy}
                  onChange={(e) =>
                    patch({ primary_contact_id: e.target.value || null })
                  }
                  className="mt-1 block w-full text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900"
                >
                  {company.contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.title ? ` — ${c.title}` : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <label className="block text-xs text-gray-500">
            Notes{" "}
            <span className="font-normal text-gray-400">
              (sequence sends append here automatically)
            </span>
            <textarea
              value={notes}
              disabled={busy}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => {
                if (notes.trim() !== (entry.notes ?? "").trim()) {
                  patch({ notes: notes.trim() || null });
                }
              }}
              rows={4}
              placeholder="Call notes, objections, next steps… Automated outreach lines appear here too."
              className="mt-1 block w-full text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900 font-mono text-[12px] leading-relaxed"
            />
          </label>

          {locked ? (
            <p className="text-sm text-red-700 dark:text-red-400">
              Do Not Contact — outreach actions are locked for this company.
              Change the status to re-open it.
            </p>
          ) : company.contacts.length > 0 ? (
            <div className="space-y-2 rounded-lg bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 p-3">
              {company.contacts.map((c) => (
                <ContactRow
                  key={c.id}
                  contact={c}
                  jobLocation={primaryJob?.location ?? null}
                />
              ))}
              {companyPhone && (
                <p className="text-xs text-gray-500">
                  Main company line:{" "}
                  <a
                    href={`tel:${parsePhoneValue(companyPhone) ?? companyPhone}`}
                    className="text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {parsePhoneValue(companyPhone) ?? companyPhone}
                  </a>
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-400 italic">No contacts on file</p>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              disabled={busy}
              onClick={handleRemove}
              className="text-xs text-red-700 dark:text-red-400 hover:underline disabled:opacity-50"
            >
              Remove from call list
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
