/** Default West Palm Beach metro = Palm Beach County + adjacent Broward hires. */
export const DEFAULT_WPB_METRO_CITIES = [
  "West Palm Beach",
  "Boca Raton",
  "Boynton Beach",
  "Delray Beach",
  "Palm Beach Gardens",
  "Jupiter",
  "Wellington",
  "Lake Worth",
  "Lake Worth Beach",
  "Riviera Beach",
  "Royal Palm Beach",
  "Greenacres",
  "Palm Springs",
  "Lake Park",
  "North Palm Beach",
  "Juno Beach",
  "Tequesta",
  "Loxahatchee",
  "Belle Glade",
  "Palm Beach",
  "Lantana",
  "Hypoluxo",
  "Manalapan",
  "Fort Lauderdale",
  "Hollywood",
  "Pembroke Pines",
  "Miramar",
  "Coral Springs",
  "Pompano Beach",
  "Davie",
  "Sunrise",
  "Plantation",
  "Deerfield Beach",
  "Tamarac",
  "Margate",
  "Dania",
] as const;

/** LinkedIn / job-board metro label fragments that map to the WPB market. */
export const DEFAULT_WPB_METRO_ALIASES = [
  "palm beach county",
  "west palm beach metropolitan area",
  "greater west palm beach area",
  "west palm beach metro",
  "south florida",
] as const;

export function normalizeMetroToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
