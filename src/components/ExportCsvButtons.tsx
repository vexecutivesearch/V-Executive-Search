"use client";

import type { ListDateRange } from "@/lib/list-date-range";

function exportQuery(range: ListDateRange, type: "scrape" | "contacts"): string {
  const params = new URLSearchParams({ type });
  if (range.mode === "range") {
    params.set("from", range.from);
    params.set("to", range.to);
  } else if (!range.isToday) {
    params.set("date", range.from);
  }
  return `/api/export/csv?${params.toString()}`;
}

export function ExportCsvButtons({ range }: { range: ListDateRange }) {
  const rangeLabel =
    range.from === range.to ? range.from : `${range.from} – ${range.to}`;

  return (
    <div className="flex flex-wrap items-center gap-2 mt-3">
      <span className="text-xs text-gray-500 dark:text-gray-400 mr-1">
        Export CSV ({rangeLabel}):
      </span>
      <a
        href={exportQuery(range, "scrape")}
        download
        className="text-sm px-3 py-1.5 rounded-md border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      >
        Scrape list
      </a>
      <a
        href={exportQuery(range, "contacts")}
        download
        className="text-sm px-3 py-1.5 rounded-md border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      >
        Enriched contacts
      </a>
    </div>
  );
}
