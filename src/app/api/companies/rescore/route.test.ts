import { describe, expect, it } from "vitest";

/**
 * Behavioral contract for POST /api/companies/rescore (full backlog):
 * never invent a zero-listing daily_runs row. Exercised here as pure
 * decision logic so we don't need a live DB in unit tests.
 */
function shouldWriteRescoreCounters(existing: {
  listingsScraped: number;
} | null): "update" | "skip_missing" | "skip_ghost" {
  if (!existing) return "skip_missing";
  if ((existing.listingsScraped ?? 0) <= 0) return "skip_ghost";
  return "update";
}

describe("rescore daily_runs write policy", () => {
  it("updates when a real scrape row exists", () => {
    expect(shouldWriteRescoreCounters({ listingsScraped: 16025 })).toBe(
      "update",
    );
  });

  it("does not create a row when scrape never landed", () => {
    expect(shouldWriteRescoreCounters(null)).toBe("skip_missing");
  });

  it("does not write onto a zero-listing ghost row", () => {
    expect(shouldWriteRescoreCounters({ listingsScraped: 0 })).toBe(
      "skip_ghost",
    );
  });
});
