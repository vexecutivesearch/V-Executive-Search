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
import {
  headcountProvenance,
  mergeQuantified,
} from "@/lib/discovery/sources/apollo-quantify";
import { verticalEvidence } from "@/lib/discovery/vertical-evidence";
import { pickSingleDecisionMaker } from "@/lib/enrich/single-contact";

/**
 * One company, end to end, through every stage these branches rewrote:
 * provider page → Apollo quantify → exclusion gate → dedupe/attach → vertical
 * evidence → scoring → review-queue filtering → approve → single-contact pick
 * → call list → CSV export.
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

  /*
   * The SerpApi Google Maps page. Maps can name a company and give it a Google
   * Business category, but it never knows headcount, revenue or a ticker — so
   * these rows arrive with nothing the gate's structural rules can read.
   */
  const mapsPage = [
    org({
      name: "Harbor Point Legal",
      domain: "harborpointlegal.com",
      websiteUrl: "https://harborpointlegal.com",
      industry: "Law firm",
      estimatedEmployees: null,
      linkedinUrl: null,
    }),
    org({
      name: "Meridian Advisory Group",
      domain: "meridianadvisory.com",
      websiteUrl: "https://meridianadvisory.com",
      // A staffing agency with a polished Google Business Profile. Nothing in
      // this row is rejectable.
      industry: "Business management consultant",
      estimatedEmployees: null,
      linkedinUrl: null,
    }),
  ];

  // What Apollo returns for those two domains, keyed on the normalised domain.
  const quantified = [
    mergeQuantified(
      mapsPage[0],
      org({
        name: "Harbor Point Legal",
        domain: "harborpointlegal.com",
        industry: "law practice",
        estimatedEmployees: 30,
      }),
      { domain: "harborpointlegal.com" },
    ),
    mergeQuantified(
      mapsPage[1],
      org({
        name: "Meridian Advisory Group",
        domain: "meridianadvisory.com",
        industry: "staffing & recruiting",
        estimatedEmployees: 22,
      }),
      { domain: "meridianadvisory.com" },
    ),
  ];

  it("stage 0 — Apollo sizes the Maps rows, and display precedence holds", () => {
    expect(quantified.map((o) => o.estimatedEmployees)).toEqual([30, 22]);
    expect(quantified.map((o) => headcountProvenance(o))).toEqual([
      "apollo",
      "apollo",
    ]);
    // A real value is never overwritten by a second provider's, so the
    // operator's screen still reads the Google category.
    expect(quantified.map((o) => o.industry)).toEqual([
      "Law firm",
      "Business management consultant",
    ]);
    // But Apollo's taxonomy is kept alongside it rather than discarded — the
    // gate is about to need it.
    expect(quantified.map((o) => o.quantification.apolloIndustry)).toEqual([
      "law practice",
      "staffing & recruiting",
    ]);
  });

  /*
   * Quantify runs BEFORE the gate. A gate that ran first would see two
   * size-unknown rows with unrejectable Google categories and wave both
   * through — including the staffing agency.
   *
   * Quantified rows join the SIZED pool, not the unknown one: candidate
   * selection drops any unknown-pool row that has a headcount, so routing by
   * where the row came from rather than by what is now known about it would
   * silently delete the company Apollo just paid to size.
   */
  const gated = gateOrganizations(
    [...providerPage, ...quantified.filter((o) => o.estimatedEmployees != null)],
    VERTICAL,
    false,
  );

  it("stage 1 — the gate rejects before dedupe and before any write", () => {
    expect(gated.kept.map((o) => o.name)).toEqual([
      "Kessler & Vance",
      "Harbor Point Legal",
    ]);
    expect(gated.rejected).toHaveLength(4);
    // Counted by reason, which is what makes a short run diagnosable.
    const reasons = summarizeGateReasons(gated.rejected);
    expect(Object.values(reasons).reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("stage 1b — the gate judges the Maps row on Apollo's taxonomy", () => {
    // The fail-open this pipeline order exists to close. Handing the gate the
    // display industry hides "staffing & recruiting" behind "Business
    // management consultant", and a 22-person staffing agency — comfortably
    // inside the legal band — is ACCEPTED into review.
    const agency = gated.rejected.find((d) =>
      d.detail.includes("staffing & recruiting"),
    );
    expect(agency?.reason).toBe("staffing_agency");
    expect(gated.kept.map((o) => o.name)).not.toContain(
      "Meridian Advisory Group",
    );
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
    expect(selection.candidates.map((c) => c.name)).toEqual([
      "Kessler & Vance",
      "Harbor Point Legal",
    ]);
    expect(candidate.name).toBe("Kessler & Vance");
    expect(candidate.sizeUnknown).toBe(false);
    // The quantified Maps row survived selection with its headcount and its
    // provenance, so the review queue can say WHO sized it.
    const harbor = selection.candidates[1];
    expect(harbor.sizeUnknown).toBe(false);
    expect(headcountProvenance(harbor)).toBe("apollo");
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
