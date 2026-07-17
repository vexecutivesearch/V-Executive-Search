import type { CrmKpis } from "@/lib/crm-queries";

function Card({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-4 py-3 shadow-sm">
      <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <p className="text-2xl font-bold tabular-nums mt-0.5">{value}</p>
      <p className="text-xs text-gray-500 mt-0.5">{hint}</p>
    </div>
  );
}

export function KpiCards({ kpis }: { kpis: CrmKpis }) {
  const enrichedPct =
    kpis.totalCompanies > 0
      ? ((100 * kpis.enriched) / kpis.totalCompanies).toFixed(1)
      : "0.0";
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
      <Card
        label="Total companies"
        value={kpis.totalCompanies.toLocaleString()}
        hint={
          kpis.newToday > 0
            ? `+${kpis.newToday.toLocaleString()} today`
            : "all markets · all dates"
        }
      />
      <Card
        label="Enriched"
        value={kpis.enriched.toLocaleString()}
        hint={`${enrichedPct}% of pipeline`}
      />
      <Card
        label="Hot signals"
        value={kpis.hot.toLocaleString()}
        hint="active hiring signals"
      />
      <Card
        label="Due today"
        value={kpis.dueToday.toLocaleString()}
        hint="call-list follow-ups"
      />
    </div>
  );
}
