import type { LeadSource } from "@/lib/db/schema";

/**
 * What each lane permits. This is the policy Part 2 encodes, in one place, so
 * no caller has to re-derive it:
 *
 *  - cold_discovery: email only. No SMS ever without a consent record.
 *    Eligible for a human call to the company main line.
 *  - inbound_form / inbound_meta: arrived with a written consent artifact, so
 *    email plus SMS is permitted. Excluded from cold calling — they already
 *    raised a hand, and calling them as a cold lead would be both rude and
 *    a waste of the caller's list.
 *
 * "SMS permitted" here means the lane does not forbid it. The actual send
 * still has to find a live consent record via hasSmsConsent; the lane is a
 * precondition, never the permission itself.
 */

export const LEAD_SOURCES: LeadSource[] = [
  "cold_discovery",
  "inbound_form",
  "inbound_meta",
];

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  cold_discovery: "Cold",
  inbound_form: "Inbound — form",
  inbound_meta: "Inbound — Meta",
};

export const LEAD_SOURCE_DESCRIPTIONS: Record<LeadSource, string> = {
  cold_discovery:
    "Found by us. Email only, plus a human call to the company main line.",
  inbound_form:
    "Raised a hand on our opt-in form. Email and SMS permitted; excluded from cold calling.",
  inbound_meta:
    "Raised a hand from a Meta ad. Email and SMS permitted; excluded from cold calling.",
};

export const LEAD_SOURCE_BADGE_CLASSES: Record<LeadSource, string> = {
  cold_discovery:
    "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  inbound_form:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  inbound_meta:
    "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300",
};

/** Null/undefined reads as cold: the pre-lane default for every legacy row. */
export function normalizeLeadSource(
  value: string | null | undefined,
): LeadSource {
  return isLeadSource(value) ? value : "cold_discovery";
}

export function isLeadSource(value: unknown): value is LeadSource {
  return (
    typeof value === "string" && (LEAD_SOURCES as string[]).includes(value)
  );
}

export function isInboundLane(value: string | null | undefined): boolean {
  return normalizeLeadSource(value) !== "cold_discovery";
}

/** Cold leads are the callable list; inbound leads already called us. */
export function eligibleForColdCalling(
  value: string | null | undefined,
): boolean {
  return !isInboundLane(value);
}

/** The lane permits SMS. A live consent record is still required to send. */
export function lanePermitsSms(value: string | null | undefined): boolean {
  return isInboundLane(value);
}

export function leadSourceLabel(value: string | null | undefined): string {
  return LEAD_SOURCE_LABELS[normalizeLeadSource(value)];
}
