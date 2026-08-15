import { describe, expect, it } from "vitest";
import {
  channelPlanLabel,
  filterStepSpecsForPlan,
  resolveChannelPlan,
} from "@/lib/outreach/channel-plan";
import { DEFAULT_STEP_SPECS } from "@/lib/outreach-draft";

describe("resolveChannelPlan", () => {
  it("usable email + text-eligible phone → email_and_text", () => {
    expect(
      resolveChannelPlan({ emailUsable: true, hasPhone: true, textEligible: true }),
    ).toBe("email_and_text");
  });

  it("usable email without a text-eligible phone → email_only", () => {
    expect(
      resolveChannelPlan({ emailUsable: true, hasPhone: false, textEligible: false }),
    ).toBe("email_only");
    // Phone present but not iMessage-verified: email plans stay email-only.
    expect(
      resolveChannelPlan({ emailUsable: true, hasPhone: true, textEligible: false }),
    ).toBe("email_only");
  });

  it("no usable email but a phone → text_only, even when not iMessage-capable", () => {
    // The Mac worker IDS-checks and falls back to SMS, so textEligible
    // (which encodes imessageCapable) must NOT gate text-only plans.
    expect(
      resolveChannelPlan({ emailUsable: false, hasPhone: true, textEligible: false }),
    ).toBe("text_only");
  });

  it("unreachable on every channel → null", () => {
    expect(
      resolveChannelPlan({ emailUsable: false, hasPhone: false, textEligible: false }),
    ).toBeNull();
  });
});

describe("filterStepSpecsForPlan", () => {
  it("email_and_text keeps the full default plan", () => {
    expect(filterStepSpecsForPlan("email_and_text", DEFAULT_STEP_SPECS)).toEqual(
      DEFAULT_STEP_SPECS,
    );
  });

  it("email_only keeps only email steps", () => {
    const specs = filterStepSpecsForPlan("email_only", DEFAULT_STEP_SPECS);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.every((s) => s.channel === "email")).toBe(true);
    expect(specs.map((s) => s.stepKind)).toEqual([
      "intro",
      "followup_1",
      "followup_2",
    ]);
  });

  it("text_only keeps only text steps — an email step can never be drafted or queued", () => {
    const specs = filterStepSpecsForPlan("text_only", DEFAULT_STEP_SPECS);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.every((s) => s.channel === "imessage")).toBe(true);
    expect(specs.map((s) => s.stepKind)).toEqual(["text_1", "text_2", "text_3"]);
  });
});

describe("channelPlanLabel", () => {
  it("names each plan for UI notes", () => {
    expect(channelPlanLabel("email_and_text")).toBe("email + SMS");
    expect(channelPlanLabel("email_only")).toBe("email only");
    expect(channelPlanLabel("text_only")).toBe("text only");
    expect(channelPlanLabel(undefined)).toBe("email only");
  });
});
