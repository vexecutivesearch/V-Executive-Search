import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No real egress: neutralize the gate/logging (they hit the DB) and stub fetch.
vi.mock("@/lib/paid-egress", () => ({
  assertPaidEgressAllowed: vi.fn(async () => {}),
  recordProviderUsageEvent: vi.fn(async () => {}),
}));

import { enrichFromContactOut } from "@/lib/contactout-enrich";

const PHONE_PAYLOAD = {
  profile: {
    phones: ["+1 561 555 0100"],
    personal_emails: [],
    work_emails: [],
  },
};

describe("ContactOut reveal waterfall", () => {
  const originalFetch = global.fetch;
  let calls: string[];

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function stubFetch(handler: (url: string) => { status: number; body?: unknown }) {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const result = handler(url);
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: async () => result.body ?? {},
        text: async () => JSON.stringify(result.body ?? {}),
      } as Response;
    }) as typeof fetch;
  }

  it("an email MISS does not abort the phone lookup (the 'phone not found' bug)", async () => {
    stubFetch((url) => {
      if (url.includes("email_type=personal%2Cwork")) return { status: 404 };
      if (url.includes("include_phone=true")) return { status: 200, body: PHONE_PAYLOAD };
      return { status: 500 };
    });

    const result = await enrichFromContactOut(
      "https://www.linkedin.com/in/test-person",
      "test-key",
      { needPersonalEmail: true, needWorkEmail: true, needPhone: true },
      "manual_enrich:test",
      "test",
    );

    expect(calls).toHaveLength(2); // email attempt + phone attempt
    expect(result).not.toBeNull();
    expect(result!.phones.length).toBeGreaterThan(0);
    expect(result!.personalPhone).toContain("561");
  });

  it("email miss with no phone requested stops after one call", async () => {
    stubFetch(() => ({ status: 404 }));

    const result = await enrichFromContactOut(
      "https://www.linkedin.com/in/test-person",
      "test-key",
      { needPersonalEmail: true, needWorkEmail: true, needPhone: false },
      "manual_enrich:test",
      "test",
    );

    expect(calls).toHaveLength(1);
    expect(result).toBeNull();
  });

  it("skips the email call entirely when only the phone is needed", async () => {
    stubFetch((url) => {
      if (url.includes("include_phone=true")) return { status: 200, body: PHONE_PAYLOAD };
      return { status: 500 };
    });

    const result = await enrichFromContactOut(
      "https://www.linkedin.com/in/test-person",
      "test-key",
      { needPersonalEmail: false, needWorkEmail: false, needPhone: true },
      "manual_enrich:test",
      "test",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("include_phone=true");
    expect(result!.phones.length).toBeGreaterThan(0);
  });
});
