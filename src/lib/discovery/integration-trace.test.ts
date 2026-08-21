import { describe, expect, it } from "vitest";
import type { CompanyCardData } from "@/components/CompanyCard";
import type { DiscoveredOrganization } from "@/lib/domain-resolver";
import { buildCallListCsvRow } from "@/lib/call-list-csv-row";
import {
  activeReviewFilters,
  normalizeReviewScope,
  reviewQueueQueryFilters,
} from "@/lib/crm-location-scope";
import { scoreCompanyFirst } from "@/lib/lead-score";
import { selectDiscoveryCandidates } from "@/lib/discovery/candidates";
import { summarizeGateReasons } from "@/lib/discovery/exclusion-gate";
import { summarizeJobSignals } from "@/lib/discovery/job-signals";
import { canAddToCallList } from "@/lib/discovery/review-actions";
import { gateOrganizations, preferredIndustry } from "@/lib/discovery/run";
import { verticalEvidence } from "@/lib/discovery/vertical-evidence";
import { pickSingleDecisionMaker } from "@/lib/enrich/single-contact";

/**
 * One company, end to end, through every stage four separate branches
 * rewrote: provider page → exclusion gate → dedupe/attach → vertical evidence
 * → scoring → review-queue filtering → approve → single-contact pick → call
 * list → CSV export.
 *
 * Each of those stages has its own unit tests. This asserts they COMPOSE:
 * that the shape one stage emits is the shape the next one reads, and that a
 * decision made early survives to the end. It is deliberately one continuous
 * narrative rather than isolated cases, because the failures worth catching
 * here are handoff failures.
 *
 * Pure functions only — no database, no network, no credits.
 */

const VERTICAL = "legal";
const MARKET = "Palm Beach County, Florida";

function org(over: Partial<DiscoveredOrganization>): DiscoveredOrganization {
  return {
    name: "Kessler & Vance",
    domain: "kesslervance.com",
    websiteUrl: "https://kesslervance.com",
    industry: "law practice",
    estimatedEmployees: 48,
    phone: "+1 561-555-0100",
    linkedinUrl: "https://linkedin.com/company/kesslervance",
    foundedYear: 1998,
    city: "Boca Raton",
    state: "Florida",
    domainConfidence: "high",
    annualRevenue: null,
    publiclyTradedSymbol: null,
    ...over,
  };
}

