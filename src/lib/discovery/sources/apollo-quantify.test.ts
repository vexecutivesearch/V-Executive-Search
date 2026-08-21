import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APOLLO_DOMAIN_LIST_MAX,
  buildOrganizationSearchBody,
  type DiscoveredOrganization,
} from "@/lib/domain-resolver";
import { selectDiscoveryCandidates } from "@/lib/discovery/candidates";
import {
  APOLLO_QUANTIFY_BATCH,
  APOLLO_QUANTIFY_FLAG,
  gateInputFor,
  headcountProvenance,
  mergeQuantified,
  namesAgree,
  planQuantify,
  quantifyDomain,
  quantifyOrganizations,
  type QuantifyLookup,
} from "@/lib/discovery/sources/apollo-quantify";

/*
 * No live Apollo calls, ever: the lookup is injected and returns fixtures shaped
 * like Apollo's documented organization-search response.
 */

const insertValues = vi.fn<(row: Record<string, unknown>) => void>();

vi.mock("@/lib/db", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => {
        void insertValues(row);
        return Promise.resolve(undefined);
      }),
    })),
  },
}));

function org(overrides: Partial<DiscoveredOrganization> = {}): DiscoveredOrganization {
  return {
    name: "Palm Beach Roofing Co",
    domain: "palmbeachroofing.com",
    websiteUrl: "https://www.palmbeachroofing.com/",
    industry: "Roofing contractor",
    estimatedEmployees: null,
    phone: "+1 561-555-0142",
    linkedinUrl: null,
    foundedYear: null,
    city: "West Palm Beach",
    state: "FL",
    domainConfidence: "high",
    ...overrides,
  };
}

/** An Apollo organization-search row. */
function apolloOrg(overrides: Partial<DiscoveredOrganization> = {}): DiscoveredOrganization {
  return {
    name: "Palm Beach Roofing",
    domain: "palmbeachroofing.com",
    websiteUrl: "http://www.palmbeachroofing.com",
    industry: "construction",
    estimatedEmployees: 18,
    phone: "+1 561-555-9999",
    linkedinUrl: "http://www.linkedin.com/company/palm-beach-roofing",
    foundedYear: 2004,
    city: "Palm Beach",
    state: "Florida",
    domainConfidence: "high",
    annualRevenue: 4_200_000,
    publiclyTradedSymbol: null,
    ...overrides,
  };
}

const CONTEXT = "manual_enrich:discovery:construction:test" as const;

function lookupReturning(
  rows: DiscoveredOrganization[],
): { lookup: QuantifyLookup; calls: string[][] } {
  const calls: string[][] = [];
  const lookup: QuantifyLookup = async ({ domains }) => {
    calls.push(domains);
    return rows.filter((row) => domains.includes(row.domain ?? ""));
  };
  return { lookup, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env[APOLLO_QUANTIFY_FLAG];
  delete process.env.APOLLO_QUANTIFY_RUN_CREDIT_CAP;
});

/* ------------------------------------------------------------------ */

describe("quantifyDomain", () => {
  it("normalises a Maps website into a bare host", () => {
    expect(
      quantifyDomain({
        domain: null,
        websiteUrl: "HTTPS://WWW.Example.com/contact?utm_source=gmb",
      }),
    ).toBe("example.com");
  });

  it("refuses a social or directory page", () => {
    // The reason this matters: asking Apollo about facebook.com returns
    // Facebook — publicly traded, 70k employees — and would hard-reject a
    // roofing company as an enterprise.
    for (const host of [
      "https://www.facebook.com/pbroofing",
      "https://www.yelp.com/biz/pb-roofing",
      "https://pbroofing.business.site",
      "https://linktr.ee/pbroofing",
    ]) {
      expect(quantifyDomain({ domain: null, websiteUrl: host })).toBeNull();
    }
  });

  it("returns null when there is no website at all", () => {
    expect(quantifyDomain({ domain: null, websiteUrl: null })).toBeNull();
  });
});

