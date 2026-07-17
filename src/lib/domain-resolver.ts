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
  primary_domain?: string;
  website_url?: string;
  industry?: string;
  estimated_num_employees?: number | string;
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

/** @deprecated Prefer resolveCompanyOrg — kept for callers that only need domain. */
export async function resolveCompanyDomain(
  companyName: string,
  apiKey: string,
  context?: PaidEgressContext,
): Promise<{ domain: string | null; confidence: DomainConfidence }> {
  const lookup = await resolveCompanyOrg(companyName, apiKey, context);
  return { domain: lookup.domain, confidence: lookup.confidence };
}
