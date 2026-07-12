import { describe, expect, it } from "vitest";
import {
  contactTitlePriority,
  emailMatchesCompanyDomain,
  isExcludedContactTitle,
} from "@/lib/contact-title-priority";

describe("contactTitlePriority", () => {
  it("ranks HR above billing and line staff", () => {
    expect(contactTitlePriority("HR Director")).toBeLessThan(
      contactTitlePriority("Billing Manager"),
    );
    expect(contactTitlePriority("VP People")).toBeLessThan(
      contactTitlePriority("Office Manager"),
    );
    expect(isExcludedContactTitle("Billing Manager")).toBe(true);
    expect(isExcludedContactTitle("Optician")).toBe(true);
  });

  it("prefers owners and executives over excluded titles", () => {
    expect(contactTitlePriority("Owner")).toBeLessThan(
      contactTitlePriority("Maid"),
    );
    expect(contactTitlePriority("General Manager")).toBeLessThan(900);
  });
});

describe("emailMatchesCompanyDomain", () => {
  it("matches company domain emails", () => {
    expect(
      emailMatchesCompanyDomain("danielle@familyeyemd.com", "familyeyemd.com"),
    ).toBe(true);
    expect(
      emailMatchesCompanyDomain("kimangel@umich.edu", "familyeyemd.com"),
    ).toBe(false);
  });
});
