import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  SmsConfig,
  SmsEnv,
  SmsProvider,
  SmsSendInput,
  SmsSendResult,
} from "@/lib/outreach/sms/provider";

/**
 * Twilio Programmable Messaging over plain `fetch`, the same way
 * resend-send.ts and apollo-enrich.ts call their providers: the REST surface we
 * need is one form POST, and the `twilio` npm package would pull in a large
 * dependency tree to hide two lines of Basic auth.
 */

export const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

/** Twilio error codes we must not treat as generic failures. */
export const TWILIO_ERROR_OPTED_OUT = 21610;
export const TWILIO_ERROR_CARRIER_FILTERED = 30007;

export type TwilioCredentials = {
  accountSid: string;
  /** Basic auth username: the API Key SID, or the account SID as fallback. */
  username: string;
  password: string;
  authKind: "api_key" | "auth_token";
};

export type TwilioRouting = {
  from: string;
  via: "messaging_service" | "number";
};

type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

const trim = (value: string | undefined): string => (value ?? "").trim();

/**
 * Account SID plus API Key pair when available, Auth Token otherwise.
 *
 * The API key pair is preferred because it can be rotated or revoked on its
 * own; the Auth Token is the account's root credential and revoking it breaks
 * every other integration on the account at the same time.
 */
export function resolveTwilioCredentials(
  env: SmsEnv = process.env,
): Resolved<TwilioCredentials> {
  const accountSid = trim(env.TWILIO_ACCOUNT_SID);
  if (!accountSid) {
    return { ok: false, error: "TWILIO_ACCOUNT_SID is not set" };
  }
  if (!accountSid.startsWith("AC")) {
    return {
      ok: false,
      error: `TWILIO_ACCOUNT_SID does not look like an account SID (expected AC…, got ${accountSid.slice(0, 2)}…)`,
    };
  }

  const keySid = trim(env.TWILIO_API_KEY_SID);
  const keySecret = trim(env.TWILIO_API_KEY_SECRET);
  if (keySid && keySecret) {
    if (!keySid.startsWith("SK")) {
      return {
        ok: false,
        error: `TWILIO_API_KEY_SID does not look like an API key SID (expected SK…, got ${keySid.slice(0, 2)}…)`,
      };
    }
    return {
      ok: true,
      value: {
        accountSid,
        username: keySid,
        password: keySecret,
        authKind: "api_key",
      },
    };
  }
  // A half-set pair is a misconfiguration, not a reason to quietly downgrade
  // to the root credential.
  if (keySid || keySecret) {
    return {
      ok: false,
      error:
        "TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET must both be set (or both unset to fall back to TWILIO_AUTH_TOKEN)",
    };
  }

  const authToken = trim(env.TWILIO_AUTH_TOKEN);
  if (authToken) {
    return {
      ok: true,
      value: {
        accountSid,
        username: accountSid,
        password: authToken,
        authKind: "auth_token",
      },
    };
  }
  return {
    ok: false,
    error:
      "no Twilio credentials — set TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET (preferred) or TWILIO_AUTH_TOKEN",
  };
}

/**
 * Messaging Service if configured, bare number otherwise.
 *
 * The Messaging Service is what the A2P 10DLC campaign is attached to, so
 * sending through it is what makes traffic registered; a bare `From` number
 * only works while the number is not yet campaign-bound.
 */
export function resolveTwilioRouting(env: SmsEnv = process.env): Resolved<TwilioRouting> {
  const serviceSid = trim(env.TWILIO_MESSAGING_SERVICE_SID);
  if (serviceSid) {
    if (!serviceSid.startsWith("MG")) {
      return {
        ok: false,
        error: `TWILIO_MESSAGING_SERVICE_SID does not look like a messaging service SID (expected MG…, got ${serviceSid.slice(0, 2)}…)`,
      };
    }
    return { ok: true, value: { from: serviceSid, via: "messaging_service" } };
  }
  const number = trim(env.TWILIO_FROM_NUMBER);
  if (number) {
    if (!number.startsWith("+")) {
      return {
        ok: false,
        error: `TWILIO_FROM_NUMBER must be E.164 (got "${number}")`,
      };
    }
    return { ok: true, value: { from: number, via: "number" } };
  }
  return {
    ok: false,
    error:
      "no sending identity — set TWILIO_MESSAGING_SERVICE_SID (preferred, carries the A2P campaign) or TWILIO_FROM_NUMBER",
  };
}

export type TwilioFailure = {
  error: string;
  retryable: boolean;
  /** Recipient is opted out (STOP) — mirror it into our suppression list. */
  optedOut: boolean;
  /** Carrier dropped it as spam. Retrying burns reputation, never volume. */
  carrierFiltered: boolean;
};

/**
 * Retryable vs permanent, decided on the code rather than the HTTP status
 * alone. A carrier-filtered or opted-out message re-sent on a loop is how a
 * 10DLC campaign gets suspended, so those two are permanent regardless of what
 * status Twilio wrapped them in.
 */
