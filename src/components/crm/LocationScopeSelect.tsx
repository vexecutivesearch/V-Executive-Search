"use client";

import { useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { CrmFilterOptions } from "@/lib/crm-queries";
import {
  cityOptionsForState,
  normalizeLocationScope,
  stateLabel,
} from "@/lib/crm-location-scope";

/**
 * The browse location scope: State, then City. The single pair of controls that
 * sets it, shared by every tab it scopes, so no tab grows a second way to set
 * the same value.
 *
 * City is only reachable through State and only ever offers that state's
 * cities. The server-side city predicate matches on city name alone, so a city
 * written without its state would match Springfield in Florida, Tennessee,
 * Missouri and Illinois at once.
 */
export function LocationScopeSelect({
  options,
  state,
  city,
}: {
  options: CrmFilterOptions;
  state: string;
  city: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const stateOptions = useMemo(
    () =>
      options.states
        .map((abbr) => ({ abbr, label: stateLabel(abbr) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [options.states],
  );

  const cityOptions = useMemo(
    () => cityOptionsForState(options.cities, state),
    [options.cities, state],
  );

  function apply(changes: { state?: string | null; city?: string | null }) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    // Re-derive the pair rather than trusting the URL, so changing state drops
    // a city that belonged to the previous one.
    const scope = normalizeLocationScope(
      { state: params.get("state"), city: params.get("city") },
      options,
    );
    for (const key of ["state", "city"] as const) {
      if (scope[key]) params.set(key, scope[key]);
      else params.delete(key);
    }
    params.delete("page"); // filter change restarts pagination
    router.push(`${pathname}?${params.toString()}`);
  }

  const selectClass =
    "text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900 max-w-[13rem]";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
        Location
      </span>

      <label className="inline-flex items-center gap-1.5 text-xs text-gray-500">
        State
        <select
          value={state}
          onChange={(e) => apply({ state: e.target.value || null })}
          className={selectClass}
          aria-label="Filter by state"
        >
          <option value="">All states</option>
          {stateOptions.map((s) => (
            <option key={s.abbr} value={s.abbr}>
              {s.label}
            </option>
          ))}
        </select>
      </label>

      <span className="text-gray-400" aria-hidden>
        →
      </span>

      <label className="inline-flex items-center gap-1.5 text-xs text-gray-500">
        City
        <select
          value={city}
          onChange={(e) => apply({ city: e.target.value || null })}
          disabled={!state}
          className={`${selectClass} disabled:opacity-60 disabled:cursor-not-allowed`}
          aria-label="Filter by city"
        >
          <option value="">
            {state
              ? `All cities in ${stateLabel(state)}`
              : "All cities — pick a state first"}
          </option>
          {cityOptions.map((c) => (
            <option key={`${c.city}|${c.stateAbbr}`} value={c.city}>
              {c.city}, {c.stateAbbr}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
