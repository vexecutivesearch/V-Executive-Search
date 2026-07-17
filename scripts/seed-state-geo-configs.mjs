import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { Pool } from "@neondatabase/serverless";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

function norm(value) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function unique(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function toStateGeoConfig(seed) {
  const selected =
    seed.markets.find((market) => norm(market.marketName) === norm(seed.defaultMarket)) ??
    seed.markets[0];
  const cities = unique(seed.markets.flatMap((market) => market.scrapeHubs));
  const counties = unique(seed.markets.flatMap((market) => market.focusCounties));
  const cityCountyMap = Object.fromEntries(
    seed.markets.flatMap((market) => Object.entries(market.cityCountyMap)),
  );
  const metroPresets = Object.fromEntries(
    seed.markets.map((market) => [
      norm(market.marketName),
      {
        marketName: market.marketName,
        metroCities: market.scrapeHubs,
        metroAliases: market.aliases,
        focusCounties: market.focusCounties,
      },
    ]),
  );

  return {
    stateName: seed.stateName,
    stateAbbr: seed.stateAbbr,
    cities,
    counties,
    defaultFocusCities: selected?.scrapeHubs?.[0] ? [selected.scrapeHubs[0]] : [],
    defaultFocusCounties: selected?.focusCounties ?? [],
    defaultMetroCities: selected?.scrapeHubs ?? [],
    defaultMetroAliases: selected?.aliases ?? [],
    cityCountyMap,
    metroPresets,
  };
}

const dryRun = process.argv.includes("--dry-run");
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl && !dryRun) {
  throw new Error("DATABASE_URL is not set. Load .env.local or pass --dry-run.");
}

const seedPath = resolve("src/lib/state-geo-expanded-seed.generated.json");
const seeds = JSON.parse(await readFile(seedPath, "utf8"));
const configs = seeds.map(toStateGeoConfig);

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        states: configs.length,
        markets: seeds.reduce((total, seed) => total + seed.markets.length, 0),
        stateNames: configs.map((config) => config.stateName),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const pool = new Pool({ connectionString: databaseUrl });

try {
  for (const geoConfig of configs) {
    await pool.query(
      `
        insert into state_geo_configs (
          state_name,
          state_abbr,
          cities,
          counties,
          default_focus_cities,
          default_focus_counties,
          default_metro_cities,
          default_metro_aliases,
          city_county_map,
          metro_presets,
          updated_at
        )
        values ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, now())
        on conflict (state_name)
        do update set
          state_abbr = excluded.state_abbr,
          cities = excluded.cities,
          counties = excluded.counties,
          default_focus_cities = excluded.default_focus_cities,
          default_focus_counties = excluded.default_focus_counties,
          default_metro_cities = excluded.default_metro_cities,
          default_metro_aliases = excluded.default_metro_aliases,
          city_county_map = excluded.city_county_map,
          metro_presets = excluded.metro_presets,
          updated_at = now()
      `,
      [
        geoConfig.stateName,
        geoConfig.stateAbbr,
        JSON.stringify(geoConfig.cities),
        JSON.stringify(geoConfig.counties),
        JSON.stringify(geoConfig.defaultFocusCities),
        JSON.stringify(geoConfig.defaultFocusCounties),
        JSON.stringify(geoConfig.defaultMetroCities),
        JSON.stringify(geoConfig.defaultMetroAliases),
        JSON.stringify(geoConfig.cityCountyMap),
        JSON.stringify(geoConfig.metroPresets),
      ],
    );
    console.log(`Upserted ${geoConfig.stateName}`);
  }
} finally {
  await pool.end();
}
