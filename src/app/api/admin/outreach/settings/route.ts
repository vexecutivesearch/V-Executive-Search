import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { outreachSettings } from "@/lib/db/schema";
import { ensureDefaultFlow } from "@/lib/outreach/default-flow";
import { seedOutreachTemplates } from "@/lib/outreach/seed-templates";
import { getOrCreateOutreachSettings } from "@/lib/outreach/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // First visit bootstraps the template bank + locked default flow.
  const settings = await getOrCreateOutreachSettings();
  await seedOutreachTemplates();
  await ensureDefaultFlow();
  return NextResponse.json({ settings });
}

const BOOLEAN_FIELDS = [
  "enabled",
  "dryRun",
  "requireApproval",
  "autoEnroll",
  "workEmailPreferred",
] as const;
const INT_FIELDS = [
  "dailySendCap",
  "maxContactsPerCompany",
  "introStaggerDays",
  "sendWindowStartHour",
  "sendWindowEndHour",
] as const;
const TEXT_FIELDS = ["physicalAddress", "replyToAddress"] as const;

export async function PUT(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const current = await getOrCreateOutreachSettings();
  const patch: Record<string, unknown> = { updatedAt: new Date() };

  for (const field of BOOLEAN_FIELDS) {
    if (typeof body[field] === "boolean") patch[field] = body[field];
  }
  for (const field of INT_FIELDS) {
    if (body[field] !== undefined) {
      const value = Number(body[field]);
      if (Number.isFinite(value) && value >= 0) patch[field] = Math.trunc(value);
    }
  }
  for (const field of TEXT_FIELDS) {
    if (typeof body[field] === "string" || body[field] === null) {
      patch[field] = body[field] ? String(body[field]).trim() || null : null;
    }
  }
  if (body.notifyIntents && typeof body.notifyIntents === "object") {
    patch.notifyIntents = body.notifyIntents;
  }
  if (Array.isArray(body.testRecipients)) {
    patch.testRecipients = body.testRecipients
      .map((r) => String(r).trim())
      .filter((r) => r.includes("@"));
  }

  const [updated] = await db
    .update(outreachSettings)
    .set(patch)
    .where(eq(outreachSettings.id, current.id))
    .returning();
  return NextResponse.json({ settings: updated });
}
