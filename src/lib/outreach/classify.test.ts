import { describe, expect, it } from "vitest";
import { classifyHeuristic } from "@/lib/outreach/classify";

describe("classifyHeuristic (deterministic — never depends on the LLM)", () => {
  it("STOP via text suppresses the number", () => {
    for (const body of ["STOP", "stop", "Unsubscribe", "CANCEL"]) {
      const result = classifyHeuristic({ body, channel: "imessage" });
      expect(result?.intent).toBe("opt_out");
    }
  });

  it("STOP words inside a longer text are NOT an opt-out match", () => {
    expect(
      classifyHeuristic({
        body: "Please don't stop reaching out, this is interesting",
        channel: "imessage",
      }),
    ).toBeNull();
  });

  it("classifies out-of-office / auto-replies (excluded from reply-rate)", () => {
    expect(
      classifyHeuristic({
        body: "I am out of the office until Monday with limited access to email.",
        channel: "email",
      })?.intent,
    ).toBe("ooo");
    expect(
      classifyHeuristic({
        body: "Anything",
        subject: "Automatic reply: Boutique Legal Recruitment",
        channel: "email",
      })?.intent,
    ).toBe("ooo");
  });

  it("classifies delivery-failure notices as hard bounces", () => {
    expect(
      classifyHeuristic({
        body: "Delivery has failed to these recipients. Address not found.",
        channel: "email",
      })?.intent,
    ).toBe("bounce_hard");
  });

  it("classifies data deletion requests", () => {
    expect(
      classifyHeuristic({
        body: "Please delete my data from your systems.",
        channel: "email",
      })?.intent,
    ).toBe("data_deletion");
  });

  it("classifies explicit unsubscribe language in email", () => {
    expect(
      classifyHeuristic({
        body: "Remove me from your list. Do not contact me again.",
        channel: "email",
      })?.intent,
    ).toBe("opt_out");
  });

  it("returns null for substantive replies (LLM handles those)", () => {
    expect(
      classifyHeuristic({
        body: "Yes, happy to chat Thursday. What are your fees?",
        channel: "email",
      }),
    ).toBeNull();
  });
});
