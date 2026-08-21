import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyTwilioFailure,
  createTwilioSmsProvider,
  resolveTwilioCredentials,
  resolveTwilioRouting,
  TWILIO_ERROR_CARRIER_FILTERED,
  TWILIO_ERROR_OPTED_OUT,
  twilioSignature,
  twilioWebhookUrl,
  verifyTwilioSignature,
} from "@/lib/outreach/sms/twilio";

/**
 * The Twilio transport, exercised without the network.
 *
 * Two of these are compliance rather than plumbing: a carrier-filtered or
 * opted-out message that gets retried in a loop is how a 10DLC campaign is
 * suspended, and an unverifiable webhook signature is a write path into the
 * inbound pipeline for anyone who knows the URL.
 */

const ACCOUNT = "AC00000000000000000000000000000001";
const KEY_SID = "SK00000000000000000000000000000002";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("credential resolution", () => {
  it("prefers the API key pair over the account auth token", () => {
    const resolved = resolveTwilioCredentials({
      TWILIO_ACCOUNT_SID: ACCOUNT,
      TWILIO_API_KEY_SID: KEY_SID,
      TWILIO_API_KEY_SECRET: "key-secret",
      TWILIO_AUTH_TOKEN: "root-auth-token",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.authKind).toBe("api_key");
    expect(resolved.value.username).toBe(KEY_SID);
    expect(resolved.value.password).toBe("key-secret");
    // The account SID still addresses the resource even under key auth.
    expect(resolved.value.accountSid).toBe(ACCOUNT);
  });

  it("falls back to the auth token when no key pair is set", () => {
    const resolved = resolveTwilioCredentials({
      TWILIO_ACCOUNT_SID: ACCOUNT,
      TWILIO_AUTH_TOKEN: "root-auth-token",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.authKind).toBe("auth_token");
    expect(resolved.value.username).toBe(ACCOUNT);
  });

  it("refuses a half-configured key pair instead of downgrading silently", () => {
    const resolved = resolveTwilioCredentials({
      TWILIO_ACCOUNT_SID: ACCOUNT,
      TWILIO_API_KEY_SID: KEY_SID,
      TWILIO_AUTH_TOKEN: "root-auth-token",
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("TWILIO_API_KEY_SECRET");
  });

  it("reports missing credentials rather than throwing", () => {
    expect(resolveTwilioCredentials({}).ok).toBe(false);
    expect(resolveTwilioCredentials({ TWILIO_ACCOUNT_SID: ACCOUNT }).ok).toBe(false);
  });

  it("rejects identifiers pasted into the wrong variable", () => {
    const swapped = resolveTwilioCredentials({
      TWILIO_ACCOUNT_SID: KEY_SID,
      TWILIO_AUTH_TOKEN: "root-auth-token",
    });
    expect(swapped.ok).toBe(false);
  });
});

describe("routing", () => {
  it("sends through the messaging service when one is configured", () => {
    const routing = resolveTwilioRouting({
      TWILIO_MESSAGING_SERVICE_SID: "MG0000000000000000000000000000003",
      TWILIO_FROM_NUMBER: "+15615550123",
    });
    expect(routing.ok).toBe(true);
    if (!routing.ok) return;
    // The A2P campaign hangs off the service, not the number.
    expect(routing.value.via).toBe("messaging_service");
    expect(routing.value.from).toBe("MG0000000000000000000000000000003");
  });

  it("falls back to a bare E.164 number", () => {
    const routing = resolveTwilioRouting({ TWILIO_FROM_NUMBER: "+15615550123" });
    expect(routing.ok).toBe(true);
    if (!routing.ok) return;
    expect(routing.value).toEqual({ from: "+15615550123", via: "number" });
  });

  it("rejects a non-E.164 number and a missing identity", () => {
    expect(resolveTwilioRouting({ TWILIO_FROM_NUMBER: "561-555-0123" }).ok).toBe(false);
    expect(resolveTwilioRouting({}).ok).toBe(false);
  });
});

describe("failure classification", () => {
  it("never retries an opted-out recipient", () => {
    const failure = classifyTwilioFailure({
      httpStatus: 400,
      code: TWILIO_ERROR_OPTED_OUT,
      message: "Attempt to send to unsubscribed recipient",
    });
    expect(failure.retryable).toBe(false);
    expect(failure.optedOut).toBe(true);
  });

  it("never retries a carrier-filtered message", () => {
    const failure = classifyTwilioFailure({
      httpStatus: 400,
      code: TWILIO_ERROR_CARRIER_FILTERED,
      message: "Message filtered",
    });
    expect(failure.retryable).toBe(false);
    expect(failure.carrierFiltered).toBe(true);
  });

  it("never retries bad auth", () => {
    expect(classifyTwilioFailure({ httpStatus: 401, code: 20003 }).retryable).toBe(false);
  });

  it("retries rate limits and server errors", () => {
    expect(classifyTwilioFailure({ httpStatus: 429 }).retryable).toBe(true);
    expect(classifyTwilioFailure({ httpStatus: 500 }).retryable).toBe(true);
    expect(classifyTwilioFailure({ httpStatus: 503 }).retryable).toBe(true);
  });

  it("treats an unrecognised 4xx as permanent", () => {
    expect(classifyTwilioFailure({ httpStatus: 400, code: 21211 }).retryable).toBe(false);
  });
});

describe("send", () => {
  const credentials = {
    accountSid: ACCOUNT,
    username: KEY_SID,
    password: "key-secret",
    authKind: "api_key" as const,
  };

  function stubFetch(status: number, body: unknown) {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(body), { status }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("posts MessagingServiceSid when the from is a service SID", async () => {
    const fetchMock = stubFetch(201, { sid: "SM123", status: "queued" });
    const result = await createTwilioSmsProvider(credentials).send({
      to: "+15615550123",
      from: "MG0000000000000000000000000000003",
      body: "hello",
    });

    expect(result).toEqual({ ok: true, providerMessageId: "SM123" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/Accounts/${ACCOUNT}/Messages.json`);
    const sent = new URLSearchParams(String(init.body));
    expect(sent.get("MessagingServiceSid")).toBe("MG0000000000000000000000000000003");
    expect(sent.get("From")).toBeNull();
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(Buffer.from(auth.replace("Basic ", ""), "base64").toString()).toBe(
      `${KEY_SID}:key-secret`,
    );
  });

  it("posts From when the from is a plain number", async () => {
    const fetchMock = stubFetch(201, { sid: "SM124" });
    await createTwilioSmsProvider(credentials).send({
      to: "+15615550123",
      from: "+15615550999",
      body: "hello",
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = new URLSearchParams(String(init.body));
    expect(sent.get("From")).toBe("+15615550999");
    expect(sent.get("MessagingServiceSid")).toBeNull();
  });

  it("surfaces a 429 as retryable and a 21610 as permanent", async () => {
    stubFetch(429, { code: 20429, message: "Too Many Requests" });
    const rateLimited = await createTwilioSmsProvider(credentials).send({
      to: "+15615550123",
      from: "+15615550999",
      body: "hello",
    });
    expect(rateLimited).toMatchObject({ ok: false, retryable: true });

    stubFetch(400, { code: TWILIO_ERROR_OPTED_OUT, message: "unsubscribed recipient" });
    const optedOut = await createTwilioSmsProvider(credentials).send({
      to: "+15615550123",
      from: "+15615550999",
      body: "hello",
    });
    expect(optedOut).toMatchObject({ ok: false, retryable: false });
  });

  it("treats a transport error as retryable — nothing reached Twilio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    const result = await createTwilioSmsProvider(credentials).send({
      to: "+15615550123",
      from: "+15615550999",
      body: "hello",
    });
    expect(result).toEqual({ ok: false, error: "ECONNRESET", retryable: true });
  });

  it("fails when Twilio returns 2xx without a sid", async () => {
    stubFetch(201, { status: "queued" });
    const result = await createTwilioSmsProvider(credentials).send({
      to: "+15615550123",
      from: "+15615550999",
      body: "hello",
    });
    expect(result).toMatchObject({ ok: false, retryable: false });
  });
});

describe("webhook signature", () => {
  const url = "https://crm.example.com/api/webhooks/twilio";
  const token = "the-account-auth-token";
  const params = new URLSearchParams({
    MessageSid: "SM9",
    From: "+15615550123",
    Body: "sounds good",
    To: "+15615550999",
  });

  it("matches Twilio's documented construction (url + key-sorted params, HMAC-SHA1)", () => {
    const expected = createHmac("sha1", token)
      .update(
        url +
          [...params]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .reduce((acc, [k, v]) => acc + k + v, ""),
        "utf8",
      )
      .digest("base64");
    expect(twilioSignature({ url, params, authToken: token })).toBe(expected);
  });

  it("accepts a correctly signed request", () => {
    const signature = twilioSignature({ url, params, authToken: token });
    expect(
      verifyTwilioSignature({ url, params, authToken: token, signatureHeader: signature }),
    ).toBe(true);
  });

  it("rejects an unsigned request", () => {
    expect(
      verifyTwilioSignature({ url, params, authToken: token, signatureHeader: null }),
    ).toBe(false);
    expect(
      verifyTwilioSignature({ url, params, authToken: token, signatureHeader: "  " }),
    ).toBe(false);
  });

  it("rejects a wrongly-signed request", () => {
    const wrongKey = twilioSignature({ url, params, authToken: "not-the-token" });
    expect(
      verifyTwilioSignature({ url, params, authToken: token, signatureHeader: wrongKey }),
    ).toBe(false);
  });

  it("rejects a signature computed over tampered params", () => {
    const signature = twilioSignature({ url, params, authToken: token });
    const tampered = new URLSearchParams(params);
    tampered.set("Body", "STOP");
    expect(
      verifyTwilioSignature({
        url,
        params: tampered,
        authToken: token,
        signatureHeader: signature,
      }),
    ).toBe(false);
  });

  it("rejects a signature computed over a different URL", () => {
    const signature = twilioSignature({
      url: "https://evil.example.com/api/webhooks/twilio",
      params,
      authToken: token,
    });
    expect(
      verifyTwilioSignature({ url, params, authToken: token, signatureHeader: signature }),
    ).toBe(false);
  });
});

describe("the URL Twilio actually signed", () => {
  it("uses the forwarded proto/host, because TLS terminates upstream", () => {
    expect(
      twilioWebhookUrl({
        requestUrl: "http://10.0.0.7/api/webhooks/twilio",
        forwardedProto: "https",
        forwardedHost: "crm.example.com",
      }),
    ).toBe("https://crm.example.com/api/webhooks/twilio");
  });

  it("takes the first hop of a comma-joined forwarded header", () => {
    expect(
      twilioWebhookUrl({
        requestUrl: "http://10.0.0.7/api/webhooks/twilio",
        forwardedProto: "https,http",
        forwardedHost: "crm.example.com,internal",
      }),
    ).toBe("https://crm.example.com/api/webhooks/twilio");
  });

  it("lets an explicit configured URL win", () => {
    expect(
      twilioWebhookUrl({
        requestUrl: "http://10.0.0.7/api/webhooks/twilio",
        forwardedProto: "https",
        forwardedHost: "crm.example.com",
        configuredUrl: "https://exact.example.com/api/webhooks/twilio",
      }),
    ).toBe("https://exact.example.com/api/webhooks/twilio");
  });
});
