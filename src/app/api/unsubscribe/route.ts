import { inArray, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sequenceEnrollments } from "@/lib/db/schema";
import { recordCallListOutreachEvent } from "@/lib/outreach/call-list-sync";
import { logEnrollmentEvent } from "@/lib/outreach/events";
import { stopPendingSteps } from "@/lib/outreach/pending-messages";
import { addSuppression, normalizeEmail } from "@/lib/outreach/suppression";
import { verifyUnsubscribeToken } from "@/lib/outreach/unsubscribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * List-Unsubscribe endpoint.
 *
 * GET renders a confirm page (never suppresses — link-scanning mail security
 * follows GETs, and a scanner must not unsubscribe a real prospect).
 * POST performs the suppression: both the RFC 8058 one-click POST from the
 * mail client and the confirm-page button land here.
 */

const LIVE_STATUSES = [
  "active",
  "paused",
  "waiting_on_reply",
  "waiting_on_manual",
  "replied_positive",
] as const;

function params(request: NextRequest): { email: string | null; token: string } {
  const email = normalizeEmail(request.nextUrl.searchParams.get("email"));
  const token = request.nextUrl.searchParams.get("token") ?? "";
  return { email, token };
}

function htmlResponse(body: string, status = 200): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribe</title></head>
<body style="font-family: -apple-system, system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a;">
${body}
</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export async function GET(request: NextRequest) {
  const { email, token } = params(request);
  if (!email || !verifyUnsubscribeToken(email, token)) {
    return htmlResponse("<p>This unsubscribe link is invalid or expired.</p>", 400);
  }
  return htmlResponse(
    `<h2 style="font-weight:600">Unsubscribe</h2>
<p>Stop receiving emails at <strong>${email}</strong>?</p>
<form method="POST" action="${request.nextUrl.pathname}?${request.nextUrl.searchParams.toString()}">
  <button type="submit" style="background:#111;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:15px;cursor:pointer">Unsubscribe</button>
</form>`,
  );
}

export async function POST(request: NextRequest) {
  const { email, token } = params(request);
  if (!email || !verifyUnsubscribeToken(email, token)) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }

  await addSuppression({
    email,
    channel: "all",
    reason: "list-unsubscribe",
    legalBasis: "recipient request",
  });

  // Stop anything still scheduled for this address.
  const live = await db
    .select()
    .from(sequenceEnrollments)
    .where(
      sql`lower(${sequenceEnrollments.emailAddress}) = ${email} and ${inArray(
        sequenceEnrollments.status,
        [...LIVE_STATUSES],
      )}`,
    )
    .limit(20);

  for (const enrollment of live) {
    await stopPendingSteps(enrollment.id, "unsubscribe_link");
    await db
      .update(sequenceEnrollments)
      .set({
        status: "suppressed",
        stopReason: "list-unsubscribe link",
        stoppedBy: "unsubscribe_link",
        nextStepAt: null,
        updatedAt: new Date(),
      })
      .where(sql`${sequenceEnrollments.id} = ${enrollment.id}`);
    await logEnrollmentEvent({
      enrollmentId: enrollment.id,
      eventType: "rule_action",
      actor: "unsubscribe_link",
      payload: { action: "list_unsubscribe", email },
    });
    await recordCallListOutreachEvent({
      companyId: enrollment.companyId,
      contactId: enrollment.contactId,
      callStatus: "do_not_contact",
      summary: `Unsubscribed via email link (${email})`,
    });
  }

  // Confirm-page form gets HTML back; the mail client's one-click POST gets JSON.
  const fromForm = request.headers
    .get("content-type")
    ?.includes("application/x-www-form-urlencoded");
  return fromForm
    ? htmlResponse("<p>You've been unsubscribed. Sorry to have bothered you.</p>")
    : NextResponse.json({ ok: true, unsubscribed: email, enrollments: live.length });
}
