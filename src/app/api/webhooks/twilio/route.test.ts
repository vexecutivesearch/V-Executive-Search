import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { twilioSignature } from "@/lib/outreach/sms/twilio";

/**
 * The public edge of the Twilio integration. This endpoint writes into the
 * inbound pipeline and the suppression list, so an unverified POST is an
 * injection vector: anyone who learns the URL could forge a reply, or a STOP
 * that silences a live prospect. Nothing here may run before the signature
 * checks out — including when the signing token is simply missing.
 */

type WebhookModule = typeof import("@/lib/outreach/sms/webhook");

const handleTwilioInbound = vi.fn<WebhookModule["handleTwilioInbound"]>();
const handleTwilioStatus = vi.fn<WebhookModule["handleTwilioStatus"]>();

vi.mock("@/lib/outreach/sms/webhook", async (importOriginal) => {
  const actual = await importOriginal<WebhookModule>();
  return {
    ...actual,
    handleTwilioInbound: (...args: Parameters<WebhookModule["handleTwilioInbound"]>) =>
      handleTwilioInbound(...args),
    handleTwilioStatus: (...args: Parameters<WebhookModule["handleTwilioStatus"]>) =>
      handleTwilioStatus(...args),
  };
});

const URL_SIGNED = "https://crm.example.com/api/webhooks/twilio";
const TOKEN = "the-account-auth-token";

const INBOUND = new URLSearchParams({
  MessageSid: "SM40",
  SmsStatus: "received",
  From: "+15615550123",
  To: "+15615550999",
  Body: "sounds good",
  NumMedia: "0",
});

async function post(options: {
  params: URLSearchParams;
  signature?: string | null;
}) {
  const { NextRequest } = await import("next/server");
  const { POST } = await import("@/app/api/webhooks/twilio/route");
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (options.signature) headers["x-twilio-signature"] = options.signature;
  const request = new NextRequest(URL_SIGNED, {
    method: "POST",
    body: options.params.toString(),
    headers,
  });
  return POST(request);
}

const signed = (params: URLSearchParams) =>
  twilioSignature({ url: URL_SIGNED, params, authToken: TOKEN });

beforeEach(() => {
  vi.clearAllMocks();
  handleTwilioInbound.mockResolvedValue({
    handled: "inbound",
    inboundId: "inbound-1",
    duplicate: false,
    matched: true,
    optOut: false,
    suppressed: false,
  });
  handleTwilioStatus.mockResolvedValue({
    handled: "status",
    messageId: "msg-1",
    status: "delivered",
    applied: "delivered",
  });
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  process.env.TWILIO_WEBHOOK_URL = URL_SIGNED;
});

afterEach(() => {
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_WEBHOOK_URL;
});

describe("POST /api/webhooks/twilio", () => {
  it("rejects an unsigned request", async () => {
    const response = await post({ params: INBOUND });
    expect(response.status).toBe(401);
    expect(handleTwilioInbound).not.toHaveBeenCalled();
  });

  it("rejects a wrongly-signed request", async () => {
    const response = await post({
      params: INBOUND,
      signature: twilioSignature({
        url: URL_SIGNED,
        params: INBOUND,
        authToken: "not-the-token",
      }),
    });
    expect(response.status).toBe(401);
    expect(handleTwilioInbound).not.toHaveBeenCalled();
  });

  it("rejects a signature that does not cover the posted body", async () => {
    const tampered = new URLSearchParams(INBOUND);
    tampered.set("Body", "STOP");
    const response = await post({ params: tampered, signature: signed(INBOUND) });
    expect(response.status).toBe(401);
    expect(handleTwilioInbound).not.toHaveBeenCalled();
  });

  it("rejects everything while the signing token is unset", async () => {
    // A missing secret must fail closed — accepting unsigned traffic here would
    // be worse than being down.
    delete process.env.TWILIO_AUTH_TOKEN;
    const response = await post({ params: INBOUND, signature: signed(INBOUND) });
    expect(response.status).toBe(401);
    expect(handleTwilioInbound).not.toHaveBeenCalled();
  });

  it("routes a correctly signed inbound to the ingest handler", async () => {
    const response = await post({ params: INBOUND, signature: signed(INBOUND) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, handled: "inbound" });
    expect(handleTwilioInbound).toHaveBeenCalledTimes(1);
    expect(handleTwilioInbound.mock.calls[0][0]).toMatchObject({
      messageSid: "SM40",
      from: "+15615550123",
      body: "sounds good",
    });
    expect(handleTwilioStatus).not.toHaveBeenCalled();
  });

  it("routes a correctly signed status callback to the status handler", async () => {
    const params = new URLSearchParams({
      MessageSid: "SM41",
      MessageStatus: "delivered",
      To: "+15615550123",
    });
    const response = await post({ params, signature: signed(params) });
    expect(response.status).toBe(200);
    expect(handleTwilioStatus).toHaveBeenCalledTimes(1);
    expect(handleTwilioInbound).not.toHaveBeenCalled();
  });

  it("ignores a signed payload it does not recognise", async () => {
    const params = new URLSearchParams({ Hello: "world" });
    const response = await post({ params, signature: signed(params) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ignored: "no MessageSid" });
    expect(handleTwilioInbound).not.toHaveBeenCalled();
    expect(handleTwilioStatus).not.toHaveBeenCalled();
  });
});
