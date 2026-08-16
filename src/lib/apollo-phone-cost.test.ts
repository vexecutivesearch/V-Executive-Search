import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EgressDetails = { estimatedCost?: number };
type EgressArgs = [string, string, unknown, EgressDetails?];

const assertPaidEgressAllowed = vi.fn<(...args: EgressArgs) => Promise<void>>(
  async () => {},
);
const recordProviderUsageEvent = vi.fn<(...args: EgressArgs) => Promise<void>>(
  async () => {},
);

vi.mock("@/lib/paid-egress", () => ({
  assertPaidEgressAllowed,
  recordProviderUsageEvent,
}));

/**
 * The daily guardrail must count what Apollo actually bills, or it fires long
 * before real spend justifies it. Apollo's published model:
 *   People API Search .. 0 credits
 *   People Enrichment .. 0 if nothing found, 1 for demographics/email,
 *                        +8 only if a mobile is returned
 * https://docs.apollo.io/docs/api-pricing
 */
describe("Apollo credit accounting", () => {
  const originalFetch = global.fetch;
  const savedEnv = {
    app: process.env.NEXT_PUBLIC_APP_URL,
    crm: process.env.CRM_API_URL,
    vercel: process.env.VERCEL_URL,
  };

  function stubFetch(body: unknown) {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })) as unknown as typeof fetch;
  }

  beforeEach(() => {
    vi.resetModules();
    assertPaidEgressAllowed.mockClear();
    recordProviderUsageEvent.mockClear();
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.CRM_API_URL;
    delete process.env.VERCEL_URL;
    stubFetch({ person: { id: "p1" } });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.NEXT_PUBLIC_APP_URL = savedEnv.app;
    process.env.CRM_API_URL = savedEnv.crm;
    process.env.VERCEL_URL = savedEnv.vercel;
    vi.restoreAllMocks();
  });

  const reserved = () => assertPaidEgressAllowed.mock.calls[0]?.[3]?.estimatedCost;
  const booked = () => recordProviderUsageEvent.mock.calls[0]?.[3]?.estimatedCost;

  async function match(enrichPhone: boolean) {
    const { matchPerson } = await import("@/lib/apollo-enrich");
    return matchPerson("key", "person-1", enrichPhone, "manual_enrich:c1", "c1");
  }

  it("charges nothing for a search — Apollo bills 0 credits for it", async () => {
    stubFetch({ people: [{ id: "a" }, { id: "b" }] });
    const { searchPeople } = await import("@/lib/apollo-enrich");
    await searchPeople("key", "acme.com", 10, undefined, [], [], "manual_enrich:c1", "c1");

    expect(reserved()).toBe(0);
    expect(booked()).toBe(0);
  });

  it("books 1 for an email-only match that found somebody", async () => {
    await match(false);
    expect(reserved()).toBe(1);
    expect(booked()).toBe(1);
  });

  it("books nothing when Apollo found nobody", async () => {
    stubFetch({});
    await match(false);
    // Reserved up front, but Apollo bills 0 for an empty match, so we do too.
    expect(reserved()).toBe(1);
    expect(booked()).toBe(0);
  });

  it("reserves the full 9 up front when a mobile is genuinely requested", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    await match(true);
    expect(reserved()).toBe(9);
  });

  /*
   * The mobile surcharge is settled by the phone webhook, because that is the
   * only place we learn whether a number actually came back. Booking it at
   * request time would charge 8 for every reveal that returns nothing.
   */
  it("does not book the mobile surcharge at request time", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    await match(true);
    expect(booked()).toBe(1);
    expect(recordProviderUsageEvent.mock.calls[0]?.[3]).toMatchObject({
      metadata: { mobile_surcharge_pending: true },
    });
  });

  it("cannot request a mobile without a webhook, so charges the plain rate", async () => {
    await match(true);
    expect(reserved()).toBe(1);
    expect(booked()).toBe(1);

    const url = String(
      (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0],
    );
    expect(url).not.toContain("reveal_phone_number");
  });
});
