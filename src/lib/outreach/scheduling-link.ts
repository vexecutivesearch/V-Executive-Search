/**
 * The one booking URL the sequencer knows about.
 *
 * The rule engine injects this link into the live positive reply, the Template
 * bank exemplars render it, and the drafting prompts quote the meeting length
 * off it. Keeping all three on this module is what stops the bank from
 * advertising a link (or a call length) that the real sends no longer use.
 */

/** Booking URL used when OUTREACH_SCHEDULING_LINK is unset. */
export const DEFAULT_SCHEDULING_LINK =
  "https://calendly.com/odv-vexecutivesearch/15m";

export function resolveSchedulingLink(): string {
  const fromEnv = process.env.OUTREACH_SCHEDULING_LINK?.trim();
  return fromEnv || DEFAULT_SCHEDULING_LINK;
}

const MINUTES_IN_SLUG = /(\d+)[\s_-]*(?:minutes?|mins?|m)(?![a-z0-9])/;
const HOURS_IN_SLUG = /(\d+)[\s_-]*(?:hours?|hrs?|h)(?![a-z0-9])/;

/**
 * Meeting length read off the booking slug ("/15m", "/30min", "/1-hour").
 *
 * Copy that invites somebody to book has to name the same length as the page
 * they land on: a link swap from a 30 minute event type to a 15 minute one
 * otherwise leaves "grab any 30 min" in the exemplars and in the prompt.
 * Returns null for a slug that says nothing about duration ("/intro-call"), and
 * callers phrase around it rather than guessing.
 */
export function schedulingCallLength(
  link: string = resolveSchedulingLink(),
): string | null {
  const slug = link.trim().replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop();
  if (!slug) return null;
  const lower = slug.toLowerCase();

  const minutes = MINUTES_IN_SLUG.exec(lower);
  if (minutes) {
    const value = Number(minutes[1]);
    if (value > 0) return `${value} min`;
  }

  const hours = HOURS_IN_SLUG.exec(lower);
  if (hours) {
    const value = Number(hours[1]);
    if (value > 0) return value === 1 ? "1 hour" : `${value} hours`;
  }

  return null;
}
