import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EgressDetails = { estimatedCost?: number };
type EgressArgs = [string, string, unknown, EgressDetails?];

const assertPaidEgressAllowed = vi.fn<(...args: EgressArgs) => Promise<void>>(
  async () => {},
);
const recordProviderUsageEvent = vi.fn(async () => {});

vi.mock("@/lib/paid-egress", () => ({
  assertPaidEgressAllowed,
  recordProviderUsageEvent,
}));

/**
 * A mobile reveal is charged 8x an email match against the daily guardrail.
 * Apollo can only deliver a phone through a webhook, so without one the call
 * goes out as a plain match — and charging 8 for it exhausts the day's budget
 * eight times faster while returning no phone at all.
 */
describe("Apollo people/match estimated cost", () => {
  const originalFetch = global.fetch;
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const originalCrmUrl = process.env.CRM_API_URL;
  const originalVercelUrl = process.env.VERCEL_URL;

  beforeEach(() => {
    vi.resetModules();
    assertPaidEgressAllowed.mockClear();
    recordProviderUsageEvent.mockClear();
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.CRM_API_URL;
    delete process.env.VERCEL_URL;
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ person: { id: "p1" } }),
      text: async () => "{}",
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    process.env.CRM_API_URL = originalCrmUrl;
    process.env.VERCEL_URL = originalVercelUrl;
    vi.restoreAllMocks();
  });

  async function callMatch(enrichPhone: boolean) {
    const { matchPerson } = await import("@/lib/apollo-enrich");
    await matchPerson("key", "person-1", enrichPhone, "manual_enrich:c1", "c1");
    return assertPaidEgressAllowed.mock.calls[0]?.[3];
  }

  it("charges 1 for an email-only match", async () => {
    expect((await callMatch(false))?.estimatedCost).toBe(1);
  });

  it("charges 8 when a phone reveal is genuinely requested", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    expect((await callMatch(true))?.estimatedCost).toBe(8);
  });

  it("charges 1, not 8, when no webhook makes a phone reveal impossible", async () => {
    expect((await callMatch(true))?.estimatedCost).toBe(1);
  });

  it("omits the reveal params entirely without a webhook", async () => {
    await callMatch(true);
    const url = String((global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
    expect(url).not.toContain("reveal_phone_number");
  });
});