describe("namesAgree", () => {
  it("accepts the same company printed at different lengths", () => {
    expect(namesAgree("Summit Roofing", "Summit Roofing & Sheet Metal")).toBe(true);
    expect(namesAgree("Vega Law, PLLC", "Vega Law LLC")).toBe(true);
  });

  it("rejects two different companies that only share an industry word", () => {
    // "Apex Roofing" vs "Beacon Roofing Supply" is the case that matters: a $9B
    // public distributor's attributes must not land on a 14-person contractor.
    expect(namesAgree("Apex Roofing", "Beacon Roofing Supply")).toBe(false);
    expect(namesAgree("Coastal Law Firm", "Morgan & Morgan Law")).toBe(false);
  });

  it("accepts a shared distinctive token", () => {
    expect(namesAgree("Kavanaugh Plumbing", "Kavanaugh & Sons")).toBe(true);
  });
});

describe("planQuantify", () => {
  it("asks about each domain once, however many locations share it", () => {
    const plan = planQuantify([
      org({ name: "Roto-Rooter Plumbing Boca", domain: "rotorooter.com" }),
      org({ name: "Roto-Rooter Plumbing Delray", domain: "rotorooter.com" }),
      org({ name: "Apex Roofing", domain: "apexroofing.com" }),
    ]);
    expect(plan.batches).toEqual([["rotorooter.com", "apexroofing.com"]]);
    expect(plan.byDomain.get("rotorooter.com")).toEqual([0, 1]);
  });

  it("skips rows that are already sized rather than re-buying them", () => {
    const plan = planQuantify([
      org({ estimatedEmployees: 40, domain: "sized.com" }),
      org({ domain: "unsized.com" }),
    ]);
    expect(plan.batches).toEqual([["unsized.com"]]);
    expect(plan.skipped).toEqual([{ index: 0, reason: "already_sized" }]);
  });

  it("skips rows with no usable domain", () => {
    const plan = planQuantify([
      org({ domain: null, websiteUrl: "https://facebook.com/x" }),
    ]);
    expect(plan.batches).toEqual([]);
    expect(plan.skipped).toEqual([{ index: 0, reason: "no_domain" }]);
  });

  it("batches at Apollo's one-credit page size", () => {
    const many = Array.from({ length: APOLLO_QUANTIFY_BATCH + 5 }, (_, i) =>
      org({ name: `Co ${i}`, domain: `co${i}.com` }),
    );
    const plan = planQuantify(many);
    expect(plan.batches).toHaveLength(2);
    expect(plan.batches[0]).toHaveLength(APOLLO_QUANTIFY_BATCH);
    expect(plan.batches[1]).toHaveLength(5);
  });

  it("reports rows past the credit ceiling as capped instead of dropping them", () => {
    const many = Array.from({ length: 4 }, (_, i) =>
      org({ name: `Co ${i}`, domain: `co${i}.com` }),
    );
    const plan = planQuantify(many, { batchSize: 2, maxBatches: 1 });
    expect(plan.batches).toEqual([["co0.com", "co1.com"]]);
    expect(plan.skipped).toEqual([
      { index: 2, reason: "credit_cap" },
      { index: 3, reason: "credit_cap" },
    ]);
  });
});

