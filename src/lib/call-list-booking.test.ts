import { describe, expect, it } from "vitest";
import {
  bookedWindowFromNotes,
  bookingFromEventPayload,
  formatBookedWindow,
} from "@/lib/call-list-booking";

/** Proven Theory LLC v8 — 15 Minute Meeting, Mon Aug 3 2026 9:00 AM ET. */
const PROVEN_THEORY = {
  action: "created",
  start_time: "2026-08-03T13:00:00.000Z",
  end_time: "2026-08-03T13:15:00.000Z",
};

describe("bookingFromEventPayload", () => {
  it("reads start and end out of a created event", () => {
    const booking = bookingFromEventPayload(PROVEN_THEORY);
    expect(booking?.startAt.toISOString()).toBe("2026-08-03T13:00:00.000Z");
    expect(booking?.endAt?.toISOString()).toBe("2026-08-03T13:15:00.000Z");
  });

  it("treats cancellations as no booking", () => {
    expect(
      bookingFromEventPayload({ ...PROVEN_THEORY, action: "canceled" }),
    ).toBeNull();
  });

  it("returns null when the time is missing or unusable", () => {
    expect(bookingFromEventPayload(null)).toBeNull();
    expect(bookingFromEventPayload({ action: "created" })).toBeNull();
    expect(
      bookingFromEventPayload({ action: "created", start_time: "soon" }),
    ).toBeNull();
  });

  it("tolerates a missing end time", () => {
    const booking = bookingFromEventPayload({
      action: "created",
      start_time: PROVEN_THEORY.start_time,
    });
    expect(booking?.endAt).toBeNull();
  });
});

describe("formatBookedWindow", () => {
  it("renders the Eastern window with a single meridiem", () => {
    expect(
      formatBookedWindow(PROVEN_THEORY.start_time, PROVEN_THEORY.end_time),
    ).toBe("Mon Aug 3, 9:00–9:15 AM ET");
  });

  it("keeps both meridiems when the window straddles noon", () => {
    expect(
      formatBookedWindow("2026-08-03T15:45:00.000Z", "2026-08-03T16:15:00.000Z"),
    ).toBe("Mon Aug 3, 11:45 AM–12:15 PM ET");
  });

  it("falls back to the start alone with no end time", () => {
    expect(formatBookedWindow(PROVEN_THEORY.start_time, null)).toBe(
      "Mon Aug 3, 9:00 AM ET",
    );
  });

  it("adds the year for the expanded detail line", () => {
    expect(
      formatBookedWindow(PROVEN_THEORY.start_time, PROVEN_THEORY.end_time, {
        includeYear: true,
      }),
    ).toBe("Mon Aug 3, 2026, 9:00–9:15 AM ET");
  });

  it("returns null rather than an Invalid Date label", () => {
    expect(formatBookedWindow("whenever", null)).toBeNull();
  });
});

describe("bookedWindowFromNotes", () => {
  it("pulls the window off the newest Call Booked line", () => {
    const notes = [
      "[Jul 31, 12:25 AM] Call Booked: Mon Aug 3, 2026 9:00–9:15 AM ET",
      "[Jul 31, 12:23 AM] Outreach reply (positive) from Miguel Lozano",
    ].join("\n");
    expect(bookedWindowFromNotes(notes)).toBe("Mon Aug 3, 2026 9:00–9:15 AM ET");
  });

  it("respects a newer cancellation", () => {
    const notes = [
      "[Jul 31, 8:00 AM] Call canceled: Mon Aug 3, 2026 9:00–9:15 AM ET",
      "[Jul 31, 12:25 AM] Call Booked: Mon Aug 3, 2026 9:00–9:15 AM ET",
    ].join("\n");
    expect(bookedWindowFromNotes(notes)).toBeNull();
  });

  it("has nothing to show for a time-TBD booking", () => {
    expect(bookedWindowFromNotes("[Jul 31, 12:25 AM] Call Booked (time TBD)")).toBeNull();
  });

  it("returns null for rows with no booking line", () => {
    expect(bookedWindowFromNotes(null)).toBeNull();
    expect(bookedWindowFromNotes("")).toBeNull();
    expect(
      bookedWindowFromNotes("[Jul 31, 12:18 AM] Outreach text_1 iMessage sent"),
    ).toBeNull();
  });

  it("handles CRLF note blobs", () => {
    expect(
      bookedWindowFromNotes(
        "[Jul 31, 12:25 AM] Call Booked: Mon Aug 3, 2026 9:00 AM ET\r\n[Jul 31, 12:18 AM] sent",
      ),
    ).toBe("Mon Aug 3, 2026 9:00 AM ET");
  });
});
