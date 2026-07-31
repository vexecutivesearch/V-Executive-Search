import { describe, expect, it } from "vitest";
import { businessDayStartUtc } from "@/lib/timezone";

describe("businessDayStartUtc", () => {
  it("returns midnight ET (EDT, UTC-4) for a summer instant", () => {
    // 2026-07-23 14:00 UTC = 10:00 AM ET → business day started 04:00 UTC.
    const now = new Date("2026-07-23T14:00:00Z");
    expect(businessDayStartUtc(now).toISOString()).toBe(
      "2026-07-23T04:00:00.000Z",
    );
  });

  it("keeps late-evening ET usage on the same business day", () => {
    // 2026-07-23 01:30 UTC = 9:30 PM ET Jul 22 — still business day Jul 22.
    const now = new Date("2026-07-23T01:30:00Z");
    expect(businessDayStartUtc(now).toISOString()).toBe(
      "2026-07-22T04:00:00.000Z",
    );
  });

  it("returns midnight ET (EST, UTC-5) for a winter instant", () => {
    // 2026-01-15 14:00 UTC = 9:00 AM ET → business day started 05:00 UTC.
    const now = new Date("2026-01-15T14:00:00Z");
    expect(businessDayStartUtc(now).toISOString()).toBe(
      "2026-01-15T05:00:00.000Z",
    );
  });
});
