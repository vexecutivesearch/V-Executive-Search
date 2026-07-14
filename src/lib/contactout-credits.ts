import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pipelineSettings } from "@/lib/db/schema";
import { getOrCreateSettings } from "@/lib/pipeline-config";

let cachedApiKey: string | null = null;
let creditsAvailable: boolean | null = null;

function syncCacheForApiKey(apiKey: string): void {
  if (cachedApiKey !== apiKey) {
    cachedApiKey = apiKey;
    creditsAvailable = null;
  }
}

/** Avoid burning ContactOut credits on probe calls — mark exhausted only after a locked response. */
export async function isContactOutCreditsAvailable(
  apiKey: string,
  _sampleLinkedIn?: string | null,
): Promise<boolean> {
  syncCacheForApiKey(apiKey);
  if (creditsAvailable !== null) return creditsAvailable;
  const settings = await getOrCreateSettings();
  if (settings.contactoutCreditsExhaustedAt) {
    const exhaustedMs = settings.contactoutCreditsExhaustedAt.getTime();
    const lockedForMs = Date.now() - exhaustedMs;
    if (lockedForMs < 24 * 60 * 60 * 1000) {
      creditsAvailable = false;
      return creditsAvailable;
    }
  }
  creditsAvailable = Boolean(apiKey);
  return creditsAvailable;
}

export async function markContactOutCreditsExhausted(): Promise<void> {
  creditsAvailable = false;
  const settings = await getOrCreateSettings();
  await db
    .update(pipelineSettings)
    .set({ contactoutCreditsExhaustedAt: new Date(), updatedAt: new Date() })
    .where(eq(pipelineSettings.id, settings.id));
}

export async function resetContactOutCreditsCache(): Promise<void> {
  creditsAvailable = null;
  const settings = await getOrCreateSettings();
  await db
    .update(pipelineSettings)
    .set({ contactoutCreditsExhaustedAt: null, updatedAt: new Date() })
    .where(eq(pipelineSettings.id, settings.id));
}
