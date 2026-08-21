import type { LocationRailState } from "@/lib/crm-queries";
import { stateLabel } from "@/lib/crm-location-scope";

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

/** Enough to see the shape of the pipeline without becoming a wall of ones. */
export const SUMMARY_STATE_LIMIT = 12;
export const SUMMARY_CITY_LIMIT = 8;

/**
 * Where the pipeline is, by job location — a summary, not a control.
 *
 * It used to be the state selector too, expanding into every city of the chosen
 * state while the filter bar showed its own city dropdown. Two controls set the
 * same value and the expansion buried twenty one-company cities. The State and
 * City selectors in the filter bar own the scope now; this reports it.
 */
export function LocationRail({
  total,
  states,
  activeState,
  activeCity,
}: {
  total: number;
  states: LocationRailState[];
  activeState: string;
  activeCity: string;
}) {
  const ranked = [...states].sort(
    (a, b) => b.count - a.count || a.stateName.localeCompare(b.stateName),
  );
  const shown = ranked.slice(0, SUMMARY_STATE_LIMIT);
  // The scoped state always shows, however small, so the summary can never
  // omit the very thing the list is filtered to.
  if (activeState && !shown.some((s) => s.stateAbbr === activeState)) {
    const scoped = ranked.find((s) => s.stateAbbr === activeState);
    if (scoped) shown.unshift(scoped);
  }
  const moreStates = ranked.length - shown.length;

  const scopedState = activeState
    ? states.find((s) => s.stateAbbr === activeState)
    : undefined;
  const cities = scopedState?.cities ?? [];
  const shownCities = cities.slice(0, SUMMARY_CITY_LIMIT);
  const moreCities = cities.length - shownCities.length;

  const rowClass = (on: boolean) =>
    `flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-sm ${
      on
        ? "bg-gray-100 dark:bg-gray-800 font-medium text-gray-900 dark:text-gray-100"
        : "text-gray-700 dark:text-gray-300"
    }`;

  return (
    <aside
      aria-label="Location summary"
      className="hidden lg:block w-56 shrink-0 self-start sticky top-[4.5rem]"
    >
      <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500 px-2.5">
        Where your pipeline is
      </p>
      <p className="text-[11px] leading-snug text-gray-500 px-2.5 mt-0.5 mb-1.5">
        Counts by job location. Set the scope with the State and City filters
        above.
      </p>

      <div className="space-y-0.5 max-h-[70vh] overflow-y-auto pr-1">
        <div className={rowClass(!activeState)}>
          <span>All locations</span>
          <span className="text-xs tabular-nums opacity-70">
            {total.toLocaleString()}
          </span>
        </div>

        {shown.map((state, index) => (
          <div key={state.stateAbbr}>
            <div className={rowClass(activeState === state.stateAbbr)}>
              <span className="flex items-center gap-2 min-w-0">
                <span
                  className={`h-2 w-2 rounded-full shrink-0 ${DOT_COLORS[index % DOT_COLORS.length]}`}
                  aria-hidden
                />
                <span className="truncate">{state.stateName}</span>
              </span>
              <span className="text-xs tabular-nums opacity-70">
                {state.count.toLocaleString()}
              </span>
            </div>

            {activeState === state.stateAbbr && shownCities.length > 0 && (
              <div className="ml-3 mt-0.5 border-l border-gray-200 dark:border-gray-700 pl-2 space-y-0.5">
                {shownCities.map((city) => (
                  <div
                    key={city.city}
                    className={`flex items-center justify-between gap-2 px-2 py-1 rounded text-xs ${
                      activeCity === city.city
                        ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900 font-medium"
                        : "text-gray-600 dark:text-gray-400"
                    }`}
                  >
                    <span className="truncate">{city.city}</span>
                    <span className="tabular-nums opacity-70">
                      {city.count.toLocaleString()}
                    </span>
                  </div>
                ))}
                {moreCities > 0 && (
                  <p className="px-2 py-1 text-xs text-gray-500">
                    +{moreCities.toLocaleString()} smaller{" "}
                    {stateLabel(state.stateAbbr)}{" "}
                    {moreCities === 1 ? "city" : "cities"} in the City filter
                  </p>
                )}
              </div>
            )}
          </div>
        ))}

        {moreStates > 0 && (
          <p className="px-2.5 py-1.5 text-xs text-gray-500">
            +{moreStates.toLocaleString()} more{" "}
            {moreStates === 1 ? "state" : "states"} in the State filter
          </p>
        )}
      </div>
    </aside>
  );
}
