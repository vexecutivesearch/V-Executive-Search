/**
 * Apollo company-attribute backfill — the "quantify" half of Maps + Apollo.
 *
 * WHY THIS EXISTS: Google Maps finds the 12-person roofing companies Apollo's
 * database misses, but Maps carries no headcount, no industry taxonomy, no
 * revenue and no ticker. Every Maps company therefore arrived `size_unknown`,
 * which is a review-triggering state, and — worse — arrived with none of the
 * structural signals the exclusion gate does most of its work with. A Maps-
 * discovered Fortune 500 branch office or a staffing agency with a tidy Google
 * Business Profile sailed through on "size unknown, operator decides".
 *
 * So: Maps discovers, Apollo quantifies, and only then does the gate run.
 *
 * THE COST DECISION, which is the whole reason this is affordable:
 * Apollo's own pricing page (https://docs.apollo.io/docs/api-pricing) prices
 *   - organization enrichment       1 credit per organization
 *   - BULK organization enrichment  1 credit per organization (not per request)
 *   - organization search           1 credit per PAGE of up to 100 results
 * and organization search accepts `q_organization_domains_list[]` with up to
 * 1,000 domains per request. Bulk enrichment's batch ceiling therefore saves
 * HTTP calls and no credits at all: 100 domains cost 100 credits there and
 * ONE credit here. This module uses the search endpoint with a domain list,
 * one page per batch of 100 domains.
 *
 * WHAT IT WILL NOT DO:
 *   - never reveals a person. This is company-attribute qualification; paid
 *     contact enrichment still starts only when the operator clicks Approve.
 *   - never quantifies a company Apollo already sized. Asking Apollo about a
 *     row Apollo just returned without a headcount buys nothing.
 *   - never attributes a shared franchise domain's headcount to one location.
 *     See `TRUST` below — a wrong headcount is worse than no headcount, because
 *     it converts an honest "operator decides" into a confident wrong answer.
 */

import { normalizeCompanyKey } from "@/lib/company-name";
import {
  searchOrganizations,
  type DiscoveredOrganization,
} from "@/lib/domain-resolver";
import {
  PaidEgressBlockedError,
  recordProviderUsageEvent,
  type PaidEgressContext,
} from "@/lib/paid-egress";
import {
  isNonCompanyHost,
  normalizeWebsiteHost,
} from "./serpapi-maps-normalize";
import { sourceFlagOn, type DiscoverySourceEnv } from "./source";

/**
 * Off switch, not an on switch — and deliberately different from every other
 * flag in this directory.
 *
 * The other flags guard a source that spends money to find companies nobody
 * asked for. This guards a step that only runs when a supplementary source has
 * ALREADY returned rows (which needs its own explicit opt-in), costs one credit
 * for up to 100 of them, and whose "off" state is the fail-open review queue
 * that PR #52's gate exists to prevent. Defaulting it off would mean the
 * operator could turn Maps on, forget this, and get exactly the problem this
 * module was written to fix. So it defaults ON and can be switched off.
 */
export const APOLLO_QUANTIFY_FLAG = "APOLLO_QUANTIFY_DISABLED";

/** One credit buys one page; one page holds 100 organizations. */
export const APOLLO_QUANTIFY_BATCH = 100;

/**
 * Credits one run may spend quantifying. Two batches (200 domains) is far more
 * than a 25-company run can produce, so this is a bug-stop rather than a budget
 * — the daily cap in paid-egress.ts is the real budget.
 */
export const DEFAULT_QUANTIFY_CREDIT_CAP = 2;

export const QUANTIFY_USAGE_LABEL_STEP = "discovery_quantify";

/** Endpoint label for the zero-cost provenance event. See `recordProvenance`. */
export const QUANTIFY_PROVENANCE_ENDPOINT = "organizations/search:quantify_audit";

/* ------------------------------------------------------------------ */
/* Provenance                                                          */
/* ------------------------------------------------------------------ */

/** The five attributes Apollo can backfill that Maps cannot supply. */
export const QUANTIFIED_FIELDS = [
  "estimatedEmployees",
  "industry",
  "linkedinUrl",
  "annualRevenue",
  "publiclyTradedSymbol",
] as const;

export type QuantifiedField = (typeof QUANTIFIED_FIELDS)[number];

/**
 * Where a field's value came from. `unknown` is a first-class answer and the
 * point of the whole type: "Apollo says 18 employees" and "nobody knows" must
 * never render as the same thing, because one is a decided company and the
 * other needs a human.
 */
