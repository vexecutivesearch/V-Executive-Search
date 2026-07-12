import { describe, expect, it } from "vitest";
import { guessDomain } from "@/lib/domain-resolver";

describe("guessDomain", () => {
  it("builds a low-confidence domain from company name", () => {
    expect(guessDomain("Aviata Health Group")).toBe("aviatahealth.com");
    expect(guessDomain("Crumbl Cookies Franchises")).toBe(
      "crumblcookiesfranchises.com",
    );
  });
});
