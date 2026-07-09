import { NextRequest, NextResponse } from "next/server";
import { verifyWorkerAuth, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import { pipelineSettings } from "@/lib/db/schema";
import { getOrCreateSettings } from "@/lib/pipeline-config";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!verifyWorkerAuth(request)) return unauthorized();

  const settings = await getOrCreateSettings();
  return NextResponse.json({
    run_requested_at: settings.runRequestedAt?.toISOString() ?? null,
    contactout_sync_requested_at:
      settings.contactoutSyncRequestedAt?.toISOString() ?? null,
    last_run_at: settings.lastRunAt?.toISOString() ?? null,
  });
}

export async function POST(request: NextRequest) {
  if (!verifyWorkerAuth(request)) return unauthorized();

  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const settings = await getOrCreateSettings();

  if (body.action === "clear_run_request") {
    await db
      .update(pipelineSettings)
      .set({ runRequestedAt: null, updatedAt: new Date() })
      .where(eq(pipelineSettings.id, settings.id));
    return NextResponse.json({ ok: true });
  }

  if (body.action === "clear_contactout_sync_request") {
    await db
      .update(pipelineSettings)
      .set({ contactoutSyncRequestedAt: null, updatedAt: new Date() })
      .where(eq(pipelineSettings.id, settings.id));
    return NextResponse.json({ ok: true });
  }

  if (body.action === "mark_run_complete") {
    await db
      .update(pipelineSettings)
      .set({
        lastRunAt: new Date(),
        runRequestedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(pipelineSettings.id, settings.id));
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
