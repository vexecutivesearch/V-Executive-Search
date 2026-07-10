import { describe, expect, it } from "vitest";
import { TARGET_TITLES } from "@/lib/enrichment-config";
import { normalizeContactTitles } from "@/lib/pipeline-config";

describe("normalizeContactTitles", () => {
  it("falls back to enrichment defaults when empty", () => {
    expect(normalizeContactTitles([])).toEqual([...TARGET_TITLES]);
    expect(normalizeContactTitles(null)).toEqual([...TARGET_TITLES]);
  });

  it("keeps configured contact titles", () => {
    expect(normalizeContactTitles(["HR Director", "VP People"])).toEqual([
      "HR Director",
      "VP People",
    ]);
  });
});
