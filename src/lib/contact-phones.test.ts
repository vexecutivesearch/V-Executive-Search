import { describe, expect, it } from "vitest";
import {
  MAX_PERSONAL_PHONES_PER_CONTACT,
  mergeSourcedPhones,
  trimPhonesForContact,
} from "@/lib/contact-phones";

describe("trimPhonesForContact", () => {
  it("keeps at most three personal/direct numbers", () => {
    const phones = Array.from({ length: 7 }, (_, i) => ({
      number: `+1954555${String(1000 + i).slice(-4)}`,
      source: "contactout" as const,
      kind: "mobile" as const,
    }));
    expect(trimPhonesForContact(phones)).toHaveLength(
      MAX_PERSONAL_PHONES_PER_CONTACT,
    );
  });

  it("trims after merging Apollo and ContactOut", () => {
    const co = Array.from({ length: 5 }, (_, i) => ({
      number: `+1954555${String(2000 + i).slice(-4)}`,
      source: "contactout" as const,
      kind: "mobile" as const,
    }));
    const apollo = [
      {
        number: "+17275634638",
        source: "apollo" as const,
        kind: "mobile" as const,
      },
    ];
    expect(mergeSourcedPhones(co, apollo)).toHaveLength(
      MAX_PERSONAL_PHONES_PER_CONTACT,
    );
  });
});
