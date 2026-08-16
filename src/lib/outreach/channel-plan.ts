/**
 * Channel plan for a sequence enrollment — which transports the sequence
 * will actually use. Pure module (no imports) so client components and unit
 * tests can share it with the enroll pipeline.
 *
 * text_only exists because the Mac worker has its own IDS capability check
 * with automatic SMS fallback: any phone number can receive a text, so a
 * contact with a phone but no usable email must still enroll.
 */

export type ChannelPlan = "email_and_text" | "email_only" | "text_only";

/**
 * Resolve the plan from what we know at enroll time. Returns null when the
 * contact is unreachable on every channel (caller refuses the enrollment).
 *
 * textEligible = phone present AND imessage-capable AND not suppressed; it
 * only widens an email plan. A usable email is never required for text_only.
 */
export function resolveChannelPlan(input: {
  emailUsable: boolean;
  hasPhone: boolean;
  textEligible: boolean;
}): ChannelPlan | null {
  if (input.emailUsable) {
    return input.textEligible ? "email_and_text" : "email_only";
  }
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
  | "imessage_capability_unknown"
  | "imessage_capability_false"
  | "phone_suppressed"
  | "email_unusable_text_only"
  | "unreachable";

export type ChannelPlanDecision = {
  plan: ChannelPlan | null;
  reason: ChannelPlanReason;
};

export function explainChannelPlan(input: {
  emailUsable: boolean;
  hasPhone: boolean;
  /** contacts.imessage_capable — null when the Mac worker has not answered. */
  imessageCapable: boolean | null;
  phoneSuppressed: boolean;
}): ChannelPlanDecision {
  const textEligible =
    input.imessageCapable === true &&
    input.hasPhone &&
    !input.phoneSuppressed;
  const plan = resolveChannelPlan({
    emailUsable: input.emailUsable,
    hasPhone: input.hasPhone,
    textEligible,
  });

  if (plan === null) return { plan, reason: "unreachable" };
  if (plan === "text_only") {
    return { plan, reason: "email_unusable_text_only" };
  }
  if (plan === "email_and_text") return { plan, reason: "text_added" };

  if (!input.hasPhone) return { plan, reason: "no_phone" };
  if (input.phoneSuppressed) return { plan, reason: "phone_suppressed" };
  if (input.imessageCapable === null) {
    return { plan, reason: "imessage_capability_unknown" };
  }
  return { plan, reason: "imessage_capability_false" };
}

export function channelPlanReasonLabel(reason: ChannelPlanReason): string {
  switch (reason) {
    case "text_added":
      return "text steps added";
    case "no_phone":
      return "no phone number on the contact";
    case "imessage_capability_unknown":
      return "iMessage capability not checked yet — the Mac worker has not answered for this contact";
    case "imessage_capability_false":
      return "the contact's handle came back not textable";
    case "phone_suppressed":
      return "the phone number is suppressed";
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
