import { asc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { searchProfiles } from "@/lib/db/schema";

export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const profiles = await db
    .select()
    .from(searchProfiles)
    .orderBy(asc(searchProfiles.sortOrder));
  return NextResponse.json({ profiles });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    name?: string;
    search_term?: string;
    is_active?: boolean;
    is_remote?: boolean;
    results_wanted?: number;
    hours_old?: number;
    linkedin_distance?: number | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.name || !body.search_term) {
    return NextResponse.json({ error: "name and search_term required" }, { status: 400 });
  }

  const [created] = await db
    .insert(searchProfiles)
    .values({
      name: body.name,
      searchTerm: body.search_term,
      isActive: body.is_active ?? true,
      isRemote: body.is_remote ?? null,
      resultsWanted: body.results_wanted ?? 50,
      hoursOld: body.hours_old ?? 24,
      linkedinDistance: body.linkedin_distance ?? null,
    })
    .returning();

  return NextResponse.json({ profile: created });
}

export async function PUT(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    id?: string;
    name?: string;
    search_term?: string;
    is_active?: boolean;
    is_remote?: boolean | null;
    results_wanted?: number;
    hours_old?: number;
    linkedin_distance?: number | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.search_term !== undefined) updates.searchTerm = body.search_term;
  if (body.is_active !== undefined) updates.isActive = body.is_active;
  if (body.is_remote !== undefined) updates.isRemote = body.is_remote;
  if (body.results_wanted !== undefined) updates.resultsWanted = body.results_wanted;
  if (body.hours_old !== undefined) updates.hoursOld = body.hours_old;
  if (body.linkedin_distance !== undefined) {
    updates.linkedinDistance = body.linkedin_distance;
  }

  const [updated] = await db
    .update(searchProfiles)
    .set(updates)
    .where(eq(searchProfiles.id, body.id))
    .returning();

  return NextResponse.json({ profile: updated });
}
