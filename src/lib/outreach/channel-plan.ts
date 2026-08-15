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
