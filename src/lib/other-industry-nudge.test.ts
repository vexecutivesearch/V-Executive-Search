import { describe, expect, it } from "vitest";
import { OTHER_SECTOR, sectorFromIndustry } from "@/lib/industry-sectors";

/** Mirrors filter-options Other collection — keep the nudge logic testable. */
function collectOtherLabels(rawIndustries: string[]): string[] {
  const otherByKey = new Map<string, string>();
  for (const raw of rawIndustries) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (sectorFromIndustry(trimmed) !== OTHER_SECTOR) continue;
    const key = trimmed.toLowerCase().replace(/\s+/g, " ");
    if (!otherByKey.has(key)) otherByKey.set(key, trimmed);
  }
  return [...otherByKey.values()].sort((a, b) => a.localeCompare(b));
}

describe("Other industry map nudge", () => {
  it("counts distinct unmapped labels", () => {
    const labels = collectOtherLabels([
      "hospital & health care",
      "brand new apollo niche",
      "Brand New Apollo Niche",
      "another mystery vertical",
    ]);
    expect(labels).toEqual([
      "another mystery vertical",
      "brand new apollo niche",
    ]);
    expect(`Other (${labels.length})`).toBe("Other (2)");
  });

  it("is empty when everything is mapped", () => {
    expect(
      collectOtherLabels(["banking", "retail", "construction"]),
    ).toEqual([]);
  });
});
