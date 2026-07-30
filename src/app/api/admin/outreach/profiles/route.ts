import { desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { sendingProfiles } from "@/lib/db/schema";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import {
  profileHealth,
  rampCap,
  requiredDnsRecords,
  verifyProfileDns,
} from "@/lib/outreach/profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function rootDomainOf(domain: string): string {
  return domain.split(".").slice(-2).join(".");
}

export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const profiles = await db
    .select()
    .from(sendingProfiles)
    .orderBy(sendingProfiles.rootDomain, desc(sendingProfiles.createdAt));

  // Root-domain grouping with group-level reputation rollup.
  const groups = new Map<
    string,
    { root: string; profiles: number; sent: number; bounced: number; complaints: number }
  >();
  for (const profile of profiles) {
    const root = profile.rootDomain ?? profile.domain ?? profile.label;
    const entry = groups.get(root) ?? {
      root,
      profiles: 0,
      sent: 0,
      bounced: 0,
      complaints: 0,
    };
    entry.profiles += 1;
    entry.sent += profile.totalSent;
    entry.bounced += profile.totalBounced;
    entry.complaints += profile.totalComplaints;
    groups.set(root, entry);
  }

  return NextResponse.json({
    profiles: profiles.map((p) => ({
      ...p,
      health: profileHealth(p),
      effectiveCap: Math.min(p.dailyLimit, rampCap(p.rampStage)),
    })),
    rootGroups: [...groups.values()],
  });
}

/** Add domain flow: create profile in `new`, return the DNS records to add. */
export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: {
    kind?: "email_domain" | "imessage_number";
    label?: string;
    domain?: string;
    fromAddress?: string;
    replyToAddress?: string;
    phoneNumber?: string;
    appleIdLabel?: string;
    resendKeyRef?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const kind = body.kind === "imessage_number" ? "imessage_number" : "email_domain";
  if (kind === "email_domain" && (!body.domain?.trim() || !body.fromAddress?.trim())) {
    return NextResponse.json({ error: "domain + fromAddress required" }, { status: 400 });
  }
  if (kind === "imessage_number" && !body.phoneNumber?.trim()) {
    return NextResponse.json({ error: "phoneNumber required" }, { status: 400 });
  }

  const domain = body.domain?.trim().toLowerCase() ?? null;
  const [created] = await db
    .insert(sendingProfiles)
    .values({
      kind,
      label: body.label?.trim() || domain || body.phoneNumber || "profile",
      domain,
      fromAddress: body.fromAddress?.trim() || null,
      replyToAddress: body.replyToAddress?.trim() || null,
      phoneNumber: body.phoneNumber?.trim() || null,
      appleIdLabel: body.appleIdLabel?.trim() || null,
      rootDomain: domain ? rootDomainOf(domain) : null,
      resendKeyRef: body.resendKeyRef?.trim() || null,
      status: "new",
    })
    .returning();

  return NextResponse.json({
    profile: created,
    dnsRecords: domain ? requiredDnsRecords(domain) : [],
  });
}

export async function PATCH(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: {
    id?: string;
    action?: "verify" | "pause" | "resume" | "ban" | "delete" | "update";
    confirmLabel?: string;
    dailyLimit?: number;
    resendKeyRef?: string;
    replyToAddress?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const [profile] = await db
    .select()
    .from(sendingProfiles)
    .where(eq(sendingProfiles.id, body.id))
    .limit(1);
  if (!profile) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (body.action === "verify") {
    if (profile.kind !== "email_domain" || !profile.domain) {
      return NextResponse.json({ error: "only email domains verify DNS" }, { status: 422 });
    }
    const check = await verifyProfileDns(profile.domain);
    const now = new Date();
    const [updated] = await db
      .update(sendingProfiles)
      .set({
        lastDnsCheck: check as unknown as Record<string, unknown>,
        // Verification gate: pass → warming starts; fail → stays unverified.
        ...(check.ok
          ? {
              status: "warming" as const,
              verifiedAt: now,
              warmingStartedAt: profile.warmingStartedAt ?? now,
              cleanSince: now,
              dailyLimit: rampCap(profile.rampStage),
            }
          : { status: "verifying" as const }),
        updatedAt: now,
      })
      .where(eq(sendingProfiles.id, profile.id))
      .returning();
    return NextResponse.json({ profile: updated, dnsCheck: check });
  }

  if (body.action === "pause" || body.action === "resume" || body.action === "ban") {
    // Destructive/risky actions on a warm domain require typed confirmation.
    if (
      (body.action === "ban" || (body.action === "pause" && profile.status === "active")) &&
      body.confirmLabel !== profile.label
    ) {
      return NextResponse.json(
        { error: `type the profile label ("${profile.label}") to confirm` },
        { status: 422 },
      );
    }
    const status =
      body.action === "ban" ? "banned" : body.action === "pause" ? "paused" : "warming";
    const [updated] = await db
      .update(sendingProfiles)
      .set({
        status,
        pausedReason: body.action === "resume" ? null : `${body.action} by admin`,
        updatedAt: new Date(),
      })
      .where(eq(sendingProfiles.id, profile.id))
      .returning();
    await logEnrollmentEvent({
      eventType: "manual_intervention",
      actor: "user",
      payload: { action: `profile_${body.action}`, profile: profile.label },
    });
    return NextResponse.json({ profile: updated });
  }

  if (body.action === "delete") {
    if (["warming", "active"].includes(profile.status) && body.confirmLabel !== profile.label) {
      return NextResponse.json(
        { error: `deleting a warm domain requires typing "${profile.label}" to confirm` },
        { status: 422 },
      );
    }
    await db.delete(sendingProfiles).where(eq(sendingProfiles.id, profile.id));
    await logEnrollmentEvent({
      eventType: "manual_intervention",
      actor: "user",
      payload: { action: "profile_delete", profile: profile.label },
    });
    return NextResponse.json({ ok: true });
  }

  // update
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (body.dailyLimit !== undefined && Number.isFinite(Number(body.dailyLimit))) {
    patch.dailyLimit = Math.max(1, Math.trunc(Number(body.dailyLimit)));
  }
  if (body.resendKeyRef !== undefined) patch.resendKeyRef = body.resendKeyRef?.trim() || null;
  if (body.replyToAddress !== undefined) patch.replyToAddress = body.replyToAddress?.trim() || null;
  const [updated] = await db
    .update(sendingProfiles)
    .set(patch)
    .where(eq(sendingProfiles.id, profile.id))
    .returning();
  return NextResponse.json({ profile: updated });
}
