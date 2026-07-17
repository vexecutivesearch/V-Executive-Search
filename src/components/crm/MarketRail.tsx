import Link from "next/link";
import type { MarketRailEntry } from "@/lib/crm-queries";
import { UNKNOWN_MARKET_VALUE } from "@/lib/market-attribution";

const DOT_COLORS = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-purple-500",
  "bg-rose-500",
  "bg-teal-500",
  "bg-indigo-500",
  "bg-orange-500",
];

/**
 * Persistent market rail — the primary lens. One click filters the active tab
 * to a market; provenance comes from companies.source_market.
 */
export function MarketRail({
  total,
  markets,
  activeMarket,
  buildHref,
}: {
  total: number;
  markets: MarketRailEntry[];
  activeMarket: string;
  buildHref: (market: string | null) => string;
}) {
  const itemClass = (active: boolean) =>
    `flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-sm transition-colors ${
      active
        ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900 font-medium"
        : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
    }`;

  return (
    <nav
      aria-label="Markets"
      className="hidden lg:block w-52 shrink-0 self-start sticky top-[4.5rem]"
    >
      <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500 px-2.5 mb-1.5">
        Markets
      </p>
      <div className="space-y-0.5 max-h-[70vh] overflow-y-auto pr-1">
        <Link href={buildHref(null)} className={itemClass(!activeMarket)}>
          <span className="truncate">All markets</span>
          <span className="text-xs tabular-nums opacity-70">
            {total.toLocaleString()}
          </span>
        </Link>
        {markets.map((m, i) => (
          <Link
            key={m.value}
            href={buildHref(m.value)}
            className={itemClass(activeMarket === m.value)}
          >
            <span className="flex items-center gap-2 min-w-0">
              <span
                className={`h-2 w-2 rounded-full shrink-0 ${
                  m.value === UNKNOWN_MARKET_VALUE
                    ? "bg-gray-400"
                    : DOT_COLORS[i % DOT_COLORS.length]
                }`}
                aria-hidden
              />
              <span className="truncate">{m.label}</span>
            </span>
            <span className="text-xs tabular-nums opacity-70">
              {m.count.toLocaleString()}
            </span>
          </Link>
        ))}
      </div>
    </nav>
  );
}
