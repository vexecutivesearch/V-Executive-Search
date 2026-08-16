import { beforeEach, describe, expect, it, vi } from "vitest";

const insertValues = vi.fn(async () => undefined);
const where = vi.fn(async () => [{ total: 0 }]);

vi.mock("@/lib/db", () => ({
  db: {
    insert: vi.fn(() => ({ values: insertValues })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where })),
    })),
  },
}));

describe("paid egress guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PAID_EGRESS_ENABLED;
    delete process.env.APOLLO_EGRESS_ENABLED;
    delete process.env.APOLLO_PAID_EGRESS_ENABLED;
    delete process.env.CONTACTOUT_EGRESS_ENABLED;
    delete process.env.CONTACTOUT_PAID_EGRESS_ENABLED;
    delete process.env.APOLLO_DAILY_CREDIT_CAP;
    delete process.env.CONTACTOUT_DAILY_CREDIT_CAP;
  });

  it("blocks scheduled pipeline provider egress by default", async () => {
    const { assertPaidEgressAllowed, PaidEgressBlockedError } = await import(
      "@/lib/paid-egress"
    );

    await expect(
      assertPaidEgressAllowed(
        "apollo",
        "organizations/search",
        "scheduled_pipeline",
      ),
    ).rejects.toBeInstanceOf(PaidEgressBlockedError);

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "apollo",
        endpoint: "organizations/search",
        egressContext: "scheduled_pipeline",
        blocked: true,
      }),
    );
  });

  it("allows explicit manual enrich context under provider cap", async () => {
    const { assertPaidEgressAllowed } = await import("@/lib/paid-egress");

    await expect(
      assertPaidEgressAllowed(
        "contactout",
        "people/linkedin",
        "manual_enrich:company-1",
      ),
    ).resolves.toBeUndefined();
  });

  it("honors provider-specific egress disable aliases", async () => {
    process.env.APOLLO_EGRESS_ENABLED = "false";
    const { assertPaidEgressAllowed, PaidEgressBlockedError } = await import(
      "@/lib/paid-egress"
    );

    await expect(
      assertPaidEgressAllowed(
        "apollo",
        "people/match",
        "manual_enrich:company-1",
      ),
    ).rejects.toBeInstanceOf(PaidEgressBlockedError);
  });

  it("allows contactout manual enrich up to the 150-credit default cap", async () => {
    where.mockResolvedValueOnce([{ total: 149 }]);
    const { assertPaidEgressAllowed } = await import("@/lib/paid-egress");

    await expect(
      assertPaidEgressAllowed(
        "contactout",
        "people/linkedin",
        "manual_enrich:company-1",
      ),
    ).resolves.toBeUndefined();
  });

  it("blocks at the cap with an actionable message naming the guardrail", async () => {
    where.mockResolvedValueOnce([{ total: 150 }]);
    const { assertPaidEgressAllowed } = await import("@/lib/paid-egress");

    await expect(
      assertPaidEgressAllowed(
        "contactout",
        "people/linkedin",
        "manual_enrich:company-1",
      ),
    ).rejects.toThrow(
      /daily safety cap reached — 150\/150 .* not your contactout balance.*CONTACTOUT_DAILY_CREDIT_CAP/,
    );

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "contactout",
        blocked: true,
        estimatedCost: 0,
        metadata: expect.objectContaining({
          reason: "daily_cap_reached",
          cap: 150,
          usedToday: 150,
        }),
      }),
    );
  });

  /*
   * Apollo bills People Search at 0 credits, and discovery makes up to four
   * per company. Logging those at 1 each exhausted a day's budget on calls
   * that were never billed, so they must not count toward any cap — including
   * rows already written under the old accounting.
   */
  it("never counts Apollo search against the cap", async () => {
    const { endpointConsumesCredits } = await import("@/lib/paid-egress");
    expect(endpointConsumesCredits("apollo", "mixed_people/api_search")).toBe(
      false,
    );
  });

  it("still counts the endpoints that do bill", async () => {
    const { endpointConsumesCredits } = await import("@/lib/paid-egress");
    expect(endpointConsumesCredits("apollo", "people/match")).toBe(true);
    // Sent with reveal_info: true, so ContactOut bills per revealed profile.
    expect(endpointConsumesCredits("contactout", "people/search")).toBe(true);
    expect(endpointConsumesCredits("contactout", "people/linkedin")).toBe(true);
  });

  it("respects the CONTACTOUT_DAILY_CREDIT_CAP override", async () => {
    process.env.CONTACTOUT_DAILY_CREDIT_CAP = "500";
    where.mockResolvedValueOnce([{ total: 400 }]);
    const { assertPaidEgressAllowed } = await import("@/lib/paid-egress");

    await expect(
      assertPaidEgressAllowed(
        "contactout",
        "people/linkedin",
        "manual_enrich:company-1",
      ),
    ).resolves.toBeUndefined();
  });
});