describe("mergeQuantified precedence", () => {
  it("fills the holes Maps cannot fill and keeps what Maps knows better", () => {
    const merged = mergeQuantified(org({ industry: null }), apolloOrg(), {
      domain: "palmbeachroofing.com",
    });

    expect(merged.estimatedEmployees).toBe(18);
    expect(merged.linkedinUrl).toBe(
      "http://www.linkedin.com/company/palm-beach-roofing",
    );
    expect(merged.industry).toBe("construction");
    expect(merged.annualRevenue).toBe(4_200_000);

    // Maps' phone is the published main line by definition; Apollo's is often a
    // national switchboard. Same for the branch's own city/state and name.
    expect(merged.phone).toBe("+1 561-555-0142");
    expect(merged.city).toBe("West Palm Beach");
    expect(merged.state).toBe("FL");
    expect(merged.name).toBe("Palm Beach Roofing Co");

    expect(merged.quantification.reason).toBe("quantified");
    expect(merged.quantification.fields).toMatchObject({
      estimatedEmployees: "apollo",
      industry: "apollo",
      linkedinUrl: "apollo",
      annualRevenue: "apollo",
      publiclyTradedSymbol: "unknown",
    });
  });

  it("never overwrites a value the source already had", () => {
    const merged = mergeQuantified(
      org({ industry: "Roofing contractor", linkedinUrl: "https://li/maps" }),
      apolloOrg(),
      { domain: "palmbeachroofing.com" },
    );
    expect(merged.industry).toBe("Roofing contractor");
    expect(merged.linkedinUrl).toBe("https://li/maps");
    expect(merged.quantification.fields.industry).toBe("source");
    expect(merged.quantification.fields.linkedinUrl).toBe("source");
  });

  it("leaves the row size-unknown when Apollo has no record", () => {
    const merged = mergeQuantified(org(), null, { domain: "palmbeachroofing.com" });
    expect(merged.estimatedEmployees).toBeNull();
    expect(merged.quantification.reason).toBe("no_apollo_record");
    expect(merged.quantification.fields.estimatedEmployees).toBe("unknown");
  });

  it("withholds headcount on a shared franchise domain but keeps the enterprise signals", () => {
    const merged = mergeQuantified(
      org({ name: "Roto-Rooter Plumbing Boca", domain: "rotorooter.com" }),
      apolloOrg({
        name: "Roto-Rooter",
        domain: "rotorooter.com",
        estimatedEmployees: 4_800,
        annualRevenue: 1_800_000_000,
        publiclyTradedSymbol: "CHDN",
      }),
      { domain: "rotorooter.com", sharedDomain: true },
    );

    // The national headcount is not this branch's, so it stays unknown and the
    // company goes to a human instead of being confidently rejected as "too
    // large" or accepted on the wrong band.
    expect(merged.estimatedEmployees).toBeNull();
    expect(merged.quantification.fields.estimatedEmployees).toBe("unknown");
    // But whether the brand behind the domain is a $1.8B public company is a
    // true fact about it, and the gate is entitled to reject on that.
    expect(merged.annualRevenue).toBe(1_800_000_000);
    expect(merged.publiclyTradedSymbol).toBe("CHDN");
    expect(merged.quantification.reason).toBe("identity_unverified");
    expect(merged.quantification.identityNote).toContain("shared by several");
  });

  it("withholds headcount when Apollo's name disagrees with the source's", () => {
    const merged = mergeQuantified(
      org({ name: "Apex Roofing", domain: "beacon.com" }),
      apolloOrg({ name: "Beacon Roofing Supply", domain: "beacon.com" }),
      { domain: "beacon.com" },
    );
    expect(merged.estimatedEmployees).toBeNull();
    expect(merged.quantification.reason).toBe("identity_unverified");
    expect(merged.quantification.identityNote).toContain("does not match");
  });
});

describe("gateInputFor", () => {
  it("hands the exclusion gate exactly the keys it reads", () => {
    // Guards against drift with DiscoveryGateInput in ./exclusion-gate, which
    // lands separately (PR #52) and so cannot be imported here yet.
    expect(Object.keys(gateInputFor(org(), "construction")).sort()).toEqual([
      "annualRevenue",
      "domain",
      "employeeCount",
      "industry",
      "name",
      "publiclyTradedSymbol",
      "vertical",
    ]);
  });

  it("passes a backfilled headcount through, and null when nobody knows", () => {
    const quantified = mergeQuantified(org(), apolloOrg(), {
      domain: "palmbeachroofing.com",
    });
    expect(gateInputFor(quantified, "construction").employeeCount).toBe(18);

    const unmatched = mergeQuantified(org(), null, { domain: "x.com" });
    // Null is what makes the gate fail CLOSED to review rather than accept.
    expect(gateInputFor(unmatched, "construction").employeeCount).toBeNull();
  });
});

describe("headcountProvenance", () => {
  it("tells a backfilled headcount from one nobody has", () => {
    expect(
      headcountProvenance(
        mergeQuantified(org(), apolloOrg(), { domain: "palmbeachroofing.com" }),
      ),
    ).toBe("apollo");
    expect(
      headcountProvenance(mergeQuantified(org(), null, { domain: "x.com" })),
    ).toBe("unknown");
    expect(headcountProvenance(org({ estimatedEmployees: 30 }))).toBe("source");
    expect(headcountProvenance(org())).toBe("unknown");
  });
});

/*
 * The trap that made the routing change in run.ts necessary. Quantifying a Maps
 * company and leaving it in the unknown-size pool would DELETE it, silently, so
 * the feature would have made the review queue smaller instead of better.
 */
