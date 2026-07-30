import { describe, expect, it } from "vitest";
import {
  formatReplyPlaybookForClassifier,
  replyKindForIntent,
} from "@/lib/outreach/reply-playbook";
import type { OutreachTemplate } from "@/lib/db/schema";

function stubTemplate(
  partial: Pick<OutreachTemplate, "kind" | "name" | "exampleBody">,
): OutreachTemplate {
  return {
    id: "t1",
    channel: "email",
    exampleSubject: null,
    isActive: true,
    timesUsed: 0,
    timesReplied: 0,
    timesPositive: 0,
    timesOptOut: 0,
    flaggedAt: null,
    flagReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

describe("reply playbook (intent → next email)", () => {
  it("maps classified intents to reply template kinds", () => {
    expect(replyKindForIntent("positive")).toBe("reply_positive");
    expect(replyKindForIntent("positive_link_request")).toBe("reply_positive");
    expect(replyKindForIntent("info_request")).toBe("reply_info_request");
    expect(replyKindForIntent("negative")).toBe("reply_decline");
    expect(replyKindForIntent("opt_out")).toBeNull();
    expect(replyKindForIntent("unknown")).toBeNull();
  });

  it("formats Template bank reply exemplars into the classifier prompt", () => {
    const block = formatReplyPlaybookForClassifier([
      stubTemplate({
        kind: "reply_positive",
        name: "Positive reply, availability",
        exampleBody: "Great to hear from you, happy to set up a quick call.",
      }),
      stubTemplate({
        kind: "reply_info_request",
        name: "Info request, hand off ack",
        exampleBody: "Happy to share more detail and get back to you shortly.",
      }),
      stubTemplate({
        kind: "reply_decline",
        name: "Decline, graceful close",
        exampleBody: "Understood, thanks for letting me know.",
      }),
    ]);
    expect(block).toContain("OUR RESPONSE PLAYBOOK");
    expect(block).toContain("reply_positive");
    expect(block).toContain("reply_info_request");
    expect(block).toContain("reply_decline");
    expect(block).toContain("Great to hear from you");
    expect(block).toContain("Understood, thanks for letting me know");
  });
});
