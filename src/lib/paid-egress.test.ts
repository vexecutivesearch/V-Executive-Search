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
});
