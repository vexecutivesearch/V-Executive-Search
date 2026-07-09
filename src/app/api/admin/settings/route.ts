import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { pipelineSettings } from "@/lib/db/schema";
import { getOrCreateSettings } from "@/lib/pipeline-config";
import { eq } from "drizzle-orm";

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
    notification_email?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const current = await getOrCreateSettings();
  const [updated] = await db
    .update(pipelineSettings)
    .set({
      geographicScope:
        (body.geographic_scope as typeof current.geographicScope) ??
        current.geographicScope,
      focusState: body.focus_state ?? current.focusState,
      focusCity: body.focus_city ?? current.focusCity,
      focusCounty: body.focus_county ?? current.focusCounty,
      notificationEmail: body.notification_email ?? current.notificationEmail,
      updatedAt: new Date(),
    })
    .where(eq(pipelineSettings.id, current.id))
    .returning();

  return NextResponse.json({ settings: updated });
}
