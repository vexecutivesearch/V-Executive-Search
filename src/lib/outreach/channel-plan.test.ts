import { describe, expect, it } from "vitest";
import {
  channelPlanLabel,
  channelPlanReasonLabel,
  explainChannelPlan,
  filterStepSpecsForPlan,
  phoneIsTextEligible,
  resolveChannelPlan,
} from "@/lib/outreach/channel-plan";
import { DEFAULT_STEP_SPECS } from "@/lib/outreach-draft";

describe("resolveChannelPlan", () => {
  it("usable email + text-eligible phone → email_and_text", () => {
    expect(
      resolveChannelPlan({
        emailUsable: true,
        hasPhone: true,
        textEligible: true,
        textEnabled: true,
      }),
    ).toBe("email_and_text");
  });

  it("usable email without a text-eligible phone → email_only", () => {
    expect(
      resolveChannelPlan({
        emailUsable: true,
        hasPhone: false,
        textEligible: false,
        textEnabled: true,
      }),
    ).toBe("email_only");
    // Phone present but not iMessage-verified: email plans stay email-only.
    expect(
      resolveChannelPlan({
        emailUsable: true,
        hasPhone: true,
        textEligible: false,
        textEnabled: true,
      }),
    ).toBe("email_only");
  });

  it("no usable email but a phone → text_only, even when not iMessage-capable", () => {
    // The Mac worker IDS-checks and falls back to SMS, so textEligible
    // (which encodes imessageCapable) must NOT gate text-only plans.
    expect(
      resolveChannelPlan({
        emailUsable: false,
        hasPhone: true,
        textEligible: false,
        textEnabled: true,
      }),
    ).toBe("text_only");
  });

  it("unreachable on every channel → null", () => {
    expect(
      resolveChannelPlan({
        emailUsable: false,
        hasPhone: false,
        textEligible: false,
        textEnabled: true,
      }),
    ).toBeNull();
  });
});

/*
 * The text channel switch. Apple disabled the operator's iMessage after three
 * days of business use, so no plan may carry a text step while it is off, and
 * that has to be decided here rather than downstream: a plan without text
 * steps is a sequence whose text steps were never drafted at all.
 */
describe("resolveChannelPlan with the text channel switched off", () => {
  it("keeps a textable contact on email only", () => {
    expect(
      resolveChannelPlan({
        emailUsable: true,
        hasPhone: true,
        textEligible: true,
        textEnabled: false,
      }),
    ).toBe("email_only");
  });

  it("refuses a text_only plan rather than enrolling a text nobody can send", () => {
    expect(
      resolveChannelPlan({
        emailUsable: false,
        hasPhone: true,
        textEligible: true,
        textEnabled: false,
      }),
    ).toBeNull();
  });

  it("never returns a plan that carries a text step", () => {
    for (const emailUsable of [true, false]) {
      for (const hasPhone of [true, false]) {
        for (const textEligible of [true, false]) {
          const plan = resolveChannelPlan({
            emailUsable,
            hasPhone,
            textEligible,
            textEnabled: false,
          });
          expect(plan === null || plan === "email_only").toBe(true);
          if (plan) {
            expect(
              filterStepSpecsForPlan(plan, DEFAULT_STEP_SPECS).some(
                (s) => s.channel === "imessage",
              ),
            ).toBe(false);
          }
        }
      }
    }
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

describe("explainChannelPlan", () => {
  const base = {
    emailUsable: true,
    hasPhone: true,
    imessageCapable: true as boolean | null,
    phoneSuppressed: false,
    textEnabled: true,
  };

  it("adds text steps when the contact has a textable phone", () => {
    expect(explainChannelPlan(base)).toEqual({
      plan: "email_and_text",
      reason: "text_added",
    });
  });

  /*
   * The common case behind a wall of "email only" enrollments: the contact
   * simply has no phone number. An iMessage-capable EMAIL does not change
   * this — the whole send path is keyed on a phone number.
   */
  it("blames the missing phone, not iMessage, when there is no number", () => {
    expect(
      explainChannelPlan({ ...base, hasPhone: false }),
    ).toEqual({ plan: "email_only", reason: "no_phone" });

    expect(
      explainChannelPlan({
        ...base,
        hasPhone: false,
        imessageCapable: true,
      }).reason,
    ).toBe("no_phone");
  });

  /*
   * A null answer waits rather than assuming. It used to be indistinguishable
   * from a real "no", which is what made a work-email-plus-mobile contact look
   * permanently email-only — the contacts check queue never asked about it.
   * The queue was widened to cover phone-only contacts; the gate itself stays
   * conservative.
   */
  it("waits for the capability answer instead of assuming", () => {
    expect(explainChannelPlan({ ...base, imessageCapable: null })).toEqual({
      plan: "email_only",
      reason: "capability_unchecked",
    });
  });

  it("refuses a number that came back not textable", () => {
    expect(explainChannelPlan({ ...base, imessageCapable: false })).toEqual({
      plan: "email_only",
      reason: "not_textable",
    });
  });

  it("names a suppressed phone rather than reporting it as uncheckable", () => {
    expect(
      explainChannelPlan({ ...base, phoneSuppressed: true }),
    ).toEqual({ plan: "email_only", reason: "phone_suppressed" });
  });

  it("falls back to text_only when the email cannot carry the sequence", () => {
    expect(
      explainChannelPlan({ ...base, emailUsable: false }),
    ).toEqual({ plan: "text_only", reason: "email_unusable_text_only" });
  });

  it("reports unreachable when there is neither channel", () => {
    expect(
      explainChannelPlan({
        emailUsable: false,
        hasPhone: false,
        imessageCapable: true,
        phoneSuppressed: false,
        textEnabled: true,
      }),
    ).toEqual({ plan: null, reason: "unreachable" });
  });

  /*
   * The switch has to be legible in the enrollment note: "email only" already
   * has five causes that need different fixes, and "we turned texting off" is
   * not one anybody should have to reverse engineer.
   */
  it("names the switch when it is what dropped the text steps", () => {
    expect(explainChannelPlan({ ...base, textEnabled: false })).toEqual({
      plan: "email_only",
      reason: "text_channel_off",
    });
    expect(channelPlanReasonLabel("text_channel_off")).toContain(
      "switched off",
    );
  });

  it("still blames the missing phone when there is no number to text anyway", () => {
    expect(
      explainChannelPlan({ ...base, hasPhone: false, textEnabled: false })
        .reason,
    ).toBe("no_phone");
  });

  it("names the switch, not unreachability, for a contact with only a phone", () => {
    expect(
      explainChannelPlan({ ...base, emailUsable: false, textEnabled: false }),
    ).toEqual({ plan: null, reason: "text_channel_off" });
  });

  it("agrees with resolveChannelPlan on the plan itself", () => {
    for (const emailUsable of [true, false]) {
      for (const hasPhone of [true, false]) {
        for (const imessageCapable of [true, false, null]) {
          for (const phoneSuppressed of [true, false]) {
            for (const textEnabled of [true, false]) {
              const input = {
                emailUsable,
                hasPhone,
                imessageCapable,
                phoneSuppressed,
                textEnabled,
              };
              expect(explainChannelPlan(input).plan).toBe(
                resolveChannelPlan({
                  emailUsable,
                  hasPhone,
                  textEligible: phoneIsTextEligible(input),
                  textEnabled,
                }),
              );
            }
          }
        }
      }
    }
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
