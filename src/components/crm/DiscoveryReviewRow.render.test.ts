import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The row calls useRouter() to refresh after an action; static markup has no
// mounted app router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

import { DiscoveryReviewRow } from "@/components/crm/DiscoveryReviewRow";
import type { ReviewQueueRow } from "@/lib/discovery/review-queue";
import { summarizeJobSignals } from "@/lib/discovery/job-signals";

const ROW: ReviewQueueRow = {
  id: "53b96f06-482d-4b27-9b28-3bbcfac2c287",
  name: "Kessler & Vance LLP",
  domain: "kesslervance.example",
  website: "https://kesslervance.example",
  industry: "Law Practice",
  city: "Boca Raton",
  state: "Florida",
  stateAbbr: "FL",
  estimatedEmployees: 48,
  sizeUnknown: false,
  phone: "(561) 555-0100",
  linkedinUrl: "linkedin.com/company/kesslervance",
  vertical: "legal",
  verticalLabel: "Legal",
  reviewStatus: "pending",
  leadScore: 74,
  icpAdjustedScore: 71,
  icpFlags: [],
  icpStatus: "pass",
  market: "South Florida",
  jobSignal: summarizeJobSignals([]),
  contactCount: 0,
  revealedContactCount: 0,
  onCallList: false,
  primaryContact: null,
  firstSeen: "2026-07-30",
};

function render(over: Partial<ReviewQueueRow> = {}): string {
  return renderToStaticMarkup(
    createElement(DiscoveryReviewRow, { row: { ...ROW, ...over } }),
  );
}

describe("DiscoveryReviewRow — review actions", () => {
  it("offers all six operator dispositions plus the enrichment approval", () => {
    const html = render();
    expect(html).toContain("Approve for enrichment");
    expect(html).toContain("Reject");
    expect(html).toContain("Review later");
    expect(html).toContain("Already contacted");
    expect(html).toContain("Existing client");
    expect(html).toContain("Do not contact");
  });

  it("hides Find additional contact until a contact has been revealed", () => {
    expect(render().includes("Find additional contact")).toBe(false);
    expect(render({ revealedContactCount: 1 })).toContain(
      "Find additional contact",
    );
  });

  it("keeps phone reveal opt-in, not default-on", () => {
    // An Apollo fallback mobile is 8 extra credits; it must never be pre-checked.
    const html = render();
    expect(html).toContain("Also reveal phone");
    expect(html).not.toContain('type="checkbox" checked');
  });
});

describe("DiscoveryReviewRow — Add to Call List", () => {
  it("offers a company-only add when nothing has been enriched yet", () => {
    // No contact and no job posting is still a valid call target.
    const html = render();
    expect(html).toContain("Add to Call List (main line)");
    expect(html).toContain("cold-call the main line");
  });

  it("drops the main-line wording once a contact is revealed", () => {
    const html = render({ revealedContactCount: 1 });
    expect(html).toContain("Add to Call List");
    expect(html).not.toContain("Add to Call List (main line)");
  });

  it("links to the call list instead of re-adding when already on it", () => {
    const html = render({ onCallList: true });
    expect(html).toContain("On Call List");
    expect(html).not.toContain("Add to Call List");
  });

  it("withholds the add for decisions that mean stop", () => {
    for (const status of ["do_not_contact", "existing_client", "rejected"] as const) {
      expect(render({ reviewStatus: status })).not.toContain("Add to Call List");
    }
  });

  it("still offers the add for review-later and already-contacted", () => {
    expect(render({ reviewStatus: "review_later" })).toContain("Add to Call List");
    expect(render({ reviewStatus: "already_contacted" })).toContain(
      "Add to Call List",
    );
  });
});

describe("DiscoveryReviewRow — job postings are a signal, not a gate", () => {
  it("says so on a company with no postings and still allows every action", () => {
    const html = render();
    expect(html).toContain("hiring is a signal, not a requirement");
    expect(html).toContain("Approve for enrichment");
    expect(html).toContain("Add to Call List");
  });
});