export type FieldProvenance = "source" | "apollo" | "unknown";

export type QuantifyOutcomeReason =
  /** Merged whatever Apollo had. */
  | "quantified"
  /** Apollo had a record, but it may not be THIS company — headcount withheld. */
  | "identity_unverified"
  /** Apollo has no row for this domain. Expected, and common for small firms. */
  | "no_apollo_record"
  /** Maps gave no usable domain (absent, or a Facebook/directory page). */
  | "no_domain"
  /** Source already knew the headcount; nothing to buy. */
  | "already_sized"
  /** Apollo was capped, disabled or erroring. */
  | "apollo_unavailable"
  /** The run's own credit ceiling stopped the batch. */
  | "credit_cap"
  /** The step is switched off. */
  | "disabled";

export type CompanyQuantification = {
  /** Normalised domain the lookup was keyed on, null when there was none. */
  domain: string | null;
  reason: QuantifyOutcomeReason;
  /** Per-field: who supplied the value that survived precedence. */
  fields: Record<QuantifiedField, FieldProvenance>;
  /** Apollo's own name for the domain, so a bad match is auditable. */
  apolloName: string | null;
  /** Set when identity could not be verified; explains which guard fired. */
  identityNote: string | null;
};

export type QuantifiedOrganization = DiscoveredOrganization & {
  quantification: CompanyQuantification;
};

function emptyFields(): Record<QuantifiedField, FieldProvenance> {
  return {
    estimatedEmployees: "unknown",
    industry: "unknown",
    linkedinUrl: "unknown",
    annualRevenue: "unknown",
    publiclyTradedSymbol: "unknown",
  };
}

/**
 * Provenance for an organization that was never looked up, reading the fields
 * the source already filled as `source`-provided. Used for the skip paths so a
 * caller never has to handle "no quantification" as a separate case.
 */
export function unquantified(
  org: DiscoveredOrganization,
  reason: QuantifyOutcomeReason,
  domain: string | null = null,
): QuantifiedOrganization {
  const fields = emptyFields();
  for (const field of QUANTIFIED_FIELDS) {
    if (org[field] != null) fields[field] = "source";
  }
  return {
    ...org,
    quantification: {
      domain,
      reason,
      fields,
      apolloName: null,
      identityNote: null,
    },
  };
}

/**
 * Read the quantification off a row that has been through the rest of the
 * pipeline, where it is carried as an extra property on a type that does not
 * declare it. Returns null for anything Apollo never looked at.
 */
export function quantificationOf(
  value: unknown,
): CompanyQuantification | null {
  if (value == null || typeof value !== "object") return null;
  const found = (value as { quantification?: unknown }).quantification;
  if (found == null || typeof found !== "object") return null;
  return found as CompanyQuantification;
}

/**
 * Where this company's headcount came from — the distinction the review queue
 * turns on, since `unknown` is what makes a row need a human.
 */
export function headcountProvenance(
  candidate: { estimatedEmployees: number | null },
): FieldProvenance {
  const quantification = quantificationOf(candidate);
  if (quantification) return quantification.fields.estimatedEmployees;
  return candidate.estimatedEmployees == null ? "unknown" : "source";
}

/* ------------------------------------------------------------------ */
/* Domain keying                                                       */
/* ------------------------------------------------------------------ */

/**
 * The domain to key Apollo on, or null when there is nothing safe to ask about.
 *
 * Maps' `website` is whatever the business owner typed into their Google
 * Business Profile, so it is regularly a Facebook page, a Yelp listing, a
 * directory profile or a link-in-bio. `isNonCompanyHost` already rejects those
 * for dedupe purposes; rejecting them here matters more, because asking Apollo
 * about `facebook.com` returns Facebook — 70,000 employees, publicly traded —
 * and would hard-reject a roofing company as an enterprise.
 */
export function quantifyDomain(
  org: Pick<DiscoveredOrganization, "domain" | "websiteUrl">,
): string | null {
  const host = normalizeWebsiteHost(org.domain ?? org.websiteUrl);
  if (!host || isNonCompanyHost(host)) return null;
  return host;
}

/* ------------------------------------------------------------------ */
/* Identity verification (TRUST)                                       */
/* ------------------------------------------------------------------ */

/**
 * Industry words that two unrelated companies in the same vertical will always
 * share, so they cannot carry a name match on their own. Without this, "Apex
 * Roofing" and "Beacon Roofing Supply" agree on "roofing" and a $9B public
 * distributor's attributes land on a 14-person contractor.
 */
