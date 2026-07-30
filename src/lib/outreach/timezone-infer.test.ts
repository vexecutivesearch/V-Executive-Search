import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  resolveContactTimezone,
  scheduleSendAt,
  timezoneFromLocation,
  wallClock,
} from "@/lib/outreach/timezone-infer";

describe("timezone inference", () => {
  it("maps City, ST locations to IANA zones", () => {
    expect(timezoneFromLocation("Charlotte, NC")).toBe("America/New_York");
    expect(timezoneFromLocation("Dallas, TX")).toBe("America/Chicago");
    expect(timezoneFromLocation("Phoenix, AZ")).toBe("America/Phoenix");
    expect(timezoneFromLocation("San Francisco, CA")).toBe("America/Los_Angeles");
    expect(timezoneFromLocation(null)).toBeNull();
  });

  it("resolution priority: override > contact > job > company HQ > ET", () => {
    expect(
      resolveContactTimezone({
        timezoneOverride: "America/Denver",
        contactLocation: "Miami, FL",
        jobLocation: "Dallas, TX",
      }),
    ).toBe("America/Denver");
    expect(
      resolveContactTimezone({
        contactLocation: "Seattle, WA",
        jobLocation: "Dallas, TX",
      }),
    ).toBe("America/Los_Angeles");
    expect(resolveContactTimezone({ jobLocation: "Dallas, TX" })).toBe("America/Chicago");
    expect(resolveContactTimezone({ companyLocation: "Atlanta, GA" })).toBe("America/New_York");
    expect(resolveContactTimezone({})).toBe("America/New_York");
  });

  it("ignores invalid overrides", () => {
    expect(
      resolveContactTimezone({ timezoneOverride: "Mars/Olympus", jobLocation: "Dallas, TX" }),
    ).toBe("America/Chicago");
  });
});

describe("scheduleSendAt (weekday sends, contact-local hours, jitter)", () => {
  // Wed Jul 15 2026 12:00 UTC = 8 AM ET
  const base = new Date("2026-07-15T12:00:00Z");

  it("lands inside the local business window on a weekday", () => {
    const scheduled = scheduleSendAt({
      base,
      offsetDays: 2,
      timeZone: "America/New_York",
      windowStartHour: 9,
      windowEndHour: 17,
      random: () => 0.5,
    });
    const wc = wallClock(scheduled, "America/New_York");
    expect(wc.weekday).toBeGreaterThanOrEqual(1);
    expect(wc.weekday).toBeLessThanOrEqual(5);
    expect(wc.hour).toBeGreaterThanOrEqual(9);
    expect(wc.hour).toBeLessThan(17);
  });

  it("rolls weekend targets forward to Monday", () => {
    // Wed + 3 = Saturday → Monday
    const scheduled = scheduleSendAt({
      base,
      offsetDays: 3,
      timeZone: "America/New_York",
      random: () => 0.1,
    });
    const wc = wallClock(scheduled, "America/New_York");
    expect(wc.weekday).toBe(1);
  });

  it("jitter varies the minute within the window", () => {
    const early = scheduleSendAt({
      base,
      offsetDays: 2,
      timeZone: "America/Chicago",
      random: () => 0.01,
    });
    const late = scheduleSendAt({
      base,
      offsetDays: 2,
      timeZone: "America/Chicago",
      random: () => 0.99,
    });
    expect(late.getTime()).toBeGreaterThan(early.getTime());
  });

  it("day-0 before the window schedules later the same day, inside it", () => {
    const scheduled = scheduleSendAt({
      base, // 7 AM CT Wednesday — before the window opens
      offsetDays: 0,
      timeZone: "America/Chicago",
      windowStartHour: 9,
      windowEndHour: 17,
      random: () => 0.5,
    });
    expect(scheduled.getTime()).toBeGreaterThan(base.getTime());
    const wc = wallClock(scheduled, "America/Chicago");
    expect(wc.weekday).toBe(3); // still Wednesday
    expect(wc.hour).toBeGreaterThanOrEqual(9);
    expect(wc.hour).toBeLessThan(17);
  });

  it("day-0 mid-window with an already-passed jitter slot sends shortly after now", () => {
    const midWindow = new Date("2026-07-15T20:00:00Z"); // 3 PM CT Wednesday
    const scheduled = scheduleSendAt({
      base: midWindow,
      offsetDays: 0,
      timeZone: "America/Chicago",
      windowStartHour: 9,
      windowEndHour: 17,
      random: () => 0.01, // jitter points at ~9 AM — already passed
    });
    expect(scheduled.getTime()).toBeGreaterThan(midWindow.getTime());
    expect(scheduled.getTime() - midWindow.getTime()).toBeLessThan(45 * 60_000);
  });
});

describe("addBusinessDays (OOO reschedule)", () => {
  it("skips weekends", () => {
    // Thursday + 3 business days = Tuesday
    const thursday = new Date("2026-07-16T15:00:00Z");
    const result = addBusinessDays(thursday, 3, "America/New_York");
    const wc = wallClock(result, "America/New_York");
    expect(wc.weekday).toBe(2);
  });
});
