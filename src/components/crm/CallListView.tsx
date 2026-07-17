"use client";

import { useMemo, useState } from "react";
import type { CallListItem } from "@/lib/crm-queries";
import type { CallListEntry, CallStatus } from "@/lib/db/schema";
import {
  CALL_STATUS_LABELS,
  CALL_STATUSES,
  isTerminalStatus,
} from "@/lib/call-status";
import { CallListRow } from "./CallListRow";

function businessToday(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

/** Active call queue: overdue follow-ups → due today → ranked by score. */
function compareActive(a: CallListItem, b: CallListItem, today: string): number {
  const bucket = (item: CallListItem): number => {
    const due = item.entry.nextFollowUpDate;
    if (due && due < today) return 0;
    if (due && due === today) return 1;
    return 2;
  };
  const ba = bucket(a);
  const bb = bucket(b);
  if (ba !== bb) return ba - bb;
  if (ba === 0) {
    return (a.entry.nextFollowUpDate ?? "").localeCompare(
      b.entry.nextFollowUpDate ?? "",
    );
  }
  return (
    (b.company.leadScore ?? 0) - (a.company.leadScore ?? 0) ||
    a.company.name.localeCompare(b.company.name)
  );
}

export function CallListView({ items: initialItems }: { items: CallListItem[] }) {
  const [items, setItems] = useState(initialItems);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<CallStatus | "">("");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [marketFilter, setMarketFilter] = useState("");
  const [dueOnly, setDueOnly] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  const today = businessToday();

  function handleEntryChange(entry: CallListEntry) {
    setItems((prev) =>
      prev.map((item) =>
        item.entry.id === entry.id ? { ...item, entry } : item,
      ),
    );
  }

  function handleRemove(entryId: string) {
    setItems((prev) => prev.filter((item) => item.entry.id !== entryId));
  }

  const assignees = useMemo(
    () =>
      [
        ...new Set(
          items
            .map((i) => i.entry.assignedTo?.trim())
            .filter((v): v is string => Boolean(v)),
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [items],
  );

  const markets = useMemo(
    () =>
      [
        ...new Set(
          items
            .map((i) => i.marketLabel?.trim())
            .filter((v): v is string => Boolean(v)),
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [items],
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((item) => {
      if (statusFilter && item.entry.callStatus !== statusFilter) return false;
      if (
        assigneeFilter &&
        (item.entry.assignedTo?.trim() ?? "") !== assigneeFilter
      ) {
        return false;
      }
      if (marketFilter && (item.marketLabel ?? "") !== marketFilter) {
        return false;
      }
      if (dueOnly) {
        const due = item.entry.nextFollowUpDate;
        if (!due || due > today) return false;
      }
      if (!term) return true;
      const haystack = [
        item.company.name,
        item.company.domain ?? "",
        item.marketLabel ?? "",
        item.entry.notes ?? "",
        item.entry.assignedTo ?? "",
        ...item.company.jobListings.map((j) => `${j.title} ${j.location ?? ""}`),
        ...item.company.contacts.map((c) => `${c.name} ${c.title ?? ""}`),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [items, search, statusFilter, assigneeFilter, marketFilter, dueOnly, today]);

  const active = useMemo(
    () =>
      filtered
        .filter((item) => !isTerminalStatus(item.entry.callStatus))
        .sort((a, b) => compareActive(a, b, today)),
    [filtered, today],
  );
  const closed = useMemo(
    () =>
      filtered
        .filter((item) => isTerminalStatus(item.entry.callStatus))
        .sort(
          (a, b) =>
            new Date(b.entry.updatedAt).getTime() -
            new Date(a.entry.updatedAt).getTime(),
        ),
    [filtered],
  );
  const overdueCount = active.filter(
    (i) => i.entry.nextFollowUpDate && i.entry.nextFollowUpDate < today,
  ).length;
  const dueTodayCount = active.filter(
    (i) => i.entry.nextFollowUpDate === today,
  ).length;

  if (items.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400">
        <p className="text-lg">Your call list is empty</p>
        <p className="text-sm mt-2">
          Enrich a company, then answer &ldquo;Add to Call List: Yes&rdquo; — or
          use the Add to Call List button on any enriched lead in All Leads or
          Today&apos;s List.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="sticky top-[3.25rem] z-10 -mx-4 px-4 py-3 mb-3 bg-gray-50/95 dark:bg-gray-950/95 backdrop-blur border-y border-gray-200 dark:border-gray-800">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search company, contact, notes…"
            className="flex-1 min-w-[12rem] text-sm border border-gray-200 dark:border-gray-700 rounded-md px-3 py-1.5 bg-white dark:bg-gray-900"
          />

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as CallStatus | "")}
            className="text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900"
            aria-label="Filter by call status"
          >
            <option value="">All statuses</option>
            {CALL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {CALL_STATUS_LABELS[s]}
              </option>
            ))}
          </select>

          {markets.length > 0 && (
            <select
              value={marketFilter}
              onChange={(e) => setMarketFilter(e.target.value)}
              className="text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900"
              aria-label="Filter by market"
            >
              <option value="">All markets</option>
              {markets.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}

          {assignees.length > 0 && (
            <select
              value={assigneeFilter}
              onChange={(e) => setAssigneeFilter(e.target.value)}
              className="text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900"
              aria-label="Filter by team member"
            >
              <option value="">All team members</option>
              {assignees.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          )}

          <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={dueOnly}
              onChange={(e) => setDueOnly(e.target.checked)}
              className="rounded border-gray-300"
            />
            Follow-ups due
          </label>
        </div>

        <p className="text-xs text-gray-500 mt-2">
          {active.length} active · {closed.length} closed
          {overdueCount > 0 && (
            <span className="text-red-700 dark:text-red-400">
              {" "}
              · {overdueCount} overdue
            </span>
          )}
          {dueTodayCount > 0 && <> · {dueTodayCount} due today</>}
          {" · sorted: overdue → due today → score"}
        </p>
      </div>

      {active.length === 0 ? (
        <div className="text-center py-10 text-gray-400">
          <p>No active call list entries match your filters</p>
        </div>
      ) : (
        <div className="border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden bg-white dark:bg-gray-950 shadow-sm">
          <div className="hidden lg:grid grid-cols-[3.25rem_minmax(0,1.4fr)_minmax(0,1.2fr)_11.5rem_4.5rem_7rem_minmax(0,0.7fr)_auto] gap-x-3 px-4 py-2 text-[10px] font-medium uppercase tracking-wide text-gray-500 bg-gray-50 dark:bg-gray-900/80 border-b border-gray-200 dark:border-gray-800">
            <span>Score</span>
            <span>Company</span>
            <span>Contact</span>
            <span>Status</span>
            <span>Attempts</span>
            <span>Follow-up</span>
            <span>Assigned</span>
            <span className="text-right pr-6">Action</span>
          </div>
          {active.map((item) => (
            <CallListRow
              key={item.entry.id}
              item={item}
              today={today}
              onEntryChange={handleEntryChange}
              onRemove={handleRemove}
            />
          ))}
        </div>
      )}

      {closed.length > 0 && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setShowClosed((v) => !v)}
            className="text-sm font-medium text-gray-600 dark:text-gray-300 hover:underline"
          >
            {showClosed ? "▾" : "▸"} Closed ({closed.length}) — Client Won, Not
            Interested, Bad Contact, Do Not Contact
          </button>
          {showClosed && (
            <div className="mt-3 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden bg-white dark:bg-gray-950 shadow-sm opacity-90">
              {closed.map((item) => (
                <CallListRow
                  key={item.entry.id}
                  item={item}
                  today={today}
                  onEntryChange={handleEntryChange}
                  onRemove={handleRemove}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