describe("a quantified company must not stay in the unknown-size pool", () => {
  const quantified = mergeQuantified(org(), apolloOrg(), {
    domain: "palmbeachroofing.com",
  });

  it("is dropped if it is left there", () => {
    // selectDiscoveryCandidates filters the unknown pool to rows with NO
    // headcount — that is what stops Apollo's unfiltered second pass from
    // re-reviewing companies its first pass already returned.
    const { candidates } = selectDiscoveryCandidates({
      vertical: "construction",
      sized: [],
      unknownSize: [quantified],
      limit: 25,
    });
    expect(candidates).toHaveLength(0);
  });

  it("survives, sized, when routed to the sized pool as run.ts does", () => {
    const { candidates, sizeUnknownCount } = selectDiscoveryCandidates({
      vertical: "construction",
      sized: [quantified],
      unknownSize: [],
      limit: 25,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].estimatedEmployees).toBe(18);
    expect(candidates[0].sizeUnknown).toBe(false);
    expect(sizeUnknownCount).toBe(0);
  });

  it("still reaches review as size-unknown when Apollo had nothing", () => {
    const unmatched = mergeQuantified(org(), null, {
      domain: "palmbeachroofing.com",
    });
    const { candidates, sizeUnknownCount } = selectDiscoveryCandidates({
      vertical: "construction",
      sized: [],
      unknownSize: [unmatched],
      limit: 25,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sizeUnknown).toBe(true);
    expect(sizeUnknownCount).toBe(1);
  });
});

/* ------------------------------------------------------------------ */

describe("quantifyOrganizations", () => {
  it("spends one credit for a whole batch of domains", async () => {
    const { lookup, calls } = lookupReturning([apolloOrg()]);
    const outcome = await quantifyOrganizations({
      apiKey: "k",
      organizations: [org(), org({ name: "Other Co", domain: "other.com" })],
      vertical: "construction",
      market: "Palm Beach County, Florida",
      context: CONTEXT,
      lookup,
    });

    expect(calls).toEqual([["palmbeachroofing.com", "other.com"]]);
    expect(outcome.creditsSpent).toBe(1);
    expect(outcome.quantified).toBe(1);
    expect(outcome.stillSizeUnknown).toBe(1);
    expect(outcome.organizations[0].estimatedEmployees).toBe(18);
    expect(outcome.organizations[1].estimatedEmployees).toBeNull();
    expect(outcome.organizations[1].quantification.reason).toBe(
      "no_apollo_record",
    );
  });

  it("records per-company provenance on a zero-cost usage event", async () => {
    const { lookup } = lookupReturning([apolloOrg()]);
    await quantifyOrganizations({
      apiKey: "k",
      organizations: [org()],
      vertical: "construction",
      market: "Palm Beach County, Florida",
      context: CONTEXT,
      lookup,
    });

    const audit = insertValues.mock.calls
      .map(([row]) => row)
      .find((row) => String(row.endpoint).includes("quantify_audit"));
    expect(audit).toBeDefined();
    // Zero cost: this is an audit row, and dailyUsage sums estimated_cost.
    expect(audit?.estimatedCost).toBe(0);
    const metadata = audit?.metadata as {
      companies: Array<Record<string, unknown>>;
    };
    expect(metadata.companies[0]).toMatchObject({
      domain: "palmbeachroofing.com",
      employees: 18,
      employeesFrom: "apollo",
      apolloName: "Palm Beach Roofing",
    });
  });

  it("returns the companies untouched when the step is switched off", async () => {
    process.env[APOLLO_QUANTIFY_FLAG] = "true";
    const { lookup, calls } = lookupReturning([apolloOrg()]);
    const outcome = await quantifyOrganizations({
      apiKey: "k",
      organizations: [org()],
      vertical: "construction",
      market: "m",
      context: CONTEXT,
      lookup,
    });

    expect(calls).toEqual([]);
    expect(outcome.creditsSpent).toBe(0);
    expect(outcome.organizations).toHaveLength(1);
    expect(outcome.organizations[0].estimatedEmployees).toBeNull();
    expect(outcome.organizations[0].quantification.reason).toBe("disabled");
    expect(outcome.notes.join(" ")).toContain("stay size-unknown");
  });

  it("is on by default, because its off state is the fail-open review queue", async () => {
    const { lookup, calls } = lookupReturning([apolloOrg()]);
    await quantifyOrganizations({
      apiKey: "k",
      organizations: [org()],
      vertical: "construction",
      market: "m",
      context: CONTEXT,
      lookup,
    });
    expect(calls).toHaveLength(1);
  });

  it("keeps every company when Apollo throws, and says so", async () => {
    const lookup: QuantifyLookup = async () => {
      throw new Error("Apollo daily safety cap reached");
    };
    const outcome = await quantifyOrganizations({
      apiKey: "k",
      organizations: [org(), org({ name: "Other Co", domain: "other.com" })],
      vertical: "construction",
      market: "m",
      context: CONTEXT,
      lookup,
    });

    expect(outcome.organizations).toHaveLength(2);
    expect(outcome.stillSizeUnknown).toBe(2);
    // Over-counted on purpose: Apollo bills the page whether or not we read the
    // response, and a meter that under-counts overspends.
    expect(outcome.creditsSpent).toBe(1);
    expect(outcome.organizations[0].quantification.reason).toBe(
      "apollo_unavailable",
    );
    expect(outcome.notes.join(" ")).toContain("Apollo quantify failed");
  });

  it("does not call Apollo without a key", async () => {
    const { lookup, calls } = lookupReturning([apolloOrg()]);
    const outcome = await quantifyOrganizations({
      apiKey: "",
      organizations: [org()],
      vertical: "construction",
      market: "m",
      context: CONTEXT,
      lookup,
    });
    expect(calls).toEqual([]);
    expect(outcome.creditsSpent).toBe(0);
    expect(outcome.organizations[0].quantification.reason).toBe(
      "apollo_unavailable",
    );
  });

  it("respects the per-run credit ceiling", async () => {
    process.env.APOLLO_QUANTIFY_RUN_CREDIT_CAP = "0";
    const { lookup, calls } = lookupReturning([apolloOrg()]);
    const outcome = await quantifyOrganizations({
      apiKey: "k",
      organizations: [org()],
      vertical: "construction",
      market: "m",
      context: CONTEXT,
      lookup,
    });
    expect(calls).toEqual([]);
    expect(outcome.creditsSpent).toBe(0);
    expect(outcome.organizations[0].quantification.reason).toBe("credit_cap");
  });

  it("asks about a franchise domain once and sizes neither location", async () => {
    const { lookup, calls } = lookupReturning([
      apolloOrg({
        name: "Roto-Rooter",
        domain: "rotorooter.com",
        estimatedEmployees: 4_800,
        annualRevenue: 1_800_000_000,
      }),
    ]);
    const outcome = await quantifyOrganizations({
      apiKey: "k",
      organizations: [
        org({ name: "Roto-Rooter Boca", domain: "rotorooter.com" }),
        org({ name: "Roto-Rooter Delray", domain: "rotorooter.com" }),
      ],
      vertical: "construction",
      market: "m",
      context: CONTEXT,
      lookup,
    });

    expect(calls).toEqual([["rotorooter.com"]]);
    expect(outcome.creditsSpent).toBe(1);
    expect(outcome.organizations.map((o) => o.estimatedEmployees)).toEqual([
      null,
      null,
    ]);
    expect(outcome.organizations.map((o) => o.annualRevenue)).toEqual([
      1_800_000_000,
      1_800_000_000,
    ]);
  });

  it("asks Apollo by domain only — no location or keyword filter", async () => {
    // Both can only hide a company we have already named, which is the one
    // failure this call must not have: Apollo's record for a local branch often
    // carries the parent's HQ location, and its industry rarely matches the
    // vertical's keyword tags.
    const body = buildOrganizationSearchBody({
      locations: [],
      domains: ["palmbeachroofing.com", "apexroofing.com"],
      page: 1,
      perPage: APOLLO_QUANTIFY_BATCH,
    });
    expect(Object.keys(body).sort()).toEqual([
      "page",
      "per_page",
      "q_organization_domains_list",
    ]);
    expect(body.per_page).toBe(100);
  });

  it("never exceeds Apollo's documented domain-list ceiling", () => {
    const domains = Array.from({ length: 1_200 }, (_, i) => `co${i}.com`);
    const body = buildOrganizationSearchBody({ locations: [], domains });
    expect(body.q_organization_domains_list).toHaveLength(APOLLO_DOMAIN_LIST_MAX);
  });

  it("spends nothing when there is nothing to quantify", async () => {
    const { lookup, calls } = lookupReturning([apolloOrg()]);
    const outcome = await quantifyOrganizations({
      apiKey: "k",
      organizations: [],
      vertical: "construction",
      market: "m",
      context: CONTEXT,
      lookup,
    });
    expect(calls).toEqual([]);
    expect(outcome.creditsSpent).toBe(0);
    expect(outcome.organizations).toEqual([]);
  });
});
