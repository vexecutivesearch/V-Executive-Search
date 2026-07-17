import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { pipelineSettings } from "@/lib/db/schema";
import { getOrCreateSettings } from "@/lib/pipeline-config";
import { eq } from "drizzle-orm";

export async function POST() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await getOrCreateSettings();
  await db
    .update(pipelineSettings)
    .set({
      runRequestedAt: new Date(),
      runClaimedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(pipelineSettings.id, settings.id));

  return NextResponse.json({
    ok: true,
    message:
      "Run requested. Your home Mac worker will pick this up within 5 minutes (or run manually).",
  });
}
