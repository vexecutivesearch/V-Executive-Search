/**
 * Disposition rules for the discovery review queue — pure, no DB.
 *
 * Two of the six review decisions are also pipeline decisions. Everything else
 * is an annotation on top of the pipeline: a review decision must never move a
 * company out of status 'new', because outreach enrollment gates on it and a
 * "review later" would silently become "never".
 */

import type { CompanyReviewStatus, CompanyStatus } from "@/lib/db/schema";

export const REVIEW_STATUS_LABELS: Record<CompanyReviewStatus, string> = {
  pending: "Pending review",
  approved: "Approved",
  rejected: "Rejected",
  review_later: "Review later",
  already_contacted: "Already contacted",
  existing_client: "Existing client",
  do_not_contact: "Do not contact",
};

/**
 * Pipeline status a review decision implies, or null to leave it alone.
 * 'skipped' and 'client' both already mean "stop" to the rest of the system,
 * which is what do-not-contact and existing-client mean here.
 */
export function companyStatusForReviewStatus(
  status: CompanyReviewStatus,
): CompanyStatus | null {
  if (status === "do_not_contact") return "skipped";
  if (status === "existing_client") return "client";
  return null;
}

/**
 * Whether the Call List add action should be offered for a company in this
 * review state. Note this is about the three decisions that mean "stop" — a
 * company with no contacts and no job posting is still perfectly addable,
 * because the operator can cold-call the main line.
 */
export function canAddToCallList(status: CompanyReviewStatus): boolean {
  return (
    status !== "do_not_contact" &&
    status !== "existing_client" &&
    status !== "rejected"
  );
}
