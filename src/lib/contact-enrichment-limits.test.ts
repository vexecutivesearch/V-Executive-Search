import { describe, expect, it } from "vitest";
import {
  getContactOutEnrichNeeds,
  normalizeContactChannels,
} from "@/lib/contact-enrichment-limits";

describe("contact enrichment limits", () => {
  it("requests only missing channels", () => {
    expect(
      getContactOutEnrichNeeds({
        workEmail: "hr@company.com",
        personalEmail: "me@gmail.com",
        phones: [
          { number: "+15551234567", source: "contactout", kind: "mobile" },
          { number: "+15557654321", source: "contactout", kind: "mobile" },
          { number: "+15559876543", source: "contactout", kind: "mobile" },
        ],
      }),
    ).toEqual({
      needPersonalEmail: false,
      needWorkEmail: false,
      needPhone: false,
    });
  });

  it("stores one work email, one personal email, and three phones", () => {
    const normalized = normalizeContactChannels({
      workEmail: "hr@company.com",
      personalEmail: "me@gmail.com",
      phones: Array.from({ length: 5 }, (_, i) => ({
        number: `+155500000${i}`,
        source: "contactout" as const,
        kind: "mobile" as const,
      })),
    });
    expect(normalized.workEmail).toBe("hr@company.com");
    expect(normalized.personalEmail).toBe("me@gmail.com");
    expect(normalized.phones).toHaveLength(3);
  });
});
