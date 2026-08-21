import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { CATALOG_SENDING_DOMAINS, NEW_SENDING_DOMAINS } from "@/lib/outreach/sending-domains-catalog";
import { ensureCatalogSendingProfiles } from "@/lib/outreach/sending-domains";
import {
  DEFAULT_DOMAIN_TEST_TO,
  sendCatalogTestEmails,
} from "@/lib/outreach/test-send-domains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { to?: string; scope?: "new" | "all" } = {};
  try {
    body = (await request.json()) as { to?: string; scope?: "new" | "all" };
  } catch {
    body = {};
  }

  const to = body.to?.trim() || DEFAULT_DOMAIN_TEST_TO;
  if (!to.includes("@")) {
    return NextResponse.json({ error: "to must be an email address" }, { status: 400 });
  }

  try {
    await ensureCatalogSendingProfiles();
  } catch (error) {
    console.error("[outreach] catalog sending domains failed", error);
  }

  const results = await sendCatalogTestEmails({
    to,
    domains: body.scope === "all" ? CATALOG_SENDING_DOMAINS : NEW_SENDING_DOMAINS,
  });
  const sent = results.filter((row) => row.ok).length;
  return NextResponse.json({
    to,
    sent,
    failed: results.length - sent,
    results,
  });
}
