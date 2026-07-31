import { describe, expect, it } from "vitest";
import { ensureNotesNewestFirst } from "@/lib/outreach/call-list-notes";

describe("ensureNotesNewestFirst", () => {
  it("reverses oldest-first stamped blobs", () => {
    const notes = [
      "[Jul 28, 9:00 AM] Outreach intro email sent",
      "[Jul 29, 10:15 AM] Reply: positive",
      "[Jul 30, 4:50 PM] Call booked via Calendly",
    ].join("\n");
    expect(ensureNotesNewestFirst(notes)).toBe(
      [
        "[Jul 30, 4:50 PM] Call booked via Calendly",
        "[Jul 29, 10:15 AM] Reply: positive",
        "[Jul 28, 9:00 AM] Outreach intro email sent",
      ].join("\n"),
    );
  });

  it("leaves newest-first stamped blobs unchanged", () => {
    const notes = [
      "[Jul 30, 4:50 PM] Call booked via Calendly",
      "[Jul 29, 10:15 AM] Reply: positive",
      "[Jul 28, 9:00 AM] Outreach intro email sent",
    ].join("\n");
    expect(ensureNotesNewestFirst(notes)).toBe(notes);
  });

  it("keeps a newest-first row upright when an Eastern stamp tops UTC stamps", () => {
    // The Call Booked line was stamped Eastern; the lines under it are the
    // legacy UTC stamps of the same evening, so they read 4 hours later.
    const notes = [
      "[Jul 30, 8:39 PM] Call Booked: Mon Aug 3, 2026 9:00–9:15 AM ET (booked as Jeff Willson)",
      "[Jul 31, 12:23 AM] Outreach reply (positive) from Miguel Lozano",
      "[Jul 31, 12:18 AM] Outreach text_1 iMessage sent",
      "[Jul 31, 12:17 AM] Outreach intro email sent",
    ].join("\n");
    expect(ensureNotesNewestFirst(notes)).toBe(notes);
  });

  it("leaves free-form notes alone", () => {
    const notes = "Spoke with Miguel.\nFollow up next week.";
    expect(ensureNotesNewestFirst(notes)).toBe(notes);
  });

  it("leaves single stamped line alone", () => {
    const notes = "[Jul 30, 4:50 PM] Only one";
    expect(ensureNotesNewestFirst(notes)).toBe(notes);
  });
});
