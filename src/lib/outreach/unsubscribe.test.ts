import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildUnsubscribeUrl,
  unsubscribeToken,
  verifyUnsubscribeToken,
} from "@/lib/outreach/unsubscribe";
import { sendOutreachEmail } from "@/lib/outreach/resend-send";

describe("unsubscribe tokens", () => {
  beforeEach(() => {
    vi.stubEnv("OUTREACH_UNSUBSCRIBE_SECRET", "test-secret");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.com");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips for the same normalized address", () => {
    const token = unsubscribeToken("Max@BellSouth.net")!;
    expect(verifyUnsubscribeToken("max@bellsouth.net", token)).toBe(true);
  });

  it("rejects a token minted for a different address", () => {
    const token = unsubscribeToken("someone@else.com")!;
    expect(verifyUnsubscribeToken("max@bellsouth.net", token)).toBe(false);
  });

  it("rejects tampered tokens", () => {
    const token = unsubscribeToken("max@bellsouth.net")!;
    expect(verifyUnsubscribeToken("max@bellsouth.net", `${token}00`)).toBe(
      false,
    );
    expect(verifyUnsubscribeToken("max@bellsouth.net", "")).toBe(false);
  });

  it("builds an absolute URL with email + token", () => {
    const url = buildUnsubscribeUrl("max@bellsouth.net")!;
    expect(url).toMatch(
      /^https:\/\/crm\.example\.com\/api\/unsubscribe\?email=max%40bellsouth\.net&token=[0-9a-f]{64}$/,
    );
  });

  it("returns null without a secret rather than an unverifiable link", () => {
    vi.stubEnv("OUTREACH_UNSUBSCRIBE_SECRET", "");
    vi.stubEnv("WORKER_API_KEY", "");
    expect(buildUnsubscribeUrl("max@bellsouth.net")).toBeNull();
  });
});

describe("sendOutreachEmail List-Unsubscribe headers", () => {
  it("sends RFC 8058 headers when an unsubscribe URL is provided", async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        headers: Record<string, string>;
      };
      calls.push({ headers: body.headers });
      return new Response(JSON.stringify({ id: "re_123" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await sendOutreachEmail({
        apiKey: "k",
        from: "odv@vexecsearch.com",
        to: "max@bellsouth.net",
        replyTo: "odv@vexecutivesearch.com",
        subject: "s",
        textBody: "b",
        unsubscribeUrl:
          "https://crm.example.com/api/unsubscribe?email=max%40bellsouth.net&token=abc",
      });
      expect(result.ok).toBe(true);
      const headers = calls[0]!.headers;
      expect(headers["List-Unsubscribe"]).toBe(
        "<mailto:odv@vexecutivesearch.com?subject=unsubscribe>, <https://crm.example.com/api/unsubscribe?email=max%40bellsouth.net&token=abc>",
      );
      expect(headers["List-Unsubscribe-Post"]).toBe(
        "List-Unsubscribe=One-Click",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("omits the headers when no unsubscribe URL is available", async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        headers: Record<string, string>;
      };
      calls.push({ headers: body.headers });
      return new Response(JSON.stringify({ id: "re_123" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await sendOutreachEmail({
        apiKey: "k",
        from: "odv@vexecsearch.com",
        to: "max@bellsouth.net",
        subject: "s",
        textBody: "b",
      });
      expect(calls[0]!.headers["List-Unsubscribe"]).toBeUndefined();
      expect(calls[0]!.headers["List-Unsubscribe-Post"]).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
