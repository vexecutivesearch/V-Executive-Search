import { enrichFromContactOut } from "@/lib/contactout-enrich";

let cachedApiKey: string | null = null;
let creditsAvailable: boolean | null = null;

function syncCacheForApiKey(apiKey: string): void {
  if (cachedApiKey !== apiKey) {
    cachedApiKey = apiKey;
    creditsAvailable = null;
  }
}

/** Probe ContactOut once per process + API key; cache when API returns sample/locked responses. */
export async function isContactOutCreditsAvailable(
  apiKey: string,
  sampleLinkedIn?: string | null,
): Promise<boolean> {
  syncCacheForApiKey(apiKey);
  if (creditsAvailable !== null) return creditsAvailable;
  if (!apiKey) {
    creditsAvailable = false;
    return false;
  }
  if (!sampleLinkedIn) {
    return true;
  }

  const probe = await enrichFromContactOut(sampleLinkedIn, apiKey);
  if (probe?.phoneApiLocked) {
    creditsAvailable = false;
    return false;
  }

  creditsAvailable = true;
  return true;
}

export function markContactOutCreditsExhausted(): void {
  creditsAvailable = false;
}

export function resetContactOutCreditsCache(): void {
  creditsAvailable = null;
}
