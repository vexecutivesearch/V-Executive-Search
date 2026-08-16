import { describe, expect, it } from "vitest";

import type { SequenceEnrollment } from "@/lib/db/schema";
import { enrollmentCanUpgrade } from "@/lib/outreach/phone-backfill";

type Status = SequenceEnrollment["status"];

const live = { phoneNumber: null, status: "active" } as const;
const textable = {
  personalPhone: "+15615550100",
  phone: null,
  imessageCapable: true,
};

describe("enrollmentCanUpgrade", () => {
  it("upgrades a live email-only enrollment whose contact now has a phone", () => {
    expect(enrollmentCanUpgrade(live, textable)).toBe(true);
  });

  it("leaves an enrollment that already has a number alone", () => {
    expect(
      enrollmentCanUpgrade(
        { phoneNumber: "+15615550100", status: "active" },
        textable,
      ),
    ).toBe(false);
  });

  it("skips contacts that still have no phone", () => {
    expect(
      enrollmentCanUpgrade(live, {
        personalPhone: null,
        phone: null,
        imessageCapable: true,
      }),
    ).toBe(false);
  });

  /*
   * Idempotent and conservative: an unchecked contact is skipped this pass and
   * picked up on a later one, once the Mac worker answers. The backfill nudges
   * that check rather than assuming the number is textable.
   */
  it("waits for the capability answer rather than assuming", () => {
    expect(
      enrollmentCanUpgrade(live, { ...textable, imessageCapable: null }),
    ).toBe(false);
    expect(
      enrollmentCanUpgrade(live, { ...textable, imessageCapable: false }),
    ).toBe(false);
  });

  /*
   * A finished sequence gains nothing from a number: the flow has already
   * walked past every text node, and reviving them would text someone whose
   * cadence ended.
   */
  it("ignores enrollments that are no longer walking the graph", () => {
    const finished: Status[] = [
      "completed",
      "stopped",
      "bounced",
      "suppressed",
      "replied_positive",
      "replied_negative",
    ];
    for (const status of finished) {
      expect(enrollmentCanUpgrade({ phoneNumber: null, status }, textable)).toBe(
        false,
      );
    }
  });

  it("still upgrades paused and reply-waiting enrollments", () => {
    const live: Status[] = ["paused", "waiting_on_reply", "waiting_on_manual"];
    for (const status of live) {
      expect(enrollmentCanUpgrade({ phoneNumber: null, status }, textable)).toBe(
        true,
      );
    }
  });

  it("falls back to the generic phone when there is no personal one", () => {
    expect(
      enrollmentCanUpgrade(live, {
        personalPhone: null,
        phone: "+15615550111",
        imessageCapable: true,
      }),
    ).toBe(true);
  });
});
