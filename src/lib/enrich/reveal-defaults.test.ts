import { describe, expect, it } from "vitest";

import { shouldDefaultPhoneOn } from "@/lib/enrich/reveal-defaults";

describe("reveal picker phone default", () => {
  it("defaults phone ON for a contact with no direct number", () => {
    expect(shouldDefaultPhoneOn({ hasPhone: false })).toBe(true);
  });

  it("leaves phone OFF when the contact already has a number", () => {
    expect(shouldDefaultPhoneOn({ hasPhone: true })).toBe(false);
  });

  /*
   * The shipped bug: the auto-phone argument was `phoneUpgrade && !hasEmail`
   * where `phoneUpgrade` already required `hasEmail`. The condition was a
   * contradiction, so phone never defaulted on for ANY candidate and every
   * reveal went out as email-only.
   */
  it("is reachable for a saved contact that has an email but no phone", () => {
    const refreshable = true;
    const hasEmail = true;
    const hasPhone = false;
    const oldCondition = refreshable && hasEmail && !hasPhone && !hasEmail;

    expect(oldCondition).toBe(false);
    expect(shouldDefaultPhoneOn({ hasPhone })).toBe(true);
  });
});
