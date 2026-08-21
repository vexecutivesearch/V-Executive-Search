/**
 * What the launcher should tell the operator about each discovery source
 * before they click Find. Apollo is always on. Maps is off until both the
 * flag and the Vercel key are set, and only for Construction and Legal.
 */

import { resolveSerpapiMapsSource } from "./sources/serpapi-maps";
import type { DiscoverySourceEnv } from "./sources/source";

export type DiscoverySourceStatus = {
  id: "apollo" | "google_maps";
  label: string;
  enabled: boolean;
  appliesToThisVertical: boolean;
  /** One line. Shown when the source will not run for this vertical. */
  reason: string | null;
};

export function discoverySourceStatus(
  vertical: string,
  env: DiscoverySourceEnv = process.env,
): DiscoverySourceStatus[] {
  const maps = resolveSerpapiMapsSource(env);
  const mapsApplies = maps.enabled ? maps.source.supportsVertical(vertical) : false;
  return [
    {
      id: "apollo",
      label: "Apollo organization search",
      enabled: true,
      appliesToThisVertical: true,
      reason: null,
    },
    {
      id: "google_maps",
      label: "Google Maps (SerpApi)",
      enabled: maps.enabled,
      appliesToThisVertical: mapsApplies,
      reason: maps.enabled
        ? mapsApplies
          ? null
          : "Maps is on for Construction and Legal only — this vertical stays Apollo-only."
        : maps.reason,
    },
  ];
}
