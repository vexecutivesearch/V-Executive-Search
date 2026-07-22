import { desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { outreachTemplates, outreachTemplateKindEnum } from "@/lib/db/schema";
import { seedOutreachTemplates } from "@/lib/outreach/seed-templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await seedOutreachTemplates();
  const templates = await db
    .select()
    .from(outreachTemplates)
    .orderBy(outreachTemplates.kind, desc(outreachTemplates.createdAt));
  return NextResponse.json({ templates });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: {
    name?: string;
    kind?: string;
    channel?: string;
    exampleSubject?: string;
    exampleBody?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const kinds = outreachTemplateKindEnum.enumValues as readonly string[];
  if (!body.name?.trim() || !body.exampleBody?.trim() || !kinds.includes(body.kind ?? "")) {
    return NextResponse.json({ error: "name, kind, exampleBody required" }, { status: 400 });
  }

  const [created] = await db
    .insert(outreachTemplates)
    .values({
      name: body.name.trim(),
      kind: body.kind as (typeof outreachTemplateKindEnum.enumValues)[number],
      channel: body.channel === "imessage" ? "imessage" : "email",
      exampleSubject: body.exampleSubject?.trim() || null,
      exampleBody: body.exampleBody.trim(),
    })
    .returning();
  return NextResponse.json({ template: created });
}

export async function PATCH(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: {
    id?: string;
    name?: string;
    exampleSubject?: string | null;
    exampleBody?: string;
    isActive?: boolean;
    clearFlag?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name?.trim()) patch.name = body.name.trim();
  if (body.exampleBody?.trim()) patch.exampleBody = body.exampleBody.trim();
  if (body.exampleSubject !== undefined) {
    patch.exampleSubject = body.exampleSubject?.trim() || null;
  }
  if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
  if (body.clearFlag) {
    patch.flaggedAt = null;
    patch.flagReason = null;
  }

  const [updated] = await db
    .update(outreachTemplates)
    .set(patch)
    .where(eq(outreachTemplates.id, body.id))
    .returning();
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ template: updated });
}

export async function DELETE(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await db.delete(outreachTemplates).where(eq(outreachTemplates.id, id));
  return NextResponse.json({ ok: true });
}
