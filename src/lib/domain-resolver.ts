import {
  assertPaidEgressAllowed,
  PaidEgressBlockedError,
  recordProviderUsageEvent,
  type PaidEgressContext,
} from "@/lib/paid-egress";

const APOLLO_BASE = "https://api.apollo.io/api/v1";

export type DomainConfidence = "high" | "low";

export type OrgLookupResult = {
  domain: string | null;
  confidence: DomainConfidence;
  industry: string | null;
  estimatedEmployees: number | null;
};

function apolloHeaders(apiKey: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    "X-Api-Key": apiKey,
  };
}

export function guessDomain(companyName: string): string | null {
  const cleaned = companyName
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(
      /\b(inc|incorporated|llc|corp|corporation|co|company|ltd|limited|plc|group|holdings)\b/gi,
      "",
    )
    .trim()
    .replace(/\s+/g, "");
  if (cleaned.length < 2) return null;
  return `${cleaned}.com`;
}

function normalizeDomain(raw: string): string {
  let domain = raw.replace(/^https?:\/\//, "").split("/")[0];
  if (domain.startsWith("www.")) domain = domain.slice(4);
  return domain.toLowerCase();
}

function parseEmployees(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && !Number.isNaN(Number(value))) {
    return parseInt(value, 10);
  }
  return null;
}

type ApolloOrg = {
  name?: string;
  primary_domain?: string;
  website_url?: string;
  industry?: string;
  estimated_num_employees?: number | string;
  primary_phone?: { number?: string; sanitized_number?: string } | string;
  sanitized_phone?: string;
  phone?: string;
  linkedin_url?: string;
  founded_year?: number | string;
  city?: string;
  state?: string;
  country?: string;
  /** Apollo returns revenue as `annual_revenue`; some plans use the alias. */
  annual_revenue?: number | string;
  organization_revenue?: number | string;
  publicly_traded_symbol?: string | null;
  publicly_traded_exchange?: string | null;
};

function parseApolloOrg(org: ApolloOrg): OrgLookupResult {
  const raw = org.primary_domain ?? org.website_url;
  const domain = raw ? normalizeDomain(raw) : null;
  const industry = org.industry?.trim() || null;
  const estimatedEmployees = parseEmployees(org.estimated_num_employees);
  return {
    domain,
    confidence: domain ? "high" : industry ? "low" : "low",
    industry,
    estimatedEmployees,
  };
}

/** Free org lookup — organizations/search returns domain, industry, and headcount. */
export async function resolveCompanyOrg(
  companyName: string,
  apiKey: string,
  context?: PaidEgressContext,
): Promise<OrgLookupResult> {
  if (!apiKey) {
    const guess = guessDomain(companyName);
    return {
      domain: guess,
      confidence: "low",
      industry: null,
      estimatedEmployees: null,
    };
  }

  try {
    await assertPaidEgressAllowed("apollo", "organizations/search", context, {
      estimatedCost: 1,
      metadata: { companyName },
    });
    const resp = await fetch(`${APOLLO_BASE}/organizations/search`, {
      method: "POST",
      headers: apolloHeaders(apiKey),
      body: JSON.stringify({
        q_organization_name: companyName,
        page: 1,
        per_page: 1,
      }),
    });
    if (!resp.ok) throw new Error(await resp.text());

    const data = (await resp.json()) as { organizations?: ApolloOrg[] };
    const org = data.organizations?.[0];
    await recordProviderUsageEvent("apollo", "organizations/search", context ?? "automated_scrape", {
      recordsReturned: data.organizations?.length ?? 0,
      estimatedCost: 1,
      metadata: { companyName },
    });
    if (org) {
      const parsed = parseApolloOrg(org);
      if (parsed.domain) return parsed;
      const guess = guessDomain(companyName);
      if (parsed.industry || parsed.estimatedEmployees != null || guess) {
        return {
          domain: guess,
          confidence: "low",
          industry: parsed.industry,
          estimatedEmployees: parsed.estimatedEmployees,
        };
      }
    }
  } catch (err) {
    if (err instanceof PaidEgressBlockedError) throw err;
    // fall through
  }

  const guess = guessDomain(companyName);
  return {
    domain: guess,
    confidence: "low",
    industry: null,
    estimatedEmployees: null,
  };
}

/* ------------------------------------------------------------------ */
/* Company-first discovery — filter-based organization search          */
/* ------------------------------------------------------------------ */

export type DiscoveredOrganization = {
  name: string;
  domain: string | null;
  websiteUrl: string | null;
  industry: string | null;
  estimatedEmployees: number | null;
  phone: string | null;
  linkedinUrl: string | null;
  foundedYear: number | null;
  city: string | null;
  state: string | null;
  domainConfidence: DomainConfidence;
  /**
   * Enterprise signals the exclusion gate reads. Both are free in the search
   * payload and both survive the case employee count cannot catch: a large
   * corporation's local office reports a small headcount but still carries the
   * parent's ticker and revenue.
   */
  annualRevenue: number | null;
  publiclyTradedSymbol: string | null;
};

export type OrganizationSearchResult = {
  organizations: DiscoveredOrganization[];
  page: number;
  perPage: number;
  totalEntries: number | null;
  totalPages: number | null;
};

export type OrganizationSearchOptions = {
  apiKey: string;
  /** Apollo `organization_locations[]` — the market for THIS run only. */
  locations: string[];
  notLocations?: string[];
  keywordTags?: string[];
  /** Omit to search without a headcount filter (surfaces unknown headcount). */
  employeeRange?: string | null;
  page?: number;
  perPage?: number;
  context?: PaidEgressContext;
  /** Free-text label recorded on the usage event (vertical/market). */
  usageLabel?: string;
};

