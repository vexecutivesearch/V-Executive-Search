"use client";

import type { ListDateRange } from "@/lib/list-date-range";

function exportQuery(
  range: ListDateRange,
  type: "backlog" | "call-sheet",
): string {
  const params = new URLSearchParams({ type });
  if (range.mode === "range") {
    params.set("from", range.from);
    params.set("to", range.to);
  } else if (!range.isToday) {
    params.set("date", range.from);
  }
  return `/api/export/csv?${params.toString()}`;
}

export function ExportCsvButtons({
  range,
  backlogCount,
  callSheetCount,
}: {
  range: ListDateRange;
  backlogCount: number;
  callSheetCount: number;
}) {
  const rangeLabel =
    range.from === range.to ? range.from : `${range.from} – ${range.to}`;

  const buttonClass =
    "inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors shadow-sm";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Export CSV
      </span>
      <a
        href={exportQuery(range, "backlog")}
        download
        title={`Download backlog for ${rangeLabel}`}
        className={buttonClass}
      >
        ↓ Backlog ({backlogCount})
      </a>
      <a
        href={exportQuery(range, "call-sheet")}
        download
        title={`Download call sheet for ${rangeLabel}`}
        className={buttonClass}
      >
        ↓ Call sheet ({callSheetCount})
      </a>
    </div>
  );
}
