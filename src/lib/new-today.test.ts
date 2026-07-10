import { describe, expect, it } from "vitest";
import { isNewToday } from "@/lib/new-today";

describe("isNewToday", () => {
  it("matches company first_seen on list date", () => {
    expect(
      isNewToday({
        companyFirstSeen: "2026-07-10",
        listDate: "2026-07-10",
      }),
    ).toBe(true);
  });

  it("matches a listing first seen today even if company is older", () => {
    expect(
      isNewToday({
        companyFirstSeen: "2026-07-01",
        listDate: "2026-07-10",
        listings: [{ firstSeenAt: "2026-07-10" }],
      }),
    ).toBe(true);
  });

  it("is false when nothing is new on list date", () => {
    expect(
      isNewToday({
        companyFirstSeen: "2026-07-01",
        listDate: "2026-07-10",
        listings: [{ firstSeenAt: "2026-07-08" }],
      }),
    ).toBe(false);
  });
});