describe("one discovered company, all the way through", () => {
  // The raw Apollo page: our target, a Fortune 500 legal department, a
  // staffing agency, and a municipality.
  const providerPage = [
    org({}),
    org({
      name: "Walmart",
      domain: "walmart.com",
      industry: "retail",
      estimatedEmployees: 2_100_000,
      publiclyTradedSymbol: "WMT",
    }),
    org({
      name: "Trinity Search Group",
      domain: "trinitysearchgroup.com",
      industry: "staffing and recruiting",
      estimatedEmployees: 40,
    }),
    org({
      name: "City of Deerfield Beach",
      domain: "deerfield-beach.gov",
      industry: "government administration",
      estimatedEmployees: 900,
    }),
  ];

  const gated = gateOrganizations(providerPage, VERTICAL, false);

  it("stage 1 — the gate rejects before dedupe and before any write", () => {
    expect(gated.kept.map((o) => o.name)).toEqual(["Kessler & Vance"]);
    expect(gated.rejected).toHaveLength(3);
    // Counted by reason, which is what makes a short run diagnosable.
    const reasons = summarizeGateReasons(gated.rejected);
    expect(Object.values(reasons).reduce((a, b) => a + b, 0)).toBe(3);
  });

  const selection = selectDiscoveryCandidates({
    vertical: VERTICAL,
    sized: gated.kept,
    unknownSize: [],
    limit: 25,
  });
  const candidate = selection.candidates[0];

  it("stage 2 — dedupe reads the gate's output, not the raw page", () => {
    // If the ordering ever flipped, the rejected companies would be here.
    expect(selection.candidates).toHaveLength(1);
    expect(candidate.name).toBe("Kessler & Vance");
    expect(candidate.sizeUnknown).toBe(false);
  });

  it("stage 3 — attach keeps Apollo's industry over a pipeline rollup", () => {
    // The job scrape derives "Professional & Business Services" from job
    // titles when Apollo gave it nothing. That placeholder must not outrank
    // Apollo's real answer, and a real value must never be overwritten.
    expect(
      preferredIndustry("Professional & Business Services", candidate.industry),
    ).toBe("law practice");
    expect(preferredIndustry("Immigration Law Practice", candidate.industry)).toBe(
      "Immigration Law Practice",
    );
    expect(preferredIndustry(null, candidate.industry)).toBe("law practice");
  });

  const evidence = verticalEvidence({
    vertical: VERTICAL,
    name: candidate.name,
    industry: candidate.industry,
  });

  it("stage 4 — the vertical is confirmed by the company's own data", () => {
    expect(evidence.status).toBe("confirmed");
  });

  // No job listings at all: the case the whole hiring-agnostic rework exists
  // to protect.
  const jobSignal = summarizeJobSignals([]);
  const leadScore = scoreCompanyFirst({
    vertical: VERTICAL,
    icpStatus: "pass",
    estimatedEmployees: candidate.estimatedEmployees,
    domainConfidence: candidate.domainConfidence,
    hasPhone: Boolean(candidate.phone),
    hasLinkedIn: Boolean(candidate.linkedinUrl),
    hiringSignals: {},
    openPositions: jobSignal.openPositions,
    exclusionFlags: [],
    verticalEvidence: evidence.status,
  });

  it("stage 5 — a company with no job postings still scores near the top", () => {
    expect(jobSignal.openPositions).toBe(0);
    expect(jobSignal.hasJobData).toBe(false);
    // 80 of a possible 86. The 6 it gives up is the entire capped job-activity
    // contribution, so not advertising a role costs it a tiebreak, not a page.
    expect(leadScore).toBe(80);
  });

  it("stage 6 — the review queue filters on found-in market, never geography", () => {
    const scope = normalizeReviewScope(
      { vertical: VERTICAL, dmarket: MARKET, hiring: "no_hiring" },
      { verticals: [VERTICAL], markets: [MARKET] },
    );
    const filters = reviewQueueQueryFilters(scope, {
      reviewStatus: "pending" as const,
      page: 1,
    });

    expect(filters.market).toBe(MARKET);
    expect(filters.hiring).toBe("no_hiring");
    // The rule that must survive every future merge: browse geography reads
    // job-listing locations, and this company has none, so any state/city
    // predicate here would hide it.
    expect(Object.keys(filters)).not.toContain("state");
    expect(Object.keys(filters)).not.toContain("city");

    // Every active filter is nameable and clearable, including the job-signal
    // one, so an empty result can never be misread as an empty queue.
    expect(activeReviewFilters(scope).map((f) => f.key)).toEqual([
      "vertical",
      "dmarket",
      "hiring",
    ]);
  });

  it("stage 7 — approve, then the credit goes to the managing partner", () => {
    const picked = pickSingleDecisionMaker(
      [
        {
          contactId: "c1",
          name: "Alice Nguyen",
          // Reordered and expanded: the substring matcher missed this one and
          // let the sector fallback choose instead.
          title: "Director, Human Resources",
          revealStatus: "discovered",
          locationMatched: true,
          priorityRank: 40,
          hasEmail: false,
          hasPhone: false,
        },
        {
          contactId: "c2",
          name: "Bea Salas",
          title: "Partner, Managing",
          revealStatus: "discovered",
          locationMatched: true,
          priorityRank: 90,
          hasEmail: false,
          hasPhone: false,
        },
        {
          contactId: "c3",
          name: "Cal Ortiz",
          title: "Assistant to the Managing Partner",
          revealStatus: "discovered",
          locationMatched: true,
          priorityRank: 0,
          hasEmail: false,
          hasPhone: false,
        },
      ],
      VERTICAL,
    );
    // Managing Partner outranks HR Director outranks the assistant, even
    // though the assistant has the best sector rank of the three.
    expect(picked?.name).toBe("Bea Salas");
  });

  it("stage 8 — an approved company can go on the call list, a stopped one cannot", () => {
    expect(canAddToCallList("approved")).toBe(true);
    expect(canAddToCallList("pending")).toBe(true);
    expect(canAddToCallList("do_not_contact")).toBe(false);
    expect(canAddToCallList("existing_client")).toBe(false);
  });

  it("stage 9 — the CSV reports no job data as blank, not as zero", () => {
    const company = {
      id: "company-1",
      name: candidate.name,
      domain: candidate.domain,
      industry: candidate.industry,
      city: candidate.city,
      state: candidate.state,
      vertical: VERTICAL,
      phone: candidate.phone,
      linkedinUrl: candidate.linkedinUrl,
      leadScore,
      contacts: [],
      jobListings: [],
      hiringSignals: {},
    } as unknown as CompanyCardData;

    const row = buildCallListCsvRow({
      entry: {
        primaryContactId: null,
        callStatus: "new",
        outreachAngle: null,
        attempts: 0,
        lastContactAt: null,
        nextFollowUpDate: null,
        notes: null,
        assignedTo: null,
        finalResult: null,
        addedAt: new Date("2026-08-21T00:00:00Z"),
      },
      company,
      marketLabel: MARKET,
    });

    expect(row.company_name).toBe("Kessler & Vance");
    expect(row.vertical).toBe("Legal");
    expect(row.market).toBe(MARKET);
    // The blank-versus-zero fix: never scraped is not the same fact as
    // scraped and hiring nobody.
    expect(row.open_positions).toBe("");
    // A company-only row is valid: no contact, no listing, still callable.
    expect(row.main_company_phone).toBe("+1 561-555-0100");
    expect(row.opportunity_score).toBe(80);
  });
});
