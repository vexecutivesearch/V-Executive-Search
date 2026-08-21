import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  usePathname: () => "/crm",
  useSearchParams: () => new URLSearchParams(),
}));

const { DiscoveryReviewList } = await import(
  "@/components/crm/DiscoveryReviewList"
);
type ListProps = Parameters<typeof DiscoveryReviewList>[0];

const FACETS = {
  verticals: [],
  markets: ["Palm Beach County, Florida", "Huntsville, Alabama"],
};

const NO_COUNTS: ListProps["counts"] = {
  pending: 0,
  approved: 0,
  rejected: 0,
  review_later: 0,
  already_contacted: 0,
  existing_client: 0,
  do_not_contact: 0,
  total: 0,
};

/** Every queue filter at its "off" value; overrides name only what is active. */
function scope(
  overrides: Partial<ListProps["active"]> = {},
): ListProps["active"] {
  return {
    reviewStatus: "pending",
    vertical: "",
    market: "",
    search: "",
    hiring: "any",
    ...overrides,
  };
}

/** A company-first Apollo row: no job listings at all, HQ only. */
function row(id: string): ListProps["result"]["rows"][number] {
  return {
    id,
    name: `Company ${id}`,
    domain: `${id}.example`,
    website: `https://${id}.example`,
    industry: "construction",
    city: "West Palm Beach",
    state: "Florida",
    stateAbbr: "FL",
    estimatedEmployees: null,
    sizeUnknown: true,
    phone: null,
    linkedinUrl: null,
    vertical: null,
    verticalLabel: null,
    verticalEvidence: {
      status: "unverified",
      matchedOn: null,
      reason: "No vertical recorded for this company.",
      looksLike: null,
    },
    industryIsRollup: false,
    reviewStatus: "pending",
    leadScore: 0,
    icpAdjustedScore: null,
    icpFlags: [],
    icpStatus: "unknown",
    market: "Palm Beach County, Florida",
    jobSignal: {
      openPositions: 0,
      oldestTitle: null,
      oldestOpenDays: null,
      label: null,
    },
    contactCount: 0,
    revealedContactCount: 0,
    primaryContact: null,
    firstSeen: "2026-08-01",
  };
}

function render(overrides: Partial<ListProps> = {}): string {
  const props: ListProps = {
    result: { rows: [], totalMatched: 0, page: 1, pageCount: 1 },
    counts: NO_COUNTS,
    queueTotal: 0,
    facets: FACETS,
    active: scope(),
    buildHref: (changes) =>
      `/crm?tab=discovery&${Object.entries(changes)
        .map(([k, v]) => `${k}=${v ?? ""}`)
        .join("&")}`,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(DiscoveryReviewList, props));
}

describe("DiscoveryReviewList — the bucket count is the list's own count", () => {
  it("counts the active bucket from the rows the query matched", () => {
    // The live bug: chips read "Pending (47)" over an empty list because the
    // counts ignored a filter the list applied.
    const html = render({
      result: { rows: [], totalMatched: 0, page: 1, pageCount: 1 },
      counts: { ...NO_COUNTS, pending: 47, total: 48 },
      queueTotal: 48,
      active: scope({ market: "Huntsville, Alabama" }),
    });
    expect(html).toContain("Pending (0)");
    expect(html).not.toContain("Pending (47)");
  });

  it("still reports the other buckets under the same scope", () => {
    const html = render({
      result: { rows: [row("a")], totalMatched: 1, page: 1, pageCount: 1 },
      counts: { ...NO_COUNTS, pending: 1, approved: 3, total: 4 },
      queueTotal: 4,
    });
    expect(html).toContain("Pending (1)");
    expect(html).toContain("Approved (3)");
    expect(html).toContain("All (4)");
  });

  it("counts the All bucket from the list when All is the active bucket", () => {
    const html = render({
      result: { rows: [row("a")], totalMatched: 1, page: 1, pageCount: 1 },
      counts: { ...NO_COUNTS, pending: 9, total: 9 },
      queueTotal: 9,
      active: scope({
        reviewStatus: "all",
        market: "Palm Beach County, Florida",
      }),
    });
    expect(html).toContain("All (1)");
  });
});

describe("DiscoveryReviewList — empty states say which is which", () => {
  it("blames the filters, not the operator, when a filter hides everything", () => {
    const html = render({
      counts: { ...NO_COUNTS, total: 0 },
      queueTotal: 47,
      active: scope({ market: "Huntsville, Alabama" }),
    });
    expect(html).toContain("found in Huntsville, Alabama");
    expect(html).toContain("the filters are hiding them");
    expect(html).toContain("Clear queue filters");
    // Never the first-run prompt: the operator already ran discovery.
    expect(html).not.toContain("Nothing discovered yet");
  });

  it("prompts a first run only when the queue is genuinely empty", () => {
    const html = render({ queueTotal: 0 });
    expect(html).toContain("Nothing discovered yet");
    expect(html).not.toContain("Clear queue filters");
  });

  it("names the empty bucket when no filter is to blame", () => {
    const html = render({
      counts: { ...NO_COUNTS, pending: 12, total: 12 },
      queueTotal: 12,
      active: scope({ reviewStatus: "approved" }),
    });
    expect(html).toContain("Nothing in the approved bucket");
    expect(html).not.toContain("Nothing discovered yet");
  });
});

describe("DiscoveryReviewList — found-in market is the queue's geography", () => {
  it("offers an All markets escape from every found-in chip", () => {
    const html = render({
      queueTotal: 3,
      active: scope({ market: "Huntsville, Alabama" }),
      result: { rows: [row("a")], totalMatched: 1, page: 1, pageCount: 1 },
      counts: { ...NO_COUNTS, pending: 1, total: 1 },
    });
    expect(html).toContain("All markets");
    expect(html).toContain("Palm Beach County, Florida");
  });

  it("keeps a zero-listing company in the queue and names where it was found", () => {
    // No job listings means no job geography; the found-in market is the only
    // location this row has, and the queue filters on exactly that.
    const html = render({
      result: { rows: [row("a")], totalMatched: 1, page: 1, pageCount: 1 },
      counts: { ...NO_COUNTS, pending: 1, total: 1 },
      queueTotal: 1,
      active: scope({ market: "Palm Beach County, Florida" }),
    });
    expect(html).toContain("Company a");
    expect(html).toContain("Pending (1)");
    expect(html).not.toContain("Nothing discovered yet");
  });

  it("says the queue is not narrowed by job-listing geography", () => {
    expect(render({ queueTotal: 1 })).toContain("found in");
  });
});
