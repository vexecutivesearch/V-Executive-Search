import Link from "next/link";
import type { LocationRailState } from "@/lib/crm-queries";

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
 * Pipeline's location lens: states alphabetically, with cities revealed on
 * click. Counts come from actual listing locations rather than metro tags.
 */
export function LocationRail({
  total,
  states,
  activeState,
  activeCity,
  buildHref,
}: {
  total: number;
  states: LocationRailState[];
  activeState: string;
  activeCity: string;
  buildHref: (state: string | null, city?: string | null) => string;
}) {
  return (
    <nav
      aria-label="Locations"
      className="hidden lg:block w-56 shrink-0 self-start sticky top-[4.5rem]"
    >
      <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500 px-2.5 mb-1.5">
        Locations
      </p>
      <div className="space-y-0.5 max-h-[70vh] overflow-y-auto pr-1">
        <Link
          href={buildHref(null)}
          className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-sm transition-colors ${
            !activeState
              ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900 font-medium"
              : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
          }`}
        >
          <span>All locations</span>
          <span className="text-xs tabular-nums opacity-70">
            {total.toLocaleString()}
          </span>
        </Link>

        {states.map((state, index) => {
          const active = activeState === state.stateAbbr;
          return (
            <details
              key={state.stateAbbr}
              open={active}
              className="group rounded-md"
            >
              <summary
                className={`flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-sm transition-colors [&::-webkit-details-marker]:hidden ${
                  active
                    ? "bg-gray-100 dark:bg-gray-800 font-medium"
                    : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className={`h-2 w-2 rounded-full shrink-0 ${DOT_COLORS[index % DOT_COLORS.length]}`}
                    aria-hidden
                  />
                  <span className="truncate">{state.stateName}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="text-xs tabular-nums opacity-70">
                    {state.count.toLocaleString()}
                  </span>
                  <span
                    className="text-[10px] text-gray-400 transition-transform group-open:rotate-90"
                    aria-hidden
                  >
                    ▸
                  </span>
                </span>
              </summary>

              <div className="ml-3 mt-0.5 border-l border-gray-200 dark:border-gray-700 pl-2 space-y-0.5">
                <Link
                  href={buildHref(state.stateAbbr)}
                  className={`flex items-center justify-between gap-2 px-2 py-1 rounded text-xs ${
                    active && !activeCity
                      ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900 font-medium"
                      : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                  }`}
                >
                  <span>All {state.stateName}</span>
                  <span className="tabular-nums opacity-70">
                    {state.count.toLocaleString()}
                  </span>
                </Link>
                {state.cities.map((city) => (
                  <Link
                    key={city.city}
                    href={buildHref(state.stateAbbr, city.city)}
                    className={`flex items-center justify-between gap-2 px-2 py-1 rounded text-xs ${
                      active && activeCity === city.city
                        ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900 font-medium"
                        : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                    }`}
                  >
                    <span className="truncate">{city.city}</span>
                    <span className="tabular-nums opacity-70">
                      {city.count.toLocaleString()}
                    </span>
                  </Link>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </nav>
  );
}
