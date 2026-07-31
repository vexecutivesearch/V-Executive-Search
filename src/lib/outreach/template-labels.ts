import type { OutreachChannel, OutreachTemplateKind } from "@/lib/db/schema";

/**
 * Human labels for the structured facets of a template. The admin tables render
 * these as their own column or badge, which is what keeps them out of the
 * template name: a row reads "Intro email, boutique firm pitch | Intro | Email"
 * rather than stacking "(won reply) (intro)" after the name.
 */

const KIND_LABELS: Record<OutreachTemplateKind, string> = {
  intro: "Intro",
  followup_1: "Follow up 1",
  followup_2: "Follow up 2",
  text_1: "Text 1",
  text_2: "Text 2",
  text_3: "Text 3",
  reply_positive: "Positive reply",
  reply_info_request: "Question reply",
  reply_decline: "Decline reply",
  booking_confirmation: "Booking confirmation",
};

const CHANNEL_LABELS: Record<OutreachChannel, string> = {
  email: "Email",
  imessage: "Text",
};

export function templateKindLabel(kind: string): string {
  return KIND_LABELS[kind as OutreachTemplateKind] ?? kind;
}

export function templateChannelLabel(channel: string): string {
  return CHANNEL_LABELS[channel as OutreachChannel] ?? channel;
}

/** Spelled out because "won reply" meant nothing to anyone reading the bank. */
export const PROVEN_BADGE_LABEL = "real send that got a reply";
