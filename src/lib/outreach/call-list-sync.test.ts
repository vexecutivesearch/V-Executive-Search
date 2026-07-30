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

  it("leaves free-form notes alone", () => {
    const notes = "Spoke with Miguel.\nFollow up next week.";
    expect(ensureNotesNewestFirst(notes)).toBe(notes);
  });

  it("leaves single stamped line alone", () => {
    const notes = "[Jul 30, 4:50 PM] Only one";
    expect(ensureNotesNewestFirst(notes)).toBe(notes);
  });
});
