import {
  DEFAULT_WPB_METRO_ALIASES,
  DEFAULT_WPB_METRO_CITIES,
} from "@/lib/metro-defaults";

export type StateGeoMetroPreset = {
  marketName?: string;
  metroCities: string[];
  metroAliases: string[];
  focusCounties: string[];
  /**
   * Zone collapse for Google/SerpApi (paid, wide-radius aggregator): the 1–2
   * hub cities Google queries in this market — metro center, plus optionally
   * one far-edge hub for sprawling metros (e.g. DFW adds Fort Worth).
   * Empty/absent = metro center only (first metro city). Free boards
   * (Indeed/LinkedIn) always keep the full hub list — their geo needs it.
   */
  googleZones?: string[];
};

export type StateGeoConfig = {
  stateName: string;
  stateAbbr: string;
  cities: string[];
  counties: string[];
  defaultFocusCities: string[];
  defaultFocusCounties: string[];
  defaultMetroCities: string[];
  defaultMetroAliases: string[];
  cityCountyMap: Record<string, string[]>;
  metroPresets: Record<string, StateGeoMetroPreset>;
};

export type GeoSelectionDefaults = {
  focusCities: string[];
  focusCounties: string[];
  metroCities: string[];
  metroAliases: string[];
};

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

const FL_CITY_TO_COUNTIES: Record<string, string[]> = {
  atlantis: ["Palm Beach"],
  "belle glade": ["Palm Beach"],
  "boca raton": ["Palm Beach"],
  "boynton beach": ["Palm Beach"],
  "cloud lake": ["Palm Beach"],
  "delray beach": ["Palm Beach"],
  "glen ridge": ["Palm Beach"],
  greenacres: ["Palm Beach"],
  "gulf stream": ["Palm Beach"],
  haverhill: ["Palm Beach"],
  "highland beach": ["Palm Beach"],
  hypoluxo: ["Palm Beach"],
  "juno beach": ["Palm Beach"],
  jupiter: ["Palm Beach"],
  "jupiter farms": ["Palm Beach"],
  "lake clarke shores": ["Palm Beach"],
  "lake park": ["Palm Beach"],
  "lake worth": ["Palm Beach"],
  "lake worth beach": ["Palm Beach"],
  lantana: ["Palm Beach"],
  loxahatchee: ["Palm Beach"],
  manalapan: ["Palm Beach"],
  "mangonia park": ["Palm Beach"],
  "north palm beach": ["Palm Beach"],
  "ocean ridge": ["Palm Beach"],
  "palm beach": ["Palm Beach"],
  "palm beach gardens": ["Palm Beach"],
  "palm beach shores": ["Palm Beach"],
  "palm springs": ["Palm Beach"],
  "riviera beach": ["Palm Beach"],
  "royal palm beach": ["Palm Beach"],
  "south palm beach": ["Palm Beach"],
  tequesta: ["Palm Beach"],
  wellington: ["Palm Beach"],
  "west palm beach": ["Palm Beach"],
  "cooper city": ["Broward"],
  "coral springs": ["Broward"],
  dania: ["Broward"],
  "dania beach": ["Broward"],
  davie: ["Broward"],
  "deerfield beach": ["Broward"],
  "fort lauderdale": ["Broward"],
  hallandale: ["Broward"],
  "hallandale beach": ["Broward"],
  hollywood: ["Broward"],
  lauderhill: ["Broward"],
  lighthouse: ["Broward"],
  "lighthouse point": ["Broward"],
  margate: ["Broward"],
  miramar: ["Broward"],
  "pembroke pines": ["Broward"],
  plantation: ["Broward"],
  "pompano beach": ["Broward"],
  sunrise: ["Broward"],
  tamarac: ["Broward"],
  weston: ["Broward"],
  miami: ["Miami-Dade"],
  orlando: ["Orange"],
  tampa: ["Hillsborough"],
};

const GA_CITY_TO_COUNTIES: Record<string, string[]> = {
  atlanta: ["Fulton", "DeKalb"],
  "sandy springs": ["Fulton"],
  marietta: ["Cobb"],
  alpharetta: ["Fulton"],
  roswell: ["Fulton"],
  duluth: ["Gwinnett"],
  norcross: ["Gwinnett"],
  decatur: ["DeKalb"],
  smyrna: ["Cobb"],
  "johns creek": ["Fulton"],
  "peachtree corners": ["Gwinnett"],
  lawrenceville: ["Gwinnett"],
  "stone mountain": ["DeKalb"],
  "college park": ["Fulton", "Clayton"],
  "east point": ["Fulton"],
  kennesaw: ["Cobb"],
  acworth: ["Cobb"],
  "peachtree city": ["Fayette"],
  "forest park": ["Clayton"],
  "tucker": ["DeKalb"],
  "brookhaven": ["DeKalb"],
  "chamblee": ["DeKalb"],
  "dunwoody": ["DeKalb"],
  "woodstock": ["Cherokee"],
  cumming: ["Forsyth"],
  "suwanee": ["Gwinnett"],
};

const GEORGIA_ATLANTA_METRO_CITIES = [
  "Atlanta",
  "Sandy Springs",
  "Marietta",
  "Alpharetta",
  "Roswell",
  "Duluth",
  "Norcross",
  "Decatur",
] as const;

const GEORGIA_ATLANTA_ALIASES = [
  "atlanta metropolitan area",
  "greater atlanta area",
  "metro atlanta",
  "atlanta metro",
] as const;

