import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pipelineSettings } from "@/lib/db/schema";
import { getOrCreateSettings } from "@/lib/pipeline-config";

/** Ask the Mac worker to prioritize iMessage checks on its next poll (~5 min). */
export async function requestImessageCheck(): Promise<void> {
  const settings = await getOrCreateSettings();
  await db
    .update(pipelineSettings)
    .set({ imessageCheckRequestedAt: new Date(), updatedAt: new Date() })
    .where(eq(pipelineSettings.id, settings.id));
}
