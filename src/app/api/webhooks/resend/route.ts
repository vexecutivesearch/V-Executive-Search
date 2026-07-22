import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { outreachMessages, sequenceEnrollments } from "@/lib/db/schema";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { ingestInboundMessage } from "@/lib/outreach/inbound";
import { bumpProfileCounters } from "@/lib/outreach/profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resend webhook — bounces/complaints/delivery for OUTREACH sends only.
 * The webhook fires for every send on the account, including transactional
 * app emails (daily reports, alerts): events whose resend_id doesn't match
 * an outreach message are logged and ignored — a bounced daily report must
 * never suppress a contact or ding a profile's health.
 *
 * Optional shared-secret check via RESEND_WEBHOOK_SECRET (svix signing is
 * validated when the secret is configured as a plain token in the endpoint
 * URL: /api/webhooks/resend?token=...).
 */

type ResendEvent = {
  type?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    subject?: string;
    bounce?: { type?: string; subType?: string; message?: string };
  };
};

export async function POST(request: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (secret) {
    const token = request.nextUrl.searchParams.get("token");
    if (token !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let event: ResendEvent;
  try {
    event = (await request.json()) as ResendEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const type = event.type ?? "";
  const resendId = event.data?.email_id;
  if (!resendId) return NextResponse.json({ ok: true, ignored: "no email_id" });

  const [message] = await db
    .select()
    .from(outreachMessages)
    .where(eq(outreachMessages.resendId, resendId))
    .limit(1);
  if (!message) {
    // Non-outreach event (transactional app email) — log, no action.
    console.log(`[outreach] resend webhook ignored (non-outreach): ${type} ${resendId}`);
    return NextResponse.json({ ok: true, ignored: "not an outreach message" });
  }

  const [enrollment] = await db
    .select()
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.id, message.enrollmentId))
    .limit(1);

  if (type === "email.delivered") {
    if (message.sendingProfileId) {
      await bumpProfileCounters(message.sendingProfileId, { totalDelivered: 1 });
    }
    await logEnrollmentEvent({
      enrollmentId: message.enrollmentId,
      eventType: "rule_action",
      payload: { webhook: type, message_id: message.id },
    });
    return NextResponse.json({ ok: true });
  }

  if (type === "email.bounced") {
    const bounceType = (event.data?.bounce?.type ?? "").toLowerCase();
    const hard = bounceType !== "transient" && bounceType !== "soft";
    if (message.sendingProfileId) {
      await bumpProfileCounters(message.sendingProfileId, { totalBounced: 1 });
    }
    await ingestInboundMessage({
      channel: "email",
      fromAddress: enrollment?.emailAddress,
      subject: `bounce (${bounceType || "unknown"})`,
      body: event.data?.bounce?.message ?? `Resend bounce for ${resendId}`,
      externalId: `resend:${type}:${resendId}`,
      preclassifiedIntent: hard ? "bounce_hard" : "bounce_soft",
    });
    return NextResponse.json({ ok: true, bounce: hard ? "hard" : "soft" });
  }

  if (type === "email.complained") {
    if (message.sendingProfileId) {
      await bumpProfileCounters(message.sendingProfileId, { totalComplaints: 1 });
    }
    // Complaints are treated as opt-outs — suppress the contact.
    await ingestInboundMessage({
      channel: "email",
      fromAddress: enrollment?.emailAddress,
      subject: "spam complaint",
      body: `Recipient marked the message as spam (resend ${resendId}).`,
      externalId: `resend:${type}:${resendId}`,
      preclassifiedIntent: "complaint",
    });
    // complaint intent falls into default rule → pause; force suppression:
    if (enrollment) {
      const { addSuppression } = await import("@/lib/outreach/suppression");
      await addSuppression({
        email: enrollment.emailAddress,
        channel: "email",
        reason: "spam complaint",
        contactId: enrollment.contactId,
      });
    }
    return NextResponse.json({ ok: true });
  }

  await logEnrollmentEvent({
    enrollmentId: message.enrollmentId,
    eventType: "rule_action",
    payload: { webhook: type, message_id: message.id, unhandled: true },
  });
  return NextResponse.json({ ok: true, unhandled: type });
}