const GENERIC_NAME_TOKENS = new Set([
  "roofing",
  "roof",
  "roofers",
  "plumbing",
  "plumbers",
  "hvac",
  "heating",
  "cooling",
  "air",
  "conditioning",
  "electric",
  "electrical",
  "construction",
  "contractors",
  "contracting",
  "builders",
  "building",
  "remodeling",
  "restoration",
  "landscaping",
  "paving",
  "concrete",
  "law",
  "legal",
  "lawyers",
  "attorney",
  "attorneys",
  "firm",
  "associates",
  "partners",
  "services",
  "service",
  "solutions",
  "systems",
  "consulting",
  "consultants",
  "accounting",
  "cpa",
  "tax",
  "financial",
  "advisors",
  "management",
  "the",
  "and",
  "of",
  "usa",
  "america",
  "american",
  "national",
  "united",
  "general",
]);

function distinctiveTokens(name: string): Set<string> {
  return new Set(
    normalizeCompanyKey(name)
      .split(" ")
      .filter((token) => token.length >= 3 && !GENERIC_NAME_TOKENS.has(token)),
  );
}

/**
 * Do the source's name and Apollo's name plausibly describe one company?
 *
 * Containment first, because Maps and Apollo disagree about how much of a legal
 * name to print ("Summit Roofing" vs "Summit Roofing & Sheet Metal"). Failing
 * that, one shared distinctive token is enough — Apollo's record is keyed on the
 * domain either way, so this is a sanity check against a website pointing
 * somewhere unrelated, not a fuzzy-matching engine.
 */
