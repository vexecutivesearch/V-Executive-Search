"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

export function TodayDatePicker({
  selectedDate,
  currentBusinessDate,
}: {
  selectedDate: string;
  currentBusinessDate: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const isToday = selectedDate === currentBusinessDate;

  function navigate(date: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (date && date !== currentBusinessDate) {
      params.set("date", date);
    } else {
      params.delete("date");
    }
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 mt-3">
      <label
        htmlFor="list-date"
        className="text-sm text-gray-500 dark:text-gray-400"
      >
        Business day
      </label>
      <input
        id="list-date"
        type="date"
        value={selectedDate}
        max={currentBusinessDate}
        onChange={(e) => navigate(e.target.value || null)}
        className="text-sm border border-gray-200 dark:border-gray-700 rounded-md px-3 py-1.5 bg-white dark:bg-gray-900"
      />
      {!isToday && (
        <button
          type="button"
          onClick={() => navigate(null)}
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
        >
          Back to today
        </button>
      )}
    </div>
  );
}
