import { describe, expect, it } from "vitest";
import { canAutoAdvanceStatus } from "@/lib/call-status";
import { callStatusForReplyIntent } from "@/lib/outreach/call-list-sync";

/**
 * The v12 test run (Jul 30) exposed two status defects:
 *  1. a positive reply was recorded as "Call Booked" (meeting_scheduled)
 *     even though nothing was booked, and
 *  2. a later courtesy reply ("mark not as junk please") silently demoted
 *     a meeting_scheduled row back down the funnel.
 * These tests pin the corrected behavior.
 */

describe("callStatusForReplyIntent", () => {
  it("records a positive reply as interested — NOT as a booked call", () => {
    expect(callStatusForReplyIntent("positive")).toBe("replied_interested");
    expect(callStatusForReplyIntent("positive_link_request")).toBe(
      "replied_interested",
    );
  });

  it("never returns meeting_scheduled for any reply intent", () => {
    const intents = [
      "positive",
      "positive_link_request",
      "info_request",
      "courtesy",
      "negative",
      "opt_out",
      "complaint",
      "data_deletion",
      "wrong_person",
      "ooo",
      "unknown",
    ];
    for (const intent of intents) {
      expect(callStatusForReplyIntent(intent)).not.toBe("meeting_scheduled");
    }
  });
});

describe("canAutoAdvanceStatus", () => {
  it("blocks a courtesy reply from demoting a booked call", () => {
    expect(canAutoAdvanceStatus("meeting_scheduled", "spoke_follow_up")).toBe(
      false,
    );
    expect(
      canAutoAdvanceStatus("meeting_scheduled", "replied_interested"),
    ).toBe(false);
    expect(canAutoAdvanceStatus("meeting_scheduled", "email_sent")).toBe(false);
  });

  it("blocks a follow-up send from demoting an interested reply", () => {
    expect(canAutoAdvanceStatus("replied_interested", "email_sent")).toBe(
      false,
    );
    expect(canAutoAdvanceStatus("replied_interested", "spoke_follow_up")).toBe(
      false,
    );
  });

  it("allows forward movement through the funnel", () => {
    expect(canAutoAdvanceStatus("email_sent", "replied_interested")).toBe(true);
    expect(
      canAutoAdvanceStatus("replied_interested", "meeting_scheduled"),
    ).toBe(true);
    expect(canAutoAdvanceStatus("new", "email_sent")).toBe(true);
  });

  it("allows terminal statuses from any non-terminal state", () => {
    expect(canAutoAdvanceStatus("meeting_scheduled", "not_interested")).toBe(
      true,
    );
    expect(canAutoAdvanceStatus("replied_interested", "do_not_contact")).toBe(
      true,
    );
  });

  it("never moves a row already in a terminal status", () => {
    expect(canAutoAdvanceStatus("do_not_contact", "replied_interested")).toBe(
      false,
    );
    expect(canAutoAdvanceStatus("client_won", "meeting_scheduled")).toBe(false);
  });

  it("treats a same-status write as a no-op", () => {
    expect(
      canAutoAdvanceStatus("replied_interested", "replied_interested"),
    ).toBe(false);
  });
});