export function namesAgree(sourceName: string, apolloName: string): boolean {
  const a = normalizeCompanyKey(sourceName);
  const b = normalizeCompanyKey(apolloName);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const tokensB = distinctiveTokens(apolloName);
  for (const token of distinctiveTokens(sourceName)) {
    if (tokensB.has(token)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Planning (pure)                                                     */
/* ------------------------------------------------------------------ */

export type QuantifyPlan = {
  /** Unique domains to ask about, split into one-credit batches. */
  batches: string[][];
  /** Index into the input array, per domain. Length > 1 means shared domain. */
  byDomain: Map<string, number[]>;
  /** Input rows that will never be looked up, with the reason. */
  skipped: Array<{ index: number; reason: QuantifyOutcomeReason }>;
};

/**
 * Which rows to look up, deduped by domain so eleven "Roto-Rooter" locations
 * cost one slot rather than eleven.
 */
export function planQuantify(
  orgs: DiscoveredOrganization[],
  options: { batchSize?: number; maxBatches?: number } = {},
): QuantifyPlan {
  const batchSize = Math.max(1, options.batchSize ?? APOLLO_QUANTIFY_BATCH);
  const maxBatches = Math.max(0, options.maxBatches ?? Number.MAX_SAFE_INTEGER);

  const byDomain = new Map<string, number[]>();
  const skipped: Array<{ index: number; reason: QuantifyOutcomeReason }> = [];

  orgs.forEach((org, index) => {
    // A row that already has a headcount is already qualified; buying Apollo's
    // opinion of it would spend a credit to learn nothing.
    if (org.estimatedEmployees != null) {
      skipped.push({ index, reason: "already_sized" });
      return;
    }
    const domain = quantifyDomain(org);
    if (!domain) {
      skipped.push({ index, reason: "no_domain" });
      return;
    }
    const list = byDomain.get(domain);
    if (list) list.push(index);
    else byDomain.set(domain, [index]);
  });

  const domains = [...byDomain.keys()];
  const batches: string[][] = [];
  for (let i = 0; i < domains.length; i += batchSize) {
    batches.push(domains.slice(i, i + batchSize));
  }

  // Anything past the credit ceiling is reported as capped rather than dropped
  // silently, so a truncated run is visible in the summary.
  const kept = batches.slice(0, maxBatches);
  for (const overflow of batches.slice(maxBatches)) {
    for (const domain of overflow) {
      for (const index of byDomain.get(domain) ?? []) {
        skipped.push({ index, reason: "credit_cap" });
      }
      byDomain.delete(domain);
    }
  }

  return { batches: kept, byDomain, skipped };
}

/* ------------------------------------------------------------------ */
/* Merge (pure)                                                        */
/* ------------------------------------------------------------------ */

/**
 * Attach Apollo's attributes to a source row.
 *
 * PRECEDENCE — the same rule `preferredIndustry` established on main: a real
 * value is never overwritten, a hole is filled.
 *   - `phone` is NEVER touched. Maps' number is the published main line by
 *     definition; Apollo's is often a national switchboard or absent.
 *   - `name`, `city`, `state`, `domain` stay with the source. Maps knows which
 *     BRANCH this is; Apollo knows the parent's headquarters.
 *   - headcount, industry, LinkedIn, revenue, ticker fill only where the source
 *     had nothing.
 *
 * TRUST — headcount is withheld when identity is unverified: either the domain
 * is shared by several source rows (a franchise brand or a multi-office firm) or
 * the names do not agree. In both cases Apollo's number describes the brand or
 * the parent, not this location, and a confident wrong band is worse than
 * `size_unknown` because it stops a human from looking.
 *
 * The enterprise signals — revenue and ticker — are applied ANYWAY in that
 * case, and that asymmetry is deliberate: whether the company behind this
 * domain is a $1B public corporation is a true fact about the brand, and a
 * local outpost of one is precisely what the operator excluded. Headcount is a
 * property of a site and does not transfer; enterprise-ness is a property of the
 * business and does.
 */
export function mergeQuantified(
  org: DiscoveredOrganization,
  apollo: DiscoveredOrganization | null,
  options: { domain: string; sharedDomain?: boolean },
): QuantifiedOrganization {
  if (!apollo) return unquantified(org, "no_apollo_record", options.domain);

  const shared = options.sharedDomain === true;
  const agree = namesAgree(org.name, apollo.name);
  const identityVerified = !shared && agree;
  const identityNote = shared
    ? `${options.domain} is shared by several discovered locations, so Apollo's headcount describes the brand rather than this one`
    : agree
      ? null
      : `Apollo's name for ${options.domain} is "${apollo.name}", which does not match "${org.name}", so its headcount was not applied`;

  const fields = emptyFields();

  /**
   * Resolve one field under the precedence rule, recording who won. Written
   * per-field rather than in a loop because each field's `allowed` flag is a
   * separate editorial decision, and a loop would hide which is which.
   */
  function resolve<T>(
    field: QuantifiedField,
    mine: T | null | undefined,
    theirs: T | null | undefined,
    allowed: boolean,
  ): T | null {
    if (mine != null) {
      fields[field] = "source";
      return mine;
    }
    if (allowed && theirs != null) {
      fields[field] = "apollo";
      return theirs;
    }
    return null;
  }

  return {
    ...org,
    estimatedEmployees: resolve(
      "estimatedEmployees",
      org.estimatedEmployees,
      apollo.estimatedEmployees,
      identityVerified,
    ),
    industry: resolve(
      "industry",
      org.industry,
      apollo.industry,
      identityVerified,
    ),
    linkedinUrl: resolve(
      "linkedinUrl",
      org.linkedinUrl,
      apollo.linkedinUrl,
      identityVerified,
    ),
    annualRevenue: resolve(
      "annualRevenue",
      org.annualRevenue,
      apollo.annualRevenue,
      true,
    ),
    publiclyTradedSymbol: resolve(
      "publiclyTradedSymbol",
      org.publiclyTradedSymbol,
      apollo.publiclyTradedSymbol,
      true,
    ),
    quantification: {
      domain: options.domain,
      reason: identityVerified ? "quantified" : "identity_unverified",
      fields,
      apolloName: apollo.name,
      identityNote,
    },
  };
}

/* ------------------------------------------------------------------ */
/* The exclusion gate adapter                                          */
/* ------------------------------------------------------------------ */

/**
 * What `partitionByGate` in `./exclusion-gate` needs from a discovered company.
 *
 * Declared here structurally rather than imported, because the gate lands on
 * `main` in a separate PR (#52) and this module must not depend on merge order.
 * It is the same shape as `DiscoveryGateInput`; a test asserts the key set so
 * this cannot drift silently. Once #52 is in, the call site is literally
 * `partitionByGate(orgs, (o) => gateInputFor(o, vertical))`.
 */
export type DiscoveryGateInputShape = {
  name: string;
  domain?: string | null;
  industry?: string | null;
  employeeCount?: number | null;
  annualRevenue?: number | null;
  publiclyTradedSymbol?: string | null;
  vertical?: string | null;
};

/**
 * Note `employeeCount` stays null when Apollo did not answer or identity was
 * unverified: the gate reads null as "size unknown → send to review", which is
 * the fail-closed path, and handing it a guess here would defeat it.
 */
export function gateInputFor(
  org: QuantifiedOrganization | DiscoveredOrganization,
  vertical: string,
): DiscoveryGateInputShape {
  return {
    name: org.name,
    domain: org.domain,
    industry: org.industry,
    employeeCount: org.estimatedEmployees,
    annualRevenue: org.annualRevenue ?? null,
    publiclyTradedSymbol: org.publiclyTradedSymbol ?? null,
    vertical,
  };
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

export function quantifyEnabled(env: DiscoverySourceEnv = process.env): boolean {
  return !sourceFlagOn(APOLLO_QUANTIFY_FLAG, env);
}

export function quantifyCreditCap(
  env: DiscoverySourceEnv = process.env,
): number {
  const parsed = Number.parseInt(
    (env.APOLLO_QUANTIFY_RUN_CREDIT_CAP ?? "").trim(),
    10,
  );
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_QUANTIFY_CREDIT_CAP;
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

/** Injectable so tests never touch Apollo; production uses the real search. */
export type QuantifyLookup = (input: {
  domains: string[];
  batchIndex: number;
}) => Promise<DiscoveredOrganization[]>;

export type QuantifyRequest = {
  apiKey: string;
  organizations: DiscoveredOrganization[];
  vertical: string;
  market: string;
  context?: PaidEgressContext;
  env?: DiscoverySourceEnv;
  lookup?: QuantifyLookup;
};

export type QuantifyOutcome = {
  organizations: QuantifiedOrganization[];
  /** Apollo credits this step spent. One per batch attempted. */
  creditsSpent: number;
  /** Rows whose headcount Apollo supplied. */
  quantified: number;
  /** Rows still without a headcount after the attempt. */
  stillSizeUnknown: number;
  reasons: Record<string, number>;
  notes: string[];
};

function countReasons(orgs: QuantifiedOrganization[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const org of orgs) {
    const reason = org.quantification.reason;
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

function summarize(
  orgs: QuantifiedOrganization[],
  creditsSpent: number,
  notes: string[],
): QuantifyOutcome {
  return {
    organizations: orgs,
    creditsSpent,
    quantified: orgs.filter(
      (o) => o.quantification.fields.estimatedEmployees === "apollo",
    ).length,
    stillSizeUnknown: orgs.filter((o) => o.estimatedEmployees == null).length,
    reasons: countReasons(orgs),
    notes,
  };
}

/**
 * Durable provenance without a schema change.
 *
 * `companies` has no free-form JSON column and this work is not worth adding
 * one for, but `provider_usage_events.metadata` is `jsonb` and is already the
 * audit trail for every paid call. A zero-cost row there records what was asked
 * and what came back, per domain, so weeks later the operator can still tell
 * which headcounts Apollo supplied and which were never known. It costs
 * nothing: `dailyUsage` sums `estimated_cost`, and this row's is 0.
 */
async function recordProvenance(
  orgs: QuantifiedOrganization[],
  context: PaidEgressContext | undefined,
  usageLabel: string,
): Promise<void> {
  await recordProviderUsageEvent(
    "apollo",
    QUANTIFY_PROVENANCE_ENDPOINT,
    context ?? "automated_scrape",
    {
      recordsReturned: orgs.length,
      estimatedCost: 0,
      metadata: {
        usageLabel,
        step: QUANTIFY_USAGE_LABEL_STEP,
        companies: orgs.map((org) => ({
          name: org.name,
          domain: org.quantification.domain,
          reason: org.quantification.reason,
          apolloName: org.quantification.apolloName,
          employees: org.estimatedEmployees,
          employeesFrom: org.quantification.fields.estimatedEmployees,
          industry: org.industry,
          revenue: org.annualRevenue ?? null,
          ticker: org.publiclyTradedSymbol ?? null,
          identityNote: org.quantification.identityNote,
        })),
      },
    },
  );
}

/**
 * Backfill company attributes for rows a supplementary source discovered.
 *
 * NEVER THROWS. Every failure — switched off, capped, HTTP error, Apollo has no
 * record — returns the organizations unchanged with a reason attached, because
 * the run must still produce companies and `size_unknown` must still reach
 * review. That is the path this whole feature exists to improve, not to replace.
 */
export async function quantifyOrganizations(
  request: QuantifyRequest,
): Promise<QuantifyOutcome> {
  const env = request.env ?? process.env;
  const orgs = request.organizations;
  if (!orgs.length) return summarize([], 0, []);

  const usageLabel = `discovery:${request.vertical}:${request.market}:quantify`;

  if (!quantifyEnabled(env)) {
    return summarize(
      orgs.map((org) => unquantified(org, "disabled")),
      0,
      [
        `Apollo quantify is off (${APOLLO_QUANTIFY_FLAG} is set), so the ` +
          `${orgs.length} company/companies found outside Apollo stay size-unknown ` +
          "and the exclusion gate cannot use headcount, revenue or ticker on them.",
      ],
    );
  }
  if (!request.apiKey) {
    return summarize(
      orgs.map((org) => unquantified(org, "apollo_unavailable")),
      0,
      ["Apollo quantify skipped: no Apollo API key."],
    );
  }

  const plan = planQuantify(orgs, { maxBatches: quantifyCreditCap(env) });
  const notes: string[] = [];

  const lookup: QuantifyLookup =
    request.lookup ??
    (async ({ domains, batchIndex }) => {
      const result = await searchOrganizations({
        apiKey: request.apiKey,
        // No location and no keyword filter on purpose: both can only hide a
        // company we have already named, and this call exists to find it.
        locations: [],
        domains,
        page: 1,
        perPage: APOLLO_QUANTIFY_BATCH,
        context: request.context,
        usageLabel,
        usageMetadata: {
          step: QUANTIFY_USAGE_LABEL_STEP,
          batchIndex,
          domainCount: domains.length,
          domains,
        },
      });
      return result.organizations;
    });

  const byDomain = new Map<string, DiscoveredOrganization>();
  let creditsSpent = 0;
  let unavailable: string | null = null;

  for (const [batchIndex, domains] of plan.batches.entries()) {
    // Counted before the call resolves, and kept even if it throws: Apollo
    // bills a page whether or not we manage to read the response, and a meter
    // that over-counts stops early while one that under-counts overspends.
    creditsSpent += 1;
    try {
      for (const org of await lookup({ domains, batchIndex })) {
        const key = quantifyDomain(org);
        if (key && !byDomain.has(key)) byDomain.set(key, org);
      }
    } catch (err) {
      if (err instanceof PaidEgressBlockedError) {
        // The cap is a hard stop, not an error: hand back what we have.
        unavailable = err.message;
        notes.push(`Apollo quantify stopped: ${err.message}`);
      } else {
        console.error("Apollo quantify batch failed:", err);
        unavailable =
          err instanceof Error ? err.message : "Apollo request failed";
        notes.push(
          `Apollo quantify failed (${unavailable}) — the companies below are ` +
            "unaffected but stay size-unknown.",
        );
      }
      break;
    }
  }

  const skipReason = new Map(
    plan.skipped.map(({ index, reason }) => [index, reason] as const),
  );
  const quantifiedOrgs = orgs.map((org, index) => {
    const skipped = skipReason.get(index);
    if (skipped) return unquantified(org, skipped, quantifyDomain(org));
    const domain = quantifyDomain(org);
    if (!domain) return unquantified(org, "no_domain");
    const sharedDomain = (plan.byDomain.get(domain)?.length ?? 0) > 1;
    const apollo = byDomain.get(domain) ?? null;
    if (!apollo && unavailable) {
      return unquantified(org, "apollo_unavailable", domain);
    }
    return mergeQuantified(org, apollo, { domain, sharedDomain });
  });

  if (creditsSpent > 0) {
    const backfilled = quantifiedOrgs.filter(
      (o) => o.quantification.fields.estimatedEmployees === "apollo",
    ).length;
    const stillUnknown = quantifiedOrgs.filter(
      (o) => o.estimatedEmployees == null,
    ).length;
    const identityWithheld = quantifiedOrgs.filter(
      (o) => o.quantification.reason === "identity_unverified",
    ).length;
    notes.push(
      `Apollo quantify: ${creditsSpent} credit(s) for ${plan.byDomain.size} ` +
        `domain(s) → ${backfilled} headcount(s) backfilled, ` +
        `${stillUnknown} still size-unknown` +
        (identityWithheld
          ? `, ${identityWithheld} withheld because the domain is shared or the names disagree`
          : "") +
        ". Company attributes only — no contact was revealed.",
    );
    try {
      await recordProvenance(quantifiedOrgs, request.context, usageLabel);
    } catch (err) {
      // Provenance is an audit nicety; losing it must not lose the companies.
      console.error("Apollo quantify provenance event failed:", err);
    }
  }

  return summarize(quantifiedOrgs, creditsSpent, notes);
}
