import { describe, expect, it } from "vitest";
import {
  formatActivityClock,
  formatActivityDay,
  formatActivityStamp,
  formatActivityStampLong,
  latestActivityAt,
  latestActivityMs,
} from "@/lib/call-list-activity";

const updatedAt = new Date("2026-07-31T04:23:50.271Z");

describe("latestActivityAt", () => {
  it("takes the most recent of the three touch stamps", () => {
    expect(
      latestActivityAt({
        lastContactAt: new Date("2026-07-31T04:18:37.028Z"),
        callStatusUpdatedAt: new Date("2026-07-31T04:23:43.272Z"),
        updatedAt,
      })?.toISOString(),
    ).toBe(updatedAt.toISOString());
  });

  it("ignores null and unparseable stamps", () => {
    expect(
      latestActivityAt({
        lastContactAt: null,
        callStatusUpdatedAt: "not a date",
        updatedAt,
      })?.toISOString(),
    ).toBe(updatedAt.toISOString());
  });

  it("accepts ISO strings from serialized rows", () => {
    expect(
      latestActivityAt({
        lastContactAt: "2026-08-01T00:00:00.000Z",
        callStatusUpdatedAt: null,
        updatedAt,
      })?.toISOString(),
    ).toBe("2026-08-01T00:00:00.000Z");
  });

  it("returns null when nothing is parseable", () => {
    expect(
      latestActivityAt({
        lastContactAt: null,
        callStatusUpdatedAt: null,
        updatedAt: "",
      }),
    ).toBeNull();
  });
});

describe("latestActivityMs", () => {
  it("matches the SQL GREATEST() sort key", () => {
    const older = {
      lastContactAt: new Date("2026-07-29T12:00:00.000Z"),
      callStatusUpdatedAt: null,
      updatedAt: new Date("2026-07-29T12:00:00.000Z"),
    };
    const newer = {
      lastContactAt: null,
      callStatusUpdatedAt: null,
      updatedAt,
    };
    expect(latestActivityMs(newer)).toBeGreaterThan(latestActivityMs(older));
  });

  it("sorts rows with no activity last", () => {
    expect(
      latestActivityMs({
        lastContactAt: null,
        callStatusUpdatedAt: null,
        updatedAt: "",
      }),
    ).toBe(0);
  });
});

describe("activity stamp formatting", () => {
  it("renders Eastern day and clock parts", () => {
    // 04:23 UTC on Jul 31 is 12:23 AM ET on Jul 31.
    expect(formatActivityDay(updatedAt)).toBe("Jul 31");
    expect(formatActivityClock(updatedAt)).toBe("12:23 AM");
  });

  it("matches the Call List note stamp shape", () => {
    expect(formatActivityStamp(updatedAt)).toBe("Jul 31, 12:23 AM");
  });

  it("adds the year and zone for the detail view", () => {
    expect(formatActivityStampLong(updatedAt)).toBe("Jul 31, 2026, 12:23 AM ET");
  });

  it("keeps late-UTC stamps on the Eastern calendar day", () => {
    // 03:30 UTC Aug 1 is still 11:30 PM ET on Jul 31.
    const d = new Date("2026-08-01T03:30:00.000Z");
    expect(formatActivityStamp(d)).toBe("Jul 31, 11:30 PM");
  });
});
