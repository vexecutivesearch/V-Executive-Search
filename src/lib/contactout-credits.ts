import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pipelineSettings } from "@/lib/db/schema";
import { getOrCreateSettings } from "@/lib/pipeline-config";

export const CONTACTOUT_LOCK_MS = 24 * 60 * 60 * 1000;

let cachedApiKey: string | null = null;
/** Timestamp the in-process lock was taken; null when not locked. */
let lockedAtMs: number | null = null;

function syncCacheForApiKey(apiKey: string): void {
  if (cachedApiKey !== apiKey) {
    cachedApiKey = apiKey;
    lockedAtMs = null;
  }
}

/** Avoid burning ContactOut credits on probe calls — mark exhausted only after a locked response. */
export async function isContactOutCreditsAvailable(
  apiKey: string,
  _sampleLinkedIn?: string | null,
): Promise<boolean> {
  syncCacheForApiKey(apiKey);
  // The in-process lock must expire on the same 24h clock as the stored one,
  // or a warm serverless instance keeps ContactOut switched off indefinitely.
  if (lockedAtMs !== null) {
    if (Date.now() - lockedAtMs < CONTACTOUT_LOCK_MS) return false;
    lockedAtMs = null;
  }
  const settings = await getOrCreateSettings();
  if (settings.contactoutCreditsExhaustedAt) {
    const exhaustedMs = settings.contactoutCreditsExhaustedAt.getTime();
    if (Date.now() - exhaustedMs < CONTACTOUT_LOCK_MS) {
      lockedAtMs = exhaustedMs;
      return false;
    }
  }
  return Boolean(apiKey);
}

export async function markContactOutCreditsExhausted(): Promise<void> {
  lockedAtMs = Date.now();
  const settings = await getOrCreateSettings();
  await db
    .update(pipelineSettings)
    .set({ contactoutCreditsExhaustedAt: new Date(), updatedAt: new Date() })
    .where(eq(pipelineSettings.id, settings.id));
}

export async function resetContactOutCreditsCache(): Promise<void> {
  lockedAtMs = null;
  const settings = await getOrCreateSettings();
  await db
    .update(pipelineSettings)
    .set({ contactoutCreditsExhaustedAt: null, updatedAt: new Date() })
    .where(eq(pipelineSettings.id, settings.id));
}
