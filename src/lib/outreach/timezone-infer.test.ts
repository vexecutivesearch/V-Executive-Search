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
      windowEndHour: 22,
      random: () => 0.5,
    });
    const wc = wallClock(scheduled, "America/New_York");
    expect(wc.weekday).toBeGreaterThanOrEqual(1);
    expect(wc.weekday).toBeLessThanOrEqual(5);
    expect(wc.hour).toBeGreaterThanOrEqual(9);
    expect(wc.hour).toBeLessThan(22);
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
      windowEndHour: 22,
      random: () => 0.5,
    });
    expect(scheduled.getTime()).toBeGreaterThan(base.getTime());
    const wc = wallClock(scheduled, "America/Chicago");
    expect(wc.weekday).toBe(3); // still Wednesday
    expect(wc.hour).toBeGreaterThanOrEqual(9);
    expect(wc.hour).toBeLessThan(22);
  });

  it("day-0 mid-window is already due so the enroll dispatch pass sends it", () => {
    const midWindow = new Date("2026-07-15T20:00:00Z"); // 3 PM CT Wednesday
    const scheduled = scheduleSendAt({
      base: midWindow,
      offsetDays: 0,
      timeZone: "America/Chicago",
      windowStartHour: 9,
      windowEndHour: 22,
      random: () => 0.5,
    });
    // enrollFlow queues the step, then runs runOutreachDispatch(new Date())
    // milliseconds later. Both that pass and the Mac worker's iMessage poll
    // select on `scheduled_for <= now`, so a future scheduled_for silently
    // costs a full 15-min cron window / 5-min poll.
    expect(scheduled.getTime()).toBeLessThanOrEqual(midWindow.getTime());
    expect(midWindow.getTime() - scheduled.getTime()).toBeLessThan(60_000);
  });

  it("day-0 in-window is due regardless of the jitter draw", () => {
    // Regression: the 5–45s random lead made the enroll dispatch a guaranteed
    // no-op for every possible draw (Proven Theory LLC v4, 2026-07-30).
    const enrolledAt = new Date("2026-07-30T21:24:50.534Z"); // 5:24:50 PM ET Thu
    for (const draw of [0, 0.425, 0.5, 0.999]) {
      const scheduled = scheduleSendAt({
        base: enrolledAt,
        offsetDays: 0,
        timeZone: "America/New_York",
        windowStartHour: 9,
        windowEndHour: 22,
        random: () => draw,
      });
      expect(scheduled.getTime()).toBeLessThanOrEqual(enrolledAt.getTime());
    }
  });

  it("day-0 late in the extended window (9 PM ET) still sends same day", () => {
    // Boundary check for the 21→22 window change: the day-0 in-window check is
    // `hour < windowEndHour`, so 9 PM ET deferred to Friday under the old end
    // hour. Testing continues past 9 PM, so 9 PM must now be in window.
    const ninePmEt = new Date("2026-07-31T01:00:18Z"); // 9:00:18 PM ET Thursday
    const scheduled = scheduleSendAt({
      base: ninePmEt,
      offsetDays: 0,
      timeZone: "America/New_York",
      windowStartHour: 9,
      windowEndHour: 22,
      random: () => 0.5,
    });
    expect(scheduled.getTime()).toBeLessThanOrEqual(ninePmEt.getTime());
  });

  it("day-0 out of hours puts the email and its text on the same instant", () => {
    // The Autism One enroll at 7:39 AM ET: each step drew its own slot inside
    // the 9 to 22 window, so the text landed 1:17 PM and the email 6:57 PM,
    // and the text announcing the email arrived five hours before it.
    const beforeWindow = new Date("2026-07-31T11:39:49Z"); // 7:39 AM ET Friday
    const draws = [0, 0.2, 0.5, 0.999].map((draw) =>
      scheduleSendAt({
        base: beforeWindow,
        offsetDays: 0,
        timeZone: "America/New_York",
        windowStartHour: 9,
        windowEndHour: 22,
        random: () => draw,
      }).getTime(),
    );
    expect(new Set(draws).size).toBe(1);

    const wc = wallClock(new Date(draws[0]), "America/New_York");
    expect(wc.weekday).toBe(5); // same Friday
    expect(wc.hour).toBe(9);
    expect(wc.minute).toBe(0);
  });

  it("a testing window that has already opened makes the same add immediate", () => {
    // The override is the lever for sending before production hours: at 7:39 AM
    // with a 7 to 23 window the add is in window, so both steps are already due
    // and the inline dispatch pass carries the email out.
    const scheduled = scheduleSendAt({
      base: new Date("2026-07-31T11:39:49Z"),
      offsetDays: 0,
      timeZone: "America/New_York",
      windowStartHour: 7,
      windowEndHour: 23,
      random: () => 0.5,
    });
    expect(scheduled.getTime()).toBeLessThanOrEqual(
      new Date("2026-07-31T11:39:49Z").getTime(),
    );
  });

  it("day-0 after the window closes waits for the next open, not a random slot", () => {
    const lateFriday = new Date("2026-08-01T03:00:00Z"); // 11 PM ET Friday
    const scheduled = scheduleSendAt({
      base: lateFriday,
      offsetDays: 0,
      timeZone: "America/New_York",
      windowStartHour: 9,
      windowEndHour: 22,
      random: () => 0.9,
    });
    const wc = wallClock(scheduled, "America/New_York");
    expect(wc.weekday).toBe(1); // Monday, weekend rolled forward
    expect(wc.hour).toBe(9);
    expect(wc.minute).toBe(0);
  });

  it("day-0 past the window end (10 PM ET) defers to the next weekday", () => {
    const tenPmEt = new Date("2026-07-31T02:00:00Z"); // 10 PM ET Thursday
    const scheduled = scheduleSendAt({
      base: tenPmEt,
      offsetDays: 0,
      timeZone: "America/New_York",
      windowStartHour: 9,
      windowEndHour: 22,
      random: () => 0.5,
    });
    expect(scheduled.getTime()).toBeGreaterThan(tenPmEt.getTime());
    const wc = wallClock(scheduled, "America/New_York");
    expect(wc.weekday).toBe(5); // Friday
    expect(wc.hour).toBeGreaterThanOrEqual(9);
    expect(wc.hour).toBeLessThan(22);
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
