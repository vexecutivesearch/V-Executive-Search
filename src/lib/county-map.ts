import { normalizeMetroToken } from "@/lib/metro-defaults";

/** Default WPB market = Palm Beach County + adjacent Broward. */
export const DEFAULT_WPB_FOCUS_COUNTIES = ["Palm Beach", "Broward"] as const;

function norm(value: string): string {
  return normalizeMetroToken(value);
}

function splitCountyToken(
  value: string,
): { name: string; stateAbbr: string | null } {
  const match = value.trim().match(/^(.*?),\s*([A-Z]{2})$/i);
  return {
    name: match ? match[1].trim() : value.trim(),
    stateAbbr: match ? match[2].toUpperCase() : null,
  };
}

/**
 * Florida city → county lookup for the WPB metro (Palm Beach + Broward).
 * Unknown cities return null — callers treat as location_unknown, not out-of-metro.
 */
export const FL_CITY_TO_COUNTY: Record<string, string> = {
  // Palm Beach County
  atlantis: "Palm Beach",
  "belle glade": "Palm Beach",
  "boca raton": "Palm Beach",
  "boynton beach": "Palm Beach",
  "cloud lake": "Palm Beach",
  "delray beach": "Palm Beach",
  "glen ridge": "Palm Beach",
  greenacres: "Palm Beach",
  "gulf stream": "Palm Beach",
  haverhill: "Palm Beach",
  "highland beach": "Palm Beach",
  hypoluxo: "Palm Beach",
  "juno beach": "Palm Beach",
  jupiter: "Palm Beach",
  "jupiter farms": "Palm Beach",
  "lake clarke shores": "Palm Beach",
  "lake park": "Palm Beach",
  "lake worth": "Palm Beach",
  "lake worth beach": "Palm Beach",
  lantana: "Palm Beach",
  loxahatchee: "Palm Beach",
  manalapan: "Palm Beach",
  "mangonia park": "Palm Beach",
  "north palm beach": "Palm Beach",
  "ocean ridge": "Palm Beach",
  "palm beach": "Palm Beach",
  "palm beach gardens": "Palm Beach",
  "palm beach shores": "Palm Beach",
  "palm springs": "Palm Beach",
  "riviera beach": "Palm Beach",
  "royal palm beach": "Palm Beach",
  "south palm beach": "Palm Beach",
  tequesta: "Palm Beach",
  wellington: "Palm Beach",
  "west palm beach": "Palm Beach",
  // Broward County (adjacent hires)
  "cooper city": "Broward",
  "coral springs": "Broward",
  dania: "Broward",
  "dania beach": "Broward",
  davie: "Broward",
  "deerfield beach": "Broward",
  "fort lauderdale": "Broward",
  hallandale: "Broward",
  "hallandale beach": "Broward",
  hollywood: "Broward",
  lauderhill: "Broward",
  lighthouse: "Broward",
  "lighthouse point": "Broward",
  margate: "Broward",
  miramar: "Broward",
  "pembroke pines": "Broward",
  plantation: "Broward",
  "pompano beach": "Broward",
  sunrise: "Broward",
  tamarac: "Broward",
  weston: "Broward",
  // Out-of-metro reference cities (explicit county → reject via focus filter)
  miami: "Miami-Dade",
  orlando: "Orange",
  tampa: "Hillsborough",
};

export function countyFromLocationString(location: string): string | null {
  const loc = norm(location);
  if (!loc) return null;
  if (loc.includes("palm beach county")) return "Palm Beach";
  if (loc.includes("broward county")) return "Broward";
  return null;
}

export function resolveFloridaCounty(
  city: string | null | undefined,
  locationRaw?: string | null,
): string | null {
  if (locationRaw) {
    const fromString = countyFromLocationString(locationRaw);
    if (fromString) return fromString;
  }
  if (!city?.trim()) return null;
  return FL_CITY_TO_COUNTY[norm(city)] ?? null;
}

export function countyInFocus(
  county: string,
  accepted: readonly string[],
): boolean {
  const c = splitCountyToken(county);
  const countyName = norm(c.name);
  return accepted.some((acceptedCounty) => {
    const a = splitCountyToken(acceptedCounty);
    if (norm(a.name) !== countyName) return false;
    if (!a.stateAbbr || !c.stateAbbr) return true;
    return a.stateAbbr === c.stateAbbr;
  });
}