function apolloPhone(org: ApolloOrg): string | null {
  const primary =
    typeof org.primary_phone === "string"
      ? org.primary_phone
      : (org.primary_phone?.sanitized_number ?? org.primary_phone?.number);
  const raw = primary ?? org.sanitized_phone ?? org.phone;
  return raw?.trim() || null;
}

function parseDiscoveredOrg(org: ApolloOrg): DiscoveredOrganization | null {
  const name = org.name?.trim();
  if (!name) return null;
  const parsed = parseApolloOrg(org);
  const foundedYear = parseEmployees(org.founded_year);
  return {
    name,
    domain: parsed.domain,
    websiteUrl: org.website_url?.trim() || null,
    industry: parsed.industry,
    estimatedEmployees: parsed.estimatedEmployees,
    phone: apolloPhone(org),
    linkedinUrl: org.linkedin_url?.trim() || null,
    foundedYear,
    city: org.city?.trim() || null,
    state: org.state?.trim() || null,
    // A domain straight from organization search is Apollo's own primary
    // domain, not a name guess — that is the high-confidence case.
    domainConfidence: parsed.domain ? "high" : "low",
    annualRevenue: parseEmployees(
      org.annual_revenue ?? org.organization_revenue,
    ),
    publiclyTradedSymbol: org.publicly_traded_symbol?.trim() || null,
  };
}

/**
 * Every Apollo organization-search parameter that would silently restrict
 * results to companies that are currently hiring. Discovery is deliberately
 * hiring-agnostic — a law firm with no open roles is still a valid prospect —
 * so none of these may ever appear in the request body. Asserted by test.
 */
export const JOB_ACTIVITY_SEARCH_KEYS = [
  "q_organization_job_titles",
  "organization_job_locations",
  "organization_job_posted_at_range",
  "organization_num_jobs_range",
  "organization_num_jobs_min",
  "organization_num_jobs_max",
  "currently_hiring",
  "q_organization_job_keyword_tags",
] as const;

/**
 * Request body for the discovery organization search — pure, so the shape can
 * be asserted without spending a credit.
 *
 * Filters on WHAT the company is (vertical keyword tags), WHERE it is
 * (market), and HOW BIG it is (employee band). Never on whether it is hiring.
 */
export function buildOrganizationSearchBody(
  options: Omit<OrganizationSearchOptions, "apiKey" | "context" | "usageLabel">,
): Record<string, unknown> {
  const {
    locations,
    notLocations = [],
    keywordTags = [],
    employeeRange = null,
    page = 1,
    perPage = 25,
  } = options;

  const body: Record<string, unknown> = {
    page,
    per_page: Math.min(Math.max(1, perPage), 100),
  };
  if (locations.length) body.organization_locations = locations;
  if (notLocations.length) body.organization_not_locations = notLocations;
  if (keywordTags.length) body.q_organization_keyword_tags = keywordTags;
  if (employeeRange) body.organization_num_employees_ranges = [employeeRange];
  return body;
}

/**
 * Filter-based organization search — the discovery source.
 *
 * Apollo bills ONE credit per page of up to 100 organizations, so a 25-company
 * run costs a single credit. Nothing here reveals a person: discovery must stay
 * cheap and must never auto-enrich.
 */
export async function searchOrganizations(
  options: OrganizationSearchOptions,
): Promise<OrganizationSearchResult> {
  const {
    apiKey,
    page = 1,
    perPage = 25,
    context,
    usageLabel,
    employeeRange = null,
  } = options;

  const boundedPerPage = Math.min(Math.max(1, perPage), 100);
  const body = buildOrganizationSearchBody(options);

  await assertPaidEgressAllowed("apollo", "organizations/search", context, {
    estimatedCost: 1,
    metadata: { usageLabel, page, perPage: boundedPerPage, employeeRange },
  });

  const resp = await fetch(`${APOLLO_BASE}/organizations/search`, {
    method: "POST",
    headers: apolloHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Apollo organization search failed: ${await resp.text()}`);
  }

  const data = (await resp.json()) as {
    organizations?: ApolloOrg[];
    accounts?: ApolloOrg[];
    pagination?: {
      page?: number;
      per_page?: number;
      total_entries?: number;
      total_pages?: number;
    };
  };
  const raw = data.organizations ?? data.accounts ?? [];
  await recordProviderUsageEvent(
    "apollo",
    "organizations/search",
    context ?? "automated_scrape",
    {
      recordsReturned: raw.length,
      estimatedCost: 1,
      metadata: { usageLabel, page, perPage: boundedPerPage, employeeRange },
    },
  );

  const organizations = raw
    .map(parseDiscoveredOrg)
    .filter((org): org is DiscoveredOrganization => org !== null);

  return {
    organizations,
    page: data.pagination?.page ?? page,
    perPage: data.pagination?.per_page ?? boundedPerPage,
    totalEntries: parseEmployees(data.pagination?.total_entries),
    totalPages: parseEmployees(data.pagination?.total_pages),
  };
}

/** @deprecated Prefer resolveCompanyOrg — kept for callers that only need domain. */
export async function resolveCompanyDomain(
  companyName: string,
  apiKey: string,
  context?: PaidEgressContext,
): Promise<{ domain: string | null; confidence: DomainConfidence }> {
  const lookup = await resolveCompanyOrg(companyName, apiKey, context);
  return { domain: lookup.domain, confidence: lookup.confidence };
}
