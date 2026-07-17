import { cache } from "react";
import { getAllStateGeoConfigs } from "@/lib/state-geo-config-store";
import { buildMarketIndex, type MarketIndex } from "@/lib/market-attribution";

/** Market registry lookup (DB-backed configs with built-in fallback), per request. */
export const getMarketIndex = cache(async (): Promise<MarketIndex> => {
  const configs = await getAllStateGeoConfigs();
  return buildMarketIndex(configs);
});
