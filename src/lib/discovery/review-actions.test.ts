import { describe, expect, it } from "vitest";
import { companyReviewStatusEnum } from "@/lib/db/schema";
import {
  canAddToCallList,
  companyStatusForReviewStatus,
  REVIEW_STATUS_LABELS,
} from "@/lib/discovery/review-actions";

describe("review dispositions", () => {
  it("covers exactly the six operator decisions plus pending", () => {
    expect([...companyReviewStatusEnum.enumValues].sort()).toEqual([
      "already_contacted",
      "approved",
      "do_not_contact",
      "existing_client",
      "pending",
      "rejected",
      "review_later",
    ]);
    for (const status of companyReviewStatusEnum.enumValues) {
      expect(REVIEW_STATUS_LABELS[status]).toBeTruthy();
    }
  });

  it("stops the pipeline only for do-not-contact and existing-client", () => {
    expect(companyStatusForReviewStatus("do_not_contact")).toBe("skipped");
    expect(companyStatusForReviewStatus("existing_client")).toBe("client");
  });

  it("leaves pipeline status alone for every other decision", () => {
    // Enrollment gates on status 'new'; a review annotation must not consume it.
    for (const status of [
      "pending",
      "approved",
      "rejected",
      "review_later",
      "already_contacted",
    ] as const) {
      expect(companyStatusForReviewStatus(status)).toBeNull();
    }
  });

  it("hides the Call List add only for the decisions that mean stop", () => {
    expect(canAddToCallList("do_not_contact")).toBe(false);
    expect(canAddToCallList("existing_client")).toBe(false);
    expect(canAddToCallList("rejected")).toBe(false);

    expect(canAddToCallList("pending")).toBe(true);
    expect(canAddToCallList("approved")).toBe(true);
    expect(canAddToCallList("review_later")).toBe(true);
    expect(canAddToCallList("already_contacted")).toBe(true);
  });
});