export const DEFAULT_STATE_GEO_CONFIGS: StateGeoConfig[] = [
  {
    stateName: "Florida",
    stateAbbr: "FL",
    cities: [
      "West Palm Beach",
      "Boca Raton",
      "Boynton Beach",
      "Delray Beach",
      "Palm Beach Gardens",
      "Jupiter",
      "Wellington",
      "Lake Worth Beach",
      "Fort Lauderdale",
      "Pompano Beach",
      "Deerfield Beach",
      "Hollywood",
      "Miami",
      "Orlando",
      "Tampa",
    ],
    counties: ["Palm Beach", "Broward", "Miami-Dade", "Orange", "Hillsborough"],
    defaultFocusCities: ["West Palm Beach"],
    defaultFocusCounties: ["Palm Beach", "Broward"],
    defaultMetroCities: [...DEFAULT_WPB_METRO_CITIES],
    defaultMetroAliases: [...DEFAULT_WPB_METRO_ALIASES],
    cityCountyMap: FL_CITY_TO_COUNTIES,
    metroPresets: {
      [norm("West Palm Beach")]: {
        metroCities: [...DEFAULT_WPB_METRO_CITIES],
        metroAliases: [...DEFAULT_WPB_METRO_ALIASES],
        focusCounties: ["Palm Beach", "Broward"],
      },
    },
  },
  {
    stateName: "Georgia",
    stateAbbr: "GA",
    cities: [
      "Atlanta",
      "Sandy Springs",
      "Marietta",
      "Alpharetta",
      "Roswell",
      "Duluth",
      "Norcross",
      "Decatur",
      "Smyrna",
      "Johns Creek",
      "Peachtree Corners",
      "Lawrenceville",
      "Stone Mountain",
      "College Park",
      "East Point",
      "Kennesaw",
      "Acworth",
      "Peachtree City",
      "Forest Park",
      "Tucker",
      "Brookhaven",
      "Chamblee",
      "Dunwoody",
      "Woodstock",
      "Cumming",
      "Suwanee",
    ],
    counties: [
      "Fulton",
      "DeKalb",
      "Cobb",
      "Gwinnett",
      "Clayton",
      "Fayette",
      "Cherokee",
      "Forsyth",
    ],
    defaultFocusCities: ["Atlanta"],
    defaultFocusCounties: ["Fulton", "DeKalb", "Cobb", "Gwinnett"],
    defaultMetroCities: [...GEORGIA_ATLANTA_METRO_CITIES],
    defaultMetroAliases: [...GEORGIA_ATLANTA_ALIASES],
    cityCountyMap: GA_CITY_TO_COUNTIES,
    metroPresets: {
      [norm("Atlanta")]: {
        metroCities: [...GEORGIA_ATLANTA_METRO_CITIES],
        metroAliases: [...GEORGIA_ATLANTA_ALIASES],
        focusCounties: ["Fulton", "DeKalb", "Cobb", "Gwinnett"],
      },
    },
  },
];

export function normalizeGeoToken(value: string): string {
  return norm(value);
}

export function findStateGeoConfig(
  state: string | null | undefined,
  configs: readonly StateGeoConfig[] = DEFAULT_STATE_GEO_CONFIGS,
): StateGeoConfig | null {
  const key = norm(state ?? "");
  if (!key) return null;
  return (
    configs.find(
      (config) =>
        norm(config.stateName) === key || norm(config.stateAbbr) === key,
    ) ?? null
  );
}

export function getStateGeoConfig(
  state: string | null | undefined,
  configs: readonly StateGeoConfig[] = DEFAULT_STATE_GEO_CONFIGS,
): StateGeoConfig {
  return (
    findStateGeoConfig(state, configs) ??
    findStateGeoConfig("Florida", configs) ??
    DEFAULT_STATE_GEO_CONFIGS[0]
  );
}

export function getStateAbbreviation(
  state: string | null | undefined,
  configs: readonly StateGeoConfig[] = DEFAULT_STATE_GEO_CONFIGS,
): string {
  return getStateGeoConfig(state, configs).stateAbbr;
}

export function getDefaultGeoSelection(
  state: string | null | undefined,
  primaryCity?: string | null,
  configs: readonly StateGeoConfig[] = DEFAULT_STATE_GEO_CONFIGS,
): GeoSelectionDefaults {
  const config = getStateGeoConfig(state, configs);
  const preset = primaryCity
    ? config.metroPresets[norm(primaryCity)] ?? null
    : null;

  return {
    focusCities: primaryCity?.trim()
      ? [primaryCity.trim()]
      : [...config.defaultFocusCities],
    focusCounties: [...(preset?.focusCounties ?? config.defaultFocusCounties)],
    metroCities: [...(preset?.metroCities ?? config.defaultMetroCities)],
    metroAliases: [...(preset?.metroAliases ?? config.defaultMetroAliases)],
  };
}

export function resolveCountyForCity(
  config: StateGeoConfig,
  city: string | null | undefined,
  stateAbbr?: string | null,
): string[] {
  if (!city?.trim()) return [];
  const counties = config.cityCountyMap[norm(city)] ?? [];
  const requestedState = stateAbbr?.trim().toUpperCase();
  if (!requestedState || !counties.some((county) => /,\s*[A-Z]{2}$/i.test(county))) {
    return counties;
  }
  return counties.filter((county) => {
    const match = county.match(/,\s*([A-Z]{2})$/i);
    return !match || match[1].toUpperCase() === requestedState;
  });
}
