import { NextRequest, NextResponse } from "next/server";
import {
  twilioWebhookUrl,
  verifyTwilioSignature,
} from "@/lib/outreach/sms/twilio";
import {
  handleTwilioInbound,
  handleTwilioStatus,
  parseTwilioWebhook,
} from "@/lib/outreach/sms/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Twilio webhook — inbound SMS replies and delivery-status callbacks.
 *
 * Inbound goes through the shared ingest (classifier → rule engine), the same
 * as an IMAP reply or a chat.db text. Status callbacks reconcile the
 * outreach_messages row and feed the profile health counters.
 *
 * Every request must carry a valid X-Twilio-Signature, keyed on
 * TWILIO_AUTH_TOKEN. This endpoint writes into the inbound pipeline and the
 * suppression list, so unsigned traffic is an injection vector: with the token
 * unset we reject instead of trusting the caller.
 *
 * Behind a proxy the signed URL is not the URL this process sees (TLS is
 * terminated upstream); set TWILIO_WEBHOOK_URL to the exact URL configured in
 * the Twilio console if the forwarded headers ever disagree with it.
 */
export async function POST(request: NextRequest) {
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!authToken) {
    console.error(
      "[outreach] twilio webhook rejected — TWILIO_AUTH_TOKEN unset, cannot verify signature",
    );
    return NextResponse.json(
      { error: "Webhook signature verification unavailable" },
      { status: 401 },
    );
  }

  const rawBody = await request.text();
  const params = new URLSearchParams(rawBody);

  const url = twilioWebhookUrl({
    requestUrl: request.url,
    forwardedProto: request.headers.get("x-forwarded-proto"),
    forwardedHost: request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
    configuredUrl: process.env.TWILIO_WEBHOOK_URL,
  });

  const signed = verifyTwilioSignature({
    url,
    params,
    authToken,
    signatureHeader: request.headers.get("x-twilio-signature"),
  });
  if (!signed) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const event = parseTwilioWebhook(params);
  if (event.kind === "ignored") {
    return NextResponse.json({ ok: true, ignored: event.reason });
  }
  if (event.kind === "inbound") {
    const outcome = await handleTwilioInbound(event.payload);
    return NextResponse.json({ ok: true, ...outcome });
  }
  const outcome = await handleTwilioStatus(event.payload);
  return NextResponse.json({ ok: true, ...outcome });
}
