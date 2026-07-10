import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { pipelineSettings } from "@/lib/db/schema";
import { resolveJobBoards } from "@/lib/job-boards";
import {
  getOrCreateSettings,
  normalizeContactTitles,
} from "@/lib/pipeline-config";
import { normalizeEmailReportPreferences } from "@/lib/email-report-preferences";
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
    metro_cities?: string[];
    metro_aliases?: string[];
    notification_email?: string;
    job_boards?: string[];
    daily_enrich_quota?: number;
    min_score_for_enrich?: number;
    min_score_for_phone?: number;
    contact_titles?: string[];
    email_report_preferences?: Record<string, unknown>;
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
  const metroCities = body.metro_cities
    ? normalizeList(body.metro_cities)
    : normalizeList(current.metroCities);
  const metroAliases = body.metro_aliases
    ? normalizeList(body.metro_aliases)
    : normalizeList(current.metroAliases);
  const jobBoards = body.job_boards
    ? resolveJobBoards(body.job_boards)
    : resolveJobBoards(current.jobBoards);

  const emailReportPreferences =
    body.email_report_preferences != null
      ? normalizeEmailReportPreferences(
          body.email_report_preferences as Parameters<
            typeof normalizeEmailReportPreferences
          >[0],
        )
      : current.emailReportPreferences;

  const contactTitles =
    body.contact_titles != null
      ? normalizeContactTitles(body.contact_titles)
      : normalizeContactTitles(current.contactTitles);

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
      metroCities,
      metroAliases,
      notificationEmail: body.notification_email ?? current.notificationEmail,
      jobBoards,
      dailyEnrichQuota:
        body.daily_enrich_quota ?? current.dailyEnrichQuota,
      minScoreForEnrich:
        body.min_score_for_enrich ?? current.minScoreForEnrich,
      minScoreForPhone:
        body.min_score_for_phone ?? current.minScoreForPhone,
      contactTitles,
      emailReportPreferences,
      updatedAt: new Date(),
    })
    .where(eq(pipelineSettings.id, current.id))
    .returning();

  return NextResponse.json({ settings: updated });
}
