import { desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { suppressions } from "@/lib/db/schema";
import { purgeContactData } from "@/lib/outreach/rules";
import { addSuppression, importDncList } from "@/lib/outreach/suppression";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rows = await db
    .select()
    .from(suppressions)
    .orderBy(desc(suppressions.createdAt))
    .limit(500);
  return NextResponse.json({ suppressions: rows });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: {
    action?: "add" | "import" | "data_deletion";
    email?: string;
    phone?: string;
    channel?: "email" | "imessage" | "all";
    reason?: string;
    /** CSV/newline-separated emails + phones for DNC import. */
    values?: string;
    contactId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.action === "import") {
    const values = (body.values ?? "")
      .split(/[\n,;]+/)
      .map((v) => v.trim())
      .filter(Boolean);
    const imported = await importDncList(values, body.reason ?? "DNC import");
    return NextResponse.json({ ok: true, imported });
  }

  if (body.action === "data_deletion") {
    // Manual button for deletion requests arriving out-of-band.
    if (!body.contactId) {
      return NextResponse.json({ error: "contactId required" }, { status: 400 });
    }
    const result = await purgeContactData(body.contactId, "user");
    return NextResponse.json({ ok: true, ...result });
  }

  const row = await addSuppression({
    email: body.email,
    phone: body.phone,
    channel: body.channel ?? "all",
    reason: body.reason ?? "manual suppression",
    legalBasis: "manual admin action",
  });
  if (!row) return NextResponse.json({ error: "valid email or phone required" }, { status: 400 });
  return NextResponse.json({ suppression: row });
}

export async function DELETE(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await db.delete(suppressions).where(eq(suppressions.id, id));
  return NextResponse.json({ ok: true });
}
