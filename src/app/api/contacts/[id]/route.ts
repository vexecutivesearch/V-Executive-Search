import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { contacts } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!verifyWorkerAuth(request)) {
    return unauthorized();
  }

  const { id } = await params;
  let body: { imessage_capable?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.imessage_capable !== "boolean") {
    return NextResponse.json(
      { error: "imessage_capable (boolean) required" },
      { status: 400 },
    );
  }

  const [updated] = await db
    .update(contacts)
    .set({ imessageCapable: body.imessage_capable })
    .where(eq(contacts.id, id))
    .returning({ id: contacts.id });

  if (!updated) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id: updated.id });
}
