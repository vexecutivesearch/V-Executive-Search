import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { outreachSettings } from "@/lib/db/schema";
import { ensureDefaultFlow } from "@/lib/outreach/default-flow";
import { seedOutreachTemplates } from "@/lib/outreach/seed-templates";
import { getOrCreateOutreachSettings } from "@/lib/outreach/settings";
import {
  isValidWindowHour,
  resolveSendWindow,
  TESTING_WINDOW_MAX_HOURS,
  testingWindowExpiry,
} from "@/lib/outreach/send-window";

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
  return NextResponse.json({ settings, window: resolveSendWindow(settings) });
}

const BOOLEAN_FIELDS = [
  "enabled",
  "textEnabled",
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

  // Testing-window override. Callers pass a DURATION, never an expiry instant,
  // so there is no way to ask for an override that outlives the session.
  if (body.testingWindowUntil === null) {
    patch.testingWindowUntil = null;
    patch.testingWindowStartHour = null;
    patch.testingWindowEndHour = null;
  } else if (body.testingWindowHours !== undefined) {
    const hours = Number(body.testingWindowHours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > TESTING_WINDOW_MAX_HOURS) {
      return NextResponse.json(
        { error: `testingWindowHours must be between 0 and ${TESTING_WINDOW_MAX_HOURS}` },
        { status: 400 },
      );
    }
    const startHour =
      body.testingWindowStartHour === undefined
        ? current.sendWindowStartHour
        : Number(body.testingWindowStartHour);
    const endHour =
      body.testingWindowEndHour === undefined
        ? current.sendWindowEndHour
        : Number(body.testingWindowEndHour);
    if (!isValidWindowHour(startHour) || !isValidWindowHour(endHour)) {
      return NextResponse.json(
        { error: "Testing window hours must be whole hours between 0 and 24" },
        { status: 400 },
      );
    }
    if (endHour <= startHour) {
      return NextResponse.json(
        { error: "Testing window end hour must be after the start hour" },
        { status: 400 },
      );
    }
    patch.testingWindowUntil = testingWindowExpiry(hours);
    patch.testingWindowStartHour = startHour;
    patch.testingWindowEndHour = endHour;
  }

  const [updated] = await db
    .update(outreachSettings)
    .set(patch)
    .where(eq(outreachSettings.id, current.id))
    .returning();
  return NextResponse.json({ settings: updated, window: resolveSendWindow(updated) });
}
