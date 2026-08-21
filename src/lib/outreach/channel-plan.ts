/**
 * Channel plan for a sequence enrollment — which transports the sequence
 * will actually use. Pure module (no imports) so client components and unit
 * tests can share it with the enroll pipeline.
 *
 * text_only exists because the Mac worker has its own IDS capability check
 * with automatic SMS fallback: any phone number can receive a text, so a
 * contact with a phone but no usable email must still enroll.
 *
 * Every plan is subject to the admin text channel switch. While it is off no
 * plan carries a text step at all, which is what keeps texts from being
 * drafted in the first place rather than merely held further downstream.
 */

export type ChannelPlan = "email_and_text" | "email_only" | "text_only";

/**
 * Resolve the plan from what we know at enroll time. Returns null when the
 * contact is unreachable on every channel (caller refuses the enrollment).
 *
 * textEligible = a phone we are allowed to text; it only widens an email
 * plan. A usable email is never required for text_only.
 *
 * textEnabled is the admin text channel switch and it outranks everything
 * else here: while it is off no plan may carry a text step, which includes
 * text_only. A contact with no usable email is simply not enrollable then,
 * because the alternative is enrolling them into a sequence that can never
 * send anything.
 */
export function resolveChannelPlan(input: {
  emailUsable: boolean;
  hasPhone: boolean;
  textEligible: boolean;
  textEnabled: boolean;
}): ChannelPlan | null {
  if (input.emailUsable) {
    return input.textEligible && input.textEnabled
      ? "email_and_text"
      : "email_only";
  }
  if (!input.textEnabled) return null;
  return input.hasPhone ? "text_only" : null;
}

/**
 * Why the plan came out the way it did. "email only" is the default outcome
 * for several unrelated causes — no phone, an unusable phone, or an iMessage
 * capability answer that never arrived — and they need very different fixes,
 * so record which one applied instead of leaving it to be reverse-engineered.
 */
export type ChannelPlanReason =
  | "text_added"
  | "no_phone"
  | "capability_unchecked"
  | "not_textable"
  | "phone_suppressed"
  | "text_channel_off"
  | "email_unusable_text_only"
  | "unreachable";

export type ChannelPlanDecision = {
  plan: ChannelPlan | null;
  reason: ChannelPlanReason;
};

/**
 * Can we add text steps to an email plan?
 *
 * Deliberately conservative: the contact must have a phone, an affirmative
 * capability answer, and no suppression. `null` is not "probably fine" — it
 * means the Mac worker has not answered yet, and an enrollment that waits one
 * check cycle is cheaper than texting someone we never confirmed.
 *
 * text_only plans are the documented exception and do NOT use this: with no
 * usable email the number is the only way to reach the contact at all, and
 * the worker's IDS check plus SMS fallback can carry it.
 */
export function phoneIsTextEligible(input: {
  hasPhone: boolean;
  imessageCapable: boolean | null;
  phoneSuppressed: boolean;
}): boolean {
  return (
    input.hasPhone && input.imessageCapable === true && !input.phoneSuppressed
  );
}

export function explainChannelPlan(input: {
  emailUsable: boolean;
  hasPhone: boolean;
  /** contacts.imessage_capable — null when the Mac worker has not answered. */
  imessageCapable: boolean | null;
  phoneSuppressed: boolean;
  /** outreach_settings.text_enabled — the admin text channel switch. */
  textEnabled: boolean;
}): ChannelPlanDecision {
  const plan = resolveChannelPlan({
    emailUsable: input.emailUsable,
    hasPhone: input.hasPhone,
    textEligible: phoneIsTextEligible(input),
    textEnabled: input.textEnabled,
  });

  if (plan === null) {
    // A phone we are not allowed to use is a switch problem, not a data one.
    return {
      plan,
      reason: input.hasPhone && !input.textEnabled ? "text_channel_off" : "unreachable",
    };
  }
  if (plan === "text_only") {
    return { plan, reason: "email_unusable_text_only" };
  }
  if (plan === "email_and_text") return { plan, reason: "text_added" };

  if (!input.hasPhone) return { plan, reason: "no_phone" };
  if (!input.textEnabled) return { plan, reason: "text_channel_off" };
  if (input.phoneSuppressed) return { plan, reason: "phone_suppressed" };
  if (input.imessageCapable === null) {
    return { plan, reason: "capability_unchecked" };
  }
  return { plan, reason: "not_textable" };
}

export function channelPlanReasonLabel(reason: ChannelPlanReason): string {
  switch (reason) {
    case "text_added":
      return "text steps added";
    case "no_phone":
      return "no phone number on the contact";
    case "capability_unchecked":
      return "has a phone but the Mac worker has not run its text check yet — it upgrades to email + SMS once that lands";
    case "not_textable":
      return "the contact's number came back not textable";
    case "phone_suppressed":
      return "the phone number is suppressed";
    case "text_channel_off":
      return "the text channel is switched off in Admin, Safety switches";
    case "email_unusable_text_only":
      return "no usable email — text only";
    case "unreachable":
      return "no reachable channel";
  }
}

/** Keep only the steps the plan's transports can carry. */
export function filterStepSpecsForPlan<
  T extends { channel: "email" | "imessage" },
>(plan: ChannelPlan, specs: readonly T[]): T[] {
  if (plan === "email_only") return specs.filter((s) => s.channel === "email");
  if (plan === "text_only") {
    return specs.filter((s) => s.channel === "imessage");
  }
  return [...specs];
}

/** Human label for UI notes and Call List badges. */
export function channelPlanLabel(plan: string | null | undefined): string {
  if (plan === "email_and_text") return "email + SMS";
  if (plan === "text_only") return "text only";
  return "email only";
}
