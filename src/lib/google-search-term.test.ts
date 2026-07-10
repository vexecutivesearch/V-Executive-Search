import { describe, expect, it } from "vitest";
import {
  formatBoardLocation,
  googleSearchTerm,
} from "@/lib/pipeline-config";

describe("googleSearchTerm (broad market scan)", () => {
  it("builds all-roles NL query with FL + last week", () => {
    expect(googleSearchTerm(" ", "West Palm Beach, FL", 168)).toBe(
      "jobs near West Palm Beach, FL posted in the last week",
    );
  });

  it("builds bucket NL query — not contact titles", () => {
    expect(googleSearchTerm("manager", "Boca Raton, FL", 168)).toBe(
      "manager jobs near Boca Raton, FL posted in the last week",
    );
  });

  it("uses yesterday window only for ≤24h", () => {
    expect(googleSearchTerm("", "Miami, FL", 24)).toBe(
      "jobs near Miami, FL posted since yesterday",
    );
  });
});

describe("formatBoardLocation", () => {
  it("uses FL abbreviation", () => {
    expect(formatBoardLocation("West Palm Beach", "Florida")).toBe(
      "West Palm Beach, FL",
    );
  });
});
