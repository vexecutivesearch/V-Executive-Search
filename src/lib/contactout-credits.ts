import { enrichFromContactOut } from "@/lib/contactout-enrich";

let creditsAvailable: boolean | null = null;

/** Probe ContactOut once per process; cache when API returns sample/locked responses. */
export async function isContactOutCreditsAvailable(
  apiKey: string,
  sampleLinkedIn?: string | null,
): Promise<boolean> {
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
