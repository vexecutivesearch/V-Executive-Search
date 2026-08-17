import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import {
  BOUNCE_VIOLATION_RATE,
  COMPLAINT_VIOLATION_RATE,
  hasViolation,
  rampCap,
} from "@/lib/outreach/profiles";

/**
 * The throttle line sits at 5%.
 *
 * 2% is the classic ESP danger figure, but `hasViolation` judges LIFETIME
 * totals that never reset, so on a few dozen sends one dead address puts a
 * domain over — and the rollback costs 5/day of real capacity. On 2026-08-17
 * all three production domains were throttled on 1-3 bounces each, two of them
 * from addresses invented during July testing.
 */
describe("bounce violation threshold", () => {
  it("throttles at 5%, not 2%", () => {
    expect(BOUNCE_VIOLATION_RATE).toBe(0.05);
  });

  it("leaves the complaint line alone — a spam report is a stronger signal", () => {
    expect(COMPLAINT_VIOLATION_RATE).toBe(0.001);
  });

  const profile = (totalSent: number, totalBounced: number) => ({
    totalSent,
    totalBounced,
    totalComplaints: 0,
  });

  /* The three production domains after the test-address cleanup. */
  it("clears the real production rates that used to be throttled", () => {
    expect(hasViolation(profile(46, 1))).toBe(false); // vexecsearch.com 2.2%
    expect(hasViolation(profile(41, 0))).toBe(false); // vexecutivesearch.co 0%
    expect(hasViolation(profile(46, 2))).toBe(false); // vtalentsearch.com 4.3%
  });

  it("still catches a genuinely bad domain", () => {
    expect(hasViolation(profile(46, 3))).toBe(true); // 6.5%
    expect(hasViolation(profile(100, 10))).toBe(true); // 10%
  });

  it("ignores samples too small to judge", () => {
    // 19 sends, every one bounced, still below the judging floor.
    expect(hasViolation(profile(19, 19))).toBe(false);
    expect(hasViolation(profile(20, 19))).toBe(true);
  });

  it("still treats complaints as a violation well below the bounce line", () => {
    expect(
      hasViolation({ totalSent: 1000, totalBounced: 0, totalComplaints: 2 }),
    ).toBe(true);
  });

  it("caps the ramp at 50/day regardless of stage", () => {
    expect(rampCap(0)).toBe(5);
    expect(rampCap(5)).toBe(30);
    expect(rampCap(9)).toBe(50);
    expect(rampCap(99)).toBe(50);
  });
});
