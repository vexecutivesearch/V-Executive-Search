import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { resolveSmsProvider, smsFlagOn } from "@/lib/outreach/sms/provider";
import { ensureSmsSendingProfile } from "@/lib/outreach/sms/sending-profile";
import { resolveTwilioCredentials } from "@/lib/outreach/sms/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SMS readiness, and the one action that registers the number as a sending
 * profile.
 *
 * A separate endpoint because the generic profiles route promotes a profile out
 * of `new` via DNS verification, which an SMS profile has no equivalent of —
 * 10DLC vetting happens inside Twilio, not in a TXT record.
 *
 * Never returns a credential value, only whether one resolves.
 */
export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const credentials = resolveTwilioCredentials();
  const resolution = await resolveSmsProvider();
  return NextResponse.json({
    enableFlag: smsFlagOn(),
    credentials: credentials.ok
      ? { ok: true, authKind: credentials.value.authKind }
      : { ok: false, error: credentials.error },
    /** Inbound needs the auth token even when sends use an API key pair. */
    webhookVerifiable: Boolean(process.env.TWILIO_AUTH_TOKEN?.trim()),
    sending: resolution.enabled
      ? { enabled: true, provider: resolution.config.providerName, via: resolution.config.via }
      : { enabled: false, reason: resolution.reason },
  });
}

export async function POST() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await ensureSmsSendingProfile();
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 422 });
  }
  return NextResponse.json(result);
}
