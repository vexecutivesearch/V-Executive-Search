import { describe, expect, it } from "vitest";

import { pickPhone } from "@/lib/outreach/contact-handles";

/**
 * The day-0 text race.
 *
 * Enrolling straight after enrichment beats the Mac worker's text check, so
 * `imessage_capable` is still null when the flow reaches the text node. The
 * node used to skip permanently, which is why a contact with an obvious
 * ContactOut mobile lands on an email-only sequence with no same-day SMS.
 *
 * Every Proven Theory v1-v12 test seeded `imessage_capable` explicitly
 * (`const textable = s.contact.phone !== null` in retire-all-seed-v12.ts), so
 * the flag was already true before enrollment and this race was never once
 * exercised across 72 hours of testing.
 *
 * This mirrors the predicate in flow-engine so the hold can never become an
 * indefinite stall, and so both deadlines stay covered.
 */
const GRACE_MS = 45 * 60_000;

function dayZeroTextStillPossible(input: {
  imessageCapable: boolean | null;
  personalPhone?: string | null;
  phone?: string | null;
  msSinceEnroll: number;
  introEmailSent: boolean;
}): boolean {
  if (input.imessageCapable !== null) return false;
  if (!pickPhone(input)) return false;
  if (input.msSinceEnroll < GRACE_MS) return true;
  return !input.introEmailSent;
}

const racing = {
  imessageCapable: null as boolean | null,
  personalPhone: "+13124606812",
  phone: null,
  msSinceEnroll: 0,
  introEmailSent: false,
};

describe("day-zero text hold", () => {
  it("holds when the contact has a mobile and the check has not come back", () => {
    expect(dayZeroTextStillPossible(racing)).toBe(true);
  });

  /*
   * The in-window case, which is the normal weekday one. enrollContact runs a
   * dispatch pass milliseconds after advancing, so the intro is already sent
   * by the next pass. Keying the hold solely on "intro not sent" would skip
   * the text immediately and leave the bug in place — the grace window is
   * what carries it.
   */
  it("keeps holding inside the grace window even after the intro has sent", () => {
    expect(
      dayZeroTextStillPossible({
        ...racing,
        introEmailSent: true,
        msSinceEnroll: 10 * 60_000,
      }),
    ).toBe(true);
  });

  /*
   * The out-of-hours case: a Sunday add sits unsent until Monday's window
   * open, far beyond any grace period. "Intro not yet sent" carries the text
   * across so both day-0 steps take the same window open instant.
   */
  it("keeps holding past the grace window while the intro is still unsent", () => {
    expect(
      dayZeroTextStillPossible({
        ...racing,
        msSinceEnroll: 20 * 60 * 60_000,
        introEmailSent: false,
      }),
    ).toBe(true);
  });

  it("gives up once the grace has passed AND the intro has gone out", () => {
    expect(
      dayZeroTextStillPossible({
        ...racing,
        msSinceEnroll: GRACE_MS + 1,
        introEmailSent: true,
      }),
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
