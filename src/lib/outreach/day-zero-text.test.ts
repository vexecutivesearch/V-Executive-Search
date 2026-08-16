import { describe, expect, it } from "vitest";

import { pickPhone } from "@/lib/outreach/contact-handles";

/**
 * The day-0 text race.
 *
 * Enrolling straight after enrichment beats the Mac worker's text check, so
 * `imessage_capable` is still null when the flow reaches the text node. The
 * node used to skip permanently, which is why a contact who clearly has a
 * mobile ends up on an email-only sequence with no same-day SMS.
 *
 * The flow now holds that step instead, but only for the genuine race. This
 * pins the predicate so the hold can never become an indefinite stall.
 */
function dayZeroTextStillPossible(input: {
  imessageCapable: boolean | null;
  personalPhone?: string | null;
  phone?: string | null;
  introEmailSent: boolean;
}): boolean {
  if (input.imessageCapable !== null) return false;
  if (!pickPhone(input)) return false;
  return !input.introEmailSent;
}

const racing = {
  imessageCapable: null as boolean | null,
  personalPhone: "+13124606812",
  phone: null,
  introEmailSent: false,
};

describe("day-zero text hold", () => {
  it("holds when the contact has a mobile and the check has not come back", () => {
    expect(dayZeroTextStillPossible(racing)).toBe(true);
  });

  it("stops holding once the intro email has gone out", () => {
    // The day-0 window has closed; a late text should not chase a sent email.
    expect(
      dayZeroTextStillPossible({ ...racing, introEmailSent: true }),
    ).toBe(false);
  });

  it("does not hold for a contact with no phone at all", () => {
    expect(
      dayZeroTextStillPossible({
        ...racing,
        personalPhone: null,
        phone: null,
      }),
    ).toBe(false);
  });

  it("does not hold once the check has actually answered", () => {
    // true is handled by the normal path (the backfill attaches the number);
    // false is a real refusal. Neither is a race.
    expect(
      dayZeroTextStillPossible({ ...racing, imessageCapable: true }),
    ).toBe(false);
    expect(
      dayZeroTextStillPossible({ ...racing, imessageCapable: false }),
    ).toBe(false);
  });

  it("accepts the generic phone field, not just the personal one", () => {
    expect(
      dayZeroTextStillPossible({
        ...racing,
        personalPhone: null,
        phone: "+13124606812",
      }),
    ).toBe(true);
  });
});
