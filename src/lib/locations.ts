import {
  DEFAULT_STATE_GEO_CONFIGS,
  findStateGeoConfig,
  type StateGeoConfig,
} from "@/lib/state-geo-config";

export const US_STATES = [
  "Alabama",
  "Alaska",
  "Arizona",
  "Arkansas",
  "California",
  "Colorado",
  "Connecticut",
  "Delaware",
  "Florida",
  "Georgia",
  "Hawaii",
  "Idaho",
  "Illinois",
  "Indiana",
  "Iowa",
  "Kansas",
  "Kentucky",
  "Louisiana",
  "Maine",
  "Maryland",
  "Massachusetts",
  "Michigan",
  "Minnesota",
  "Mississippi",
  "Missouri",
  "Montana",
  "Nebraska",
  "Nevada",
  "New Hampshire",
  "New Jersey",
  "New Mexico",
  "New York",
  "North Carolina",
  "North Dakota",
  "Ohio",
  "Oklahoma",
  "Oregon",
  "Pennsylvania",
  "Rhode Island",
  "South Carolina",
  "South Dakota",
  "Tennessee",
  "Texas",
  "Utah",
  "Vermont",
  "Virginia",
  "Washington",
  "West Virginia",
  "Wisconsin",
  "Wyoming",
];

export function getCitiesForState(
  state: string,
  configs: readonly StateGeoConfig[] = DEFAULT_STATE_GEO_CONFIGS,
): string[] {
  return [...(findStateGeoConfig(state, configs)?.cities ?? [])].sort((a, b) =>
    a.localeCompare(b),
  );
}

export function getCountiesForState(
  state: string,
  configs: readonly StateGeoConfig[] = DEFAULT_STATE_GEO_CONFIGS,
): string[] {
  return [...(findStateGeoConfig(state, configs)?.counties ?? [])].sort((a, b) =>
    a.localeCompare(b),
  );
}

export function getMetroCitiesForState(
  state: string,
  configs: readonly StateGeoConfig[] = DEFAULT_STATE_GEO_CONFIGS,
): string[] {
  return [
    ...(findStateGeoConfig(state, configs)?.defaultMetroCities ?? []),
  ].sort((a, b) => a.localeCompare(b));
}
