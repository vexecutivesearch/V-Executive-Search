import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { stateGeoConfigs, type StateGeoConfigRow } from "@/lib/db/schema";
import {
  DEFAULT_STATE_GEO_CONFIGS,
  type StateGeoConfig,
  getStateGeoConfig,
} from "@/lib/state-geo-config";
import {
  REVIEWABLE_STATE_GEO_EXPANSION,
  toStateGeoConfig,
} from "@/lib/state-geo-expanded-seed";

const EXPANDED_STATE_GEO_CONFIGS = REVIEWABLE_STATE_GEO_EXPANSION.map((seed) =>
  toStateGeoConfig(seed),
);

const SEED_STATE_GEO_CONFIGS = Array.from(
  new Map(
    [
      ...DEFAULT_STATE_GEO_CONFIGS,
      ...EXPANDED_STATE_GEO_CONFIGS,
    ].map((config) => [config.stateName, config]),
  ).values(),
);

const FALLBACK_STATE_GEO_CONFIGS = [
  ...DEFAULT_STATE_GEO_CONFIGS,
  ...EXPANDED_STATE_GEO_CONFIGS.filter(
    (config) =>
      !DEFAULT_STATE_GEO_CONFIGS.some(
        (defaultConfig) => defaultConfig.stateName === config.stateName,
      ),
  ),
];

function rowToConfig(row: StateGeoConfigRow): StateGeoConfig {
  return {
    stateName: row.stateName,
    stateAbbr: row.stateAbbr,
    cities: row.cities ?? [],
    counties: row.counties ?? [],
    defaultFocusCities: row.defaultFocusCities ?? [],
    defaultFocusCounties: row.defaultFocusCounties ?? [],
    defaultMetroCities: row.defaultMetroCities ?? [],
    defaultMetroAliases: row.defaultMetroAliases ?? [],
    cityCountyMap: row.cityCountyMap ?? {},
    metroPresets: Object.fromEntries(
      Object.entries(row.metroPresets ?? {}).map(([key, preset]) => [
        key,
        {
          marketName: preset.marketName,
          metroCities: preset.metroCities ?? [],
          metroAliases: preset.metroAliases ?? [],
          focusCounties: preset.focusCounties ?? [],
        },
      ]),
    ),
  };
}

async function seedMissingStateGeoConfigs() {
  const existing = await db
    .select({ stateName: stateGeoConfigs.stateName })
    .from(stateGeoConfigs);
  const existingNames = new Set(existing.map((row) => row.stateName));

  for (const config of SEED_STATE_GEO_CONFIGS) {
    if (existingNames.has(config.stateName)) continue;
    await db.insert(stateGeoConfigs).values({
      stateName: config.stateName,
      stateAbbr: config.stateAbbr,
      cities: config.cities,
      counties: config.counties,
      defaultFocusCities: config.defaultFocusCities,
      defaultFocusCounties: config.defaultFocusCounties,
      defaultMetroCities: config.defaultMetroCities,
      defaultMetroAliases: config.defaultMetroAliases,
      cityCountyMap: config.cityCountyMap,
      metroPresets: config.metroPresets,
    });
  }
}

export async function getAllStateGeoConfigs(): Promise<StateGeoConfig[]> {
  try {
    await seedMissingStateGeoConfigs();
    const rows = await db
      .select()
      .from(stateGeoConfigs)
      .orderBy(stateGeoConfigs.stateName);
    return rows.map(rowToConfig);
  } catch (error) {
    console.warn("Falling back to built-in state geo configs", error);
    return FALLBACK_STATE_GEO_CONFIGS;
  }
}

export async function getStateGeoConfigForState(
  state: string | null | undefined,
): Promise<StateGeoConfig> {
  try {
    await seedMissingStateGeoConfigs();
    const rows = await db
      .select()
      .from(stateGeoConfigs)
      .where(eq(stateGeoConfigs.stateName, state ?? ""))
      .limit(1);
    if (rows[0]) return rowToConfig(rows[0]);
  } catch (error) {
    console.warn("Falling back to built-in state geo config", error);
  }
  return getStateGeoConfig(state, FALLBACK_STATE_GEO_CONFIGS);
}