export function classifyTwilioFailure(input: {
  httpStatus: number;
  code?: number | null;
  message?: string | null;
}): TwilioFailure {
  const code = input.code ?? null;
  const detail = input.message?.trim() ? `: ${input.message.trim()}` : "";
  const label = (what: string) =>
    `Twilio ${what} (HTTP ${input.httpStatus}${code ? `, code ${code}` : ""})${detail}`;

  if (code === TWILIO_ERROR_OPTED_OUT) {
    return {
      error: label("recipient opted out via STOP"),
      retryable: false,
      optedOut: true,
      carrierFiltered: false,
    };
  }
  if (code === TWILIO_ERROR_CARRIER_FILTERED) {
    return {
      error: label("carrier filtered the message"),
      retryable: false,
      optedOut: false,
      carrierFiltered: true,
    };
  }
  if (input.httpStatus === 401 || input.httpStatus === 403) {
    return {
      error: label("authentication rejected — check the API key pair"),
      retryable: false,
      optedOut: false,
      carrierFiltered: false,
    };
  }
  if (input.httpStatus === 429) {
    return {
      error: label("rate limited"),
      retryable: true,
      optedOut: false,
      carrierFiltered: false,
    };
  }
  if (input.httpStatus >= 500) {
    return {
      error: label("server error"),
      retryable: true,
      optedOut: false,
      carrierFiltered: false,
    };
  }
  return {
    error: label("send rejected"),
    retryable: false,
    optedOut: false,
    carrierFiltered: false,
  };
}

type TwilioMessageResponse = {
  sid?: string;
  status?: string;
  code?: number;
  message?: string;
};

export function createTwilioSmsProvider(
  credentials: TwilioCredentials,
  options: { statusCallbackUrl?: string | null } = {},
): SmsProvider {
  const auth = Buffer.from(
    `${credentials.username}:${credentials.password}`,
    "utf8",
  ).toString("base64");
  const url = `${TWILIO_API_BASE}/Accounts/${credentials.accountSid}/Messages.json`;

  return {
    name: "twilio",
    async send(input: SmsSendInput): Promise<SmsSendResult> {
      const form = new URLSearchParams({ To: input.to, Body: input.body });
      if (input.from.startsWith("MG")) {
        form.set("MessagingServiceSid", input.from);
      } else {
        form.set("From", input.from);
      }
      const statusCallback = trim(options.statusCallbackUrl ?? undefined);
      if (statusCallback) form.set("StatusCallback", statusCallback);

      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
        });
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "unknown Twilio send error",
          // A transport-level failure never reached Twilio, so nothing was sent.
          retryable: true,
        };
      }

      const raw = await resp.text();
      let data: TwilioMessageResponse = {};
      try {
        data = raw ? (JSON.parse(raw) as TwilioMessageResponse) : {};
      } catch {
        data = { message: raw.slice(0, 300) };
      }

      if (!resp.ok) {
        const failure = classifyTwilioFailure({
          httpStatus: resp.status,
          code: data.code ?? null,
          message: data.message ?? raw.slice(0, 300),
        });
        console.error(`[outreach] twilio send failed — ${failure.error}`);
        return { ok: false, error: failure.error, retryable: failure.retryable };
      }
      if (!data.sid) {
        return {
          ok: false,
          error: "Twilio response missing sid",
          retryable: false,
        };
      }
      return { ok: true, providerMessageId: data.sid };
    },
  };
}

/** Factory used by the provider registry in provider.ts. */
export function twilioSmsConfig(
  env: SmsEnv = process.env,
): { ok: true; config: SmsConfig } | { ok: false; error: string } {
  const credentials = resolveTwilioCredentials(env);
  if (!credentials.ok) return { ok: false, error: credentials.error };
  const routing = resolveTwilioRouting(env);
  if (!routing.ok) return { ok: false, error: routing.error };
  return {
    ok: true,
    config: {
      providerName: "twilio",
      provider: createTwilioSmsProvider(credentials.value, {
        statusCallbackUrl: env.TWILIO_STATUS_CALLBACK_URL,
      }),
      from: routing.value.from,
      via: routing.value.via,
    },
  };
}

/**
 * X-Twilio-Signature: base64 HMAC-SHA1, keyed on the account Auth Token, over
 * the full request URL with every POST parameter appended in key-sorted order.
 *
 * Keyed on the Auth Token specifically — an API Key secret cannot validate a
 * webhook, so TWILIO_AUTH_TOKEN is required for inbound even when sends use the
 * API key pair.
 */
export function twilioSignature(options: {
  url: string;
  params: Iterable<[string, string]>;
  authToken: string;
}): string {
  const sorted = [...options.params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const payload = sorted.reduce(
    (acc, [key, value]) => acc + key + value,
    options.url,
  );
  return createHmac("sha1", options.authToken).update(payload, "utf8").digest("base64");
}

export function verifyTwilioSignature(options: {
  url: string;
  params: Iterable<[string, string]>;
  authToken: string;
  signatureHeader: string | null;
}): boolean {
  const provided = options.signatureHeader?.trim();
  if (!provided) return false;
  const expected = twilioSignature(options);
  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(provided, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * The URL Twilio signed, which is the one configured in the console — not
 * necessarily the one this process sees. Vercel terminates TLS upstream, so
 * `request.url` can arrive as http and the HMAC would never match. An explicit
 * TWILIO_WEBHOOK_URL wins when set; otherwise trust the forwarded proto/host.
 */
export function twilioWebhookUrl(options: {
  requestUrl: string;
  forwardedProto?: string | null;
  forwardedHost?: string | null;
  configuredUrl?: string | null;
}): string {
  const configured = trim(options.configuredUrl ?? undefined);
  if (configured) return configured;

  const url = new URL(options.requestUrl);
  const proto = trim(options.forwardedProto ?? undefined).split(",")[0];
  const host = trim(options.forwardedHost ?? undefined).split(",")[0];
  if (proto) url.protocol = `${proto}:`;
  if (host) url.host = host;
  return url.toString();
}
