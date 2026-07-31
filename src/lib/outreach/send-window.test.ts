import { describe, expect, it } from "vitest";
import {
  isValidWindowHour,
  minutesUntilOverrideExpiry,
  resolveSendWindow,
  TESTING_WINDOW_MAX_HOURS,
  testingWindowExpiry,
  type SendWindowSettings,
} from "./send-window";

const PRODUCTION: SendWindowSettings = {
  sendWindowStartHour: 9,
  sendWindowEndHour: 17,
  testingWindowUntil: null,
  testingWindowStartHour: null,
  testingWindowEndHour: null,
};

const now = new Date("2026-07-30T21:00:00Z"); // 5 PM ET Thursday

describe("resolveSendWindow", () => {
  it("uses the production window when no override is set", () => {
    const w = resolveSendWindow(PRODUCTION, now);
    expect(w).toEqual({
      startHour: 9,
      endHour: 17,
      testingOverrideActive: false,
      overrideExpiresAt: null,
    });
  });

  it("uses the production window when only the hours are set but no expiry", () => {
    // An override with no expiry is exactly the permanent widening this
    // feature exists to prevent, so it must not take effect.
    const w = resolveSendWindow(
      { ...PRODUCTION, testingWindowStartHour: 6, testingWindowEndHour: 23 },
      now,
    );
    expect(w.testingOverrideActive).toBe(false);
    expect(w.endHour).toBe(17);
  });

  it("applies the override while it is unexpired", () => {
    const until = new Date(now.getTime() + 60 * 60_000);
    const w = resolveSendWindow(
      {
        ...PRODUCTION,
        testingWindowUntil: until,
        testingWindowStartHour: 6,
        testingWindowEndHour: 23,
      },
      now,
    );
    expect(w).toEqual({
      startHour: 6,
      endHour: 23,
      testingOverrideActive: true,
      overrideExpiresAt: until,
    });
  });

  it("falls back to production hours for whichever override bound is unset", () => {
    const w = resolveSendWindow(
      {
        ...PRODUCTION,
        testingWindowUntil: new Date(now.getTime() + 60 * 60_000),
        testingWindowStartHour: null,
        testingWindowEndHour: 23,
      },
      now,
    );
    expect(w.startHour).toBe(9); // production start preserved
    expect(w.endHour).toBe(23);
    expect(w.testingOverrideActive).toBe(true);
  });

  it("reverts to production the moment the override expires", () => {
    const settings = {
      ...PRODUCTION,
      testingWindowUntil: new Date(now.getTime() + 60_000),
      testingWindowStartHour: 6,
      testingWindowEndHour: 23,
    };
    expect(resolveSendWindow(settings, now).endHour).toBe(23);

    const afterExpiry = new Date(now.getTime() + 61_000);
    const w = resolveSendWindow(settings, afterExpiry);
    expect(w.testingOverrideActive).toBe(false);
    expect(w.startHour).toBe(9);
    expect(w.endHour).toBe(17);
    expect(w.overrideExpiresAt).toBeNull();
  });

  it("treats the exact expiry instant as expired", () => {
    const w = resolveSendWindow(
      { ...PRODUCTION, testingWindowUntil: new Date(now.getTime()), testingWindowEndHour: 23 },
      now,
    );
    expect(w.testingOverrideActive).toBe(false);
    expect(w.endHour).toBe(17);
  });

  it("ignores an override left over from a previous session", () => {
    // Stale rows are the expected steady state: nobody turns this off by hand.
    const w = resolveSendWindow(
      {
        ...PRODUCTION,
        testingWindowUntil: new Date("2026-07-29T02:00:00Z"),
        testingWindowStartHour: 0,
        testingWindowEndHour: 24,
      },
      now,
    );
    expect(w.testingOverrideActive).toBe(false);
    expect(w.endHour).toBe(17);
  });

  it("can narrow as well as widen", () => {
    const w = resolveSendWindow(
      {
        ...PRODUCTION,
        testingWindowUntil: new Date(now.getTime() + 60 * 60_000),
        testingWindowStartHour: 12,
        testingWindowEndHour: 13,
      },
      now,
    );
    expect(w.startHour).toBe(12);
    expect(w.endHour).toBe(13);
  });
});

describe("testingWindowExpiry", () => {
  it("adds the requested hours", () => {
    expect(testingWindowExpiry(3, now).toISOString()).toBe("2026-07-31T00:00:00.000Z");
  });

  it("clamps to the maximum duration", () => {
    const expiry = testingWindowExpiry(999, now);
    expect(expiry.getTime() - now.getTime()).toBe(TESTING_WINDOW_MAX_HOURS * 3_600_000);
  });

  it("clamps negatives to now, which reads as already expired", () => {
    const expiry = testingWindowExpiry(-5, now);
    expect(expiry.getTime()).toBe(now.getTime());
    expect(
      resolveSendWindow({ ...PRODUCTION, testingWindowUntil: expiry, testingWindowEndHour: 23 }, now)
        .testingOverrideActive,
    ).toBe(false);
  });

  it("treats a non-finite duration as no override", () => {
    expect(testingWindowExpiry(Number.NaN, now).getTime()).toBe(now.getTime());
  });
});

describe("isValidWindowHour", () => {
  it("accepts 0 through 24", () => {
    for (const h of [0, 9, 17, 22, 24]) expect(isValidWindowHour(h)).toBe(true);
  });

  it("rejects out-of-range, fractional and non-numeric values", () => {
    for (const h of [-1, 25, 9.5, "9", null, undefined, Number.NaN]) {
      expect(isValidWindowHour(h)).toBe(false);
    }
  });
});

describe("minutesUntilOverrideExpiry", () => {
  it("is 0 when the override is off", () => {
    expect(minutesUntilOverrideExpiry(resolveSendWindow(PRODUCTION, now), now)).toBe(0);
  });

  it("rounds up to the next whole minute", () => {
    const window = resolveSendWindow(
      {
        ...PRODUCTION,
        testingWindowUntil: new Date(now.getTime() + 90_000),
        testingWindowEndHour: 23,
      },
      now,
    );
    expect(minutesUntilOverrideExpiry(window, now)).toBe(2);
  });
});
