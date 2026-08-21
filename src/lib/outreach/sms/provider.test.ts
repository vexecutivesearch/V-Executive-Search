import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSmsProvider, sendSms, smsFlagOn } from "@/lib/outreach/sms/provider";

/**
 * The integration is built but must not send: the A2P 10DLC brand and campaign
 * are unregistered, and carriers drop unregistered traffic. So credentials
 * alone must never be enough — every path here checks that a fully configured
 * environment with the flag off still makes zero network calls.
 */

const CREDENTIALED = {
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000001",
  TWILIO_API_KEY_SID: "SK00000000000000000000000000000002",
  TWILIO_API_KEY_SECRET: "key-secret",
  TWILIO_MESSAGING_SERVICE_SID: "MG0000000000000000000000000000003",
};

afterEach(() => {
  vi.restoreAllMocks();
});

function noFetch() {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("the enable flag", () => {
  it("is off unless set to exactly true", () => {
    expect(smsFlagOn({})).toBe(false);
    expect(smsFlagOn({ OUTREACH_SMS_ENABLED: "" })).toBe(false);
    expect(smsFlagOn({ OUTREACH_SMS_ENABLED: "1" })).toBe(false);
    expect(smsFlagOn({ OUTREACH_SMS_ENABLED: "yes" })).toBe(false);
    expect(smsFlagOn({ OUTREACH_SMS_ENABLED: "false" })).toBe(false);
    expect(smsFlagOn({ OUTREACH_SMS_ENABLED: "true" })).toBe(true);
    expect(smsFlagOn({ OUTREACH_SMS_ENABLED: " TRUE " })).toBe(true);
  });
});

describe("with the flag off", () => {
  it("resolves to disabled even with complete credentials", async () => {
    const resolution = await resolveSmsProvider(CREDENTIALED);
    expect(resolution.enabled).toBe(false);
    if (resolution.enabled) return;
    expect(resolution.reason).toContain("OUTREACH_SMS_ENABLED");
  });

  it("refuses to send, without touching the network", async () => {
    const fetchMock = noFetch();
    const result = await sendSms(
      { to: "+15615550123", body: "hello" },
      CREDENTIALED,
    );
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("with the flag on", () => {
  const enabled = { ...CREDENTIALED, OUTREACH_SMS_ENABLED: "true" };

  it("resolves the Twilio provider and its messaging-service identity", async () => {
    const resolution = await resolveSmsProvider(enabled);
    expect(resolution.enabled).toBe(true);
    if (!resolution.enabled) return;
    expect(resolution.config.providerName).toBe("twilio");
    expect(resolution.config.via).toBe("messaging_service");
    expect(resolution.config.from).toBe(CREDENTIALED.TWILIO_MESSAGING_SERVICE_SID);
  });

  it("still refuses when credentials are incomplete", async () => {
    const resolution = await resolveSmsProvider({ OUTREACH_SMS_ENABLED: "true" });
    expect(resolution.enabled).toBe(false);
    if (resolution.enabled) return;
    expect(resolution.reason).toContain("TWILIO_ACCOUNT_SID");
  });

  it("defaults the from to the configured sending identity", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ sid: "SM777" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendSms({ to: "+15615550123", body: "hello" }, enabled);
    expect(result).toEqual({ ok: true, providerMessageId: "SM777" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).get("MessagingServiceSid")).toBe(
      CREDENTIALED.TWILIO_MESSAGING_SERVICE_SID,
    );
  });

  it("rejects an unknown provider rather than guessing", async () => {
    const resolution = await resolveSmsProvider({ ...enabled, SMS_PROVIDER: "bandwidth" });
    expect(resolution.enabled).toBe(false);
    if (resolution.enabled) return;
    expect(resolution.reason).toContain("bandwidth");
  });
});
