import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULING_LINK,
  resolveSchedulingLink,
  schedulingCallLength,
} from "@/lib/outreach/scheduling-link";

const original = process.env.OUTREACH_SCHEDULING_LINK;

afterEach(() => {
  if (original === undefined) delete process.env.OUTREACH_SCHEDULING_LINK;
  else process.env.OUTREACH_SCHEDULING_LINK = original;
});

describe("resolveSchedulingLink", () => {
  it("books the 15 minute ODV event type by default", () => {
    delete process.env.OUTREACH_SCHEDULING_LINK;
    expect(resolveSchedulingLink()).toBe(
      "https://calendly.com/odv-vexecutivesearch/15m",
    );
    expect(DEFAULT_SCHEDULING_LINK).toBe(resolveSchedulingLink());
  });

  it("lets the deployment override the link", () => {
    process.env.OUTREACH_SCHEDULING_LINK = "  https://cal.com/alejandro/intro  ";
    expect(resolveSchedulingLink()).toBe("https://cal.com/alejandro/intro");
  });

  it("falls back when the override is blank", () => {
    process.env.OUTREACH_SCHEDULING_LINK = "   ";
    expect(resolveSchedulingLink()).toBe(DEFAULT_SCHEDULING_LINK);
  });
});

describe("schedulingCallLength", () => {
  it("reads the length off the booking slug", () => {
    expect(schedulingCallLength("https://calendly.com/odv/15m")).toBe("15 min");
    expect(schedulingCallLength("https://calendly.com/odv/30min")).toBe(
      "30 min",
    );
    expect(schedulingCallLength("https://calendly.com/odv/45-minutes")).toBe(
      "45 min",
    );
    expect(schedulingCallLength("https://calendly.com/odv/1hour")).toBe(
      "1 hour",
    );
    expect(schedulingCallLength("https://calendly.com/odv/2-hours")).toBe(
      "2 hours",
    );
  });

  it("survives a trailing slash and query string", () => {
    expect(
      schedulingCallLength("https://calendly.com/odv/15m/?month=2026-08"),
    ).toBe("15 min");
  });

  it("says nothing rather than guessing when the slug has no duration", () => {
    expect(schedulingCallLength("https://calendly.com/odv/intro-call")).toBe(
      null,
    );
    expect(schedulingCallLength("https://cal.com/alejandro")).toBe(null);
  });

  it("defaults to the resolved link", () => {
    delete process.env.OUTREACH_SCHEDULING_LINK;
    expect(schedulingCallLength()).toBe("15 min");
  });
});
