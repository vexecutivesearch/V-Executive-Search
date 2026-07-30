import { NextRequest, NextResponse } from "next/server";
import {
  applyCalendlyBooking,
  fetchScheduledEventTimes,
  parseCalendlyWebhookBody,
  verifyCalendlySignature,
} from "@/lib/outreach/calendly-booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Calendly webhook — invitee.created / invitee.canceled → Call List
 * "Call Booked" (meeting_scheduled) with exact date/time.
 *
 * Auth (either or both):
 *   ?token=<CALENDLY_WEBHOOK_SECRET>  (same pattern as Resend)
 *   Calendly-Webhook-Signature when CALENDLY_WEBHOOK_SIGNING_KEY is set
 *
 * Optional CALENDLY_API_TOKEN: fetch start/end when payload only has a
 * scheduled_event URI.
 */

export async function POST(request: NextRequest) {
  const secret = process.env.CALENDLY_WEBHOOK_SECRET;
  if (secret) {
    const token = request.nextUrl.searchParams.get("token");
    if (token !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const rawBody = await request.text();

  const signingKey = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
  if (signingKey) {
    const ok = verifyCalendlySignature({
      rawBody,
      signatureHeader: request.headers.get("calendly-webhook-signature"),
      signingKey,
    });
    if (!ok) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  let booking = parseCalendlyWebhookBody(body);
  if (!booking) {
    return NextResponse.json({ ok: true, ignored: "unrecognized payload" });
  }

  const handled =
    booking.event === "invitee.created" ||
    booking.event === "invitee.canceled" ||
    booking.event === "invitee.cancelled";
  if (!handled) {
    return NextResponse.json({ ok: true, ignored: booking.event || "unknown" });
  }

  // URI-only scheduled_event → hydrate times via Calendly API when possible.
  if (
    !booking.startTime &&
    booking.scheduledEventUri &&
    process.env.CALENDLY_API_TOKEN
  ) {
    const times = await fetchScheduledEventTimes(
      booking.scheduledEventUri,
      process.env.CALENDLY_API_TOKEN,
    );
    booking = {
      ...booking,
      startTime: times.startTime,
      endTime: times.endTime ?? booking.endTime,
    };
  }

  const result = await applyCalendlyBooking(booking);
  return NextResponse.json(result);
}
