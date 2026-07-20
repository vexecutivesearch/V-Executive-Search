import { afterEach, describe, expect, it } from "vitest";
import { serpapiPeriodStart, serpapiPlanConfig } from "@/lib/serpapi-usage";

describe("serpapiPeriodStart (plan renews on the renewal day)", () => {
  it("uses this month's renewal day on/after it", () => {
    expect(
      serpapiPeriodStart(11, new Date("2026-07-11T12:00:00Z")).toISOString(),
    ).toBe("2026-07-11T00:00:00.000Z");
    expect(
      serpapiPeriodStart(11, new Date("2026-07-19T12:00:00Z")).toISOString(),
    ).toBe("2026-07-11T00:00:00.000Z");
  });

  it("uses last month's renewal day before it", () => {
    expect(
      serpapiPeriodStart(11, new Date("2026-07-10T12:00:00Z")).toISOString(),
    ).toBe("2026-06-11T00:00:00.000Z");
  });

  it("wraps into the previous year in January", () => {
    expect(
      serpapiPeriodStart(11, new Date("2026-01-05T12:00:00Z")).toISOString(),
    ).toBe("2025-12-11T00:00:00.000Z");
  });
});

describe("serpapiPlanConfig (every knob config-driven)", () => {
  afterEach(() => {
    delete process.env.SERPAPI_MONTHLY_PLAN;
    delete process.env.SERPAPI_BUDGET_PCT;
  });

  it("defaults match the Production plan + plan doc", () => {
    const config = serpapiPlanConfig();
    expect(config.monthlyPlan).toBe(15000);
    expect(config.budgetPct).toBe(0.8);
    expect(config.renewalDay).toBe(11);
    expect(config.runCap).toBe(200);
    expect(config.pageMinYield).toBe(0.3);
    expect(config.maxPages).toBe(5);
    expect(config.maxPagesCold).toBe(10);
    expect(config.adaptiveEnabled).toBe(true);
    expect(config.adaptiveEmptyRuns).toBe(3);
  });

  it("env overrides win", () => {
    process.env.SERPAPI_MONTHLY_PLAN = "5000";
    process.env.SERPAPI_BUDGET_PCT = "0.5";
    const config = serpapiPlanConfig();
    expect(config.monthlyPlan).toBe(5000);
    expect(config.budgetPct).toBe(0.5);
  });
});
