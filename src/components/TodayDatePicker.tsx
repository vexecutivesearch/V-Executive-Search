"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import type { ListDateRange } from "@/lib/list-date-range";

export function TodayDatePicker({
  selectedRange,
  currentBusinessDate,
}: {
  selectedRange: ListDateRange;
  currentBusinessDate: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const isToday = selectedRange.isToday;

  function navigate(from: string, to: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("date");
    params.delete("from");
    params.delete("to");

    const isDefault =
      from === currentBusinessDate && to === currentBusinessDate;

    if (!isDefault) {
      if (from === to) {
        params.set("date", from);
      } else {
        params.set("from", from);
        params.set("to", to);
      }
    }

    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  }

  function onFromChange(value: string) {
    if (!value) return;
    const to =
      selectedRange.to >= value ? selectedRange.to : value;
    navigate(value, to);
  }

  function onToChange(value: string) {
    if (!value) return;
    const from =
      selectedRange.from <= value ? selectedRange.from : value;
    navigate(from, value);
  }

  return (
    <div className="flex flex-wrap items-end gap-3 mt-3">
      <div>
        <label
          htmlFor="list-from"
          className="block text-xs text-gray-500 dark:text-gray-400 mb-1"
        >
          From
        </label>
        <input
          id="list-from"
          type="date"
          value={selectedRange.from}
          max={currentBusinessDate}
          onChange={(e) => onFromChange(e.target.value)}
          className="text-sm border border-gray-200 dark:border-gray-700 rounded-md px-3 py-1.5 bg-white dark:bg-gray-900"
        />
      </div>
      <div>
        <label
          htmlFor="list-to"
          className="block text-xs text-gray-500 dark:text-gray-400 mb-1"
        >
          To
        </label>
        <input
          id="list-to"
          type="date"
          value={selectedRange.to}
          min={selectedRange.from}
          max={currentBusinessDate}
          onChange={(e) => onToChange(e.target.value)}
          className="text-sm border border-gray-200 dark:border-gray-700 rounded-md px-3 py-1.5 bg-white dark:bg-gray-900"
        />
      </div>
      {selectedRange.mode === "range" && (
        <p className="text-xs text-gray-400 pb-2">
          Date range · backlog snapshot as of end date
        </p>
      )}
      {!isToday && (
        <button
          type="button"
          onClick={() => navigate(currentBusinessDate, currentBusinessDate)}
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline pb-2"
        >
          Back to today
        </button>
      )}
    </div>
  );
}
