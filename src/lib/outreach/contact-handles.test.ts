import { describe, expect, it } from "vitest";

import { pickPhone } from "@/lib/outreach/contact-handles";

/**
 * The text target must be a direct number.
 *
 * `contacts.phone` falls back to the company line when there is no direct dial
 * (`pickPrimaryFromPhones`: `directDial?.number ?? companyLine?.number`), and
 * `personal_phone` accepts any ContactOut number including a company one. So
 * reading either field straight sends "Hey Brett, this is Alejandro…" to a main
 * office line — and since every contact at that company resolves to the same
 * switchboard, they all text the same number.
 */
describe("pickPhone", () => {
  it("prefers a ContactOut mobile", () => {
    expect(
      pickPhone({
        phones: [
          { number: "+17865550000", source: "apollo", kind: "company" },
          { number: "+15635949838", source: "contactout", kind: "mobile" },
          { number: "+13055551111", source: "apollo", kind: "mobile" },
        ],
      }),
    ).toBe("+15635949838");
  });

  it("never texts a company switchboard, even as the only number", () => {
    expect(
      pickPhone({
        phones: [{ number: "+17868064011", source: "contactout", kind: "company" }],
      }),
    ).toBeNull();
  });

  it("ignores a company line promoted into the legacy phone fields", () => {
    // What actually happened: the only ContactOut number was a company line,
    // so it landed in both `phone` and `company_phone`.
    expect(
      pickPhone({
        phone: "+17868064011",
        companyPhone: "+17868064011",
        phones: [{ number: "+17868064011", source: "contactout", kind: "company" }],
      }),
    ).toBeNull();
  });

  it("still finds a direct number alongside a company line", () => {
    expect(
      pickPhone({
        phones: [
          { number: "+17868064011", source: "contactout", kind: "company" },
          { number: "+15635949838", source: "contactout", kind: "mobile" },
        ],
      }),
    ).toBe("+15635949838");
  });

  it("takes a work direct dial when there is no mobile", () => {
    expect(
      pickPhone({
        phones: [
          { number: "+17868064011", source: "apollo", kind: "company" },
          { number: "+13055552222", source: "apollo", kind: "work" },
        ],
      }),
    ).toBe("+13055552222");
  });

  it("reads legacy rows that have no structured phones", () => {
    expect(pickPhone({ personalPhone: "+15635949838" })).toBe("+15635949838");
  });

  it("has no target when the contact has no phone at all", () => {
    expect(pickPhone({})).toBeNull();
    expect(pickPhone({ phones: [] })).toBeNull();
  });
});
