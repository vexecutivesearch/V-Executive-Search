import { desc, eq, inArray, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import {
  companies,
  contacts,
  inboundMessages,
  outreachNotifications,
} from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const unreadOnly = request.nextUrl.searchParams.get("unread") === "1";

  const rows = await db
    .select({
      notification: outreachNotifications,
      contactName: contacts.name,
      companyName: companies.name,
    })
    .from(outreachNotifications)
    .leftJoin(contacts, eq(contacts.id, outreachNotifications.contactId))
    .leftJoin(companies, eq(companies.id, outreachNotifications.companyId))
    .where(unreadOnly ? isNull(outreachNotifications.readAt) : undefined)
    .orderBy(desc(outreachNotifications.createdAt))
    .limit(100);

  const inbound = await db
    .select()
    .from(inboundMessages)
    .orderBy(desc(inboundMessages.receivedAt))
    .limit(100);

  return NextResponse.json({ notifications: rows, inbound });
}

export async function PATCH(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { ids?: string[]; markRead?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.ids?.length) return NextResponse.json({ error: "ids required" }, { status: 400 });
  await db
    .update(outreachNotifications)
    .set({ readAt: body.markRead === false ? null : new Date() })
    .where(inArray(outreachNotifications.id, body.ids));
  return NextResponse.json({ ok: true });
}
