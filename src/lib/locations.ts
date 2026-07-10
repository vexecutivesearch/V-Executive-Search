import { DEFAULT_WPB_METRO_CITIES } from "@/lib/metro-defaults";

/** Florida cities for admin dropdown (geofence multi-select). */
export const FLORIDA_CITIES = [
  "Boca Raton",
  "Clearwater",
  "Daytona Beach",
  "Fort Lauderdale",
  "Fort Myers",
  "Gainesville",
  "Hialeah",
  "Hollywood",
  "Jacksonville",
  "Lakeland",
  "Melbourne",
  "Miami",
  "Naples",
  "Ocala",
  "Orlando",
  "Palm Bay",
  "Pensacola",
  "Port St. Lucie",
  "Sarasota",
  "St. Petersburg",
  "Tallahassee",
  "Tampa",
  "West Palm Beach",
  "Winter Park",
].sort();

/** Florida counties for admin dropdown (geofence multi-select). */
export const FLORIDA_COUNTIES = [
  "Alachua",
  "Brevard",
  "Broward",
  "Charlotte",
  "Citrus",
  "Collier",
  "Duval",
  "Escambia",
  "Flagler",
  "Hernando",
  "Hillsborough",
  "Indian River",
  "Lake",
  "Lee",
  "Leon",
  "Manatee",
  "Marion",
  "Martin",
  "Miami-Dade",
  "Monroe",
  "Nassau",
  "Okaloosa",
  "Orange",
  "Osceola",
  "Palm Beach",
  "Pasco",
  "Pinellas",
  "Polk",
  "Sarasota",
  "Seminole",
  "St. Johns",
  "St. Lucie",
  "Volusia",
].sort();

export function getMetroCitiesForState(state: string): string[] {
  if (state === "Florida") return [...DEFAULT_WPB_METRO_CITIES].sort();
  return [];
}

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

export function getCitiesForState(state: string): string[] {
  if (state === "Florida") return FLORIDA_CITIES;
  return [];
}

export function getCountiesForState(state: string): string[] {
  if (state === "Florida") return FLORIDA_COUNTIES;
  return [];
}
