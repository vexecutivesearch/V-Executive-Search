/**
 * A2P 10DLC SMS, provider-agnostic.
 *
 * The email side (resend-send.ts) is allowed to be Resend-shaped because the
 * domains and the ESP are one decision. Texting is not: 10DLC throughput and
 * per-segment price differ enough between Twilio, Telnyx and Plivo that the
 * operator may re-point the number mid-campaign, and the send path must not
 * have to change when they do. Everything Twilio-specific lives in twilio.ts
 * behind the `SmsProvider` interface below.
 *
 * Nothing here sends until BOTH credentials and OUTREACH_SMS_ENABLED=true are
 * present: carriers block unregistered A2P traffic outright since Feb 2025, so
 * a half-configured environment must be inert rather than optimistic.
 */

export type SmsSendInput = {
  to: string;
  /**
   * E.164 number, or a provider routing identifier that stands in for one — a
   * Twilio Messaging Service SID, for instance, which is what actually carries
   * the A2P campaign registration. The provider decides how to spend it.
   */
  from: string;
  body: string;
};

export type SmsSendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; error: string; retryable: boolean };

export interface SmsProvider {
  /** For logs and the provider column on send records. */
  readonly name: string;
  send(input: SmsSendInput): Promise<SmsSendResult>;
}

export type SmsEnv = Record<string, string | undefined>;

export type SmsConfig = {
  /** Provider id, e.g. "twilio". */
  providerName: string;
  provider: SmsProvider;
  /** Routing identity handed to `send` as `from`. */
  from: string;
  /** How that identity routes — a Messaging Service or a bare number. */
  via: "messaging_service" | "number";
};

export type SmsResolution =
  | { enabled: true; config: SmsConfig }
  | { enabled: false; reason: string };

/** Explicit opt-in. Credentials alone must never be enough to start traffic. */
export const SMS_ENABLE_FLAG = "OUTREACH_SMS_ENABLED";

export function smsFlagOn(env: SmsEnv = process.env): boolean {
  return (env[SMS_ENABLE_FLAG] ?? "").trim().toLowerCase() === "true";
}

export type SmsProviderFactory = (
  env: SmsEnv,
) => { ok: true; config: SmsConfig } | { ok: false; error: string };

const FACTORIES: Record<string, () => Promise<SmsProviderFactory>> = {
  twilio: async () => (await import("@/lib/outreach/sms/twilio")).twilioSmsConfig,
};

export const DEFAULT_SMS_PROVIDER = "twilio";

/**
 * Resolve the configured provider, or say why there isn't one. Never throws:
 * callers treat "not configured" and "flag off" the same way — no send.
 */
export async function resolveSmsProvider(
  env: SmsEnv = process.env,
): Promise<SmsResolution> {
  if (!smsFlagOn(env)) {
    return {
      enabled: false,
      reason: `${SMS_ENABLE_FLAG} is not true — SMS integration is off`,
    };
  }

  const name = (env.SMS_PROVIDER ?? DEFAULT_SMS_PROVIDER).trim().toLowerCase();
  const load = FACTORIES[name];
  if (!load) {
    return { enabled: false, reason: `unknown SMS_PROVIDER "${name}"` };
  }

  const factory = await load();
  const built = factory(env);
  if (!built.ok) return { enabled: false, reason: built.error };
  return { enabled: true, config: built.config };
}

/**
 * The one send entry point. Returns a non-retryable failure when the
 * integration is off, so a caller that ignores the flag still cannot send and
 * still cannot spin on retries.
 */
export async function sendSms(
  input: Omit<SmsSendInput, "from"> & { from?: string },
  env: SmsEnv = process.env,
): Promise<SmsSendResult> {
  const resolution = await resolveSmsProvider(env);
  if (!resolution.enabled) {
    return { ok: false, error: `sms disabled: ${resolution.reason}`, retryable: false };
  }
  const { config } = resolution;
  return config.provider.send({
    to: input.to,
    from: input.from ?? config.from,
    body: input.body,
  });
}
