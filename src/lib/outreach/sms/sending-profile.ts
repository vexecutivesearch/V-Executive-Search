import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { sendingProfiles, type SendingProfile } from "@/lib/db/schema";
import { RAMP_BASE } from "@/lib/outreach/profiles";
import { smsFlagOn, type SmsEnv } from "@/lib/outreach/sms/provider";
import { resolveTwilioRouting } from "@/lib/outreach/sms/twilio";

/**
 * Register the Twilio sending identity as a sending_profiles row of kind
 * imessage_number, idempotently (ensureDefaultFlow's shape: look it up, create
 * or reconcile, never duplicate).
 *
 * Why bother: pickSendingProfile, rampCap and tickWarmupStateMachine already
 * key on kind and status, not on anything email-specific, so a registered
 * number inherits ramp stages, daily caps, health scoring and throttling with
 * no new machinery. The only email-specific parts of profiles.ts are
 * verifyProfileDns / requiredDnsRecords (SPF/DKIM/DMARC) and resend_key_ref,
 * none of which the pick path calls — an SMS profile simply leaves them null,
 * because 10DLC vetting is Twilio's registration, not a DNS record.
 */

export const SMS_PROFILE_LABEL_PREFIX = "SMS";

export type EnsureSmsProfileResult =
  | { ok: true; profileId: string; created: boolean; activated: boolean; label: string }
  | { ok: false; reason: string };

function labelFor(routing: { from: string; via: "messaging_service" | "number" }): string {
  return routing.via === "messaging_service"
    ? `${SMS_PROFILE_LABEL_PREFIX} via ${routing.from}`
    : `${SMS_PROFILE_LABEL_PREFIX} ${routing.from}`;
}

async function findExisting(
  routing: { from: string; via: "messaging_service" | "number" },
  label: string,
): Promise<SendingProfile | undefined> {
  if (routing.via === "number") {
    const [byNumber] = await db
      .select()
      .from(sendingProfiles)
      .where(
        and(
          eq(sendingProfiles.kind, "imessage_number"),
          eq(sendingProfiles.phoneNumber, routing.from),
        ),
      )
      .limit(1);
    if (byNumber) return byNumber;
  }
  const [byLabel] = await db
    .select()
    .from(sendingProfiles)
    .where(
      and(eq(sendingProfiles.kind, "imessage_number"), eq(sendingProfiles.label, label)),
    )
    .limit(1);
  return byLabel;
}

/**
 * Create (or reconcile) the profile for the configured Twilio identity.
 *
 * Ships as `new`, which pickSendingProfile does not select: registering the
 * number must not by itself make it sendable. It moves to `warming` only once
 * OUTREACH_SMS_ENABLED is true, i.e. after the A2P campaign is approved and the
 * operator has flipped the flag.
 */
export async function ensureSmsSendingProfile(
  env: SmsEnv = process.env,
  now = new Date(),
): Promise<EnsureSmsProfileResult> {
  const routing = resolveTwilioRouting(env);
  if (!routing.ok) return { ok: false, reason: routing.error };

  const label = labelFor(routing.value);
  const existing = await findExisting(routing.value, label);
  const enabled = smsFlagOn(env);

  if (!existing) {
    const [row] = await db
      .insert(sendingProfiles)
      .values({
        kind: "imessage_number",
        label,
        // The A2P campaign lives on the Messaging Service, so when we route
        // through one that SID — not a number — is the sending identity.
        phoneNumber: routing.value.via === "number" ? routing.value.from : null,
        appleIdLabel:
          routing.value.via === "messaging_service" ? routing.value.from : null,
        status: enabled ? "warming" : "new",
        dailyLimit: RAMP_BASE,
        rampStage: 0,
        warmingStartedAt: enabled ? now : null,
        cleanSince: enabled ? now : null,
      })
      .returning();
    return {
      ok: true,
      profileId: row.id,
      created: true,
      activated: enabled,
      label,
    };
  }

  // Only ever the one promotion out of `new`; ramp stage, caps and health
  // counters belong to the warm-up state machine from here on.
  if (enabled && existing.status === "new") {
    await db
      .update(sendingProfiles)
      .set({
        status: "warming",
        warmingStartedAt: existing.warmingStartedAt ?? now,
        cleanSince: existing.cleanSince ?? now,
        updatedAt: now,
      })
      .where(eq(sendingProfiles.id, existing.id));
    return {
      ok: true,
      profileId: existing.id,
      created: false,
      activated: true,
      label: existing.label,
    };
  }

  return {
    ok: true,
    profileId: existing.id,
    created: false,
    activated: false,
    label: existing.label,
  };
}
