import { describe, expect, it } from "vitest";
import { discoverySourceStatus } from "./source-status";

describe("discoverySourceStatus", () => {
  it("always lists Apollo as on", () => {
    const sources = discoverySourceStatus("finance_accounting", {});
    expect(sources[0]).toMatchObject({
      id: "apollo",
      enabled: true,
      appliesToThisVertical: true,
    });
  });

  it("says Maps is off for Finance when the flag is unset", () => {
    const maps = discoverySourceStatus("finance_accounting", {})[1];
    expect(maps.enabled).toBe(false);
    expect(maps.appliesToThisVertical).toBe(false);
    expect(maps.reason).toMatch(/SERPAPI_DISCOVERY_ENABLED/);
  });

  it("says Maps does not apply to Finance even when the source is on", () => {
    const maps = discoverySourceStatus("finance_accounting", {
      SERPAPI_DISCOVERY_ENABLED: "true",
      SERPAPI_API_KEY: "k",
    })[1];
    expect(maps.enabled).toBe(true);
    expect(maps.appliesToThisVertical).toBe(false);
    expect(maps.reason).toMatch(/Construction and Legal/);
  });

  it("applies Maps to Construction when the source is on", () => {
    const maps = discoverySourceStatus("construction", {
      SERPAPI_DISCOVERY_ENABLED: "true",
      SERPAPI_API_KEY: "k",
    })[1];
    expect(maps.enabled).toBe(true);
    expect(maps.appliesToThisVertical).toBe(true);
    expect(maps.reason).toBeNull();
  });
});
