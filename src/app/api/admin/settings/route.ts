import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { pipelineSettings } from "@/lib/db/schema";
import { getOrCreateSettings } from "@/lib/pipeline-config";
import { eq } from "drizzle-orm";

function normalizeList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
}

export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const settings = await getOrCreateSettings();
  return NextResponse.json({ settings });
}

export async function PUT(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    geographic_scope?: string;
    focus_state?: string;
    focus_city?: string;
    focus_county?: string;
    focus_cities?: string[];
    focus_counties?: string[];
    notification_email?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const current = await getOrCreateSettings();
  const focusCities = body.focus_cities
    ? normalizeList(body.focus_cities)
    : normalizeList(current.focusCities);
  const focusCounties = body.focus_counties
    ? normalizeList(body.focus_counties)
    : normalizeList(current.focusCounties);

  const [updated] = await db
    .update(pipelineSettings)
    .set({
      geographicScope:
        (body.geographic_scope as typeof current.geographicScope) ??
        current.geographicScope,
      focusState: body.focus_state ?? current.focusState,
      focusCity: focusCities[0] ?? body.focus_city ?? current.focusCity,
      focusCounty: focusCounties[0] ?? body.focus_county ?? current.focusCounty,
      focusCities,
      focusCounties,
      notificationEmail: body.notification_email ?? current.notificationEmail,
      updatedAt: new Date(),
    })
    .where(eq(pipelineSettings.id, current.id))
    .returning();

  return NextResponse.json({ settings: updated });
}
